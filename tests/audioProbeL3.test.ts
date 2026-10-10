import { describe, it, expect } from 'vitest'
import { parseFfprobeAudioInfo } from '../server/utils/audioPreview'
import { correctedQualityFromProbe } from '#shared/quality'

/** 真实 `ffprobe -select_streams a:0 -of default=noprint_wrappers=1` 的输出（《旅行》原样） */
const REAL_FLAC_16BIT_6CH = `codec_name=flac
sample_rate=44100
channels=6
bits_per_raw_sample=16
duration=266.853719
`

describe('parseFfprobeAudioInfo', () => {
  it('解析真实输出（16bit / 44.1kHz / 6声道）', () => {
    const info = parseFfprobeAudioInfo(REAL_FLAC_16BIT_6CH)
    expect(info.codec).toBe('flac')
    expect(info.sampleRate).toBe(44100)
    expect(info.channels).toBe(6)
    expect(info.bitsPerRawSample).toBe(16)
    expect(info.durationSec).toBeCloseTo(266.853719, 3)
  })

  it('真 24bit / 96kHz 立体声（应与 16bit 区分开）', () => {
    const info = parseFfprobeAudioInfo(
      'codec_name=flac\nsample_rate=96000\nchannels=2\nbits_per_raw_sample=24\nduration=200\n',
    )
    expect(info.bitsPerRawSample).toBe(24)
    expect(info.sampleRate).toBe(96000)
    expect(info.channels).toBe(2)
  })

  it('缺 bits_per_raw_sample（如 mp3）→ 该字段为 null，不影响其余字段', () => {
    const info = parseFfprobeAudioInfo('codec_name=mp3\nsample_rate=44100\nchannels=2\nduration=180\n')
    expect(info.bitsPerRawSample).toBeNull()
    expect(info.codec).toBe('mp3')
    expect(info.durationSec).toBe(180)
  })

  it('N/A 视为未知，不产生 NaN', () => {
    const info = parseFfprobeAudioInfo(
      'codec_name=flac\nbits_per_raw_sample=N/A\nchannels=N/A\nduration=N/A\n',
    )
    expect(info.bitsPerRawSample).toBeNull()
    expect(info.channels).toBeNull()
    expect(info.durationSec).toBeNull()
    expect(info.codec).toBe('flac')
  })

  it('空输出 / 无等号噪声 → 全字段 null，不抛错', () => {
    expect(parseFfprobeAudioInfo('')).toEqual({
      durationSec: null,
      codec: null,
      sampleRate: null,
      bitsPerRawSample: null,
      channels: null,
    })
    const noisy = parseFfprobeAudioInfo('ffprobe version 6.0\nsome noise\n=orphan\n')
    expect(noisy.codec).toBeNull()
    expect(noisy.durationSec).toBeNull()
  })

  it('值里含等号也能正确切分（只按第一个 = 拆）', () => {
    const info = parseFfprobeAudioInfo('codec_name=flac\nduration=1=2\n')
    expect(info.codec).toBe('flac')
    expect(info.durationSec).toBeNull() // "1=2" 不是合法数字 → null
  })

  it('多流混入（未加 -select_streams）时后出现的会覆盖前者 —— 这正是必须限定 a:0 的原因', () => {
    // 封面图 mjpeg 流在后：若无 select_streams，位深会被图片的 8bit 覆盖
    const polluted = parseFfprobeAudioInfo(
      'codec_name=flac\nbits_per_raw_sample=16\ncodec_name=mjpeg\nbits_per_raw_sample=8\n',
    )
    expect(polluted.codec).toBe('mjpeg')
    expect(polluted.bitsPerRawSample).toBe(8)
  })
})

describe('correctedQualityFromProbe（L3：只修正记录档位）', () => {
  it('声称 flac24bit 但实测 16bit → 修正为 flac（ynx 的真实情况）', () => {
    expect(correctedQualityFromProbe('flac24bit', { bitsPerRawSample: 16 })).toBe('flac')
  })

  it('实测确实是 24bit → 保持 flac24bit', () => {
    expect(correctedQualityFromProbe('flac24bit', { bitsPerRawSample: 24 })).toBe('flac24bit')
    expect(correctedQualityFromProbe('flac24bit', { bitsPerRawSample: 32 })).toBe('flac24bit')
  })

  it('位深未知（null）→ 不修正，不凭空降级', () => {
    expect(correctedQualityFromProbe('flac24bit', { bitsPerRawSample: null })).toBe('flac24bit')
  })

  it('探测失败（info 为 null）→ 不修正', () => {
    expect(correctedQualityFromProbe('flac24bit', null)).toBe('flac24bit')
    expect(correctedQualityFromProbe('flac24bit', undefined)).toBe('flac24bit')
  })

  it('非 flac24bit 的档位一律不动（不超出证据做推断）', () => {
    expect(correctedQualityFromProbe('flac', { bitsPerRawSample: 16 })).toBe('flac')
    expect(correctedQualityFromProbe('320k', { bitsPerRawSample: 16 })).toBe('320k')
    expect(correctedQualityFromProbe('128k', { bitsPerRawSample: null })).toBe('128k')
  })

  it('声称档位缺失时不修正', () => {
    expect(correctedQualityFromProbe(null, { bitsPerRawSample: 16 })).toBeNull()
    expect(correctedQualityFromProbe('', { bitsPerRawSample: 16 })).toBe('')
    expect(correctedQualityFromProbe(undefined, { bitsPerRawSample: 16 })).toBeUndefined()
  })

  it('修正只降一级到 flac，绝不会降到有损档位（文件本身是真无损）', () => {
    for (const bits of [8, 12, 16, 20, 23]) {
      expect(correctedQualityFromProbe('flac24bit', { bitsPerRawSample: bits })).toBe('flac')
    }
  })
})
