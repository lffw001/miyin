import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../server/utils/db'
import {
  enqueueDownload,
  batchEnqueueDownload,
  listTasks,
  getTaskStats,
} from '../server/services/downloadQueue'
import { buildDedupKey, buildSearchText, matchesTrackKeyword } from '#shared/trackKey'

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

describe('下载历史检索', () => {
  let prevDataDir: string | undefined

  type SeedTrack = {
    title: string
    artist: string
    album?: string
    batchId?: string
    playlistUrl?: string
  }

  function enqueueCompleted(track: SeedTrack) {
    const task = enqueueDownload({
      title: track.title,
      artist: track.artist,
      album: track.album,
      platform: 'wy',
      musicInfo: { songmid: `${track.artist}-${track.title}` },
      batchId: track.batchId,
      playlistUrl: track.playlistUrl,
    })
    getDb()
      .prepare(`UPDATE download_tasks SET status = 'completed' WHERE id = ?`)
      .run(task.id)
    return task.id
  }

  function titleOf(rows: Array<{ title: string }>) {
    return rows.map((r) => r.title).sort()
  }

  beforeEach(() => {
    closeDb()
    prevDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'miyin-search-test-'))
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

  it('入队时写入 dedup_key / search_text（非回填路径）', () => {
    const id = enqueueCompleted({ title: '稻香 (Live)', artist: '周杰伦', album: '魔杰座' })
    const row = getDb()
      .prepare(`SELECT dedup_key, search_text FROM download_tasks WHERE id = ?`)
      .get(id) as { dedup_key: string; search_text: string }

    expect(row.dedup_key).toBe(buildDedupKey('周杰伦', '稻香 (Live)'))
    expect(row.search_text).toBe(
      buildSearchText({ title: '稻香 (Live)', artist: '周杰伦', album: '魔杰座' }),
    )
  })

  it('批量入队同样写入检索键', () => {
    const res = batchEnqueueDownload(
      [
        { title: '晴天', artist: '周杰伦', platform: 'wy', musicInfo: { songmid: 'a' } },
        { title: '七里香', artist: '周杰伦', platform: 'wy', musicInfo: { songmid: 'b' } },
      ],
      { silent: true },
    )
    expect(res.enqueued).toBe(2)

    const nulls = getDb()
      .prepare(`SELECT count(*) AS c FROM download_tasks WHERE dedup_key IS NULL OR search_text IS NULL`)
      .get() as { c: number }
    expect(nulls.c).toBe(0)
  })

  it('多关键词 AND 检索，词序无关', () => {
    enqueueCompleted({ title: '稻香', artist: '周杰伦' })
    enqueueCompleted({ title: '晴天', artist: '周杰伦' })
    enqueueCompleted({ title: '稻香', artist: '某翻唱歌手' })
    enqueueCompleted({ title: '七里香', artist: '周杰伦' })

    const a = listTasks({ tab: 'completed', q: '周杰伦 稻香' })
    const b = listTasks({ tab: 'completed', q: '稻香 周杰伦' })

    expect(titleOf(a)).toEqual(['稻香'])
    expect(titleOf(b)).toEqual(['稻香'])
    // 只命中「周杰伦 + 稻香」这一条，翻唱版与其它曲目都被 AND 排除
    expect(a.length).toBe(1)
  })

  it('全角空格 / 大小写差异不影响命中', () => {
    enqueueCompleted({ title: 'Hello (Live)', artist: 'Adele' })
    enqueueCompleted({ title: 'Someone Like You', artist: 'Adele' })

    expect(titleOf(listTasks({ q: 'hello' }))).toEqual(['Hello (Live)'])
    expect(titleOf(listTasks({ q: 'ＡＤＥＬＥ' }))).toEqual(['Hello (Live)', 'Someone Like You'])
    expect(titleOf(listTasks({ q: '周杰伦　稻香' }))).toEqual([])
  })

  it('可搜到专辑名，也可用括号内版本标记检索', () => {
    enqueueCompleted({ title: '稻香 (Live)', artist: '周杰伦', album: '魔杰座' })
    enqueueCompleted({ title: '稻香', artist: '周杰伦', album: '魔杰座' })

    expect(listTasks({ q: '魔杰座' }).length).toBe(2)
    // search_text 保留括号内容 → 「live」能命中现场版
    expect(titleOf(listTasks({ q: '稻香 live' }))).toEqual(['稻香 (Live)'])
  })

  it('检索与 tab / batchId 过滤可叠加', () => {
    enqueueCompleted({ title: '稻香', artist: '周杰伦', batchId: 'batch-A' })
    enqueueCompleted({ title: '稻香', artist: '周杰伦', batchId: 'batch-B' })

    expect(listTasks({ tab: 'completed', q: '稻香' }).length).toBe(2)
    expect(listTasks({ tab: 'completed', q: '稻香', batchId: 'batch-A' }).length).toBe(1)
    // 当前 tab 限定的语义：queued 里没有 completed 记录
    expect(listTasks({ tab: 'running', q: '稻香' }).length).toBe(0)
    expect(listTasks({ tab: 'failed', q: '稻香' }).length).toBe(0)
  })

  it('无匹配时返回空数组', () => {
    enqueueCompleted({ title: '稻香', artist: '周杰伦' })
    expect(listTasks({ q: '完全不存在的曲目' })).toEqual([])
  })

  it('纯标点查询退化为无过滤，不会误报也不会抛错', () => {
    enqueueCompleted({ title: '稻香', artist: '周杰伦' })
    enqueueCompleted({ title: '晴天', artist: '周杰伦' })

    const all = listTasks({ tab: 'completed' })
    const punctuationOnly = listTasks({ tab: 'completed', q: '%' })
    const underscoreOnly = listTasks({ tab: 'completed', q: '_' })

    // token 归一化会去掉标点 → 空 token 集合 → 不附加 LIKE 子句
    expect(punctuationOnly.length).toBe(all.length)
    expect(underscoreOnly.length).toBe(all.length)
  })

  it('getTaskStats 感知关键词，与 listTasks 条数一致（分页 total 回归锚点）', () => {
    enqueueCompleted({ title: '稻香', artist: '周杰伦' })
    enqueueCompleted({ title: '稻香 (Live)', artist: '周杰伦' })
    enqueueCompleted({ title: '晴天', artist: '周杰伦' })
    enqueueCompleted({ title: '七里香', artist: '周杰伦' })

    const filteredRows = listTasks({ tab: 'completed', q: '稻香' })
    const filteredStats = getTaskStats({ q: '稻香' })
    const allStats = getTaskStats()

    expect(filteredStats.completed).toBe(filteredRows.length)
    expect(filteredStats.completed).toBe(2)
    // 不传关键词时是全量 —— 证明 q 确实参与了统计
    expect(allStats.completed).toBe(4)
  })

  it('超出单页时 total 仍按过滤后的条数计算', () => {
    for (let i = 0; i < 12; i++) {
      enqueueCompleted({ title: `稻香 第${i}版`, artist: '周杰伦' })
    }
    enqueueCompleted({ title: '晴天', artist: '周杰伦' })

    const pageSize = 5
    const page1 = listTasks({ tab: 'completed', q: '稻香', page: 1, pageSize })
    const stats = getTaskStats({ q: '稻香' })
    const total = stats.completed

    expect(page1.length).toBe(5)
    expect(total).toBe(12)
    expect(Math.ceil(total / pageSize)).toBe(3)
  })

  it('客户端 SSE 过滤判据与服务端检索结果逐条一致', () => {
    const seeds: SeedTrack[] = [
      { title: '稻香', artist: '周杰伦', album: '魔杰座' },
      { title: '稻香 (Live)', artist: '周杰伦', album: '魔杰座' },
      { title: '晴天', artist: '周杰伦' },
      { title: '稻香', artist: '某翻唱歌手' },
      { title: 'Hello (Live)', artist: 'Adele' },
    ]
    seeds.forEach(enqueueCompleted)

    const keywords = [
      '稻香',
      '周杰伦 稻香',
      '稻香 周杰伦',
      '魔杰座',
      'live',
      'hello',
      'adele',
      '不存在',
      '  ',
      '%',
      'ＬＩＶＥ',
    ]

    for (const keyword of keywords) {
      const serverTitles = titleOf(listTasks({ tab: 'completed', q: keyword }))
      const clientTitles = seeds
        .filter((seed) => matchesTrackKeyword(seed, keyword))
        .map((seed) => seed.title)
        .sort()
      expect(clientTitles, `关键词「${keyword}」的客户端判定应与服务端一致`).toEqual(serverTitles)
    }
  })
})
