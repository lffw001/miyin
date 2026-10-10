import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  runChannelMatrix,
  UpstreamMatrixError,
  getUpstreamChannelStats,
  getUpstreamRecentEvents,
  resetUpstreamState,
  parseLooseJson,
  type UpstreamChannel,
} from '../server/services/upstreamChannels'

type Item = { id: string }

const jsonRes = (obj: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
  }) as Response

type ChOpts = {
  detect?: (d: any) => string | null
  parse?: (d: any) => Item[]
  retries?: number
}

/** 构造一个测试通道；URL 固定为 https://example.test/<id>，由 installFetch 按末段分发 */
function ch(id: string, priority: number, opts: ChOpts = {}): UpstreamChannel<Item> {
  return {
    id,
    label: id,
    platform: 'tx',
    priority,
    buildUrl: () => `https://example.test/${id}`,
    retries: opts.retries,
    detectUpstreamError: opts.detect,
    parse: opts.parse ?? ((d: any) => (d?.items || []) as Item[]),
  }
}

/** 按 URL 末段分发响应，返回记录到的调用 URL 列表 */
function installFetch(map: Record<string, () => Response>) {
  const calls: string[] = []
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input)
    calls.push(url)
    const key = url.split('/').pop() || ''
    const handler = map[key]
    if (!handler) throw new Error(`unexpected url ${url}`)
    return handler()
  }) as unknown as typeof fetch
  return calls
}

/** 依次返回给定步骤；用尽后重复最后一步 */
const sequence = (steps: Array<{ body?: unknown; status?: number; reject?: string }>) => {
  let i = 0
  return () => {
    const s = steps[Math.min(i, steps.length - 1)]!
    i += 1
    if (s.reject) throw new Error(s.reject)
    return jsonRes(s.body ?? {}, s.status ?? 200)
  }
}

