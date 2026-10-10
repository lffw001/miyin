declare global {
  var createError: (input: {
    statusCode?: number
    statusMessage?: string
    message?: string
    data?: unknown
  }) => Error
}

if (!globalThis.createError) {
  globalThis.createError = (input) => {
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../server/utils/db'
import { listMusicUrlCandidates } from '../server/services/musicUrlResolve'
import { resetSourceRuntimeState } from '../server/services/sourceRuntime'
import { probeCandidate } from '../server/utils/audioPreview'
import { recordSourceOutcome } from '../server/services/sourceStats'

/**
 * 这一组测试打的是**真实实现**：
 * `previewFailover.test.ts` 把整个 musicUrlResolve 模块 mock 掉了，
 * 所以 `listMusicUrlCandidates` 的枚举 / 排除 / 提前收工逻辑此前没有任何直接覆盖。
 */

/** 生成一个洛雪兼容的最小音源：按请求的档位返回不同 URL */
function writeSource(dir: string, name: string, body: string) {
  const file = join(dir, `${name}.js`)
  writeFileSync(
    file,
    `
    const { EVENT_NAMES, on, send } = globalThis.lx
    ${body}
    `,
    'utf8',
  )
  return file
}

/** 按档位映射 URL 的音源；缺失档位即抛错 */
function tieredSource(qualitys: string[], urlByTier: Record<string, string>, failTiers: string[] = []) {
  return `
  on(EVENT_NAMES.request, ({ info }) => {
    const map = ${JSON.stringify(urlByTier)}
    const fail = ${JSON.stringify(failTiers)}
    if (fail.includes(info.type)) throw new Error('tier unavailable')
    const url = map[info.type]
    if (!url) throw new Error('unsupported tier: ' + info.type)
    return url
  })
  send(EVENT_NAMES.inited, { sources: { tx: { qualitys: ${JSON.stringify(qualitys)} } } })
  `
}

describe('listMusicUrlCandidates（真实取链层）', () => {
  let prevDataDir: string | undefined
  let dir: string
  let server: Server
  let baseUrl: string
  let requestCount: { total: number } = { total: 0 }

  beforeEach(async () => {
    resetSourceRuntimeState()
    closeDb()
    prevDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'miyin-cand-'))
    dir = mkdtempSync(join(tmpdir(), 'miyin-cand-src-'))
    requestCount = { total: 0 }
    getDb()

    server = createServer((req, res) => {
      requestCount.total += 1
      const url = req.url || ''
      if (url.includes('/nolen')) {
        // 不给 content-length：探测应判为 unknown 而不是崩
        res.writeHead(200, { 'content-type': 'audio/flac' })
        res.end(Buffer.from('fLaC'))
        return
      }
      if (url.includes('/slow-body')) {
        // 只发响应头、永不发/结束 body。
        // 必须 flushHeaders()：writeHead 只是暂存，不首次写出就不会真的发出头，
        // fetch 也就拿不到响应 —— 那样测的就不是"不读 body"，而是"服务端没发头"
        res.writeHead(200, { 'content-type': 'audio/flac', 'content-length': String(50 * 1024 * 1024) })
        res.flushHeaders()
        return
      }
      if (url.includes('/gzip')) {
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': '1024' })
        res.end(Buffer.alloc(1024))
        return
      }
      if (url.includes('/boom')) {
        res.writeHead(500)
        res.end('err')
        return
      }
      const size = url.includes('/small') ? 300 * 1024 : 7 * 1024 * 1024
      res.writeHead(200, { 'content-type': 'audio/flac', 'content-length': String(size) })
      res.end(Buffer.alloc(Math.min(size, 4096), 0x41))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    closeDb()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (prevDataDir) process.env.DATA_DIR = prevDataDir
    else delete process.env.DATA_DIR
  })

  function addSource(id: string, localPath: string) {
    getDb()
      .prepare(
        `INSERT INTO sources (id, name, url, local_path, enabled, status, platforms, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'ok', ?, datetime('now'), datetime('now'))`,
      )
      .run(id, id, `http://example.com/${id}.js`, localPath, JSON.stringify(['tx']))
  }

  async function list(opts: {
    limit?: number
    exclude?: ReadonlySet<string>
    onCandidate?: (c: { sourceId: string; quality: string; url: string }) => Promise<boolean | void> | boolean | void
    quality?: string
  } = {}) {
    return listMusicUrlCandidates({
      platform: 'tx',
      musicInfo: { songmid: '1', interval: '3:43' },
      quality: opts.quality ?? 'highest',
      limit: opts.limit,
      exclude: opts.exclude,
      onCandidate: opts.onCandidate,
    })
  }

  it('按「档位从高到低」枚举出多个候选（不再只返回第一个）', async () => {
    addSource(
      'src-a',
      writeSource(dir, 'a', tieredSource(['flac24bit', 'flac', '320k'], {
        flac24bit: `${baseUrl}/a-hires.flac`,
        flac: `${baseUrl}/a.flac`,
        '320k': `${baseUrl}/a.mp3`,
      })),
    )
    const res = await list({ limit: 10 })
    expect(res.candidates.map((c) => c.quality)).toEqual(['flac24bit', 'flac', '320k'])
    expect(res.candidates.every((c) => c.sourceId === 'src-a')).toBe(true)
    expect(res.truncated).toBe(false)
  })

  it('exclude 跳过指定组合，并计入 excludedSkips', async () => {
    addSource(
      'src-a',
      writeSource(dir, 'a', tieredSource(['flac24bit', 'flac'], {
        flac24bit: `${baseUrl}/a-hires.flac`,
        flac: `${baseUrl}/a.flac`,
      })),
    )
    const res = await list({ limit: 10, exclude: new Set(['src-a@flac24bit']) })
    expect(res.candidates.map((c) => c.quality)).toEqual(['flac'])
    expect(res.excludedSkips).toBe(1)
  })

  it('全部组合都被排除时不返回候选，且 truncated 为 false（如实告知没有新路）', async () => {
    addSource(
      'src-a',
      writeSource(dir, 'a', tieredSource(['flac24bit', 'flac'], {
        flac24bit: `${baseUrl}/a-hires.flac`,
        flac: `${baseUrl}/a.flac`,
      })),
    )
    const res = await list({ limit: 10, exclude: new Set(['src-a@flac24bit', 'src-a@flac']) })
    expect(res.candidates).toEqual([])
    expect(res.excludedSkips).toBe(2)
    expect(res.truncated).toBe(false)
  })

  it('limit 截断枚举，truncated 为 true（表示重试仍有新路可走）', async () => {
    addSource(
      'src-a',
      writeSource(dir, 'a', tieredSource(['flac24bit', 'flac', '320k', '128k'], {
        flac24bit: `${baseUrl}/a-hires.flac`,
        flac: `${baseUrl}/a.flac`,
        '320k': `${baseUrl}/a.mp3`,
        '128k': `${baseUrl}/a-low.mp3`,
      })),
    )
    const res = await list({ limit: 2 })
    expect(res.candidates.length).toBe(2)
    expect(res.truncated).toBe(true)
  })

  it('onCandidate 返回 false → 立即停止枚举并置 truncated', async () => {
    addSource(
      'src-a',
      writeSource(dir, 'a', tieredSource(['flac24bit', 'flac', '320k'], {
        flac24bit: `${baseUrl}/a-hires.flac`,
        flac: `${baseUrl}/a.flac`,
        '320k': `${baseUrl}/a.mp3`,
      })),
    )
    const seen: string[] = []
    const res = await list({
      limit: 10,
      onCandidate: (c) => {
        seen.push(c.quality)
        return false
      },
    })
    expect(seen).toEqual(['flac24bit'])
    expect(res.candidates.length).toBe(1)
    expect(res.truncated).toBe(true)
  })

  it('某档位取链失败只跳过该档位，其余档位照常枚举（异常路径）', async () => {
    addSource(
      'src-a',
      writeSource(
        dir,
        'a',
        tieredSource(
          ['flac24bit', 'flac', '320k'],
          { '320k': `${baseUrl}/a.mp3` },
          ['flac24bit', 'flac'], // 高码率两档抛错
        ),
      ),
    )
    const res = await list({ limit: 10 })
    expect(res.candidates.map((c) => c.quality)).toEqual(['320k'])
    // 失败的档位被记进 errors，供最终报错展示
    expect(res.errors.join(' ')).toContain('tier unavailable')
  })

  it('全部音源取链失败 → 候选为空，errors 非空', async () => {
    addSource('src-a', writeSource(dir, 'a', tieredSource(['flac'], {}, ['flac'])))
    const res = await list({ limit: 10 })
    expect(res.candidates).toEqual([])
    expect(res.errors.length).toBeGreaterThan(0)
    expect(res.loadedCount).toBe(1)
  })

  it('音源按实测评分排序：高分音源的候选排在前面（决定"先探谁"）', async () => {
    addSource(
      'src-low',
      writeSource(dir, 'low', tieredSource(['flac'], { flac: `${baseUrl}/low.flac` })),
    )
    addSource(
      'src-high',
      writeSource(dir, 'high', tieredSource(['flac'], { flac: `${baseUrl}/high.flac` })),
    )
    // 给 src-high 造出"稳定交付高码率"的历史，src-low 造出"常给试听"的历史
    recordSourceOutcome({ sourceId: 'src-high', platform: 'tx', outcome: 'success', kbps: 2372 })
    recordSourceOutcome({ sourceId: 'src-high', platform: 'tx', outcome: 'success', kbps: 2200 })
    for (let i = 0; i < 3; i++) {
      recordSourceOutcome({ sourceId: 'src-low', platform: 'tx', outcome: 'preview' })
    }
    const res = await list({ limit: 10 })
    expect(res.candidates[0]!.sourceId).toBe('src-high')
  })

  it('固定音质档位：只枚举该档，即使音源未宣称支持也仍尝试', async () => {
    addSource(
      'src-a',
      writeSource(dir, 'a', tieredSource(['128k'], { '128k': `${baseUrl}/a-low.mp3` })),
    )
    const res = await list({ limit: 10, quality: 'flac' })
    // 未宣称 flac → 走到 getMusicUrl 报 unsupported tier，候选为空但错误信息完整
    expect(res.candidates).toEqual([])
    expect(res.errors.join(' ')).toContain('unsupported tier')
  })
})

describe('probeCandidate（只读响应头）', () => {
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    server = createServer((req, res) => {
      const url = req.url || ''
      if (url.includes('/nolen')) {
        res.writeHead(200, { 'content-type': 'audio/flac' })
        res.end(Buffer.from('fLaC'))
        return
      }
      if (url.includes('/slow-body')) {
        // 同上：发头但不发 body，用于证明探测不消费 body
        res.writeHead(200, { 'content-type': 'audio/flac', 'content-length': String(50 * 1024 * 1024) })
        res.flushHeaders()
        return // 永不结束 body
      }
      if (url.includes('/gzip')) {
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': '1024' })
        res.end(Buffer.alloc(1024))
        return
      }
      if (url.includes('/boom')) {
        res.writeHead(500)
        res.end('err')
        return
      }
      const size = url.includes('/small') ? 300 * 1024 : 7 * 1024 * 1024
      res.writeHead(200, { 'content-type': 'audio/flac', 'content-length': String(size) })
      res.end(Buffer.alloc(4096, 0x41))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('码率达标 → ok；过低 → preview；配不上档位 → implausible', async () => {
    const full = await probeCandidate(`${baseUrl}/full.flac`, {
      expectedDurationSec: 60,
      quality: 'flac',
    })
    expect(full.verdict).toBe('ok')
    expect(full.contentLength).toBe(7 * 1024 * 1024)

    const small = await probeCandidate(`${baseUrl}/small.flac`, {
      expectedDurationSec: 60,
      quality: 'flac',
    })
    // 300KB / 60s ≈ 41kbps → 低于 MIN_KBPS_ANY，属"内容被截断"
    expect(small.verdict).toBe('preview')

    const implausible = await probeCandidate(`${baseUrl}/full.flac`, {
      expectedDurationSec: 600,
      quality: 'flac24bit',
    })
    // 7MB / 600s ≈ 98kbps → 高于 MIN_KBPS_ANY 但远低于 24bit 的 1400 → 只降级、不硬拒
    expect(implausible.verdict).toBe('implausible')
  })

  it('无 Content-Length → unknown（不误判为试听）', async () => {
    const r = await probeCandidate(`${baseUrl}/nolen`, {
      expectedDurationSec: 60,
      quality: 'flac',
    })
    expect(r.verdict).toBe('unknown')
    expect(r.contentLength).toBeNull()
    expect(r.estKbps).toBeNull()
  })

  it('压缩传输 → unknown（Content-Length 是压缩后大小，不能用来估码率）', async () => {
    const r = await probeCandidate(`${baseUrl}/gzip`, {
      expectedDurationSec: 60,
      quality: 'flac',
    })
    expect(r.verdict).toBe('unknown')
    expect(r.reason).toContain('gzip')
  })

  it('无已知时长 → unknown（无法估算）', async () => {
    const r = await probeCandidate(`${baseUrl}/full.flac`, {
      expectedDurationSec: null,
      quality: 'flac',
    })
    expect(r.verdict).toBe('unknown')
    expect(r.reason).toContain('时长')
  })

  it('HTTP 500 → error（不抛异常，由调用方跳过该候选）', async () => {
    const r = await probeCandidate(`${baseUrl}/boom`, {
      expectedDurationSec: 60,
      quality: 'flac',
    })
    expect(r.verdict).toBe('error')
    expect(r.reason).toContain('500')
  })

  it('连接失败 → error（不冒泡异常）', async () => {
    const r = await probeCandidate('http://127.0.0.1:1/nope.flac', {
      expectedDurationSec: 60,
      quality: 'flac',
    })
    expect(r.verdict).toBe('error')
  })

  it('只读响应头：服务端不结束 body 也能返回（证明没有消费 body）', async () => {
    const started = Date.now()
    const r = await probeCandidate(`${baseUrl}/slow-body`, {
      expectedDurationSec: 60,
      quality: 'flac',
      timeoutMs: 3000,
    })
    // 若实现去读 body，这里会一直挂到 timeout → verdict 变 error
    expect(r.verdict).toBe('ok')
    expect(r.contentLength).toBe(50 * 1024 * 1024)
    expect(Date.now() - started).toBeLessThan(2500)
  })

  it('已 abort 的信号 → error，不长时间阻塞', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const r = await probeCandidate(`${baseUrl}/full.flac`, {
      expectedDurationSec: 60,
      quality: 'flac',
      signal: ctrl.signal,
    })
    expect(r.verdict).toBe('error')
  })
})
