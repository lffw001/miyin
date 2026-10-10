import { describe, it, expect } from 'vitest'
import {
  MIN_KBPS_ANY,
  MIN_KBPS_BY_QUALITY,
  estimateBitrateKbps,
  qualityFromBitrate,
  qualityPlausibility,
} from '#shared/quality'
import { isLosslessClaimMismatch } from '../server/utils/audioSniff'

/**
 * 实测锚点：同一首《稻香》(223s) 在四个音源上的真实响应体积。
 * 这四条是本轮「最高可用落到最好音源」的判据来源，必须锁住。
 */
const XIANG = { durationSec: 223, ynx: 64578, nianxin: 25403, heiMusic: 8731, trial: 938 }

describe('estimateBitrateKbps', () => {
  it('复现实测四组：真 Hi-Res / 真无损 / 谎报的 320k / 试听', () => {
    const kb = (kbSize: number) => estimateBitrateKbps(kbSize * 1024, XIANG.durationSec)!
    expect(Math.round(kb(XIANG.ynx))).toBe(2372)
    expect(Math.round(kb(XIANG.nianxin))).toBe(933)
    expect(Math.round(kb(XIANG.heiMusic))).toBe(321)
    expect(Math.round(kb(XIANG.trial))).toBe(34)
  })

  it('时长解析成 0 / 负数 / null 时返回 null（未知，不判定）', () => {
    expect(estimateBitrateKbps(1000, 0)).toBeNull()
    expect(estimateBitrateKbps(1000, -5)).toBeNull()
    expect(estimateBitrateKbps(1000, null)).toBeNull()
    expect(estimateBitrateKbps(1000, undefined)).toBeNull()
  })

  it('体积为 0 / 负数 / null 时返回 null，不产生 Infinity 或负码率', () => {
    expect(estimateBitrateKbps(0, 223)).toBeNull()
    expect(estimateBitrateKbps(-1, 223)).toBeNull()
    expect(estimateBitrateKbps(null, 223)).toBeNull()
    expect(estimateBitrateKbps(undefined, 223)).toBeNull()
  })

  it('时长很短时不会算出离谱数值（只做除法，不做兜底猜测）', () => {
    // 1 秒 1MB ≈ 8388kbps —— 数学上正确，判据是否合理交给 plausibility
    expect(Math.round(estimateBitrateKbps(1024 * 1024, 1)!)).toBe(8389)
  })
})

describe('qualityPlausibility（配不配得上声称的档位）', () => {
  it('实测锚点分别落在正确的判定上', () => {
    const p = (kbSize: number, q: string) =>
      qualityPlausibility(estimateBitrateKbps(kbSize * 1024, XIANG.durationSec), q)
    expect(p(XIANG.ynx, 'flac24bit')).toBe('ok') // 2372kbps 真 Hi-Res
    expect(p(XIANG.nianxin, 'flac')).toBe('ok') // 933kbps 真无损
    expect(p(XIANG.heiMusic, 'flac24bit')).toBe('implausible') // 321kbps 谎报
    expect(p(XIANG.nianxin, 'flac24bit')).toBe('implausible') // 真无损也够不上 24bit
  })

  it('恰好等于档位下限算合格，低 1kbps 即不合格（边界方向不能反）', () => {
    const min = MIN_KBPS_BY_QUALITY.flac24bit!
    expect(qualityPlausibility(min, 'flac24bit')).toBe('ok')
    expect(qualityPlausibility(min - 0.001, 'flac24bit')).toBe('implausible')
  })

  it('未知档位（highest / null / 空串 / 非阶梯值）一律不判定', () => {
    expect(qualityPlausibility(2000, 'highest')).toBe('unknown')
    expect(qualityPlausibility(2000, null)).toBe('unknown')
    expect(qualityPlausibility(2000, undefined)).toBe('unknown')
    expect(qualityPlausibility(2000, '')).toBe('unknown')
    expect(qualityPlausibility(2000, 'flac32bit')).toBe('unknown')
  })

  it('码率未知（null）时不判定，不误杀', () => {
    expect(qualityPlausibility(null, 'flac24bit')).toBe('unknown')
  })

  it('128k 档位下限最宽松：低码率整曲不会被判谎报', () => {
    expect(qualityPlausibility(MIN_KBPS_BY_QUALITY['128k']!, '128k')).toBe('ok')
  })
})

