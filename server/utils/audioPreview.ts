import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { MIN_KBPS_ANY, estimateBitrateKbps, qualityPlausibility } from '#shared/quality'

/** 解析 interval / duration 为秒。支持 "4:28"、"1:02:03"、秒数字、毫秒大数 */
export function parseIntervalToSeconds(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 10_000 ? raw / 1000 : raw
  }
  const s = String(raw).trim()
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n) || n <= 0) return null
    return n > 10_000 ? n / 1000 : n
  }
  const parts = s.split(':').map((x) => Number(x))
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  return null
}

export function expectedDurationFromMusicInfo(musicInfo: Record<string, any>): number | null {
  return (
    parseIntervalToSeconds(musicInfo.interval) ||
    parseIntervalToSeconds(musicInfo.duration) ||
    parseIntervalToSeconds(musicInfo.dt) ||
    parseIntervalToSeconds(musicInfo.time) ||
    null
  )
}

/**
 * 判定是否疑似试听：
 * - 实际时长 < 期望的 50%
 * - 或期望 ≥90s 且实际 ≤65s（覆盖 20/30/35s 及 QQ 常见 60s 试听）
 */
export function isLikelyPreviewClip(actualSec: number, expectedSec: number): boolean {
  if (!(actualSec > 0) || !(expectedSec > 0)) return false
  if (actualSec < expectedSec * 0.5) return true
  if (expectedSec >= 90 && actualSec <= 65) return true
  return false
}

/**
 * 无期望时长时的兜底：命中平台常见固定试听时长，且体积不像整曲。
 * QQ 试听常为精确 60.0s + ~960KB@128k。
 */
export function isLikelyPreviewByAbsoluteDuration(
  actualSec: number,
  fileBytes?: number | null,
): boolean {
  if (!(actualSec > 0)) return false
  const near = (t: number, tol = 0.6) => Math.abs(actualSec - t) <= tol
  if (!(near(60) || near(30) || near(35) || near(20))) return false
  // 短于 90s 的整曲可能碰巧接近这些秒数；体积明显偏大则放过
  if (fileBytes != null && fileBytes > 2_500_000) return false
  return true
}

export function isLikelyPreviewUrl(url: string): boolean {
  return /preview|trial|clip|试听|audition|snippet|fragment|试听\d/i.test(url)
}

/** 按期望时长与最低合理码率估算「整曲」下限字节数（用于 Content-Length 预检） */
export function minFullTrackBytes(expectedSec: number, qualityHint?: string | null): number {
  // 试听常为 128k 左右；用 96kbps × 50% 时长作宽松下限，避免误杀低码率整曲
  let kbps = 96
  const q = (qualityHint || '').toLowerCase()
  if (q.includes('flac') || q === 'highest') kbps = 200
  else if (q.includes('320')) kbps = 160
  else if (q.includes('128')) kbps = 96
  return Math.floor(expectedSec * 0.5 * ((kbps * 1000) / 8))
}

export function probeAudioDurationSeconds(filePath: string): Promise<number | null> {
  if (!existsSync(filePath)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const p = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let out = ''
    p.stdout?.on('data', (c) => {
      out += String(c)
    })
    p.on('error', () => resolve(null))
    p.on('close', () => {
      const n = Number(String(out).trim())
      resolve(Number.isFinite(n) && n > 0 ? n : null)
    })
  })
}

export function previewClipError(actualSec: number, expectedSec?: number | null): Error {
  const detail =
    expectedSec && expectedSec > 0
      ? `实际 ${Math.round(actualSec)}s / 期望约 ${Math.round(expectedSec)}s`
      : `实际约 ${Math.round(actualSec)}s，疑似平台固定试听时长`
  const err = new Error(`疑似试听片段（${detail}），请换源后重试`)
  ;(err as any).code = 'PREVIEW_CLIP'
  return err
}

export function previewSizeError(contentLength: number, expectedSec: number): Error {
  const err = new Error(
    `响应体积过小（${Math.round(contentLength / 1024)}KB，期望时长约 ${Math.round(expectedSec)}s），疑似试听，请换源后重试`,
  )
  ;(err as any).code = 'PREVIEW_CLIP'
  return err
}

