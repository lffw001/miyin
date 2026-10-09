import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../server/utils/db'
import { listTasks, getTaskStats } from '../server/services/downloadQueue'
import { buildDedupKey, buildSearchText } from '#shared/trackKey'

declare global {
  var createError: (input: { statusCode?: number; statusMessage?: string; data?: unknown }) => Error
}

globalThis.createError = (input) => {
  const err = new Error(input.statusMessage || 'Error') as Error & {
    statusCode?: number
    data?: unknown
  }
  err.statusCode = input.statusCode
  err.data = input.data
  return err
}

describe('下载历史增强筛选（平台 / 音质 / 入队日期）', () => {
  let prevDataDir: string | undefined

  type SeedRow = {
    title: string
    artist?: string
    platform?: string
    quality?: string
    status?: string
    /** 入队时间（ISO，直接写库以便测日期筛选） */
    createdAt?: string
  }

  function seed(rows: SeedRow[]) {
    const db = getDb()
    const insert = db.prepare(
      `INSERT INTO download_tasks (
         id, title, artist, album, platform, quality, status, progress,
         dedup_key, search_text, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    db.transaction(() => {
      rows.forEach((row, index) => {
        const artist = row.artist ?? '周杰伦'
        const createdAt = row.createdAt ?? '2026-10-01T00:00:00.000Z'
        insert.run(
          `f-${index}`,
          row.title,
          artist,
          row.platform ?? 'wy',
          row.quality ?? 'flac',
          row.status ?? 'completed',
          buildDedupKey(artist, row.title),
          buildSearchText({ title: row.title, artist }),
          createdAt,
          createdAt,
        )
      })
    })()
  }

  function titles(rows: Array<{ title: string }>) {
    return rows.map((r) => r.title).sort()
  }

  beforeEach(() => {
    closeDb()
    prevDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'miyin-filters-test-'))
    getDb()
  })

  afterEach(() => {
    closeDb()
    if (prevDataDir) process.env.DATA_DIR = prevDataDir
    else delete process.env.DATA_DIR
  })

  it('平台筛选', () => {
    seed([
      { title: '稻香', platform: 'wy' },
      { title: '晴天', platform: 'tx' },
      { title: '七里香', platform: 'wy' },
    ])
    expect(titles(listTasks({ tab: 'completed', platform: 'wy' }))).toEqual(['七里香', '稻香'])
    expect(titles(listTasks({ tab: 'completed', platform: 'tx' }))).toEqual(['晴天'])
    // 多个平台用逗号分隔无效值时应返回空
    expect(listTasks({ tab: 'completed', platform: 'kg' })).toEqual([])
  })

  it('音质筛选包含 192k（不能被 ALLOWED_QUALITIES 的缺口漏掉）', () => {
    seed([
      { title: 'A', quality: 'flac' },
      { title: 'B', quality: '192k' },
      { title: 'C', quality: '320k' },
    ])
    expect(titles(listTasks({ tab: 'completed', quality: '192k' }))).toEqual(['B'])
    expect(titles(listTasks({ tab: 'completed', quality: 'flac' }))).toEqual(['A'])
  })

  it('入队日期筛选为闭区间（含起止当天）', () => {
    seed([
      { title: '九月末', createdAt: '2026-09-30T23:00:00.000Z' },
      { title: '十月一', createdAt: '2026-10-01T00:00:00.000Z' },
      { title: '十月五', createdAt: '2026-10-05T12:00:00.000Z' },
      { title: '十月八', createdAt: '2026-10-08T23:59:00.000Z' },
    ])

    // titles() 用默认 sort（UTF-16 码位）：一 < 五 < 八
    expect(titles(listTasks({ tab: 'completed', since: '2026-10-01' }))).toEqual([
      '十月一',
      '十月五',
      '十月八',
    ])
    // until 含当天：10-05 当天的记录必须在内，10-08 不在
    expect(titles(listTasks({ tab: 'completed', until: '2026-10-05' }))).toEqual([
      '九月末',
      '十月一',
      '十月五',
    ])
    expect(titles(listTasks({ tab: 'completed', since: '2026-10-01', until: '2026-10-05' }))).toEqual(
      ['十月一', '十月五'],
    )
  })

  it('非法日期被忽略，不产生过滤也不抛错', () => {
    seed([{ title: '稻香' }, { title: '晴天' }])
    expect(listTasks({ tab: 'completed', since: 'not-a-date' }).length).toBe(2)
    expect(listTasks({ tab: 'completed', until: '2026/10/05' }).length).toBe(2)
  })

  it('关键词 + 平台 + 音质 + 日期 可叠加', () => {
    seed([
      { title: '稻香', platform: 'wy', quality: 'flac', createdAt: '2026-10-02T00:00:00.000Z' },
      { title: '稻香 (Live)', platform: 'wy', quality: '320k', createdAt: '2026-10-03T00:00:00.000Z' },
      { title: '稻香', platform: 'tx', quality: 'flac', createdAt: '2026-10-03T00:00:00.000Z' },
      { title: '晴天', platform: 'wy', quality: 'flac', createdAt: '2026-10-03T00:00:00.000Z' },
    ])

    const hit = listTasks({
      tab: 'completed',
      q: '稻香',
      platform: 'wy',
      quality: 'flac',
      since: '2026-10-01',
      until: '2026-10-02',
    })
    expect(titles(hit)).toEqual(['稻香'])
  })

  it('带筛选时分页 total 与列表一致（分页 total 回归锚点）', () => {
    seed([
      { title: '稻香 A', platform: 'wy' },
      { title: '稻香 B', platform: 'wy' },
      { title: '稻香 C', platform: 'wy' },
      { title: '晴天', platform: 'tx' },
    ])
    const filters = { platform: 'wy' } as const

    const rows = listTasks({ tab: 'completed', ...filters, page: 1, pageSize: 2 })
    const stats = getTaskStats(filters)

    expect(rows.length).toBe(2)
    expect(stats.completed).toBe(3)
    // 不带平台过滤时是全量，证明筛选确实参与了统计
    expect(getTaskStats({}).completed).toBe(4)
  })

  it('筛选同样作用于 tab 角标统计', () => {
    seed([
      { title: 'A', platform: 'wy', status: 'completed' },
      { title: 'B', platform: 'wy', status: 'failed' },
      { title: 'C', platform: 'tx', status: 'completed' },
    ])
    expect(getTaskStats({ platform: 'wy' }).completed).toBe(1)
    expect(getTaskStats({ platform: 'wy' }).failed).toBe(1)
    expect(getTaskStats({ platform: 'tx' }).failed).toBe(0)
  })

  describe('跨 tab 检索（搜索结果覆盖所有分类）', () => {
    beforeEach(() => {
      seed([
        { title: '稻香', status: 'queued' },
        { title: '稻香 (Live)', status: 'running' },
        { title: '稻香（Demo）', status: 'completed' },
        { title: '稻香（钢琴版）', status: 'failed' },
        { title: '稻香（藏声版）', status: 'cancelled' },
        { title: '晴天', status: 'completed' },
      ])
    })

    it('不传 tab / status 时返回全部分类的命中', () => {
      const rows = listTasks({ q: '稻香' })
      expect(rows.length).toBe(5)
      // 用状态集合校验，避免中文排序干扰
      expect(new Set(rows.map((r) => r.status))).toEqual(
        new Set(['queued', 'running', 'completed', 'failed', 'cancelled']),
      )
      // 未命中关键词的不该混进来
      expect(rows.some((r) => r.title === '晴天')).toBe(false)
    })

    it('getTaskStats 给出各分类命中数，可直接用于「归属分类」展示', () => {
      const stats = getTaskStats({ q: '稻香' })
      expect(stats.queued).toBe(1)
      expect(stats.running).toBe(1)
      expect(stats.completed).toBe(1)
      expect(stats.failed).toBe(1)
      expect(stats.cancelled).toBe(1)
      // 三个 tab 角标之和 = 命中总数
      expect(stats.running + stats.queued + stats.completed + stats.failed + stats.cancelled).toBe(5)
    })

    it('传 tab 时仍按分类收窄（「点分类限定」走这条路径）', () => {
      expect(listTasks({ tab: 'completed', q: '稻香' }).length).toBe(1)
      // 「失败」分类含 failed + cancelled
      expect(listTasks({ tab: 'failed', q: '稻香' }).length).toBe(2)
      // 「进行中」分类含 queued + running
      expect(listTasks({ tab: 'running', q: '稻香' }).length).toBe(2)
    })

    it('跨 tab 检索与增强筛选可叠加', () => {
      const rows = listTasks({ q: '稻香', quality: 'flac', status: undefined })
      // seed 默认音质是 flac，全部命中
      expect(rows.length).toBe(5)

      getDb()
        .prepare(`UPDATE download_tasks SET quality = '320k' WHERE title = '稻香（钢琴版）'`)
        .run()
      const filtered = listTasks({ q: '稻香', quality: 'flac' })
      expect(filtered.length).toBe(4)
      expect(titles(filtered)).not.toContain('稻香（钢琴版）')
    })
  })
})
