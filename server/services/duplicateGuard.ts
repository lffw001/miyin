import { statSync } from 'node:fs'
import { getDb } from '../utils/db'
import { buildDedupKey } from '#shared/trackKey'
import { isQualityInverted } from '#shared/quality'
import { getSettings } from './settingsService'

/**
 * 入队判重（曲库检索能力层的 C2 消费方）。
 *
 * ③B 已确认：命中范围仅 `completed` 与在途（`queued` / `running`），**不校验文件是否仍在磁盘**。
 * 文件存在性只在需要展示时按需 stat（`withFileStat`，供 duplicate-check 接口用，见 R-b）。
 */

/**
 * 判定原因：
 * - `exact`    命中同名记录（键本身即「主歌手 + 标题」的精确归一化结果）
 * - `inflight` 命中的是待下载 / 下载中的在途任务
 * - `batch`    同批次内重复，没有历史记录可指
 *
 * ⚠️ 曾经还有 `version`（归一化同键但原始标题不同，即版本差异）。
 * 自 2026-10-09 口径 v2 起归一化**保留括号内容**，版本差异在归一化层就被区分开，
 * 该态不再可能产生，已移除。
 */
export type DuplicateReason = 'exact' | 'inflight' | 'batch'

export type DuplicateCandidate = {
  title: string
  artist: string
  album?: string | null
  quality?: string | null
}

export type DuplicateExisting = {
  id: string
  title: string
  artist: string
  album: string | null
  platform: string
  quality: string | null
  status: string
  filePath: string | null
  fileSize: number | null
  /** 仅 `withFileStat` 时计算；否则为 `null`（未知），不误报「文件缺失」 */
  fileExists: boolean | null
  updatedAt: string
}

export type DuplicateMatch = {
  dedupKey: string
  reason: DuplicateReason
  /** 低音质覆盖高音质 → 默认拦截（④A）；受 `duplicateProtectQuality` 设置约束 */
  qualityInverted: boolean
  /** `reason === 'batch'` 时为 `null`（批内自重复，没有历史记录可指） */
  existing: DuplicateExisting | null
}

/** 判重命中范围 */
const DUPLICATE_STATUSES = ['completed', 'queued', 'running'] as const
/** `completed` 优先于在途；同状态取更新更近的 */
const STATUS_PRIORITY: Record<string, number> = { completed: 0, running: 1, queued: 2 }
/** `IN` 子句分块：防超大歌单打爆 SQL 变量数，同时保持「批量、非 N+1」 */
const KEY_CHUNK = 500

type TaskKeyRow = {
  id: string
  title: string
  artist: string
  album: string | null
  platform: string
  quality: string | null
  status: string
  file_path: string | null
  file_size: number | null
  updated_at: string
  dedup_key: string | null
}

function isBetterMatch(a: TaskKeyRow, b: TaskKeyRow) {
  const pa = STATUS_PRIORITY[a.status] ?? 9
  const pb = STATUS_PRIORITY[b.status] ?? 9
  if (pa !== pb) return pa < pb
  return a.updated_at > b.updated_at
}