/**
 * 组合预算用尽时的收尾错误。
 *
 * 与上面几个的区别：那几个是「这一条路走不通」的中间态，本函数是「已经试过 N 条路」的结论 ——
 * 必须说清试了什么、为什么停，而不是笼统地让用户「请换源后重试」。
 *
 * `hasMore` 为 `true` 表示还有未试过的组合，手动重试可以继续（排除集已持久化在任务上）。
 */
export function allPreviewError(tried: number, hasMore: boolean): Error {
  const tail = hasMore
    ? '，可点「重试」继续尝试其余音源'
    : '，该曲目在当前平台可能仅对会员开放'
  const err = new Error(`已试过 ${tried} 个音源/音质组合，均只返回试听片段${tail}`)
  ;(err as any).code = 'PREVIEW_CLIP'
  return err
}

/**
 * 候选探测结论。
 *
 * - `ok`          码率配得上声称档位
 * - `implausible` 低于该档位下限（如谎报 flac24bit 的 320k mp3）→ **降级排序**但保留作兜底
 * - `preview`     低到不可能是一首歌（内容被截断）→ **硬拒绝**
 * - `unknown`     拿不到响应头信息（无 Content-Length / 无时长 / 压缩传输）→ 不作判断
 * - `error`       请求本身失败（HTTP 4xx/5xx）
 */
export type CandidateVerdict = 'ok' | 'implausible' | 'preview' | 'unknown' | 'error'

export type CandidateProbe = {
  verdict: CandidateVerdict
  contentLength: number | null
  estKbps: number | null
  reason?: string
}

/**
 * 只读响应头探测一个候选 URL —— **不消费 body**。
 *
 * 这是「择优下载」的主判据：`Content-Length ÷ 时长` 就能把真 Hi-Res（2372kbps）、
 * 真无损（933kbps）、谎报的 320k（321kbps）、试听片段（34kbps）干净地分开，
 * 而代价只是一次请求头。
 */
export async function probeCandidate(
  url: string,
  opts: {
    expectedDurationSec: number | null
    quality: string | null
    signal?: AbortSignal
    timeoutMs?: number
  },
): Promise<CandidateProbe> {
  const timeoutMs = opts.timeoutMs ?? 20000
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'miyin/0.1', Referer: 'https://www.google.com/' },
    })
    // 只读头：立刻取消 body，不下载内容
    await res.body?.cancel().catch(() => {})
    if (!res.ok) {
      return { verdict: 'error', contentLength: null, estKbps: null, reason: `HTTP ${res.status}` }
    }
    // 压缩传输时 Content-Length 是压缩后大小，不能用来估码率
    const encoding = res.headers.get('content-encoding')
    if (encoding && encoding !== 'identity') {
      return {
        verdict: 'unknown',
        contentLength: null,
        estKbps: null,
        reason: `内容被 ${encoding} 压缩，长度不可用于估码率`,
      }
    }
    const raw = Number(res.headers.get('content-length') || 0)
    const contentLength = raw > 0 ? raw : null
    const estKbps = estimateBitrateKbps(contentLength, opts.expectedDurationSec)
    if (estKbps == null) {
      return {
        verdict: 'unknown',
        contentLength,
        estKbps: null,
        reason: contentLength == null ? '无 Content-Length' : '无已知时长',
      }
    }
    if (estKbps < MIN_KBPS_ANY) {
      return {
        verdict: 'preview',
        contentLength,
        estKbps,
        reason: `估算仅 ${Math.round(estKbps)}kbps，远低于任何档位`,
      }
    }
    const plausibility = qualityPlausibility(estKbps, opts.quality)
    if (plausibility === 'implausible') {
      return {
        verdict: 'implausible',
        contentLength,
        estKbps,
        reason: `估算 ${Math.round(estKbps)}kbps 配不上声称的 ${opts.quality}`,
      }
    }
    return { verdict: plausibility === 'ok' ? 'ok' : 'unknown', contentLength, estKbps }
  } catch (err) {
    return {
      verdict: 'error',
      contentLength: null,
      estKbps: null,
      reason: String((err as Error)?.message || err),
    }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
