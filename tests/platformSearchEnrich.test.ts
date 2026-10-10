declare global {
  var createError: (input: { statusCode?: number; statusMessage?: string; message?: string; data?: unknown }) => Error
}

if (!globalThis.createError) {
  globalThis.createError = (input: {
    statusCode?: number
    statusMessage?: string
    message?: string
    data?: unknown
  }) => {
    const err = new Error(input.message || input.statusMessage || 'Error') as Error & {
      statusCode?: number
      statusMessage?: string
      data?: unknown
    }
    err.statusCode = input.statusCode
    err.statusMessage = input.statusMessage
    err.data = input.data
    return err
  }
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  searchPlatform,
  searchPlatformDetailed,
  clearSearchCache,
  mapKgMobileSong,
  txQualitysFromFile,
} from '../server/services/platformSearch'
import { mapTxAlbumSong } from '../server/services/platformAlbum'
import { resetUpstreamState } from '../server/services/upstreamChannels'

const jsonRes = (obj: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
  }) as Response

function installFetch(routes: Array<[string, () => Response]>) {
  const calls: string[] = []
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input)
    calls.push(url)
    for (const [frag, handler] of routes) {
      if (url.includes(frag)) return handler()
    }
    throw new Error(`unexpected url ${url}`)
  }) as unknown as typeof fetch
  return calls
}

/** search_for_qq_cp 的搜索响应：**不含** strMediaMid（这是新端点的真实行为） */
const TX_SEARCH_OK = () =>
  jsonRes({
    code: 0,
    data: {
      song: {
        list: [
          {
            songmid: '003aAYrm3GE0Ac',
            songname: '稻香',
            singer: [{ name: '周杰伦' }],
            albumname: '魔杰座',
            albummid: '000bviBl4F5P1N',
            interval: 223,
          },
        ],
      },
    },
  })

/** musicu.fcg 批量详情响应：带 media_mid 与各档位体积 */
const TX_TRACKINFO_OK = (fileExtra: Record<string, unknown> = {}) =>
  jsonRes({
    code: 0,
    req_1: {
      code: 0,
      data: {
        tracks: [
          {
            mid: '003aAYrm3GE0Ac',
            title: '稻香',
            file: {
              media_mid: '0020wJDo3cx0j3',
              size_128mp3: 3576668,
              size_320mp3: 8941053,
              size_flac: 26012257,
              size_ape: 0,
              size_hires: 0,
              ...fileExtra,
            },
          },
        ],
      },
    },
  })

describe('tx 后置增强：补 media_mid 与真实音质档位', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    resetUpstreamState()
    clearSearchCache()
    process.env.MIYIN_UPSTREAM_RETRIES = '0'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = { ...savedEnv } as NodeJS.ProcessEnv
    vi.restoreAllMocks()
  })

  it('searchPlatform 结果带上 media_mid（高音质取链必需），并回填真实档位', async () => {
    const calls = installFetch([
      ['search_for_qq_cp', TX_SEARCH_OK],
      ['u.y.qq.com', () => TX_TRACKINFO_OK()],
    ])

    const res = await searchPlatform('tx', '稻香', 1)
    expect(res).toHaveLength(1)
    const t = res[0]!
    // 新端点原生没有的值，由增强补齐
    expect(t.musicInfo.strMediaMid).toBe('0020wJDo3cx0j3')
    expect(t.musicInfo.media_mid).toBe('0020wJDo3cx0j3')
    // 档位来自 file.size_*（该曲无 hires → 到 flac 为止）
    expect(t.qualitys).toEqual(['128k', '320k', 'flac'])
    expect(t.musicInfo.qualitys).toEqual(['128k', '320k', 'flac'])
    expect(t.musicInfo.hasLossless).toBe(true)
    // 整页只发一次批量请求
    expect(calls.filter((u) => u.includes('u.y.qq.com'))).toHaveLength(1)
  })

  it('存在 Hi-Res 时档位含 flac24bit', async () => {
    installFetch([
      ['search_for_qq_cp', TX_SEARCH_OK],
      ['u.y.qq.com', () => TX_TRACKINFO_OK({ size_hires: 66127392, hires_bitdepth: 24, hires_sample: 96000 })],
    ])
    const res = await searchPlatform('tx', '稻香', 1)
    expect(res[0]!.qualitys).toEqual(['128k', '320k', 'flac', 'flac24bit'])
  })

  it('批量详情查不到该曲 → 保留原始条目，不改动已有字段', async () => {
    installFetch([
      ['search_for_qq_cp', TX_SEARCH_OK],
      ['u.y.qq.com', () => jsonRes({ code: 0, req_1: { code: 0, data: { tracks: [] } } })],
    ])
    const res = await searchPlatform('tx', '稻香', 1)
    expect(res).toHaveLength(1)
    expect(res[0]!.musicInfo.strMediaMid).toBeUndefined()
    expect(res[0]!.qualitys).toEqual(['128k', '320k'])
  })

  it('增强请求失败不影响主搜索结果（enriched=false，条目保留）', async () => {
    installFetch([
      ['search_for_qq_cp', TX_SEARCH_OK],
      [
        'u.y.qq.com',
        () => {
          throw new Error('ECONNRESET')
        },
      ],
    ])

    const detail = await searchPlatformDetailed('tx', '稻香', 1)
    expect(detail.items).toHaveLength(1)
    expect(detail.enriched).toBe(false)
    expect(detail.enrichError).toContain('ECONNRESET')
    // 主结果仍然可用（只是拿不到无损）
    expect(detail.items[0]!.title).toBe('稻香')
  })

  it('增强返回非 2xx 时同样是非致命失败', async () => {
    installFetch([
      ['search_for_qq_cp', TX_SEARCH_OK],
      ['u.y.qq.com', () => jsonRes({}, 500)],
    ])
    const detail = await searchPlatformDetailed('tx', '稻香', 1)
    expect(detail.enriched).toBe(false)
    expect(detail.items).toHaveLength(1)
  })

  it('musicu 子模块返回非 0 code 视为增强失败', async () => {
    installFetch([
      ['search_for_qq_cp', TX_SEARCH_OK],
      ['u.y.qq.com', () => jsonRes({ code: 0, req_1: { code: 1000, data: { tracks: [] } } })],
    ])
    const detail = await searchPlatformDetailed('tx', '稻香', 1)
    expect(detail.enriched).toBe(false)
    expect(detail.enrichError).toContain('trackinfo code 1000')
  })

  it('无增强配置的平台（wy/kg）不受影响：enriched 恒为 true', async () => {
    installFetch([['music.163.com', () => jsonRes({ code: 200, result: { songs: [{ id: 1, name: 'x', ar: [], al: {}, dt: 1000 }] } })]])
    const detail = await searchPlatformDetailed('wy', 'x', 1)
    expect(detail.enriched).toBe(true)
    expect(detail.enrichError).toBeUndefined()
  })
})

