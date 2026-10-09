import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../server/utils/db'
import {
  enqueueDownload,
  enqueueDownloadChecked,
  batchEnqueueDownload,
  cancelTask,
  getTask,
  listTasks,
} from '../server/services/downloadQueue'
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

describe('入队判重（C2）', () => {
  let prevDataDir: string | undefined
  let prevDownloadDir: string | undefined
  let downloadDir: string

  /** 造一条已完成的下载记录，并在磁盘上放一个真实文件 */
  function seedCompleted(title: string, artist = '周杰伦', quality = 'flac') {
    const task = enqueueDownload({
      title,
      artist,
      platform: 'wy',
      musicInfo: { songmid: `${artist}-${title}` },
    })
    const file = join(downloadDir, `${artist} - ${title}.${quality === 'flac' ? 'flac' : 'mp3'}`)
    writeFileSync(file, 'OLD')
    getDb()
      .prepare(
        `UPDATE download_tasks SET status = 'completed', quality = ?, file_path = ?, dedup_key = ?, search_text = ? WHERE id = ?`,
      )
      .run(quality, file, buildDedupKey(artist, title), buildSearchText({ title, artist }), task.id)
    return { id: task.id, file }
  }

  function seedQueuedRaw(opts: {
    title: string
    artist: string
    musicInfo?: Record<string, unknown>
  }) {
    const id = `raw-${Math.random().toString(36).slice(2)}`
    getDb()
      .prepare(
        `INSERT INTO download_tasks (
           id, title, artist, platform, source_id, quality, status, progress,
           music_info_json, dedup_key, search_text, created_at, updated_at
         ) VALUES (?, ?, ?, 'wy', 'src-1', 'flac', 'queued', 0, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(
        id,
        opts.title,
        opts.artist,
        JSON.stringify(opts.musicInfo ?? { songmid: 'x' }),
        buildDedupKey(opts.artist, opts.title),
        buildSearchText({ title: opts.title, artist: opts.artist }),
      )
    return id
  }

  function taskCount() {
    return (getDb().prepare(`SELECT count(*) AS c FROM download_tasks`).get() as { c: number }).c
  }

  beforeEach(() => {
    closeDb()
    prevDataDir = process.env.DATA_DIR
    prevDownloadDir = process.env.DOWNLOAD_DIR
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'miyin-endup-data-'))
    downloadDir = mkdtempSync(join(tmpdir(), 'miyin-endup-dl-'))
    process.env.DOWNLOAD_DIR = downloadDir

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
    if (prevDownloadDir) process.env.DOWNLOAD_DIR = prevDownloadDir
    else delete process.env.DOWNLOAD_DIR
  })

  it('显式 skip：不入库，返回 duplicate 信息', () => {
    seedCompleted('稻香')
    const before = taskCount()

    const outcome = enqueueDownloadChecked(
      { title: '稻香', artist: '周杰伦', platform: 'wy', musicInfo: { songmid: 'new' } },
      { action: 'skip' },
    )

    expect(outcome.kind).toBe('skipped')
    if (outcome.kind === 'skipped') {
      expect(outcome.duplicate.reason).toBe('exact')
      expect(outcome.duplicate.existing?.title).toBe('稻香')
    }
    expect(taskCount()).toBe(before)
  })

  it('显式 replace：UPDATE 既有行（复用同一 id），不新增行且未删旧文件', () => {
    const seeded = seedCompleted('稻香')
    const before = taskCount()

    const outcome = enqueueDownloadChecked(
      { title: '稻香', artist: '周杰伦', platform: 'wy', musicInfo: { songmid: 'new' } },
      { action: 'replace' },
    )

    expect(outcome.kind).toBe('replaced')
    if (outcome.kind === 'replaced') {
      expect(outcome.replacedFrom).toBe(seeded.id)
      expect(outcome.task.id).toBe(seeded.id)
      // 复用同一记录 → 计数不变
      expect(taskCount()).toBe(before)
      expect(outcome.task.status).toBe('queued')
      // 旧路径被记进 music_info_json，待新文件落地后才清理（R-d）
      const info = JSON.parse(outcome.task.music_info_json || '{}')
      expect(info.__replaceOldFile).toBe(seeded.file)
      // 关键：替换开始前旧文件必须还在
      expect(existsSync(seeded.file)).toBe(true)
    }
  })

  it('显式 enqueue：强制插入新任务（等价当前版本行为，会覆盖同名文件）', () => {
    seedCompleted('稻香')
    const before = taskCount()

    const outcome = enqueueDownloadChecked(
      { title: '稻香', artist: '周杰伦', platform: 'wy', musicInfo: { songmid: 'new' } },
      { action: 'enqueue' },
    )

    expect(outcome.kind).toBe('enqueued')
    expect(taskCount()).toBe(before + 1)
  })

  it('无重复时正常入队', () => {
    seedCompleted('稻香')
    const before = taskCount()

    const outcome = enqueueDownloadChecked({
      title: '晴天',
      artist: '周杰伦',
      platform: 'wy',
      musicInfo: { songmid: 'qing' },
    })

    expect(outcome.kind).toBe('enqueued')
    expect(taskCount()).toBe(before + 1)
  })

  it('prompt 策略且未给裁决时，服务端回落 skip —— 绝不静默覆盖（D3）', () => {
    seedCompleted('稻香')
    const before = taskCount()

    const outcome = enqueueDownloadChecked({
      title: '稻香',
      artist: '周杰伦',
      platform: 'wy',
      musicInfo: { songmid: 'new' },
    })

    expect(outcome.kind).toBe('skipped')
    expect(taskCount()).toBe(before)
  })

  it('策略 skip / replace 时无需客户端裁决即可生效（「不再提醒」路径）', () => {
    seedCompleted('稻香')

    saveSettings({ duplicatePolicy: 'skip' })
    expect(
      enqueueDownloadChecked({
        title: '稻香',
        artist: '周杰伦',
        platform: 'wy',
        musicInfo: { songmid: 'a' },
      }).kind,
    ).toBe('skipped')

    saveSettings({ duplicatePolicy: 'replace' })
    expect(
      enqueueDownloadChecked({
        title: '稻香',
        artist: '周杰伦',
        platform: 'wy',
        musicInfo: { songmid: 'b' },
      }).kind,
    ).toBe('replaced')
  })

  it('关闭判重开关后行为回到当前版本：重复也照常插入', () => {
    seedCompleted('稻香')
    saveSettings({ duplicateCheckEnabled: false })
    const before = taskCount()

    const outcome = enqueueDownloadChecked({
      title: '稻香',
      artist: '周杰伦',
      platform: 'wy',
      musicInfo: { songmid: 'new' },
    })

    expect(outcome.kind).toBe('enqueued')
    expect(taskCount()).toBe(before + 1)
  })

  it('在途任务也算重复（防同一首并发入队两份）', () => {
    seedQueuedRaw({ title: '稻香', artist: '周杰伦' })
    const outcome = enqueueDownloadChecked(
      { title: '稻香', artist: '周杰伦', platform: 'wy', musicInfo: { songmid: 'new' } },
      { action: 'skip' },
    )
    expect(outcome.kind).toBe('skipped')
    if (outcome.kind === 'skipped') expect(outcome.duplicate.reason).toBe('inflight')
  })

  it('策略 replace 也不得绕过音质保护：低覆盖高仍被拦下（④A）', () => {
    const seeded = seedCompleted('稻香', '周杰伦', 'flac')
    saveSettings({ duplicatePolicy: 'replace' })

    const outcome = enqueueDownloadChecked({
      title: '稻香',
      artist: '周杰伦',
      platform: 'wy',
      quality: '320k',
      musicInfo: { songmid: 'low' },
    })

    expect(outcome.kind).toBe('skipped')
    if (outcome.kind === 'skipped') expect(outcome.duplicate.qualityInverted).toBe(true)
    // 既有记录未被改动，且记录未被清空
    const after = getTask(seeded.id)!
    expect(after.status).toBe('completed')
    expect(after.quality).toBe('flac')
    expect(after.file_path).toBe(seeded.file)

    // 关闭保护后放行
    saveSettings({ duplicateProtectQuality: false })
    expect(
      enqueueDownloadChecked({
        title: '稻香',
        artist: '周杰伦',
        platform: 'wy',
        quality: '320k',
        musicInfo: { songmid: 'low2' },
      }).kind,
    ).toBe('replaced')
  })

  it('替换任务被取消后，记录指回旧文件（避免"文件还在、记录说没有"）', () => {
    const oldFile = join(downloadDir, '周杰伦 - 稻香 (Live).flac')
    writeFileSync(oldFile, 'OLD-LIVE')
    const id = seedQueuedRaw({
      title: '稻香',
      artist: '周杰伦',
      musicInfo: { songmid: 'x', __replaceOldFile: oldFile },
    })
    // 替换开始：file_path 已被置空
    getDb().prepare(`UPDATE download_tasks SET file_path = NULL WHERE id = ?`).run(id)

    cancelTask(id)

    const after = getTask(id)!
    expect(after.status).toBe('cancelled')
    expect(after.file_path).toBe(oldFile)
    expect(existsSync(oldFile)).toBe(true)
  })

  describe('批量入队', () => {
    function batchItems(titles: string[]) {
      return titles.map((title) => ({
        title,
        artist: '周杰伦',
        platform: 'wy',
        musicInfo: { songmid: title },
      }))
    }

    it('批内自去重：同批次相同歌曲只入队一次，其余标 skipped', () => {
      const res = batchEnqueueDownload(
        batchItems(['稻香', '晴天', '稻香', '稻香 (Live)']),
        { silent: true },
      )

      expect(res.total).toBe(4)
      // 口径 v2：`稻香 (Live)` 是另一个版本，不再被判为重复
      expect(res.enqueued).toBe(3)
      expect(res.skipped).toBe(1)
      const skipped = res.results.filter((r) => r.skipped)
      expect(skipped.length).toBe(1)
      expect(skipped[0]!.duplicate?.reason).toBe('batch')
      expect(listTasks({ tab: 'running' }).length).toBe(3)
    })

    it('同曲不同版本可同时入队（口径 v2 的端到端确认）', () => {
      const res = batchEnqueueDownload(
        batchItems(['稻香', '稻香 (Live)', '稻香（Demo）', '稻香（钢琴版）']),
        { silent: true },
      )
      expect(res.enqueued).toBe(4)
      expect(res.skipped).toBe(0)
    })

    it('命中历史记录：默认跳过并回报 duplicate；策略 replace 时更新既有行', () => {
      const seeded = seedCompleted('稻香')
      const before = taskCount()

      const skipped = batchEnqueueDownload(batchItems(['稻香', '晴天']), { silent: true })
      expect(skipped.enqueued).toBe(1)
      expect(skipped.skipped).toBe(1)
      const hit = skipped.results.find((r) => r.skipped)!
      expect(hit.duplicate?.reason).toBe('exact')
      expect(hit.duplicate?.existing?.id).toBe(seeded.id)

      saveSettings({ duplicatePolicy: 'replace' })
      const replaced = batchEnqueueDownload(batchItems(['稻香']), { silent: true })
      expect(replaced.replaced).toBe(1)
      expect(replaced.enqueued).toBe(0)
      expect(replaced.results[0]!.id).toBe(seeded.id)
      // 复用既有行 → 只多出「晴天」一条
      expect(taskCount()).toBe(before + 1)
    })

    it('关闭判重后批量照常全部入队', () => {
      seedCompleted('稻香')
      saveSettings({ duplicateCheckEnabled: false })
      const res = batchEnqueueDownload(batchItems(['稻香', '晴天', '晴天']), { silent: true })
      expect(res.enqueued).toBe(3)
      expect(res.skipped).toBe(0)
    })

    it('跨分块（>200）仍能正确判重与批内去重', () => {
      const total = 250
      const titles = Array.from({ length: total }, (_, i) => `曲目${i}`)
      // 后半段重复前半段，跨越 200 分块边界
      const items = batchItems([...titles, ...titles.slice(0, 60)])

      const res = batchEnqueueDownload(items, { silent: true })
      expect(res.total).toBe(total + 60)
      expect(res.enqueued).toBe(total)
      expect(res.skipped).toBe(60)
    })

    it('质量非法与无可用音源仍按原有失败语义回报', () => {
      const res = batchEnqueueDownload(
        [
          { title: 'A', artist: 'X', platform: 'wy', quality: 'flac32bit', musicInfo: {} },
          { title: 'B', artist: 'X', platform: 'kg', musicInfo: {} },
        ],
        { silent: true },
      )
      expect(res.enqueued).toBe(0)
      expect(res.results[0]!.ok).toBe(false)
      expect(res.results[0]!.error).toContain('不支持的音质')
      expect(res.results[1]!.ok).toBe(false)
      expect(res.results[1]!.error).toContain('没有可用音源')
    })
  })
})
