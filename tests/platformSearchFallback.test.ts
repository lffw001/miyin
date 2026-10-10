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
import { searchPlatform, clearSearchCache } from '../server/services/platformSearch'
import { resetUpstreamState } from '../server/services/upstreamChannels'

type CustomError = Error & { statusCode?: number; statusMessage?: string; data?: any }

const jsonRes = (obj: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
  }) as Response

/** 按 URL 关键片段分发响应；未命中则抛错（暴露非预期请求） */
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

const KG_SIGNATURE_ERROR = () =>
  jsonRes({ status: 0, error_code: 20006, error_msg: 'err signature', data: { lists: [] } })

const KG_V3_OK = () =>
  jsonRes({
    status: 1,
    data: {
      info: [
        {
          hash: '8909e1809908cd8e3bf6cf85d98b93f0',
          sqhash: '36ab2c542af54578efd376a4e2c57c1f',
          '320hash': '21ac928e1d68ec3632ef2cae68718201',
          songname: '稻香',
          singername: '周杰伦',
          album_name: '魔杰座',
          album_id: '960399',
          duration: 223,
          // 封面藏在 trans_param.union_cover，含 {size} 占位符
          trans_param: {
            union_cover: 'http://imge.kugou.com/stdmusic/{size}/20241118/20241118160622508429.jpg',
          },
        },
      ],
    },
  })

const KG_LEGACY_OK = () =>
  jsonRes({
    status: 0,
    data: {
      lists: [
        {
          FileHash: 'ABCDEF1234567890ABCDEF1234567890',
          SongName: '稻香',
          SingerName: '周杰伦',
          AlbumName: '魔杰座',
          Duration: 223,
          Image: 'https://imge.kugou.com/{size}/cover.jpg',
        },
      ],
    },
  })

const TX_SONG_LIST = (mid: string, withMediaMid = false) =>
  jsonRes({
    code: 0,
    data: {
      song: {
        list: [
          {
            songmid: mid,
            songname: '稻香',
            singer: [{ name: '周杰伦' }],
            albumname: '魔杰座',
            albummid: '000bviBl4F5P1N',
            interval: 223,
            ...(withMediaMid ? { strMediaMid: 'MEDIA_MID_001' } : {}),
          },
        ],
      },
    },
  })

