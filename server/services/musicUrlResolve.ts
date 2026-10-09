import { getSource, listEnabledOkSources, type SourceRow } from './sourceRegistry'
import { loadLxSource } from './sourceRuntime'
import { COLD_START_SCORE, PRIMARY_BONUS, sourceScores } from './sourceStats'
import { QUALITY_LADDER } from '#shared/quality'

/** 音质从高到低（highest 降级阶梯）—— 唯一来源在 shared/quality.ts，此处 re-export 保持既有 import 有效 */
export { QUALITY_LADDER }

export function isHighestQuality(pref: string | null | undefined): boolean {
  return !pref || pref === 'highest'
}

/** 补齐 id/songmid/hash，兼容洛雪/部分音源只认 id */
export function normalizeMusicInfo(musicInfo: Record<string, any>): Record<string, any> {
  const id = musicInfo.id || musicInfo.songmid || musicInfo.hash || musicInfo.songId
  if (id == null || id === '') return { ...musicInfo }
  const sid = String(id)
  return {
    ...musicInfo,
    id: musicInfo.id != null && musicInfo.id !== '' ? String(musicInfo.id) : sid,
    songmid: musicInfo.songmid != null && musicInfo.songmid !== '' ? String(musicInfo.songmid) : sid,
    hash: musicInfo.hash != null && musicInfo.hash !== '' ? String(musicInfo.hash) : sid,
  }
}

/**
 * 根据偏好与音源宣称的 qualitys 生成尝试列表（单音源视角，供旧逻辑/单测）。
 * - highest：按阶梯降级，只保留音源支持的项
 * - 固定音质：仅该项
 */
export function buildQualityAttempts(available: string[], preferred: string): string[] {
  if (isHighestQuality(preferred)) {
    const set = new Set(available.map(String))
    const ladder = QUALITY_LADDER.filter((q) => set.has(q))
    if (ladder.length) return [...ladder]
    return ['flac', '320k', '128k']
  }
  return [preferred]
}

/** 全局音质阶梯：highest 时取各源宣称音质并集，再按 QUALITY_LADDER 排序 */
export function buildGlobalQualityLadder(preferred: string, availableLists: string[][]): string[] {
  if (!isHighestQuality(preferred)) return [preferred]
  const union = new Set<string>()
  for (const list of availableLists) {
    for (const q of list) union.add(String(q))
  }
  const ladder = QUALITY_LADDER.filter((q) => union.has(q))
  if (ladder.length) return [...ladder]
  return ['flac', '320k', '128k']
}

/**
 * 音源排序：按**实测表现评分**降序（同分保持原顺序，即最新导入优先）。
 *
 * 任务指定的 `sourceId` 得到小幅加成（它服务过这个任务），但**不再无条件置顶** ——
 * 无条件置顶会让"历史表现很差的指定源"一直挡在前面。
 *
 * ⚠️ 顺序只影响"先探谁"，不影响"下哪个"（那由 `processTask` 按实测码率择优）。
 */
export function orderSourcesForResolve(
  all: SourceRow[],
  sourceId?: string | null,
  platform?: string,
): SourceRow[] {
  const scores = platform ? sourceScores(platform) : new Map<string, number>()
  const effective = (s: SourceRow) =>
    (scores.get(s.id) ?? COLD_START_SCORE) + (s.id === sourceId ? PRIMARY_BONUS : 0)
  // Array.sort 是稳定的：同分时保持 listSources() 的原始顺序
  return [...all].sort((a, b) => effective(b) - effective(a))
}

export function shouldTryQualityOnSource(
  available: string[],
  quality: string,
  highest: boolean,
): boolean {
  if (!highest) return true
  return available.includes(quality)
}

export type ResolveMusicUrlResult = {
  url: string
  quality: string
  sourceId: string
  sourceName: string
}

export type ResolveMusicUrlInput = {
  platform: string
  musicInfo: Record<string, any>
  /** highest | flac24bit | flac | 320k | 128k ... */
  quality: string
  /** 优先尝试的音源（仍轮询全部音源） */
  sourceId?: string | null
  /**
   * 需要跳过的 `sourceId@quality` 组合。
   *
   * **取链成功 ≠ 内容正确**：某些音源对会员曲目会返回一个能正常取链、但内容是
   * 60s 试听的 URL。这只有下载层才能发现，所以必须把结论回灌到这里，
   * 否则每次重试都会重新选中同一个"看起来成功"的音源。
   */
  exclude?: ReadonlySet<string>
}

type LoadedSource = {
  source: SourceRow
  handle: Awaited<ReturnType<typeof loadLxSource>>
  available: string[]
}

/** 加载并排序可用于该平台的音源；`resolveMusicUrl` 与 `listMusicUrlCandidates` 共用 */
async function loadSourcesForResolve(
  platform: string,
  sourceId: string | null | undefined,
  preferred: string,
  highest: boolean,
) {
  const all = listEnabledOkSources(platform)
  if (!all.length) {
    throw Object.assign(new Error(`没有可用音源支持平台 ${platform}`), { code: 'NO_SOURCE' })
  }

  const ordered = orderSourcesForResolve(all, sourceId, platform)
  const errors: string[] = []
  const loaded: LoadedSource[] = []

  for (const source of ordered) {
    if (!source?.local_path) {
      errors.push(`${source?.name || source?.id || '?'}: 音源文件缺失`)
      continue
    }
    try {
      const handle = await loadLxSource(source.local_path)
      const available = handle.qualityMap[platform] || ['128k', '320k']
      if (!highest && !available.includes(preferred)) {
        errors.push(`${source.name}: 未宣称支持 ${preferred}，仍尝试取链`)
      }
      loaded.push({ source, handle, available })
    } catch (err: any) {
      const msg = err?.message || String(err)
      errors.push(`${source.name}: 加载失败（${msg}）`)
    }
  }

  if (!loaded.length) {
    const detail = errors.slice(0, 12).join(' | ') || '无可用音源'
    throw Object.assign(new Error(`取链失败：${detail}`), { code: 'NO_SOURCE' })
  }

  return { loaded, errors }
}

