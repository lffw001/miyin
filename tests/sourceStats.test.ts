import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../server/utils/db'
import {
  COLD_START_SCORE,
  recordSourceOutcome,
  sourceScores,
} from '../server/services/sourceStats'
import { orderSourcesForResolve } from '../server/services/musicUrlResolve'
import type { SourceRow } from '../server/services/sourceRegistry'

function sourceRow(id: string): SourceRow {
  return {
    id,
    name: id,
    url: `http://example.com/${id}.js`,
    mirror_url: null,
    local_path: `/tmp/${id}.js`,
    enabled: 1,
    status: 'ok',
    platforms: JSON.stringify(['tx']),
    last_checked_at: null,
    last_error: null,
    update_info_json: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as SourceRow
}

describe('音源评分：只决定「先探谁」', () => {
  let prevDataDir: string | undefined

  beforeEach(() => {
    closeDb()
    prevDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'miyin-stats-'))
    getDb()
  })

  afterEach(() => {
    closeDb()
    if (prevDataDir) process.env.DATA_DIR = prevDataDir
    else delete process.env.DATA_DIR
  })

  it('无历史记录 → 中性冷启动分（新音源仍有机会被验证）', () => {
    expect(sourceScores('tx').size).toBe(0)
    const ordered = orderSourcesForResolve([sourceRow('a'), sourceRow('b')], null, 'tx')
    // 同分时保持原顺序（稳定排序）
    expect(ordered.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('稳定交付真无损的音源得分最高', () => {
    recordSourceOutcome({ sourceId: 'great', platform: 'tx', outcome: 'success', kbps: 2372 })
    recordSourceOutcome({ sourceId: 'great', platform: 'tx', outcome: 'success', kbps: 2100 })
    recordSourceOutcome({ sourceId: 'low', platform: 'tx', outcome: 'success', kbps: 320 })
    const scores = sourceScores('tx')
    expect(scores.get('great')!).toBeGreaterThan(scores.get('low')!)
  })

  it('只给试听的音源得分低于冷启动（下次排到最后）', () => {
    for (let i = 0; i < 3; i++) {
      recordSourceOutcome({ sourceId: 'previewer', platform: 'tx', outcome: 'preview' })
    }
    const score = sourceScores('tx').get('previewer')!
    expect(score).toBeLessThan(COLD_START_SCORE)
  })

  it('谎报档位的音源被明显压低（比试听还低：既浪费带宽又骗人）', () => {
    for (let i = 0; i < 3; i++) {
      recordSourceOutcome({ sourceId: 'liar', platform: 'tx', outcome: 'quality-lie' })
      recordSourceOutcome({ sourceId: 'previewer', platform: 'tx', outcome: 'preview' })
    }
    const scores = sourceScores('tx')
    expect(scores.get('liar')!).toBeLessThan(scores.get('previewer')!)
  })

  it('排序把「实测可靠」的源排到「已知只给试听」的源前面', () => {
    recordSourceOutcome({ sourceId: 'good', platform: 'tx', outcome: 'success', kbps: 2372 })
    recordSourceOutcome({ sourceId: 'good', platform: 'tx', outcome: 'success', kbps: 2200 })
    for (let i = 0; i < 3; i++) {
      recordSourceOutcome({ sourceId: 'bad', platform: 'tx', outcome: 'preview' })
    }
    const ordered = orderSourcesForResolve([sourceRow('bad'), sourceRow('good')], null, 'tx')
    expect(ordered.map((s) => s.id)).toEqual(['good', 'bad'])
  })

  it('指定音源有小幅加成，但不会让"已知很差"的指定源压过可靠源', () => {
    recordSourceOutcome({ sourceId: 'good', platform: 'tx', outcome: 'success', kbps: 2372 })
    recordSourceOutcome({ sourceId: 'good', platform: 'tx', outcome: 'success', kbps: 2200 })
    for (let i = 0; i < 5; i++) {
      recordSourceOutcome({ sourceId: 'bad', platform: 'tx', outcome: 'preview' })
    }
    // bad 是任务当前指定的音源，但历史太差 → 仍排在 good 之后
    const ordered = orderSourcesForResolve([sourceRow('bad'), sourceRow('good')], 'bad', 'tx')
    expect(ordered.map((s) => s.id)).toEqual(['good', 'bad'])
  })

  it('统计按平台隔离：tx 的表现不影响 wy 的排序', () => {
    recordSourceOutcome({ sourceId: 'a', platform: 'tx', outcome: 'success', kbps: 2372 })
    expect(sourceScores('tx').get('a')).toBeGreaterThan(COLD_START_SCORE)
    expect(sourceScores('wy').has('a')).toBe(false)
  })

  it('同一音源同一平台重复记录是累加而非覆盖', () => {
    recordSourceOutcome({ sourceId: 'a', platform: 'tx', outcome: 'success', kbps: 1000 })
    recordSourceOutcome({ sourceId: 'a', platform: 'tx', outcome: 'success', kbps: 3000 })
    const row = getDb()
      .prepare(`SELECT attempts, successes, kbps_sum, kbps_count FROM source_stats WHERE source_id='a'`)
      .get() as { attempts: number; successes: number; kbps_sum: number; kbps_count: number }
    expect(row.attempts).toBe(2)
    expect(row.successes).toBe(2)
    expect(row.kbps_count).toBe(2)
    expect(row.kbps_sum).toBe(4000)
  })
})
