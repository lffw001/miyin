/**
 * 上游接口矩阵（Upstream Channel Matrix）：多通道 + 自动降级 + 失败兜底。
 *
 * 设计要点（对应 issue #34）：
 *
 * 1. **通道列表而非单点**：每个「平台 + 场景」声明一条通道列表
 *    （primary → fallback → last resort），按 `priority` 升序尝试，
 *    首个成功者胜出。单个接口失效不再等于整个平台功能失效。
 *
 * 2. **区分「网络失败」与「业务失败」**：酷狗 `complexsearch` 返回
 *    HTTP 200 + `error_code=20006 "err signature"`，HTTP 层完全健康。
 *    旧实现只判 `res.ok`，于是把它当成「搜索无结果」，静默返回空数组 ——
 *    真实原因被彻底吞掉（这就是 issue #34 里「搜不出歌又看不懂原因」的根源）。
 *    本模块用 `detectUpstreamError` 显式判定业务态，命中即降级到备用通道。
 *
 * 3. **绝不掩盖真实原因**：所有通道都失败时抛 `UpstreamMatrixError`，携带每条
 *    通道的原始错误（失败类型 / HTTP 状态码 / 上游 error_code / 错误描述 / 耗时）。
 *    只有「上游明确返回成功但结果为空」才算真正的空结果。
 *
 * 4. **熔断**：连续失败达阈值后短路该通道，冷却期后半开放行重试；
 *    当所有通道都处于熔断态时强制全量重试，避免熔断把功能彻底锁死。
 *
 * 5. **可观测**：进程内统计 + 最近事件环形缓冲，供 `GET /api/upstream/health`
 *    与结构化日志（`[upstream] ...`）查看。飞牛部署下这些日志会落在
 *    `/var/apps/miyin/var/app.log`。
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 默认单通道超时（毫秒）。可用 MIYIN_UPSTREAM_TIMEOUT_MS 覆盖。 */
const DEFAULT_TIMEOUT_MS = 10_000
/** 默认网络/超时类失败的重试次数（不含首次）。可用 MIYIN_UPSTREAM_RETRIES 覆盖。 */
const DEFAULT_RETRIES = 1
/** 熔断阈值：连续失败多少次后短路。可用 MIYIN_UPSTREAM_BREAKER_THRESHOLD 覆盖。 */
const DEFAULT_BREAKER_THRESHOLD = 3
/** 熔断冷却时长。可用 MIYIN_UPSTREAM_BREAKER_COOLDOWN_MS 覆盖。 */
const DEFAULT_BREAKER_COOLDOWN_MS = 60_000
/** 最近事件环形缓冲容量 */
const EVENT_BUFFER_SIZE = 200

export type UpstreamFailureKind =
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'business_error'
  | 'parse_error'
  | 'empty'
  | 'circuit_open'
  | 'aborted'

export type ChannelAttemptKind = 'success' | UpstreamFailureKind

/** 通道执行上下文：搜索词 / 页码 / 外部中断信号，可扩展任意字段 */
export type ChannelContext = {
  keyword: string
  page: number
  signal?: AbortSignal
  [key: string]: unknown
}

export type UpstreamChannel<T> = {
  /** 全局唯一的通道标识，如 `tx:soso-v2` */
  id: string
  /** 人类可读名称，用于日志与错误文案 */
  label: string
  /** 归属平台（wy / kw / kg / tx …） */
  platform: string
  /** 优先级，数字小者先试 */
  priority: number
  /** 构造请求 URL */
  buildUrl: (ctx: ChannelContext) => string
  /** 附加请求头（UA 会自动补齐） */
  headers?: Record<string, string>
  /** 覆盖默认超时 */
  timeoutMs?: number
  /** 覆盖默认重试次数（仅对 timeout / network_error / 5xx 生效） */
  retries?: number
  /** 把上游原始 JSON 映射为条目数组；不关心业务态，业务态由 detectUpstreamError 判 */
  parse: (data: unknown) => T[]
  /**
   * 业务态错误探测：返回非空字符串 = HTTP 200 但上游明确报错。
   * 例：酷狗 `error_code=20006`、网易 `code!==200`、QQ `code!==0`。
   */
  detectUpstreamError?: (data: unknown) => string | null
}

