import { describe, it, expect } from 'vitest'
import { QUALITY_LADDER, qualityRank, isQualityInverted } from '#shared/quality'

describe('QUALITY_LADDER', () => {
  it('是实际产出档位阶梯，必须包含 192k', () => {
    expect(QUALITY_LADDER).toEqual(['flac24bit', 'flac', '320k', '192k', '128k'])
    // 回归锚点：192k 只在产出阶梯里，ALLOWED_QUALITIES 没有它
    expect(QUALITY_LADDER as readonly string[]).toContain('192k')
  })
})

describe('qualityRank', () => {
  it('数值越小音质越高', () => {
    expect(qualityRank('flac24bit')).toBeLessThan(qualityRank('flac')!)
    expect(qualityRank('flac')).toBeLessThan(qualityRank('320k')!)
    expect(qualityRank('320k')).toBeLessThan(qualityRank('192k')!)
    expect(qualityRank('192k')).toBeLessThan(qualityRank('128k')!)
  })

  it('192k 有正确排名（防误用 ALLOWED_QUALITIES 导致 -1）', () => {
    expect(qualityRank('192k')).toBe(3)
    expect(qualityRank('192k')).not.toBe(-1)
  })

  it('highest / null / 空串 / 未知值一律返回 null（未知）', () => {
    expect(qualityRank('highest')).toBeNull()
    expect(qualityRank(null)).toBeNull()
    expect(qualityRank(undefined)).toBeNull()
    expect(qualityRank('')).toBeNull()
    expect(qualityRank('flac32bit')).toBeNull()
  })
})

describe('isQualityInverted（低音质覆盖高音质 → 应拦截）', () => {
  it('低覆盖高返回 true', () => {
    expect(isQualityInverted('flac', '320k')).toBe(true)
    expect(isQualityInverted('flac24bit', 'flac')).toBe(true)
    // 关键回归：若 qualityRank 误用 ALLOWED_QUALITIES，'192k' 会得到 -1，
    // 这条降级（320k 已被 192k 覆盖）就会漏拦
    expect(isQualityInverted('320k', '192k')).toBe(true)
  })

  it('高覆盖低返回 false（是升级，不拦）', () => {
    expect(isQualityInverted('320k', 'flac')).toBe(false)
    expect(isQualityInverted('192k', 'flac24bit')).toBe(false)
    // 192k → 320k 是升级（320k 比特率更高，阶梯里位置更靠前）
    expect(isQualityInverted('192k', '320k')).toBe(false)
  })

  it('同档不算倒挂', () => {
    expect(isQualityInverted('flac', 'flac')).toBe(false)
  })

  it('任一档未知则不拦截（highest 是偏好，不是产出档位）', () => {
    expect(isQualityInverted('flac', 'highest')).toBe(false)
    expect(isQualityInverted('highest', 'flac')).toBe(false)
    expect(isQualityInverted(null, '320k')).toBe(false)
    expect(isQualityInverted('flac', null)).toBe(false)
    expect(isQualityInverted('flac', undefined)).toBe(false)
  })
})
