import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../server/utils/db'
import { enqueueDownload } from '../server/services/downloadQueue'
import { findDuplicates, dedupeWithinBatch, findDuplicateGroups } from '../server/services/duplicateGuard'
import { saveSettings } from '../server/services/settingsService'
import { buildDedupKey, buildSearchText } from '#shared/trackKey'

declare global {
  var createError: (input: { statusCode?: number; statusMessage?: string; data?: unknown }) => Error
}

globalThis.createError = (input: { statusCode?: number; statusMessage?: string; data?: unknown }) => {
  const err = new Error(input.statusMessage || 'Error') as Error & {
    statusCode?: number
    data?: unknown
  }
  err.statusCode = input.statusCode
  err.data = input.data
  return err
}

describe('duplicateGuard', () => {
  let prevDataDir: string | undefined
  let workDir: string

  function seedTask(input: {
    title: string
    artist: string
    quality?: string
    status?: string
    filePath?: string | null
  }) {
    const task = enqueueDownload({
      title: input.title,
      artist: input.artist,
      platform: 'wy',
      quality: input.quality,
      musicInfo: { songmid: `${input.artist}-${input.title}` },
    })
    getDb()
      .prepare(
        `UPDATE download_tasks SET status = ?, quality = ?, file_path = ? WHERE id = ?`,
      )
      .run(
        input.status ?? 'completed',
        input.quality ?? 'flac',
        input.filePath === undefined ? null : input.filePath,
        task.id,
      )
    return task.id
  }

  beforeEach(() => {
    closeDb()
    prevDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'miyin-dupguard-test-'))
    workDir = mkdtempSync(join(tmpdir(), 'miyin-dupguard-files-'))
    getDb()
      .prepare(
        `INSERT INTO sources (id, name, url, local_path, enabled, status, platforms, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'ok', ?, datetime('now'), datetime('now'))`,
      )
      .run('src-1', '测试音源', 'http://example.com/s.js', '/tmp/fake.js', JSON.stringify(['wy']))
  })

  afterEach(() => {
    closeDb()
    if (prevDataDir) process.env.DATA_DIR = prevDataDir
    else delete process.env.DATA_DIR
  })

  it('命中已完成记录；不命中的不返回', () => {
    seedTask({ title: '稻香', artist: '周杰伦' })
    seedTask({ title: '晴天', artist: '周杰伦' })

    const hits = findDuplicates([
      { title: '稻香', artist: '周杰伦' },
      { title: '七里香', artist: '周杰伦' },
    ])

    expect(hits.size).toBe(1)
    const hit = hits.get(buildDedupKey('周杰伦', '稻香'))!
    expect(hit.existing?.title).toBe('稻香')
    expect(hit.existing?.status).toBe('completed')
  })

  it('全角 / 大小写 / 空格差异仍能命中（归一化生效）', () => {
    seedTask({ title: '稻香', artist: '周杰伦' })
    const hits = findDuplicates([{ title: ' 稻香 ', artist: '周杰伦' }])
    expect(hits.size).toBe(1)
  })

  it('reason：完全同名 → exact', () => {
    seedTask({ title: '稻香', artist: '周杰伦' })

    const exact = findDuplicates([{ title: '稻香', artist: '周杰伦' }])
    expect(exact.get(buildDedupKey('周杰伦', '稻香'))!.reason).toBe('exact')
  })

  it('口径 v2：版本差异**不**判重，允许同曲多版本共存', () => {
    seedTask({ title: '稻香', artist: '周杰伦' })

    // 这些都是不同版本 → 不同键 → 不命中（用户的明确诉求）
    for (const variant of ['稻香 (Live)', '稻香（Demo）', '稻香（藏声版）', '稻香（钢琴版）']) {
      const hits = findDuplicates([{ title: variant, artist: '周杰伦' }])
      expect(hits.size, `${variant} 不应被判为已存在`).toBe(0)
    }
  })

  it('同一版本的写法差异仍判重（全角 / 空格 / 大小写）', () => {
    seedTask({ title: '稻香 (Live)', artist: '周杰伦' })
    const hits = findDuplicates([{ title: '稻香（live）', artist: '周杰伦' }])
    expect(hits.size).toBe(1)
    expect(hits.values().next().value?.reason).toBe('exact')
  })

  it('reason：在途（queued / running）→ inflight', () => {
    seedTask({ title: '稻香', artist: '周杰伦', status: 'queued' })
    expect(findDuplicates([{ title: '稻香', artist: '周杰伦' }]).values().next().value?.reason).toBe(
      'inflight',
    )

    getDb().prepare(`UPDATE download_tasks SET status = 'running'`).run()
    expect(findDuplicates([{ title: '稻香', artist: '周杰伦' }]).values().next().value?.reason).toBe(
      'inflight',
    )
  })

  it('同一首既有 completed 又在途时，优先取 completed', () => {
    seedTask({ title: '稻香', artist: '周杰伦', status: 'completed' })
    seedTask({ title: '稻香', artist: '周杰伦', status: 'queued' })

    const hit = findDuplicates([{ title: '稻香', artist: '周杰伦' }]).values().next().value!
    expect(hit.reason).toBe('exact')
    expect(hit.existing?.status).toBe('completed')
  })

  it('failed / cancelled 记录不命中（没成功过不算"已有"）', () => {
    seedTask({ title: '稻香', artist: '周杰伦', status: 'failed' })
    seedTask({ title: '晴天', artist: '周杰伦', status: 'cancelled' })
    expect(findDuplicates([
      { title: '稻香', artist: '周杰伦' },
      { title: '晴天', artist: '周杰伦' },
    ]).size).toBe(0)
  })

  it('默认不校验文件；withFileStat 时才 stat 并区分存在与否', () => {
    const realFile = join(workDir, 'exists.flac')
    writeFileSync(realFile, 'fLaC')
    seedTask({ title: '稻香', artist: '周杰伦', filePath: realFile })
    seedTask({ title: '晴天', artist: '周杰伦', filePath: join(workDir, 'missing.flac') })
    seedTask({ title: '七里香', artist: '周杰伦', filePath: null })

    const plain = findDuplicates([
      { title: '稻香', artist: '周杰伦' },
      { title: '晴天', artist: '周杰伦' },
    ])
    for (const hit of plain.values()) {
      expect(hit.existing?.fileExists).toBeNull()
    }
    // 不 stat 也照样命中（③B）
    expect(plain.size).toBe(2)

    const withStat = findDuplicates(
      [
        { title: '稻香', artist: '周杰伦' },
        { title: '晴天', artist: '周杰伦' },
        { title: '七里香', artist: '周杰伦' },
      ],
      { withFileStat: true },
    )
    expect(withStat.get(buildDedupKey('周杰伦', '稻香'))!.existing?.fileExists).toBe(true)
    expect(withStat.get(buildDedupKey('周杰伦', '晴天'))!.existing?.fileExists).toBe(false)
    expect(withStat.get(buildDedupKey('周杰伦', '七里香'))!.existing?.fileExists).toBeNull()
  })

  it('音质倒挂：已有 flac + 候选 320k → 拦截；关闭保护则不拦', () => {
    seedTask({ title: '稻香', artist: '周杰伦', quality: 'flac' })

    const protectedHit = findDuplicates([{ title: '稻香', artist: '周杰伦', quality: '320k' }])
    expect(protectedHit.values().next().value?.qualityInverted).toBe(true)

    // 升级不算倒挂
    seedTask({ title: '晴天', artist: '周杰伦', quality: '320k' })
    expect(
      findDuplicates([{ title: '晴天', artist: '周杰伦', quality: 'flac' }]).values().next().value
        ?.qualityInverted,
    ).toBe(false)

    // 关键回归：192k 与 320k 的相对关系必须基于 QUALITY_LADDER
    seedTask({ title: '七里香', artist: '周杰伦', quality: '320k' })
    expect(
      findDuplicates([{ title: '七里香', artist: '周杰伦', quality: '192k' }]).values().next().value
        ?.qualityInverted,
    ).toBe(true)

    saveSettings({ duplicateProtectQuality: false })
    expect(
      findDuplicates([{ title: '稻香', artist: '周杰伦', quality: '320k' }]).values().next().value
        ?.qualityInverted,
    ).toBe(false)
  })

  it('候选档位未知（highest / 缺省）时不判定倒挂', () => {
    seedTask({ title: '稻香', artist: '周杰伦', quality: 'flac' })
    expect(
      findDuplicates([{ title: '稻香', artist: '周杰伦', quality: 'highest' }]).values().next().value
        ?.qualityInverted,
    ).toBe(false)
    expect(
      findDuplicates([{ title: '稻香', artist: '周杰伦' }]).values().next().value?.qualityInverted,
    ).toBe(false)
  })

  it(
    '超过分块阈值（500）时仍完整命中，不丢结果',
    () => {
      const total = 600
      // 直插：本用例只验证查询分块，走 enqueueDownload 会连带 worker/事件开销（600 次 >40s）
      const db = getDb()
      const insert = db.prepare(
        `INSERT INTO download_tasks (
           id, title, artist, platform, status, progress, quality,
           dedup_key, search_text, created_at, updated_at
         ) VALUES (?, ?, ?, 'wy', 'completed', 1, 'flac', ?, ?, datetime('now'), datetime('now'))`,
      )
      db.transaction(() => {
        for (let i = 0; i < total; i++) {
          const title = `曲目${i}`
          const artist = '批量歌手'
          insert.run(
            `bulk-${i}`,
            title,
            artist,
            buildDedupKey(artist, title),
            buildSearchText({ title, artist }),
          )
        }
      })()

      const candidates = Array.from({ length: total }, (_, i) => ({
        title: `曲目${i}`,
        artist: '批量歌手',
      }))
      const hits = findDuplicates(candidates)

      expect(hits.size).toBe(total)
      expect(hits.get(buildDedupKey('批量歌手', '曲目0'))?.existing).toBeTruthy()
      expect(hits.get(buildDedupKey('批量歌手', `曲目${total - 1}`))?.existing).toBeTruthy()
    },
    20000,
  )

  it('空候选与全空键直接返回空，不查库', () => {
    seedTask({ title: '稻香', artist: '周杰伦' })
    expect(findDuplicates([]).size).toBe(0)
    expect(findDuplicates([{ title: '', artist: '' }]).size).toBe(0)
  })

  describe('dedupeWithinBatch', () => {
    it('同批次内相同 dedupKey 只保留首个，其余标为 batch', () => {
      const dupes = dedupeWithinBatch([
        { title: '稻香', artist: '周杰伦' },
        { title: '晴天', artist: '周杰伦' },
        { title: '稻香 (Live)', artist: '周杰伦' }, // 版本不同 → 不算批内重复
        { title: ' 稻香 ', artist: '周杰伦' }, // 与首个同键
        { title: '稻香（demo）', artist: '周杰伦' }, // 版本不同 → 不算
      ])
      expect([...dupes.keys()]).toEqual([3])
      for (const match of dupes.values()) {
        expect(match.reason).toBe('batch')
        expect(match.existing).toBeNull()
      }
    })

    it('不同歌手不算批内重复', () => {
      const dupes = dedupeWithinBatch([
        { title: '稻香', artist: '周杰伦' },
        { title: '稻香', artist: '某翻唱歌手' },
      ])
      expect(dupes.size).toBe(0)
    })
  })

  describe('findDuplicateGroups（C4 事后清理）', () => {
    it('归一化同键的多条已完成记录聚成一组（同版本写法差异才成组）', () => {
      seedTask({ title: '稻香', artist: '周杰伦' })
      seedTask({ title: '稻香 (Live)', artist: '周杰伦' }) // 不同版本 → 独立
      seedTask({ title: ' 稻香 ', artist: '周杰伦' }) // 与首个同键
      seedTask({ title: '晴天', artist: '周杰伦' })

      const groups = findDuplicateGroups()
      expect(groups.length).toBe(1)
      expect(groups[0]!.items.length).toBe(2)
      expect(groups[0]!.items.map((i) => i.title).sort()).toEqual([' 稻香 ', '稻香'])
    })

    it('单条不成组；不同歌手不成组', () => {
      seedTask({ title: '晴天', artist: '周杰伦' })
      seedTask({ title: '稻香', artist: '周杰伦' })
      seedTask({ title: '稻香', artist: '某翻唱歌手' })
      expect(findDuplicateGroups()).toEqual([])
    })

    it('failed / cancelled / 在途记录不参与（只有已完成才算"占着文件"）', () => {
      seedTask({ title: '稻香', artist: '周杰伦', status: 'completed' })
      seedTask({ title: '稻香', artist: '周杰伦', status: 'failed' })
      seedTask({ title: '稻香', artist: '周杰伦', status: 'cancelled' })
      seedTask({ title: '稻香', artist: '周杰伦', status: 'queued' })
      expect(findDuplicateGroups()).toEqual([])
    })

    it('支持按平台过滤，且按重复条数降序', () => {
      seedTask({ title: 'A', artist: 'X' })
      seedTask({ title: 'A', artist: 'X' })
      seedTask({ title: 'A', artist: 'X' })
      seedTask({ title: 'B', artist: 'Y' })
      seedTask({ title: 'B', artist: 'Y' })
      // 另起一个平台，不应混入
      getDb()
        .prepare(`UPDATE download_tasks SET platform = 'tx' WHERE artist = 'Y'`)
        .run()

      const wy = findDuplicateGroups({ platform: 'wy' })
      expect(wy.length).toBe(1)
      expect(wy[0]!.items.length).toBe(3)

      const all = findDuplicateGroups()
      expect(all.length).toBe(2)
      expect(all[0]!.items.length).toBe(3) // 条数多的在前
    })

    it('limit 限制分组数', () => {
      for (let g = 0; g < 5; g++) {
        seedTask({ title: `组${g}`, artist: '歌手' })
        seedTask({ title: `组${g}`, artist: '歌手' })
      }
      expect(findDuplicateGroups({ limit: 2 }).length).toBe(2)
      expect(findDuplicateGroups().length).toBe(5)
    })
  })
})