describe('MIN_KBPS_ANY 与档位下限的分工', () => {
  it('试听（34kbps）低于 MIN_KBPS_ANY → 硬拒绝；谎报（321kbps）高于它 → 只降级', () => {
    expect(34).toBeLessThan(MIN_KBPS_ANY)
    expect(321).toBeGreaterThan(MIN_KBPS_ANY)
    // 谎报不应触发"试听"硬拒绝，只应影响排序
    expect(qualityPlausibility(321, 'flac24bit')).toBe('implausible')
  })

  it('MIN_KBPS_ANY 严格低于所有档位下限（否则会把合格整曲误判成试听）', () => {
    for (const [, min] of Object.entries(MIN_KBPS_BY_QUALITY)) {
      expect(MIN_KBPS_ANY).toBeLessThan(min)
    }
  })
})

describe('qualityFromBitrate（把谎报档位改写回真实档位）', () => {
  it('实测锚点反推正确', () => {
    expect(qualityFromBitrate(2372)).toBe('flac24bit')
    expect(qualityFromBitrate(933)).toBe('flac')
    expect(qualityFromBitrate(321)).toBe('320k')
  })

  it('边界：恰好等于下限取该档位', () => {
    expect(qualityFromBitrate(MIN_KBPS_BY_QUALITY.flac24bit!)).toBe('flac24bit')
    expect(qualityFromBitrate(MIN_KBPS_BY_QUALITY.flac!)).toBe('flac')
    expect(qualityFromBitrate(MIN_KBPS_BY_QUALITY['320k']!)).toBe('320k')
    expect(qualityFromBitrate(MIN_KBPS_BY_QUALITY['192k']!)).toBe('192k')
  })

  it('低到不可能时兜底到 128k，不返回空', () => {
    expect(qualityFromBitrate(1)).toBe('128k')
    expect(qualityFromBitrate(0)).toBe('128k')
  })
})

describe('isLosslessClaimMismatch（L2 兜底：声称无损实为 mp3）', () => {
  it('声称 flac / flac24bit 而实际 mp3 → 判谎报', () => {
    expect(isLosslessClaimMismatch('flac', 'mp3')).toBe(true)
    expect(isLosslessClaimMismatch('flac24bit', 'mp3')).toBe(true)
  })

  it('m4a / ogg 不判（可能是 ALAC / 无损 Vorbis，魔数无法区分）', () => {
    expect(isLosslessClaimMismatch('flac', 'm4a')).toBe(false)
    expect(isLosslessClaimMismatch('flac24bit', 'ogg')).toBe(false)
  })

  it('声称有损档位时不判（320k 拿到 mp3 是正常的）', () => {
    expect(isLosslessClaimMismatch('320k', 'mp3')).toBe(false)
    expect(isLosslessClaimMismatch('128k', 'mp3')).toBe(false)
  })

  it('声称无损且实际也是无损 → 不判', () => {
    expect(isLosslessClaimMismatch('flac24bit', 'flac')).toBe(false)
    expect(isLosslessClaimMismatch('flac', 'wav')).toBe(false)
  })

  it('任一侧缺失时不判（嗅探失败不应导致误杀）', () => {
    expect(isLosslessClaimMismatch(null, 'mp3')).toBe(false)
    expect(isLosslessClaimMismatch(undefined, 'mp3')).toBe(false)
    expect(isLosslessClaimMismatch('flac', null)).toBe(false)
  })
})