describe('upstreamChannels / runChannelMatrix', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    resetUpstreamState()
    process.env.MIYIN_UPSTREAM_RETRIES = '0'
    process.env.MIYIN_UPSTREAM_BREAKER_THRESHOLD = '2'
    process.env.MIYIN_UPSTREAM_BREAKER_COOLDOWN_MS = '60000'
    delete process.env.MIYIN_UPSTREAM_STALE_FALLBACK
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = { ...savedEnv } as NodeJS.ProcessEnv
    vi.restoreAllMocks()
  })

  it('按 priority 升序尝试，首个成功者胜出且不标记降级', async () => {
    const hi = ch('a-low-priority', 5)
    const lo = ch('a-high-priority', 1)
    const calls = installFetch({
      'a-high-priority': () => jsonRes({ items: [{ id: 'first' }] }),
      // 低优先级通道若被调用会直接抛错，用于证明它没被请求
      'a-low-priority': () => {
        throw new Error('不应请求低优先级通道')
      },
    })

    const outcome = await runChannelMatrix<Item>([hi, lo], { keyword: 'k', page: 1 }, { scope: 'search' })
    expect(outcome.channelId).toBe('a-high-priority')
    expect(outcome.items).toEqual([{ id: 'first' }])
    expect(outcome.degraded).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('主通道网络失败时自动降级到备用通道', async () => {
    installFetch({
      'tx:primary': () => {
        throw new Error('ECONNRESET')
      },
      'tx:backup': () => jsonRes({ items: [{ id: 'backup' }] }),
    })

    const outcome = await runChannelMatrix<Item>(
      [ch('tx:primary', 1), ch('tx:backup', 2)],
      { keyword: '稻香', page: 1 },
      { scope: 'search' },
    )
    expect(outcome.channelId).toBe('tx:backup')
    expect(outcome.items).toEqual([{ id: 'backup' }])
    expect(outcome.degraded).toBe(true)
    expect(outcome.attempts.map((a) => a.kind)).toEqual(['network_error', 'success'])
  })

  it('识别「HTTP 200 + 业务错误码」并降级（酷狗 err signature 场景）', async () => {
    installFetch({
      'kg:complexsearch-v2': () =>
        jsonRes({ status: 0, error_code: 20006, error_msg: 'err signature', data: { lists: [] } }),
      'kg:mobileservice-v3': () => jsonRes({ status: 1, data: { info: [{ id: 'ok' }] } }),
    })

    const broken = ch('kg:complexsearch-v2', 1, {
      detect: (d) => (d?.error_code ? `${d.error_msg} (error_code=${d.error_code})` : null),
    })
    const good = ch('kg:mobileservice-v3', 2, {
      detect: () => null,
      parse: (d) => (d?.data?.info || []) as Item[],
    })

    const outcome = await runChannelMatrix<Item>(
      [broken, good],
      { keyword: '稻香', page: 1 },
      { scope: 'search' },
    )
    expect(outcome.items).toEqual([{ id: 'ok' }])
    expect(outcome.channelId).toBe('kg:mobileservice-v3')

    const failed = outcome.attempts.find((a) => a.channelId === 'kg:complexsearch-v2')!
    expect(failed.kind).toBe('business_error')
    expect(failed.upstreamCode).toBe('20006')
    expect(failed.error).toContain('err signature')
  })

  it('全通道失败时抛出 UpstreamMatrixError 并保留真实错误码与描述', async () => {
    installFetch({
      'kg:a': () => jsonRes({ status: 0, error_code: 20006, error_msg: 'err signature' }),
      'kg:b': () => jsonRes({}, 503),
    })

    const a = ch('kg:a', 1, {
      detect: (d) => (d?.error_code ? `${d.error_msg} (error_code=${d.error_code})` : null),
    })
    const b = ch('kg:b', 2)

    await expect(
      runChannelMatrix<Item>([a, b], { keyword: 'k', page: 1 }, { scope: 'search' }),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as UpstreamMatrixError
      expect(e).toBeInstanceOf(UpstreamMatrixError)
      expect(e.platform).toBe('tx')
      expect(e.scope).toBe('search')
      expect(e.attempts).toHaveLength(2)
      expect(e.attempts[0]!.upstreamCode).toBe('20006')
      expect(e.attempts[0]!.error).toContain('err signature')
      expect(e.attempts[1]!.kind).toBe('http_error')
      expect(e.attempts[1]!.upstreamCode).toBe('503')
      // message 必须带真实原因，禁止通用文案掩盖
      expect(e.message).toContain('20006')
      expect(e.message).toContain('err signature')
      return true
    })
  })

  it('上游明确成功但无结果 → 返回空数组而非报错', async () => {
    installFetch({ 'tx:a': () => jsonRes({ data: { song: { list: [] } } }) })
    const a = ch('tx:a', 1, { parse: (d) => (d?.data?.song?.list || []) as Item[] })

    const outcome = await runChannelMatrix<Item>(
      [a],
      { keyword: '不存在的歌名xyz', page: 1 },
      { scope: 'search' },
    )
    expect(outcome.items).toEqual([])
    expect(outcome.channelId).toBeNull()
    expect(outcome.attempts[0]!.kind).toBe('empty')
  })

  it('网络错误按 retries 重试，业务错误不重试', async () => {
    process.env.MIYIN_UPSTREAM_RETRIES = '2'
    installFetch({
      'tx:retry': sequence([{ reject: 'ECONNRESET' }, { reject: 'ECONNRESET' }, { body: { items: [{ id: 'x' }] } }]),
    })
    const a = ch('tx:retry', 1)
    const outcome = await runChannelMatrix<Item>([a], { keyword: 'k', page: 1 }, { scope: 'search' })
    expect(outcome.items).toEqual([{ id: 'x' }])
    expect(outcome.attempts[0]!.requests).toBe(3)
    // 两次重试各退避 300ms / 600ms → 总耗时不小于 850ms
    expect(outcome.attempts[0]!.ms).toBeGreaterThanOrEqual(850)

    resetUpstreamState()
    installFetch({ 'kg:biz': () => jsonRes({ error_code: 20006 }) })
    const biz = ch('kg:biz', 1, { detect: (d) => (d?.error_code ? 'err signature' : null) })
    await expect(
      runChannelMatrix<Item>([biz], { keyword: 'k', page: 1 }, { scope: 'search' }),
    ).rejects.toSatisfy((err: unknown) => {
      expect((err as UpstreamMatrixError).attempts[0]!.requests).toBe(1)
      return true
    })
  })

  it('连续失败达阈值后熔断该通道，冷却期内跳过', async () => {
    installFetch({ 'tx:bad': () => jsonRes({}, 500), 'tx:good': () => jsonRes({ items: [{ id: 'g' }] }) })
    const channels = [ch('tx:bad', 1), ch('tx:good', 2)]

    for (let i = 0; i < 2; i++) {
      await runChannelMatrix<Item>(channels, { keyword: 'k', page: 1 }, { scope: 'search' })
    }

    const calls = installFetch({
      'tx:bad': () => jsonRes({}, 500),
      'tx:good': () => jsonRes({ items: [{ id: 'g' }] }),
    })
    const outcome = await runChannelMatrix<Item>(channels, { keyword: 'k', page: 1 }, { scope: 'search' })
    expect(outcome.items).toEqual([{ id: 'g' }])
    expect(calls.filter((u) => u.endsWith('/tx:bad'))).toHaveLength(0)
    expect(outcome.attempts[0]!.kind).toBe('circuit_open')

    const stat = getUpstreamChannelStats().find((s) => s.channelId === 'tx:bad')!
    expect(stat.skippedByBreaker).toBe(1)
    expect(stat.circuitOpen).toBe(true)
  })

  it('全部通道熔断时强制放行重试，不把功能锁死', async () => {
    process.env.MIYIN_UPSTREAM_BREAKER_THRESHOLD = '1'
    installFetch({ 'tx:a': () => jsonRes({}, 500) })
    await expect(
      runChannelMatrix<Item>([ch('tx:a', 1)], { keyword: 'k', page: 1 }, { scope: 'search' }),
    ).rejects.toThrow(UpstreamMatrixError)

    // 上游恢复后，即便该通道仍在熔断态也应被强制放行
    installFetch({ 'tx:a': () => jsonRes({ items: [{ id: 'recovered' }] }) })
    const outcome = await runChannelMatrix<Item>([ch('tx:a', 1)], { keyword: 'k', page: 1 }, { scope: 'search' })
    expect(outcome.items).toEqual([{ id: 'recovered' }])
  })

  it('记录统计与最近事件供健康检查消费', async () => {
    installFetch({ 'kg:a': () => jsonRes({ error_code: 20006, error_msg: 'err signature' }) })
    const a = ch('kg:a', 1, { detect: (d) => (d?.error_code ? `${d.error_msg} (error_code=${d.error_code})` : null) })

    await expect(
      runChannelMatrix<Item>([a], { keyword: 'k', page: 1 }, { scope: 'search' }),
    ).rejects.toThrow(UpstreamMatrixError)

    const stat = getUpstreamChannelStats().find((s) => s.channelId === 'kg:a')!
    expect(stat.calls).toBe(1)
    expect(stat.failures).toBe(1)
    expect(stat.businessErrors).toBe(1)
    expect(stat.lastUpstreamCode).toBe('20006')
    expect(stat.lastError).toContain('err signature')

    const events = getUpstreamRecentEvents()
    expect(events[0]!.channelId).toBe('kg:a')
    expect(events[0]!.kind).toBe('business_error')
    expect(events[0]!.upstreamCode).toBe('20006')
  })

  it('过期缓存兜底仅在开关打开时生效', async () => {
    installFetch({ 'tx:down': () => jsonRes({}, 502) })
    const a = ch('tx:down', 1)
    const staleFallback = () => [{ id: 'stale' }]

    await expect(
      runChannelMatrix<Item>([a], { keyword: 'k', page: 1 }, { scope: 'search', staleFallback }),
    ).rejects.toThrow(UpstreamMatrixError)

    process.env.MIYIN_UPSTREAM_STALE_FALLBACK = '1'
    const outcome = await runChannelMatrix<Item>(
      [a],
      { keyword: 'k', page: 1 },
      { scope: 'search', staleFallback },
    )
    expect(outcome.stale).toBe(true)
    expect(outcome.items).toEqual([{ id: 'stale' }])
  })

  it('parseLooseJson 仍兼容单引号伪 JSON 与 JSONP', () => {
    expect(parseLooseJson("{'HIT':'1'}")).toEqual({ HIT: '1' })
    expect(parseLooseJson("cb({'a':'b'});")).toEqual({ a: 'b' })
  })
})
