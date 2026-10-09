import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  closeDb,
  getDb,
  backfillTrackKeys,
  backfillTrackKeysInBackground,
} from '../server/utils/db'
import { getDbPath } from '../server/utils/paths'
import {
  FIELD_SEP,
  normalizeText,
  normalizeForMatch,
  buildDedupKey,
  buildSearchText,
} from '#shared/trackKey'

/** 模拟「早于键列存在」的老库：连 file_size 都没有，验证迁移的叠加能力 */
const OLD_SCHEMA = `
CREATE TABLE download_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT,
  platform TEXT NOT NULL,
  source_id TEXT,
  quality TEXT,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  file_path TEXT,
  lyric_path TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  external_id TEXT,
  match_method TEXT,
  match_score REAL,
  batch_id TEXT,
  playlist_url TEXT,
  music_info_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

type SeedRow = {
  id: string
  title: string
  artist: string
  album?: string | null
  status?: string
}

function seedOldDb(rows: SeedRow[]) {
  const db = new Database(getDbPath())
  db.exec(OLD_SCHEMA)
  const stmt = db.prepare(
    `INSERT INTO download_tasks (id, title, artist, album, platform, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'wy', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  )
  for (const row of rows) {
    stmt.run(row.id, row.title, row.artist, row.album ?? null, row.status ?? 'completed')
  }
  db.close()
}

function columnNames() {
  const cols = getDb().prepare(`PRAGMA table_info(download_tasks)`).all() as Array<{ name: string }>
  return new Set(cols.map((c) => c.name))
}

function keyRow(id: string) {
  return getDb()
    .prepare(`SELECT dedup_key, search_text FROM download_tasks WHERE id = ?`)
    .get(id) as { dedup_key: string | null; search_text: string | null } | undefined
}