describe('txQualitysFromFile 档位推导', () => {
  it('无 file / 空 file → 保守返回 128k+320k', () => {
    expect(txQualitysFromFile(null)).toEqual(['128k', '320k'])
    expect(txQualitysFromFile({})).toEqual(['128k', '320k'])
  })

  it('按 size_* 递增产出档位', () => {
    expect(txQualitysFromFile({ size_128mp3: 1 })).toEqual(['128k'])
    expect(txQualitysFromFile({ size_128mp3: 1, size_320mp3: 1 })).toEqual(['128k', '320k'])
    expect(txQualitysFromFile({ size_128mp3: 1, size_320mp3: 1, size_flac: 1 })).toEqual([
      '128k',
      '320k',
      'flac',
    ])
    expect(txQualitysFromFile({ size_320mp3: 1, size_ape: 1 })).toEqual(['320k', 'flac'])
    expect(txQualitysFromFile({ size_320mp3: 1, size_flac: 1, size_hires: 1 })).toEqual([
      '320k',
      'flac',
      'flac24bit',
    ])
  })
})

describe('kg 封面（trans_param.union_cover）', () => {
  it('替换 {size} 占位符', () => {
    const t = mapKgMobileSong({
      hash: 'H1',
      songname: '稻香',
      singername: '周杰伦',
      trans_param: { union_cover: 'http://imge.kugou.com/stdmusic/{size}/a.jpg' },
    })
    expect(t.cover).toBe('http://imge.kugou.com/stdmusic/240/a.jpg')
    expect(t.musicInfo.img).toBe(t.cover)
  })

  it('无 {size} 时原样返回；无字段则置空', () => {
    expect(
      mapKgMobileSong({ hash: 'H2', songname: 'x', trans_param: { union_cover: 'http://a/b.jpg' } }).cover,
    ).toBe('http://a/b.jpg')
    expect(mapKgMobileSong({ hash: 'H3', songname: 'x' }).cover).toBeUndefined()
    expect(mapKgMobileSong({ hash: 'H4', songname: 'x', trans_param: {} }).cover).toBeUndefined()
    expect(mapKgMobileSong({ hash: 'H5', songname: 'x', trans_param: { union_cover: '' } }).cover).toBeUndefined()
  })
})

describe('tx 专辑详情档位（无需额外请求）', () => {
  it('按 size128/size320/sizeflac/sizeape 推导', () => {
    expect(mapTxAlbumSong({ songmid: 'M1', songname: 'x', size128: 1, size320: 1, sizeflac: 1 }).qualitys).toEqual([
      '128k',
      '320k',
      'flac',
    ])
    expect(mapTxAlbumSong({ songmid: 'M2', songname: 'x', size320: 1 }).qualitys).toEqual(['320k'])
    expect(mapTxAlbumSong({ songmid: 'M3', songname: 'x' }).qualitys).toEqual(['128k', '320k'])
  })

  it('保留 strMediaMid（专辑详情原生就有）', () => {
    const t = mapTxAlbumSong({ songmid: 'M4', songname: 'x', strMediaMid: 'MEDIA9' })
    expect(t.musicInfo.strMediaMid).toBe('MEDIA9')
  })
})