export type ChannelAttempt = {
  channelId: string
  label: string
  platform: string
  priority: number
  ok: boolean
  kind: ChannelAttemptKind
  /** 该通道累计耗时（含重试） */
  ms: number
  /** 本次请求次数（含重试） */
  requests: number
  items: number
  /** 人类可读的原始错误描述 */
  error?: string
  /** 上游业务错误码（如 `20006`）或 HTTP 状态码 */
  upstreamCode?: string
  url?: string
}

export type MatrixOutcome<T> = {
  items: T[]
  /** 胜出通道 id；纯空结果时为 null */
  channelId: string | null
  attempts: ChannelAttempt[]
  /** 是否发生了降级（存在失败/空结果的通道尝试） */
  degraded: boolean
  /** 是否来自过期缓存兜底 */
  stale: boolean
  /** 后置增强是否成功（未配置 enrich 时恒为 true） */
  enriched: boolean
  /** 增强失败的原始原因（`enriched=false` 时存在） */
  enrichError?: string
}

/**
 * 全部通道均不可用时抛出。`attempts` 保留每条通道的原始失败信息，
 * 供上层拼装真实错误文案（禁止用通用错误掩盖根因）。
 */
export class UpstreamMatrixError extends Error {
  readonly platform: string
  readonly scope: string
  readonly attempts: ChannelAttempt[]

  constructor(platform: string, scope: string, attempts: ChannelAttempt[]) {
    const detail = attempts
      .map((a) => {
        const code = a.upstreamCode ? ` code=${a.upstreamCode}` : ''
        const reason = a.error ? ` ${a.error}` : ''
        return `${a.channelId}(${a.kind}${code}${reason} ${a.ms}ms)`
      })
      .join(' · ')
    super(`上游通道全部不可用：${detail || '无可用通道'}`)
    this.name = 'UpstreamMatrixError'
    this.platform = platform
    this.scope = scope
    this.attempts = attempts
  }
}