describe('下载任务表：检索键列迁移与回填', () => {
  let prevDataDir: string | undefined

  beforeEach(() => {
    closeDb()
    prevDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'miyin-trackkey-test-'))
  })

  afterEach(() => {
    closeDb()
    if (prevDataDir) process.env.DATA_DIR = prevDataDir
    else delete process.env.DATA_DIR
  })

  it('老库升级补齐 dedup_key / search_text 列与去重索引，历史行不被破坏', () => {
    seedOldDb([
      { id: 'a', title: '稻香', artist: '周杰伦' },
      { id: 'b', title: '晴天', artist: '周杰伦' },
    ])

    const db = getDb()

    const names = columnNames()
    expect(names.has('dedup_key')).toBe(true)
    expect(names.has('search_text')).toBe(true)
    // 既有迁移能力未被破坏
    expect(names.has('file_size')).toBe(true)

    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get('idx_download_tasks_dedup_key')
    expect(idx).toBeTruthy()

    const count = db.prepare(`SELECT count(*) AS c FROM download_tasks`).get() as { c: number }
    expect(count.c).toBe(2)

    // 尚未回填
    expect(keyRow('a')?.dedup_key).toBeNull()
  })

  it('口径升级：v1 的旧 dedup_key 被整体置空，并按 v2 口径重算', () => {
    // 造一个「v1 口径」的库：列已存在，键是**去括号**版本，user_version = 1
    const db = new Database(getDbPath())
    db.exec(`
      CREATE TABLE download_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        platform TEXT NOT NULL,
        status TEXT NOT NULL,
        batch_id TEXT,
        playlist_url TEXT,
        dedup_key TEXT,
        search_text TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const v1Key = `${normalizeText('周杰伦')}${FIELD_SEP}${normalizeForMatch('稻香 (Live)')}`
    db.prepare(
      `INSERT INTO download_tasks (id, title, artist, platform, status, dedup_key, search_text, created_at, updated_at)
       VALUES ('v1', '稻香 (Live)', '周杰伦', 'wy', 'completed', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(v1Key, buildSearchText({ title: '稻香 (Live)', artist: '周杰伦' }))
    db.pragma('user_version = 1')
    db.close()

    const opened = getDb()
    // 迁移：旧键语义已失效 → 置空 + 版本推进
    const row = opened
      .prepare(`SELECT dedup_key FROM download_tasks WHERE id = 'v1'`)
      .get() as { dedup_key: string | null }
    expect(row.dedup_key).toBeNull()
    expect(opened.pragma('user_version', { simple: true })).toBe(2)

    // 回填按新口径重算：保留括号 → 与「稻香」不再同键
    expect(backfillTrackKeys()).toBe(1)
    expect(keyRow('v1')?.dedup_key).toBe(buildDedupKey('周杰伦', '稻香 (Live)'))
    expect(keyRow('v1')?.dedup_key).not.toBe(buildDedupKey('周杰伦', '稻香'))
  })

  it('已是 v2 口径的库不会被重复清空（幂等）', () => {
    seedOldDb([{ id: 'a', title: '稻香', artist: '周杰伦' }])
    getDb()
    backfillTrackKeys()
    const before = keyRow('a')?.dedup_key
    expect(before).toBeTruthy()

    // 关掉重开：user_version 已是 2 → 不再清空
    closeDb()
    getDb()
    expect(keyRow('a')?.dedup_key).toBe(before)
  })

  it('回填写入与 buildDedupKey / buildSearchText 一致的值', () => {
    seedOldDb([
      { id: 'a', title: '稻香 (Live)', artist: '周杰伦', album: '魔杰座' },
      { id: 'b', title: '晴天', artist: '周杰伦' },
    ])
    getDb()

    const filled = backfillTrackKeys()
    expect(filled).toBe(2)

    const a = keyRow('a')
    expect(a?.dedup_key).toBe(buildDedupKey('周杰伦', '稻香 (Live)'))
    expect(a?.search_text).toBe(
      buildSearchText({ title: '稻香 (Live)', artist: '周杰伦', album: '魔杰座' }),
    )

    // Live 版与录音室版同键（已确认口径）
    const b = keyRow('b')
    expect(b?.dedup_key).toBe(buildDedupKey('周杰伦', '晴天'))
    expect(a?.dedup_key).not.toBe(b?.dedup_key)
  })

  it('分批回填覆盖全部行，且幂等（第二次为 0）', () => {
    const rows: SeedRow[] = []
    for (let i = 0; i < 25; i++) {
      rows.push({ id: `t${i}`, title: `曲目${i}`, artist: '歌手' })
    }
    seedOldDb(rows)
    getDb()

    // chunkSize=1：强制走 25 次独立事务
    expect(backfillTrackKeys({ chunkSize: 1 })).toBe(25)
    expect(backfillTrackKeys()).toBe(0)

    const remaining = getDb()
      .prepare(`SELECT count(*) AS c FROM download_tasks WHERE dedup_key IS NULL`)
      .get() as { c: number }
    expect(remaining.c).toBe(0)
  })

  it('按 maxRows 限制单次回填量，不一次吃满', () => {
    const rows: SeedRow[] = []
    for (let i = 0; i < 10; i++) rows.push({ id: `m${i}`, title: `曲${i}`, artist: '唱' })
    seedOldDb(rows)
    getDb()

    expect(backfillTrackKeys({ chunkSize: 4, maxRows: 4 })).toBe(4)
    expect(backfillTrackKeys({ chunkSize: 4, maxRows: 4 })).toBe(4)
    expect(backfillTrackKeys({ chunkSize: 4, maxRows: 4 })).toBe(2)
    expect(backfillTrackKeys({ chunkSize: 4, maxRows: 4 })).toBe(0)
  })

  it('后台渐进回填可跨多批完成，且已回填时立即返回 0', async () => {
    const rows: SeedRow[] = []
    for (let i = 0; i < 7; i++) rows.push({ id: `bg${i}`, title: `后台${i}`, artist: '歌手' })
    seedOldDb(rows)
    getDb()

    expect(await backfillTrackKeysInBackground({ chunkSize: 2 })).toBe(7)
    expect(await backfillTrackKeysInBackground({ chunkSize: 2 })).toBe(0)

    const nulls = getDb()
      .prepare(`SELECT count(*) AS c FROM download_tasks WHERE dedup_key IS NULL OR search_text IS NULL`)
      .get() as { c: number }
    expect(nulls.c).toBe(0)
  })

  it('新建库自带两列，回填为空操作', () => {
    const db = getDb()
    const names = columnNames()
    expect(names.has('dedup_key')).toBe(true)
    expect(names.has('search_text')).toBe(true)
    expect(backfillTrackKeys()).toBe(0)
    expect(db.prepare(`SELECT count(*) AS c FROM download_tasks`).get()).toEqual({ c: 0 })
  })
})
