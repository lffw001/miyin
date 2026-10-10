declare global {
  var createError: (input: {
    statusCode?: number
    statusMessage?: string
    message?: string
    data?: unknown
  }) => Error
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
import { searchPlatform, clearSearchCache, kwErrorDetector } from '../server/services/platformSearch'
import { searchAlbums, getAlbumDetail, clearAlbumCache } from '../server/services/platformAlbum'
import { resetUpstreamState } from '../server/services/upstreamChannels'

type CustomError = Error & { statusCode?: number; statusMessage?: string; data?: any }

const jsonRes = (obj: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
  }) as Response

/** 用单引号伪 JSON 响应，模拟酷我真实格式 */
const pseudoJsonRes = (obj: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(obj).replace(/"/g, "'"),
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

/** 主通道 cloudsearch/pc 形态：ar / al.picUrl */
const WY_PRIMARY_OK = () =>
  jsonRes({
    code: 200,
    result: {
      songs: [
        {
          id: 111,
          name: '稻香',
          ar: [{ name: '周杰伦' }],
          al: { id: 222, name: '魔杰座', picUrl: 'http://p1.music.126.net/primary.jpg' },
          dt: 223000,
        },
      ],
    },
  })

/** 备用通道 search/get/web 形态：artists / album（只有 picId，无 picUrl） */
const WY_FALLBACK_OK = () =>
  jsonRes({
    code: 200,
    result: {
      songs: [
        {
          id: 111,
          name: '稻香',
          artists: [{ name: '周杰伦' }],
          album: { id: 222, name: '魔杰座', picId: 999 },
          duration: 223000,
        },
      ],
    },
  })

const WY_DETAIL_OK = () =>
  jsonRes({
    code: 200,
    songs: [{ id: 111, album: { picUrl: 'http://p1.music.126.net/from-detail.jpg' } }],
  })

describe('wy 通道矩阵与封面增强', () => {
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

  it('主通道成功时不需要增强：不发 song/detail 请求', async () => {
    const calls = installFetch([['cloudsearch/pc', WY_PRIMARY_OK]])
    const res = await searchPlatform('wy', '稻香', 1)
    expect(res).toHaveLength(1)
    expect(res[0]!.cover).toBe('http://p1.music.126.net/primary.jpg')
    expect(res[0]!.albumId).toBe('222')
    expect(calls.filter((u) => u.includes('song/detail'))).toHaveLength(0)
  })

  it('主通道业务失败 → 降级到 search/get/web，并由增强补回封面', async () => {
    const calls = installFetch([
      ['cloudsearch/pc', () => jsonRes({ code: 400 })],
      ['search/get/web', WY_FALLBACK_OK],
      ['song/detail', WY_DETAIL_OK],
    ])
    const res = await searchPlatform('wy', '稻香', 1)
    expect(res).toHaveLength(1)
    // 备用端点自身的 artists/album 形态被正确映射
    expect(res[0]!.artist).toBe('周杰伦')
    expect(res[0]!.album).toBe('魔杰座')
    expect(res[0]!.albumId).toBe('222')
    expect(res[0]!.duration).toBe(223)
    // 封面由 song/detail 批量补回
    expect(res[0]!.cover).toBe('http://p1.music.126.net/from-detail.jpg')
    expect(res[0]!.musicInfo.img).toBe('http://p1.music.126.net/from-detail.jpg')
    expect(calls.filter((u) => u.includes('song/detail'))).toHaveLength(1)
  })

  it('两端点都失败 → 502 且带两条通道的真实原因', async () => {
    installFetch([
      ['cloudsearch/pc', () => jsonRes({ code: 400 })],
      ['search/get/web', () => jsonRes({ code: 500 })],
    ])
    await expect(searchPlatform('wy', '稻香', 1)).rejects.toSatisfy((err: unknown) => {
      const e = err as CustomError
      expect(e.statusCode).toBe(502)
      expect(e.message).toContain('wy:cloudsearch-pc')
      expect(e.message).toContain('wy:search-get-web')
      return true
    })
  })

  it('专辑搜索：主通道失败 → 降级到备用端点（字段等价，含封面）', async () => {
    const album = {
      code: 200,
      result: {
        albums: [{ id: 333, name: '魔杰座', picUrl: 'http://p1.music.126.net/album.jpg', size: 11, artist: { name: '周杰伦' } }],
      },
    }
    const calls = installFetch([
      ['cloudsearch/pc', () => jsonRes({ code: 400 })],
      ['search/get/web', () => jsonRes(album)],
    ])
    const res = await searchAlbums('wy', '魔杰座', 1)
    expect(res).toHaveLength(1)
    expect(res[0]!.id).toBe('wy:333')
    expect(res[0]!.cover).toBe('http://p1.music.126.net/album.jpg')
    expect(res[0]!.trackCount).toBe(11)
    expect(calls.filter((u) => u.includes('search/get/web'))).toHaveLength(1)
  })
})

describe('kw 业务态探测与静默防护', () => {
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

  it('kwErrorDetector 不会把 HIT:0 误判为错误', () => {
    expect(kwErrorDetector({ HIT: '0', HITMODE: 'nores', abslist: [] })).toBeNull()
    expect(kwErrorDetector({ HIT: '1318', abslist: [{}] })).toBeNull()
    expect(kwErrorDetector({ success: false, message: 'The request is illegal!' })).toContain('illegal')
    expect(kwErrorDetector({ code: 500 })).toContain('500')
    expect(kwErrorDetector({ errcode: '10' })).toBeTruthy()
    expect(kwErrorDetector({ code: 200 })).toBeNull()
    expect(kwErrorDetector(null)).toBeNull()
  })

  it('kw r.s 业务态失败不再静默返回空结果', async () => {
    installFetch([['search.kuwo.cn', () => jsonRes({ success: false, message: 'The request is illegal!' })]])
    await expect(searchPlatform('kw', '稻香', 1)).rejects.toSatisfy((err: unknown) => {
      const e = err as CustomError
      expect(e.statusCode).toBe(502)
      expect(e.message).toContain('illegal')
      expect(e.data.attempts[0].kind).toBe('business_error')
      return true
    })
  })

  it('kw 真·无结果（HIT:0）仍返回空数组，不报错', async () => {
    installFetch([
      ['search.kuwo.cn', () => pseudoJsonRes({ HIT: '0', HITMODE: 'nores', abslist: [] })],
    ])
    const res = await searchPlatform('kw', '不存在的歌xyz', 1)
    expect(res).toEqual([])
  })

  it('kw 正常结果（伪 JSON）可正确解析', async () => {
    installFetch([
      [
        'search.kuwo.cn',
        () =>
          pseudoJsonRes({
            HIT: '1',
            abslist: [
              {
                MUSICRID: 'MUSIC_348424',
                NAME: '稻香',
                ARTIST: '周杰伦',
                ALBUM: '魔杰座',
                DURATION: '223',
                web_albumpic_short: 'abc.jpg',
              },
            ],
          }),
      ],
    ])
    const res = await searchPlatform('kw', '稻香', 1)
    expect(res).toHaveLength(1)
    expect(res[0]!.id).toBe('kw:348424')
    expect(res[0]!.cover).toBe('https://img2.kuwo.cn/star/albumcover/abc.jpg')
  })

  it('kw 专辑搜索解析 albumlist 并识别业务态失败', async () => {
    const okCalls = installFetch([
      [
        'search.kuwo.cn',
        () =>
          pseudoJsonRes({
            SHOW: '1',
            albumlist: [
              {
                DC_TARGETID: '29218',
                NAME: '魔杰座',
                ARTIST: '周杰伦',
                SONGNUM: '11',
                web_albumpic_short: 'al.jpg',
              },
            ],
          }),
      ],
    ])
    const ok = await searchAlbums('kw', '魔杰座', 1)
    expect(ok).toHaveLength(1)
    expect(okCalls.filter((u) => u.includes('ft=album'))).toHaveLength(1)

    resetUpstreamState()
    clearAlbumCache()
    installFetch([['search.kuwo.cn', () => jsonRes({ success: false, message: 'illegal' })]])
    await expect(searchAlbums('kw', '魔杰座', 1)).rejects.toSatisfy((err: unknown) => {
      const e = err as CustomError
      expect(e.statusCode).toBe(502)
      expect(e.message).toContain('illegal')
      return true
    })
  })
})

describe('tx 专辑详情业务态检查', () => {
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

  it('非法 albummid（HTTP 200 + code 1101）不再被当成空专辑', async () => {
    installFetch([
      [
        'fcg_v8_album_info_cp',
        () => jsonRes({ code: 1101, subcode: 1101, message: 'para error!' }),
      ],
    ])
    await expect(getAlbumDetail('tx', 'ZZZZnotexist000')).rejects.toSatisfy((err: unknown) => {
      const e = err as CustomError
      expect(e.statusCode).toBe(502)
      expect(e.message).toContain('para error!')
      expect(e.message).toContain('1101')
      return true
    })
  })

  it('正常专辑（code 0）不受影响', async () => {
    installFetch([
      [
        'fcg_v8_album_info_cp',
        () =>
          jsonRes({
            code: 0,
            data: {
              mid: '002Neh8l0uciQZ',
              name: '魔杰座',
              singername: '周杰伦',
              list: [{ songmid: 'M1', songname: '稻香', strMediaMid: 'MM1', interval: 223 }],
            },
          }),
      ],
    ])
    const detail = await getAlbumDetail('tx', '002Neh8l0uciQZ')
    expect(detail.tracks).toHaveLength(1)
    expect(detail.tracks[0]!.musicInfo.strMediaMid).toBe('MM1')
  })
})