describe('platformSearch 接口矩阵 / 自动降级 / 真实错误透传', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    resetUpstreamState()
    clearSearchCache()
    process.env.MIYIN_UPSTREAM_RETRIES = '0'
    process.env.MIYIN_UPSTREAM_BREAKER_THRESHOLD = '99'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.env = { ...savedEnv } as NodeJS.ProcessEnv
    vi.restoreAllMocks()
  })

  it('kg：主通道返回 HTTP 200 + error_code=20006 时自动降级到备用通道并正确映射小驼峰字段', async () => {
    const calls = installFetch([
      ['complexsearch.kugou.com', KG_SIGNATURE_ERROR],
      ['mobileservice.kugou.com', KG_V3_OK],
    ])

    const res = await searchPlatform('kg', '稻香', 1)
    expect(res).toHaveLength(1)
    const t = res[0]!
    expect(t.id).toBe('kg:8909e1809908cd8e3bf6cf85d98b93f0')
    expect(t.externalId).toBe('8909e1809908cd8e3bf6cf85d98b93f0')
    expect(t.title).toBe('稻香')
    expect(t.artist).toBe('周杰伦')
    expect(t.album).toBe('魔杰座')
    expect(t.albumId).toBe('960399')
    expect(t.duration).toBe(223)
    expect(t.musicInfo.source).toBe('kg')
    expect(t.musicInfo.hash).toBe('8909e1809908cd8e3bf6cf85d98b93f0')
    // 封面来自 trans_param.union_cover，且 {size} 已被替换
    expect(t.cover).toBe('http://imge.kugou.com/stdmusic/240/20241118/20241118160622508429.jpg')
    expect(t.musicInfo.img).toBe(t.cover)

    // 备用通道命中后不应再请求后续通道
    expect(calls.some((u) => u.includes('complexsearch.kugou.com'))).toBe(false)
  })

  it('kg：主通道网络失败 → 降级到 mobilecdn → 再降级到 legacy 大驼峰通道', async () => {
    const calls = installFetch([
      [
        'mobileservice.kugou.com',
        () => {
          throw new Error('ECONNRESET')
        },
      ],
      ['mobilecdn.kugou.com', () => jsonRes({ status: 1, data: { info: [] } })],
      ['complexsearch.kugou.com', KG_LEGACY_OK],
    ])

    const res = await searchPlatform('kg', '稻香', 1)
    expect(res).toHaveLength(1)
    // legacy 通道字段为大驼峰，cover 仍可解析
    expect(res[0]!.id).toBe('kg:ABCDEF1234567890ABCDEF1234567890')
    expect(res[0]!.cover).toBe('https://imge.kugou.com/240/cover.jpg')
    expect(calls.filter((u) => u.includes('complexsearch.kugou.com'))).toHaveLength(1)
  })

  it('kg：全通道签名错误 → 502 且 message 携带 error_code=20006 与原始描述（不被空结果掩盖）', async () => {
    installFetch([
      ['mobileservice.kugou.com', KG_SIGNATURE_ERROR],
      ['mobilecdn.kugou.com', KG_SIGNATURE_ERROR],
      ['complexsearch.kugou.com', KG_SIGNATURE_ERROR],
    ])

    await expect(searchPlatform('kg', '稻香', 1)).rejects.toSatisfy((err: unknown) => {
      const e = err as CustomError
      expect(e.statusCode).toBe(502)
      expect(e.statusMessage).toBe('Bad Gateway')
      // 真实原因必须出现在用户可见文案里
      expect(e.message).toContain('全部上游通道不可用')
      expect(e.message).toContain('20006')
      expect(e.message).toContain('err signature')
      // 结构化数据保留每条通道的失败明细
      expect(Array.isArray(e.data?.attempts)).toBe(true)
      expect(e.data.attempts).toHaveLength(3)
      expect(e.data.attempts.every((a: any) => a.kind === 'business_error')).toBe(true)
      expect(e.data.attempts[0].upstreamCode).toBe('20006')
      return true
    })
  })

  it('tx：默认走新端点（快），且不请求老端点', async () => {
    const calls = installFetch([['search_for_qq_cp', () => TX_SONG_LIST('003aAYrm3GE0Ac')]])

    const res = await searchPlatform('tx', '稻香', 1)
    expect(res).toHaveLength(1)
    expect(res[0]!.id).toBe('tx:003aAYrm3GE0Ac')
    expect(res[0]!.title).toBe('稻香')
    expect(res[0]!.artist).toBe('周杰伦')
    expect(res[0]!.duration).toBe(223)
    expect(calls.filter((u) => u.includes('client_search_cp'))).toHaveLength(0)
  })

  it('tx：新端点业务失败 → 降级到老端点，并补回 strMediaMid', async () => {
    const calls = installFetch([
      ['search_for_qq_cp', () => jsonRes({ code: 1000, data: {} })],
      ['client_search_cp', () => TX_SONG_LIST('003aAYrm3GE0Ac', true)],
    ])

    const res = await searchPlatform('tx', '稻香', 1)
    expect(res).toHaveLength(1)
    expect(res[0]!.musicInfo.strMediaMid).toBe('MEDIA_MID_001')
    expect(calls.filter((u) => u.includes('client_search_cp'))).toHaveLength(1)
  })

  it('tx：MIYIN_TX_PREFER_LEGACY=1 时老端点优先（可拿到 strMediaMid）', async () => {
    process.env.MIYIN_TX_PREFER_LEGACY = '1'
    try {
      const calls = installFetch([
        ['client_search_cp', () => TX_SONG_LIST('003aAYrm3GE0Ac', true)],
        ['search_for_qq_cp', () => TX_SONG_LIST('NEW_MID')],
      ])
      const res = await searchPlatform('tx', '稻香', 1)
      expect(res[0]!.musicInfo.strMediaMid).toBe('MEDIA_MID_001')
      expect(calls.filter((u) => u.includes('search_for_qq_cp'))).toHaveLength(0)
    } finally {
      delete process.env.MIYIN_TX_PREFER_LEGACY
    }
  })

  it('tx：两端点都失败 → 502 且两次尝试的真实原因都在 message 里', async () => {
    installFetch([
      ['search_for_qq_cp', () => jsonRes({ code: 1000, data: {} })],
      [
        'client_search_cp',
        () => {
          throw new Error('socket hang up')
        },
      ],
    ])

    await expect(searchPlatform('tx', '稻香', 1)).rejects.toSatisfy((err: unknown) => {
      const e = err as CustomError
      expect(e.statusCode).toBe(502)
      expect(e.message).toContain('tx:soso-v2')
      expect(e.message).toContain('tx:soso-cp')
      expect(e.message).toContain('socket hang up')
      expect(e.data.attempts.map((a: any) => a.kind)).toEqual(['business_error', 'network_error'])
      return true
    })
  })

  it('wy：单通道业务失败（code!==200）同样以真实原因上报，不返回空结果', async () => {
    installFetch([['music.163.com', () => jsonRes({ code: 406, msg: '需要登录' })]])
    await expect(searchPlatform('wy', '稻香', 1)).rejects.toSatisfy((err: unknown) => {
      const e = err as CustomError
      expect(e.statusCode).toBe(502)
      expect(e.message).toContain('406')
      return true
    })
  })

  it('搜索结果命中缓存后不再触发上游请求', async () => {
    const calls = installFetch([['search_for_qq_cp', () => TX_SONG_LIST('003aAYrm3GE0Ac')]])
    await searchPlatform('tx', '稻香', 1)
    const after = calls.length
    await searchPlatform('tx', '稻香', 1)
    expect(calls.length).toBe(after)
  })
})