function fileExistsOf(path: string | null): boolean | null {
  if (!path) return null
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 批量判重：一次（分块）查询搞定，返回 `dedupKey → 命中信息`。
 * 调用方用自己的 `buildDedupKey` 结果去 `Map.get` 即可，无需关心分块细节。
 */
export function findDuplicates(
  candidates: DuplicateCandidate[],
  opts?: { withFileStat?: boolean },
): Map<string, DuplicateMatch> {
  const result = new Map<string, DuplicateMatch>()
  const keys = [
    ...new Set(candidates.map((c) => buildDedupKey(c.artist, c.title)).filter(Boolean)),
  ]
  if (!keys.length) return result

  const qualityByKey = new Map<string, string | null>()
  for (const candidate of candidates) {
    const key = buildDedupKey(candidate.artist, candidate.title)
    if (!key) continue
    if (!qualityByKey.has(key)) qualityByKey.set(key, candidate.quality ?? null)
  }

  const best = new Map<string, TaskKeyRow>()
  const db = getDb()
  const statusPlaceholders = DUPLICATE_STATUSES.map(() => '?').join(',')
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    const chunk = keys.slice(i, i + KEY_CHUNK)
    const keyPlaceholders = chunk.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT id, title, artist, album, platform, quality, status,
                file_path, file_size, updated_at, dedup_key
         FROM download_tasks
         WHERE dedup_key IN (${keyPlaceholders})
           AND status IN (${statusPlaceholders})`,
      )
      .all(...chunk, ...DUPLICATE_STATUSES) as TaskKeyRow[]

    for (const row of rows) {
      const key = row.dedup_key
      if (!key) continue
      const prev = best.get(key)
      if (!prev || isBetterMatch(row, prev)) best.set(key, row)
    }
  }

  const protectQuality = getSettings().duplicateProtectQuality

  for (const [key, row] of best) {
    const isInflight = row.status === 'queued' || row.status === 'running'
    // 键即「主歌手 + 标题」，命中即为同名；版本差异在归一化层已区分（口径 v2）
    const reason: DuplicateReason = isInflight ? 'inflight' : 'exact'
    const incomingQuality = qualityByKey.get(key) ?? null

    result.set(key, {
      dedupKey: key,
      reason,
      qualityInverted: protectQuality && isQualityInverted(row.quality, incomingQuality),
      existing: {
        id: row.id,
        title: row.title,
        artist: row.artist,
        album: row.album,
        platform: row.platform,
        quality: row.quality,
        status: row.status,
        filePath: row.file_path,
        fileSize: row.file_size,
        fileExists: opts?.withFileStat ? fileExistsOf(row.file_path) : null,
        updatedAt: row.updated_at,
      },
    })
  }

  return result
}

/**
 * 批内自去重：同一批次内 `dedupKey` 相同的只保留首个，其余标为 `batch`。
 *
 * **必须在入库前调用** —— 否则两个歌单交叉提交时，同一批次就会自己撞自己，
 * 而彼时判重查询还看不到"本该由本批次插入的那一条"。
 */
export function dedupeWithinBatch(
  candidates: DuplicateCandidate[],
): Map<number, DuplicateMatch> {
  const firstIndexByKey = new Map<string, number>()
  const batchDuplicates = new Map<number, DuplicateMatch>()

  candidates.forEach((candidate, index) => {
    const key = buildDedupKey(candidate.artist, candidate.title)
    if (!key) return
    if (firstIndexByKey.has(key)) {
      batchDuplicates.set(index, {
        dedupKey: key,
        reason: 'batch',
        qualityInverted: false,
        existing: null,
      })
      return
    }
    firstIndexByKey.set(key, index)
  })

  return batchDuplicates
}

export type DuplicateGroupItem = {
  id: string
  title: string
  artist: string
  album: string | null
  platform: string
  quality: string | null
  status: string
  filePath: string | null
  fileSize: number | null
  updatedAt: string
}

export type DuplicateGroup = {
  dedupKey: string
  /** 以最新一条作为展示代表（同键 ⇒ 归一化标题一致，仅可能有大小写 / 全半角 / 空白差异） */
  label: string
  items: DuplicateGroupItem[]
}

type GroupRow = {
  id: string
  title: string
  artist: string
  album: string | null
  platform: string
  quality: string | null
  status: string
  file_path: string | null
  file_size: number | null
  updated_at: string
  dedup_key: string | null
}

/**
 * 已下载记录中「归一化后同键」的分组（C4：事后批量清理）。
 *
 * 只统计 `completed`：入队判重不会产生重复，重复只可能来自判重引入之前的历史数据。
 */
export function findDuplicateGroups(opts?: {
  limit?: number
  platform?: string
}): DuplicateGroup[] {
  const db = getDb()
  const limit = opts?.limit ?? 100
  const params: unknown[] = []
  const platformFilter = opts?.platform ? 'AND platform = ?' : ''
  if (opts?.platform) params.push(opts.platform)

  const keyRows = db
    .prepare(
      `SELECT dedup_key, count(*) AS c
       FROM download_tasks
       WHERE status = 'completed'
         AND dedup_key IS NOT NULL
         AND dedup_key <> ''
         ${platformFilter}
       GROUP BY dedup_key
       HAVING c > 1
       ORDER BY c DESC, MAX(updated_at) DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{ dedup_key: string; c: number }>

  if (!keyRows.length) return []

  const keyList = keyRows.map((r) => r.dedup_key)
  const placeholders = keyList.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT id, title, artist, album, platform, quality, status,
              file_path, file_size, updated_at, dedup_key
       FROM download_tasks
       WHERE status = 'completed' AND dedup_key IN (${placeholders})
       ORDER BY updated_at DESC`,
    )
    .all(...keyList) as GroupRow[]

  const byKey = new Map<string, DuplicateGroupItem[]>()
  for (const row of rows) {
    const key = row.dedup_key
    if (!key) continue
    const list = byKey.get(key) ?? []
    list.push({
      id: row.id,
      title: row.title,
      artist: row.artist,
      album: row.album,
      platform: row.platform,
      quality: row.quality,
      status: row.status,
      filePath: row.file_path,
      fileSize: row.file_size,
      updatedAt: row.updated_at,
    })
    byKey.set(key, list)
  }

  return keyRows
    .map((keyRow) => {
      const items = byKey.get(keyRow.dedup_key) ?? []
      const first = items[0]
      return {
        dedupKey: keyRow.dedup_key,
        label: first ? `${first.artist} - ${first.title}` : keyRow.dedup_key,
        items,
      }
    })
    .filter((group) => group.items.length > 1)
}