function noCandidateError(
  loaded: LoadedSource[],
  errors: string[],
  highest: boolean,
  excludedSkips: number,
) {
  const detail = errors.slice(0, 12).join(' | ') || '无详细错误'
  const skipHint = excludedSkips > 0 ? `（另跳过 ${excludedSkips} 个已知不可用的组合）` : ''
  return Object.assign(
    new Error(
      highest
        ? `取链失败${skipHint}（已轮询 ${loaded.length} 个音源并尝试降级）：${detail}`
        : `取链失败${skipHint}（已轮询 ${loaded.length} 个音源）：${detail}`,
    ),
    { code: 'GET_URL_FAILED' },
  )
}

/**
 * 取链：先按音质档位、再轮询全部音源，**返回第一个可用组合**。
 * - highest：每档试遍所有源，全失败再降档
 * - 固定音质：该档试遍所有源
 *
 * ⚠️ 「第一个可用」不等于「质量最好」—— 需要择优时请用 `listMusicUrlCandidates`。
 */
export async function resolveMusicUrl(input: ResolveMusicUrlInput): Promise<ResolveMusicUrlResult> {
  const preferred = input.quality || 'highest'
  const highest = isHighestQuality(preferred)
  const musicInfo = normalizeMusicInfo(input.musicInfo)

  const { loaded, errors } = await loadSourcesForResolve(
    input.platform,
    input.sourceId,
    preferred,
    highest,
  )
  const tiers = buildGlobalQualityLadder(
    preferred,
    loaded.map((l) => l.available),
  )

  let excludedSkips = 0
  for (const q of tiers) {
    for (const { source, handle, available } of loaded) {
      if (!shouldTryQualityOnSource(available, q, highest)) continue
      if (input.exclude?.has(`${source.id}@${q}`)) {
        excludedSkips++
        continue
      }
      try {
        const url = await handle.getMusicUrl(input.platform, musicInfo, q)
        return {
          url,
          quality: q,
          sourceId: source.id,
          sourceName: source.name,
        }
      } catch (err: any) {
        const msg = err?.message || String(err)
        errors.push(`${source.name}@${q}: ${msg}`)
      }
    }
  }

  throw noCandidateError(loaded, errors, highest, excludedSkips)
}

export type MusicUrlCandidate = ResolveMusicUrlResult

/**
 * 列出**多个**候选（不提前 return），供上层按实测码率择优。
 *
 * 为什么需要它：`resolveMusicUrl` 拿到第一个 URL 就返回，此后其它音源根本不会被探查 ——
 * 于是"第一个响应的音源"（可能是谎报 flac24bit 的 320k mp3）永远胜出。
 *
 * 顺序与 `resolveMusicUrl` 一致（档位从高到低、音源按优先级），最多收集 `limit` 个。
 */
export async function listMusicUrlCandidates(
  input: ResolveMusicUrlInput & {
    limit?: number
    /**
     * 每拿到一个候选就回调（可异步）。返回 `false` 表示**已满足收工条件**，立即停止列举。
     *
     * 存在的原因：列举阶段的每次 `getMusicUrl` 都是一次真实的源调用，
     * 15 个源全探一遍会让每首歌多花十几秒。把探测嵌进来就能提前收工。
     */
    onCandidate?: (candidate: MusicUrlCandidate) => Promise<boolean | void> | boolean | void
  },
): Promise<{
  candidates: MusicUrlCandidate[]
  errors: string[]
  loadedCount: number
  excludedSkips: number
  /** 是否提前停止（被 `limit` 或被 `onCandidate` 判定收工）—— 为 true 表示还有组合没探查 */
  truncated: boolean
}> {
  const preferred = input.quality || 'highest'
  const highest = isHighestQuality(preferred)
  const musicInfo = normalizeMusicInfo(input.musicInfo)
  const limit = Math.max(1, input.limit ?? 8)

  const { loaded, errors } = await loadSourcesForResolve(
    input.platform,
    input.sourceId,
    preferred,
    highest,
  )
  const tiers = buildGlobalQualityLadder(
    preferred,
    loaded.map((l) => l.available),
  )

  const candidates: MusicUrlCandidate[] = []
  let excludedSkips = 0
  let truncated = false

  outer: for (const q of tiers) {
    for (const { source, handle, available } of loaded) {
      if (candidates.length >= limit) {
        truncated = true
        break outer
      }
      if (!shouldTryQualityOnSource(available, q, highest)) continue
      if (input.exclude?.has(`${source.id}@${q}`)) {
        excludedSkips++
        continue
      }
      try {
        const url = await handle.getMusicUrl(input.platform, musicInfo, q)
        const candidate: MusicUrlCandidate = {
          url,
          quality: q,
          sourceId: source.id,
          sourceName: source.name,
        }
        candidates.push(candidate)
        if (input.onCandidate && (await input.onCandidate(candidate)) === false) {
          truncated = true
          break outer
        }
      } catch (err: any) {
        const msg = err?.message || String(err)
        errors.push(`${source.name}@${q}: ${msg}`)
      }
    }
  }

  return { candidates, errors, loadedCount: loaded.length, excludedSkips, truncated }
}

/** 供单测 / 旧调用：从 available 选一个首选音质 */
export function pickQuality(available: string[], preferred: string) {
  const attempts = buildQualityAttempts(available, preferred)
  return attempts[0] || (preferred === 'highest' ? '320k' : preferred)
}