/* ------------------------------------------------------------------ *
 * 配置读取（调用时读取，便于测试注入）
 * ------------------------------------------------------------------ */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export function upstreamTimeoutMs(): number {
  return envInt('MIYIN_UPSTREAM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
}

export function upstreamRetries(): number {
  return envInt('MIYIN_UPSTREAM_RETRIES', DEFAULT_RETRIES)
}

export function upstreamBreakerThreshold(): number {
  return envInt('MIYIN_UPSTREAM_BREAKER_THRESHOLD', DEFAULT_BREAKER_THRESHOLD)
}

export function upstreamBreakerCooldownMs(): number {
  return envInt('MIYIN_UPSTREAM_BREAKER_COOLDOWN_MS', DEFAULT_BREAKER_COOLDOWN_MS)
}

/** 过期缓存兜底开关，默认关闭（关闭时全通道失败必须抛真实错误） */
export function upstreamStaleFallbackEnabled(): boolean {
  const v = String(process.env.MIYIN_UPSTREAM_STALE_FALLBACK ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/* ------------------------------------------------------------------ *
 * 容错 JSON 解析（原 platformSearch.parseLooseJson，下沉至此避免循环依赖）
 * ------------------------------------------------------------------ */

/**
 * kw 等接口常返回单引号「伪 JSON」（{'a':'b'}），标准 JSON.parse 会在 position 1 报错。
 * 亦兼容 JSONP / try{var jsondata=...} 包装。
 */
export function parseLooseJson(raw: string): any {
  let text = String(raw || '').trim()
  if (!text) throw new Error('空响应')

  // JSONP / kw 旧客户端: try{var jsondata={...};} / callback({...})
  const jsonp = text.match(/^[a-zA-Z_$][\w$]*\s*\(([\s\S]*)\)\s*;?\s*$/)
  if (jsonp) text = jsonp[1]!.trim()
  const kwWrap = text.match(/^\s*try\s*\{\s*var\s+\w+\s*=\s*([\s\S]*?)\s*;?\s*\}\s*(catch[\s\S]*)?$/i)
  if (kwWrap) text = kwWrap[1]!.trim()

  try {
    return JSON.parse(text)
  } catch {
    // 单引号 → 双引号（kw r.s 当前格式；值内极少含未转义单引号）
    const normalized = text.replace(/'/g, '"')
    try {
      return JSON.parse(normalized)
    } catch (err: any) {
      throw new Error(`响应不是合法 JSON: ${err?.message || err}`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 熔断状态
 * ------------------------------------------------------------------ */

type BreakerState = {
  consecutiveFailures: number
  openUntil: number
}

const breakers = new Map<string, BreakerState>()

function breakerKey(scope: string, channelId: string): string {
  return `${scope}::${channelId}`
}

function isBreakerOpen(scope: string, channelId: string): boolean {
  const st = breakers.get(breakerKey(scope, channelId))
  if (!st) return false
  return st.openUntil > Date.now()
}

function recordBreaker(scope: string, channelId: string, failed: boolean) {
  const key = breakerKey(scope, channelId)
  if (!failed) {
    breakers.delete(key)
    return
  }
  const threshold = upstreamBreakerThreshold()
  const st = breakers.get(key) || { consecutiveFailures: 0, openUntil: 0 }
  st.consecutiveFailures += 1
  if (threshold > 0 && st.consecutiveFailures >= threshold) {
    st.openUntil = Date.now() + upstreamBreakerCooldownMs()
    st.consecutiveFailures = 0
  }
  breakers.set(key, st)
}

/** 某通道当前是否处于熔断（供健康检查展示） */
export function isChannelCircuitOpen(scope: string, channelId: string): boolean {
  return isBreakerOpen(scope, channelId)
}

/* ------------------------------------------------------------------ *
 * 统计与事件（可观测性）
 * ------------------------------------------------------------------ */

export type ChannelStat = {
  channelId: string
  label: string
  platform: string
  scope: string
  calls: number
  successes: number
  failures: number
  empty: number
  timeouts: number
  networkErrors: number
  httpErrors: number
  businessErrors: number
  skippedByBreaker: number
  lastMs: number | null
  avgMs: number | null
  lastError: string | null
  lastUpstreamCode: string | null
  lastOkAt: number | null
  lastFailAt: number | null
  circuitOpen: boolean
}

export type UpstreamEvent = {
  at: number
  scope: string
  platform: string
  channelId: string
  kind: ChannelAttemptKind
  ms: number
  items: number
  detail?: string
  upstreamCode?: string
}

type MutableStat = Omit<ChannelStat, 'circuitOpen' | 'avgMs'> & { totalMs: number }

const stats = new Map<string, MutableStat>()
const events: UpstreamEvent[] = []

function statOf(scope: string, ch: UpstreamChannel<unknown>): MutableStat {
  const key = `${scope}::${ch.id}`
  let st = stats.get(key)
  if (!st) {
    st = {
      channelId: ch.id,
      label: ch.label,
      platform: ch.platform,
      scope,
      calls: 0,
      successes: 0,
      failures: 0,
      empty: 0,
      timeouts: 0,
      networkErrors: 0,
      httpErrors: 0,
      businessErrors: 0,
      skippedByBreaker: 0,
      lastMs: null,
      totalMs: 0,
      lastError: null,
      lastUpstreamCode: null,
      lastOkAt: null,
      lastFailAt: null,
    }
    stats.set(key, st)
  }
  return st
}

function pushEvent(ev: UpstreamEvent) {
  events.push(ev)
  if (events.length > EVENT_BUFFER_SIZE) events.splice(0, events.length - EVENT_BUFFER_SIZE)
}

/** 全部通道健康统计快照（按平台 + 通道排序） */
export function getUpstreamChannelStats(): ChannelStat[] {
  return [...stats.values()]
    .map((s) => ({
      ...s,
      avgMs: s.calls > 0 ? Math.round(s.totalMs / s.calls) : null,
      circuitOpen: isBreakerOpen(s.scope, s.channelId),
    }))
    .sort((a, b) => a.platform.localeCompare(b.platform) || a.channelId.localeCompare(b.channelId))
}

/** 最近上游事件（新→旧） */
export function getUpstreamRecentEvents(limit = 50): UpstreamEvent[] {
  return events.slice(-Math.max(1, limit)).reverse()
}

/** 测试用：清空熔断、统计与事件 */
export function resetUpstreamState() {
  breakers.clear()
  stats.clear()
  events.length = 0
}

/* ------------------------------------------------------------------ *
 * 单通道执行
 * ------------------------------------------------------------------ */

type AttemptResult<T> =
  | { ok: true; kind: 'success'; data: unknown; items: T[]; ms: number; requests: number; url: string }
  | {
      ok: false
      kind: UpstreamFailureKind
      ms: number
      requests: number
      url: string
      error?: string
      upstreamCode?: string
    }

function isRetryable(kind: UpstreamFailureKind, upstreamCode?: string): boolean {
  if (kind === 'timeout' || kind === 'network_error') return true
  if (kind === 'http_error') {
    const code = Number(upstreamCode)
    return Number.isFinite(code) && code >= 500
  }
  return false
}

async function runChannel<T>(ch: UpstreamChannel<T>, ctx: ChannelContext): Promise<AttemptResult<T>> {
  const timeoutMs = ch.timeoutMs ?? upstreamTimeoutMs()
  const retries = ch.retries ?? upstreamRetries()
  const url = ch.buildUrl(ctx)
  const startedAt = Date.now()
  let requests = 0
  let lastKind: UpstreamFailureKind = 'network_error'
  let lastError: string | undefined
  let lastCode: string | undefined

  for (let attempt = 0; attempt <= retries; attempt++) {
    // 调用方主动中断：立即上交，不重试
    if (ctx.signal?.aborted) {
      return { ok: false, kind: 'aborted', ms: Date.now() - startedAt, requests, url, error: '调用方已中断' }
    }

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const signal = ctx.signal
      ? AbortSignal.any([ctx.signal, controller.signal])
      : controller.signal

    requests += 1
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal,
        headers: { 'User-Agent': DEFAULT_UA, ...(ch.headers || {}) },
      })
      if (!res.ok) {
        lastKind = 'http_error'
        lastCode = String(res.status)
        lastError = `HTTP ${res.status}`
      } else {
        const text = await res.text()
        let data: unknown
        let parseFailed = false
        try {
          data = parseLooseJson(text)
        } catch (err: any) {
          parseFailed = true
          lastKind = 'parse_error'
          lastError = String(err?.message || err)
          lastCode = undefined
        }

        if (!parseFailed) {
          const bizErr = ch.detectUpstreamError?.(data)
          if (bizErr) {
            // 业务态错误重试无意义，直接判失败
            return {
              ok: false,
              kind: 'business_error',
              ms: Date.now() - startedAt,
              requests,
              url,
              error: bizErr,
              upstreamCode: extractUpstreamCode(data),
            }
          }

          const items = ch.parse(data) || []
          if (items.length === 0) {
            return { ok: false, kind: 'empty', ms: Date.now() - startedAt, requests, url }
          }
          return { ok: true, kind: 'success', data, items, ms: Date.now() - startedAt, requests, url }
        }
      }
    } catch (err: any) {
      if (ctx.signal?.aborted) {
        return {
          ok: false,
          kind: 'aborted',
          ms: Date.now() - startedAt,
          requests,
          url,
          error: '调用方已中断',
        }
      }
      if (timedOut) {
        lastKind = 'timeout'
        lastError = `超时 ${timeoutMs}ms`
        lastCode = undefined
      } else {
        lastKind = 'network_error'
        lastError = String(err?.message || err || '网络错误')
        lastCode = undefined
      }
    } finally {
      clearTimeout(timer)
    }

    if (!isRetryable(lastKind, lastCode) || attempt >= retries) break
    // 退避后再试：上游抖动时立即重发会放大压力，且容易连续撞同一个故障点
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
  }

  return {
    ok: false,
    kind: lastKind,
    ms: Date.now() - startedAt,
    requests,
    url,
    error: lastError,
    upstreamCode: lastCode,
  }
}

/** 从上游响应中尽力提取业务错误码，用于错误上报 */
function extractUpstreamCode(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  for (const key of ['error_code', 'errcode', 'code', 'status']) {
    const v = d[key]
    if (typeof v === 'number' || typeof v === 'string') {
      const s = String(v)
      // code/status 常为 0 表示成功，不作为错误码上报
      if ((key === 'code' || key === 'status') && (s === '0' || s === '1' || s === '200')) continue
      return s
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * 矩阵执行
 * ------------------------------------------------------------------ */

export type RunMatrixOptions<T> = {
  /** 场景标识，用于日志/统计分组（search / albumSearch / albumDetail） */
  scope: string
  /**
   * 过期缓存兜底：仅当 MIYIN_UPSTREAM_STALE_FALLBACK 打开时生效。
   * 返回非空数组则作为兜底数据，并在结果中标记 `stale: true`。
   */
  staleFallback?: () => T[] | null
  /** 单条通道尝试结束时的回调（测试与埋点用） */
  onAttempt?: (attempt: ChannelAttempt) => void
  /**
   * 后置增强：通道命中后对整页结果做一次补充查询（如 tx 批量补 `media_mid`/
   * 真实音质档位、kg 补封面）。
   *
   * 语义：**非致命**。抛错时保留原始 items，仅在结果里标记 `enriched: false`
   * 并记一条日志 —— 增强失败不该让本来可用的搜索结果整体失败。
   */
  enrich?: (items: T[], ctx: ChannelContext) => Promise<T[]>
  /** 增强步骤在日志/事件里的标识，默认 `${platform}:enrich` */
  enrichId?: string
}

function attemptFromResult<T>(ch: UpstreamChannel<T>, r: AttemptResult<T>): ChannelAttempt {
  return {
    channelId: ch.id,
    label: ch.label,
    platform: ch.platform,
    priority: ch.priority,
    ok: r.ok,
    kind: r.kind,
    ms: r.ms,
    requests: r.requests,
    items: r.ok ? r.items.length : 0,
    error: r.ok ? undefined : r.error,
    upstreamCode: r.ok ? undefined : r.upstreamCode,
    url: r.url,
  }
}

function logAttempt(scope: string, a: ChannelAttempt) {
  if (a.kind === 'success') {
    if (a.priority > 1 || a.requests > 1) {
      console.info(
        `[upstream] ${scope} ${a.channelId} success(降级后) ${a.ms}ms items=${a.items} requests=${a.requests}`,
      )
    }
    return
  }
  const code = a.upstreamCode ? ` code=${a.upstreamCode}` : ''
  const reason = a.error ? ` "${a.error}"` : ''
  if (a.kind === 'circuit_open') {
    console.warn(`[upstream] ${scope} ${a.channelId} circuit_open（熔断中，跳过）`)
    return
  }
  console.warn(`[upstream] ${scope} ${a.channelId} ${a.kind}${code}${reason} ${a.ms}ms → 尝试下一通道`)
}

/**
 * 按优先级依次尝试通道，首个成功者胜出。
 *
 * - 某通道 HTTP 正常但业务报错 / 结果为空 → 记录后继续降级；
 * - 全部通道失败 → 抛 `UpstreamMatrixError`（携带完整原始错误）；
 * - 存在「上游明确成功但无结果」的通道且无成功者 → 返回空数组（真实空结果）。
 */
export async function runChannelMatrix<T>(
  channels: UpstreamChannel<T>[],
  ctx: ChannelContext,
  opts: RunMatrixOptions<T>,
): Promise<MatrixOutcome<T>> {
  const scope = opts.scope
  const ordered = [...channels].sort((a, b) => a.priority - b.priority)
  if (ordered.length === 0) {
    throw new UpstreamMatrixError('unknown', scope, [])
  }

  const attempts: ChannelAttempt[] = []

  const tryRun = async (ch: UpstreamChannel<T>): Promise<{ attempt: ChannelAttempt; items: T[] | null }> => {
    const r = await runChannel(ch, ctx)
    const a = attemptFromResult(ch, r)
    const st = statOf(scope, ch as UpstreamChannel<unknown>)
    st.calls += 1
    st.lastMs = a.ms
    st.totalMs += a.ms
    st.lastUpstreamCode = a.upstreamCode ?? null
    if (a.ok) {
      st.successes += 1
      st.lastOkAt = Date.now()
      recordBreaker(scope, ch.id, false)
    } else {
      st.failures += 1
      st.lastFailAt = Date.now()
      st.lastError = a.error ?? null
      if (a.kind === 'empty') st.empty += 1
      if (a.kind === 'timeout') st.timeouts += 1
      if (a.kind === 'network_error') st.networkErrors += 1
      if (a.kind === 'http_error') st.httpErrors += 1
      if (a.kind === 'business_error') st.businessErrors += 1
      // 空结果不参与熔断：上游是健康的，只是这个词没歌
      if (a.kind !== 'empty' && a.kind !== 'aborted') recordBreaker(scope, ch.id, true)
    }
    attempts.push(a)
    pushEvent({
      at: Date.now(),
      scope,
      platform: ch.platform,
      channelId: ch.id,
      kind: a.kind,
      ms: a.ms,
      items: a.items,
      detail: a.error,
      upstreamCode: a.upstreamCode,
    })
    logAttempt(scope, a)
    opts.onAttempt?.(a)
    return { attempt: a, items: r.ok ? r.items : null }
  }

  // 第一轮：跳过熔断中的通道
  const pending: UpstreamChannel<T>[] = []
  for (const ch of ordered) {
    if (isBreakerOpen(scope, ch.id)) {
      const a: ChannelAttempt = {
        channelId: ch.id,
        label: ch.label,
        platform: ch.platform,
        priority: ch.priority,
        ok: false,
        kind: 'circuit_open',
        ms: 0,
        requests: 0,
        items: 0,
        error: '熔断中，冷却期内跳过',
      }
      attempts.push(a)
      const st = statOf(scope, ch as UpstreamChannel<unknown>)
      st.skippedByBreaker += 1
      pushEvent({
        at: Date.now(),
        scope,
        platform: ch.platform,
        channelId: ch.id,
        kind: 'circuit_open',
        ms: 0,
        items: 0,
        detail: a.error,
      })
      logAttempt(scope, a)
      opts.onAttempt?.(a)
      continue
    }
    pending.push(ch)
  }

  // 全通道熔断 → 强制全量重试，避免熔断把功能锁死
  if (pending.length === 0) {
    console.warn(`[upstream] ${scope} 全部通道处于熔断态 → 强制放行重试`)
    for (const ch of ordered) {
      const { attempt, items } = await tryRun(ch)
      if (items) return finish(attempts, attempt, items, ctx, opts)
    }
    return finalize(ordered, attempts, opts)
  }

  for (const ch of pending) {
    const { attempt, items } = await tryRun(ch)
    if (items) return finish(attempts, attempt, items, ctx, opts)
  }
  return finalize(ordered, attempts, opts)
}

async function finish<T>(
  attempts: ChannelAttempt[],
  winner: ChannelAttempt,
  items: T[],
  ctx: ChannelContext,
  opts: RunMatrixOptions<T>,
): Promise<MatrixOutcome<T>> {
  const degraded = attempts.some((a) => !a.ok)
  if (degraded) {
    const failed = attempts.filter((a) => !a.ok).length
    console.warn(`[upstream] 已降级：${winner.channelId} 胜出（此前 ${failed} 条通道失败/空结果）`)
  }

  let finalItems = items
  let enriched = true
  let enrichError: string | undefined
  if (opts.enrich && items.length) {
    const enrichId = opts.enrichId || `${winner.platform}:enrich`
    const t0 = Date.now()
    try {
      finalItems = await opts.enrich(items, ctx)
      console.info(`[upstream] ${opts.scope} ${enrichId} 增强完成 ${Date.now() - t0}ms items=${finalItems.length}`)
      pushEvent({
        at: Date.now(),
        scope: opts.scope,
        platform: winner.platform,
        channelId: enrichId,
        kind: 'success',
        ms: Date.now() - t0,
        items: finalItems.length,
      })
    } catch (err: any) {
      // 非致命：保留原始结果，只标记未增强
      enriched = false
      enrichError = String(err?.message || err || 'unknown')
      console.warn(
        `[upstream] ${opts.scope} ${enrichId} 增强失败（保留原始结果）: ${enrichError}`,
      )
      pushEvent({
        at: Date.now(),
        scope: opts.scope,
        platform: winner.platform,
        channelId: enrichId,
        kind: 'business_error',
        ms: Date.now() - t0,
        items: items.length,
        detail: enrichError,
      })
    }
  }

  return { items: finalItems, channelId: winner.channelId, attempts, degraded, stale: false, enriched, enrichError }
}

function finalize<T>(
  channels: UpstreamChannel<T>[],
  attempts: ChannelAttempt[],
  opts: RunMatrixOptions<T>,
): MatrixOutcome<T> {
  const platform = channels[0]?.platform ?? 'unknown'
  const aborted = attempts.some((a) => a.kind === 'aborted')
  if (aborted) {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    throw err
  }

  // 上游明确成功但没结果（至少一条 empty）→ 这是真实空结果，不算失败
  const cleanEmpty = attempts.some((a) => a.kind === 'empty')
  if (cleanEmpty) {
    console.warn(
      `[upstream] ${opts.scope} ${platform} 上游正常但无结果（attempts=${attempts.length}）`,
    )
    return {
      items: [],
      channelId: null,
      attempts,
      degraded: attempts.some((a) => !a.ok),
      stale: false,
      enriched: true,
    }
  }

  // 过期缓存兜底（默认关闭）
  if (opts.staleFallback && upstreamStaleFallbackEnabled()) {
    const stale = opts.staleFallback()
    if (stale && stale.length) {
      console.warn(`[upstream] ${opts.scope} ${platform} 全通道失败 → 使用过期缓存兜底（stale）`)
      return { items: stale, channelId: null, attempts, degraded: true, stale: true, enriched: true }
    }
  }

  console.error(
    `[upstream] ${opts.scope} ${platform} 全通道失败 signals=${attempts.map((a) => a.kind).join(',')}`,
  )
  throw new UpstreamMatrixError(platform, opts.scope, attempts)
}

/** 把尝试记录压成人读文案，供错误 message 与前端提示使用 */
export function summarizeAttempts(attempts: ChannelAttempt[]): string {
  return attempts
    .map((a) => {
      const code = a.upstreamCode ? ` code=${a.upstreamCode}` : ''
      const reason = a.error ? ` ${a.error}` : ''
      return `${a.channelId} ${a.kind}${code}${reason}`.trim()
    })
    .join(' · ')
}
