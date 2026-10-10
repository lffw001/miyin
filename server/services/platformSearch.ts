import { PLATFORM_DISPLAY, platformLabel } from '#shared/platforms'
import { SEARCH_PAGE_SIZE } from '#shared/searchPagination'
import {
  DEFAULT_UA,
  parseLooseJson,
  runChannelMatrix,
  summarizeAttempts,
  UpstreamMatrixError,
  type ChannelAttempt,
  type ChannelContext,
  type UpstreamChannel,
} from './upstreamChannels'

// 容错 JSON 解析已下沉到 upstreamChannels，这里保持既有导出路径不变
export { parseLooseJson }

export type SearchTrack = {
  id: string
  externalId: string
  title: string
  artist: string
  album: string
  albumId?: string
  duration: number
  platform: string
  cover?: string
  qualitys: string[]
  musicInfo: Record<string, any>
  sourceId?: string
  sourceName?: string
}

const PAGE_MAX_ITEMS = SEARCH_PAGE_SIZE

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

export function artistsJoin(list: any, key = 'name') {
  if (!list) return '未知'
  if (typeof list === 'string') return cleanArtist(list)
  if (Array.isArray(list)) {
    return cleanArtist(list.map((a) => a?.[key] || a).filter(Boolean).join(' / ') || '未知')
  }
  return cleanArtist(String(list))
}

/** 清洗脏歌手字段：如「周杰伦- / A-LNK」→「周杰伦」 */
export function cleanArtist(raw: string) {
  let s = String(raw || '').trim()
  if (!s) return '未知'
  // 去掉「名- / 后缀」或「名-/后缀」
  s = s.replace(/\s*-\s*\/\s*.+$/, '')
  // 去掉末尾孤立的 - /
  s = s.replace(/[\s\-\/]+$/g, '')
  // 合并多余分隔
  s = s.replace(/\s*\/\s*/g, ' / ').replace(/\s{2,}/g, ' ').trim()
  return s || '未知'
}

function decode(s: any) {
  if (s == null) return ''
  try {
    return decodeURIComponent(String(s).replace(/\+/g, '%20'))
  } catch {
    return String(s)
  }
}

function formatInterval(ms: number) {
  return formatIntervalFromSec(Math.round((ms || 0) / 1000))
}

function formatIntervalFromSec(secRaw: number) {
  const sec = Math.max(0, Math.round(secRaw || 0))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/* ------------------------------------------------------------------ *
 * 各平台映射函数
 * ------------------------------------------------------------------ */

/**
 * 网易云歌曲映射。
 *
 * 兼容两种上游字段形态：
 * - `cloudsearch/pc`（主通道）：`ar` / `al`（`al.picUrl` 带封面）
 * - `api/search/get/web`（备用通道）：`artists` / `album`
 *   注意备用通道的 `album` **只有 `picId` 没有 `picUrl`** → 封面缺失，由
 *   `enrichWyTracks` 在「主通道失败」时批量补齐（正常情况下不会触发）。
 */
export function mapWySong(s: any): SearchTrack {
  const id = String(s.id)
  const album = s.al || s.album || {}
  const artist = artistsJoin(s.ar || s.artists)
  const cover = album.picUrl || undefined
  return {
    id: `wy:${id}`,
    externalId: id,
    title: s.name || '未知',
    artist,
    album: album.name || '',
    albumId: album.id ? String(album.id) : undefined,
    duration: Math.round((s.dt || s.duration || 0) / 1000),
    platform: 'wy',
    cover,
    qualitys: ['128k', '320k', 'flac'],
    musicInfo: {
      name: s.name,
      singer: artist,
      albumName: album.name || '',
      songmid: id,
      hash: id,
      source: 'wy',
      img: cover,
      interval: formatInterval(s.dt || s.duration),
    },
  }
}

/** 酷我：`search.kuwo.cn/r.s`（伪 JSON） */
export function mapKwSong(s: any): SearchTrack {
  const id = String(s.MUSICRID || s.DC_TARGETID || '').replace('MUSIC_', '')
  const pic = s.web_albumpic_short
  return {
    id: `kw:${id}`,
    externalId: id,
    title: decode(s.NAME || s.SONGNAME),
    artist: decode(s.ARTIST),
    album: decode(s.ALBUM),
    albumId: s.ALBUMID ? String(s.ALBUMID).replace(/^ALBUM_/, '') : undefined,
    duration: Number(s.DURATION || 0),
    platform: 'kw',
    cover: pic ? `https://img2.kuwo.cn/star/albumcover/${pic}` : undefined,
    qualitys: ['128k', '320k'],
    musicInfo: {
      name: decode(s.NAME || s.SONGNAME),
      singer: decode(s.ARTIST),
      albumName: decode(s.ALBUM),
      songmid: id,
      hash: id,
      source: 'kw',
      img: pic ? `https://img2.kuwo.cn/star/albumcover/${pic}` : undefined,
      interval: formatIntervalFromSec(Number(s.DURATION || 0)),
    },
  }
}

/** 酷狗封面尺寸占位符的替换值（与旧 `Image` 字段的 `{size}` 用法一致） */
const KG_COVER_SIZE = '240'

/**
 * 从搜索条目里取封面 URL。
 *
 * ⚠️ 酷狗 v3 端点的封面**不在顶层**，而是藏在 `trans_param.union_cover`，
 * 形如 `http://imge.kugou.com/stdmusic/{size}/20241118/xxx.jpg`，需替换 `{size}`。
 * 实测 4 组关键词共 120 条，`union_cover` 覆盖率 **100%**，故无需额外请求。
 * 旧 `complexsearch` 顶层的 `Image` 字段已随签名校验失效。
 */
function kgCoverFrom(entry: any): string | undefined {
  const raw = entry?.trans_param?.union_cover
  if (typeof raw !== 'string' || !raw) return undefined
  return raw.includes('{size}') ? raw.replace('{size}', KG_COVER_SIZE) : raw
}

/**
 * 酷狗「小驼峰」结构（mobileservice / mobilecdn v3）。
 */
export function mapKgMobileSong(s: any): SearchTrack {
  const hash = String(s.hash || s.sqhash || s['320hash'] || '')
  const title = s.songname || s.songname_original || '未知'
  const artist = s.singername || '未知'
  const album = s.album_name || ''
  const cover = kgCoverFrom(s)
  return {
    id: `kg:${hash}`,
    externalId: hash,
    title,
    artist,
    album,
    albumId: s.album_id ? String(s.album_id) : undefined,
    duration: Number(s.duration || 0),
    platform: 'kg',
    cover,
    qualitys: ['128k', '320k'],
    musicInfo: {
      name: title,
      singer: artist,
      albumName: album,
      hash,
      songmid: hash,
      source: 'kg',
      img: cover,
      interval: formatIntervalFromSec(Number(s.duration || 0)),
    },
  }
}

/** 酷狗「大驼峰」结构（旧 complexsearch v2；当前上游已加签名校验，保留为末级通道） */
export function mapKgLegacySong(s: any): SearchTrack {
  const hash = String(s.FileHash || s.HQFileHash || '')
  return {
    id: `kg:${hash}`,
    externalId: hash,
    title: s.SongName || s.OriSongName || '未知',
    artist: s.SingerName || artistsJoin(s.Singers, 'name'),
    album: s.AlbumName || '',
    albumId: s.AlbumID ? String(s.AlbumID) : undefined,
    duration: Number(s.Duration || 0),
    platform: 'kg',
    cover: s.Image?.replace('{size}', '240'),
    qualitys: ['128k', '320k'],
    musicInfo: {
      name: s.SongName,
      singer: s.SingerName,
      albumName: s.AlbumName,
      hash,
      songmid: hash,
      source: 'kg',
      img: s.Image?.replace('{size}', '240'),
      interval: formatIntervalFromSec(Number(s.Duration || 0)),
    },
  }
}

/**
 * QQ 音乐搜索结果映射。
 * `search_for_qq_cp` 与 `client_search_cp` 的 song 列表字段结构一致，
 * 唯一差别是老接口额外返回 `strMediaMid`（新接口无此字段）。
 */
export function mapTxSong(s: any): SearchTrack {
  const mid = String(s.songmid || s.mid || '')
  const cover = s.albummid
    ? `https://y.qq.com/music/photo_new/T002R300x300M000${s.albummid}.jpg`
    : undefined
  return {
    id: `tx:${mid}`,
    externalId: mid,
    title: s.songname || s.name || '未知',
    artist: artistsJoin(s.singer),
    album: s.albumname || '',
    albumId: s.albummid ? String(s.albummid) : undefined,
    duration: Number(s.interval || 0),
    platform: 'tx',
    cover,
    qualitys: ['128k', '320k'],
    musicInfo: {
      name: s.songname || s.name,
      singer: artistsJoin(s.singer),
      albumName: s.albumname,
      songmid: mid,
      hash: mid,
      songid: s.songid || s.id,
      strMediaMid: s.strMediaMid || s.media_mid,
      source: 'tx',
      img: cover,
      interval: formatIntervalFromSec(Number(s.interval || 0)),
    },
  }
}

/* ------------------------------------------------------------------ *
 * 通道定义（接口矩阵）
 * ------------------------------------------------------------------ */

const QQ_HEADERS = { Referer: 'https://y.qq.com/' }

/* ---------------------------- tx 高音质增强 ---------------------------- *
 *
 * 问题：`search_for_qq_cp`（新端点，快）**不返回 `strMediaMid` / `media_mid`**，
 * 而 `media_mid` 是 QQ 高音质（flac / Hi-Res）取链的关键参数 —— 缺了它，
 * 洛雪音源脚本只能拿到 320k，取不到无损。
 *
 * 已验证的解法：`u.y.qq.com/cgi-bin/musicu.fcg` 的
 * `music.trackInfo.UniformRuleCtrl / CgiGetTrackInfo` 支持**一次请求批量查询**，
 * 返回的 `file.media_mid` 与老端点 `strMediaMid` **逐条一致**
 * （实测《稻香》`0020wJDo3cx0j3`、《搁浅》`004UlK9x0jeuow` 全部吻合）。
 *
 * 额外收益：`file.size_*` 给出了该曲**真实可得的档位**
 * （`size_hires` / `size_flac` / `size_ape` / `size_320mp3` / `size_128mp3`），
 * 可据此把硬编码的 `qualitys: ['128k','320k']` 换成准确值。
 *
 * 成本：整页 30 首一次请求，实测 **55–182ms**（远小于老端点的 3.1s）。
 * --------------------------------------------------------------------- */

/** 一次批量查询最多带多少首（实测 30 首正常；留余量防上游限流） */
const TX_TRACKINFO_CHUNK = 50

/**
 * 由 `file.size_*` 反推真实可得档位，取值对齐 `shared/quality.ts` 的 `QUALITY_LADDER`。
 */
export function txQualitysFromFile(file: any): string[] {
  if (!file || typeof file !== 'object') return ['128k', '320k']
  const out: string[] = []
  if (Number(file.size_128mp3) > 0) out.push('128k')
  if (Number(file.size_320mp3) > 0) out.push('320k')
  if (Number(file.size_flac) > 0 || Number(file.size_ape) > 0) out.push('flac')
  if (Number(file.size_hires) > 0) out.push('flac24bit')
  return out.length ? out : ['128k', '320k']
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * 批量拉取 songmid 的 `file` 信息（含 `media_mid` 与各档位体积）。
 * 单块失败不抛出：降级为「这一块没增强」，避免整个搜索失败。
 */
async function fetchTxTrackInfo(mids: string[]): Promise<Map<string, any>> {
  const result = new Map<string, any>()
  for (const part of chunk(mids, TX_TRACKINFO_CHUNK)) {
    const payload = {
      comm: { ct: 24, cv: 0 },
      req_1: {
        module: 'music.trackInfo.UniformRuleCtrl',
        method: 'CgiGetTrackInfo',
        param: { ids: part.map(() => 0), types: part.map(() => 0), mids: part },
      },
    }
    const url =
      'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=' +
      encodeURIComponent(JSON.stringify(payload))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': DEFAULT_UA, ...QQ_HEADERS },
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = parseLooseJson(await res.text())
      const subCode = data?.req_1?.code
      if (subCode !== undefined && subCode !== 0) {
        throw new Error(`trackinfo code ${subCode}`)
      }
      for (const t of data?.req_1?.data?.tracks || []) {
        if (t?.mid) result.set(String(t.mid), t)
      }
    } finally {
      clearTimeout(timer)
    }
  }
  return result
}

/**
 * tx 搜索结果后置增强：回填 `media_mid`（高音质取链必需）与真实音质档位。
 *
 * 幂等且不破坏原字段：仅补 `musicInfo.strMediaMid` / `musicInfo.media_mid`
 * 与 `qualitys`；查不到的条目原样保留。
 */
export async function enrichTxTracks(items: SearchTrack[]): Promise<SearchTrack[]> {
  const mids = items.map((t) => t.externalId).filter(Boolean)
  if (!mids.length) return items
  const info = await fetchTxTrackInfo(mids)
  if (!info.size) return items

  for (const t of items) {
    const track = info.get(t.externalId)
    const file = track?.file
    const mediaMid = file?.media_mid
    if (mediaMid) {
      t.musicInfo.strMediaMid = mediaMid
      t.musicInfo.media_mid = mediaMid
    }
    if (file) {
      t.qualitys = txQualitysFromFile(file)
      t.musicInfo.qualitys = t.qualitys
      if (Number(file.size_flac) > 0 || Number(file.size_hires) > 0) {
        t.musicInfo.hasLossless = true
      }
    }
  }
  return items
}

/** 网易云批量详情一次最多带多少 id（实测 60 个 / 84ms 正常） */
const WY_DETAIL_CHUNK = 50

/**
 * 网易云后置增强：**仅在封面缺失时**批量补封面。
 *
 * - 主通道 `cloudsearch/pc` 自带 `al.picUrl` → `missing` 为空 → **不发任何请求**（正常路径零开销）
 * - 只有走到备用通道（`album` 只有 `picId`、无 `picUrl`）才触发，
 *   用 `api/song/detail?ids=[...]` 一次补齐（实测 60 个 id / 84ms，60/60 带 `album.picUrl`）
 */
export async function enrichWyTracks(items: SearchTrack[]): Promise<SearchTrack[]> {
  const missing = items.filter((t) => !t.cover)
  if (!missing.length) return items

  const covers = new Map<string, string>()
  for (const part of chunk(missing.map((t) => t.externalId).filter(Boolean), WY_DETAIL_CHUNK)) {
    const nums = part.map((x) => Number(x)).filter((n) => Number.isFinite(n))
    if (!nums.length) continue
    const url =
      'https://music.163.com/api/song/detail?ids=' + encodeURIComponent(JSON.stringify(nums))
    const res = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = parseLooseJson(await res.text())
    for (const s of data?.songs || []) {
      const pic = s?.album?.picUrl || s?.al?.picUrl
      if (s?.id && pic) covers.set(String(s.id), pic)
    }
  }
  if (!covers.size) return items

  for (const t of missing) {
    const pic = covers.get(t.externalId)
    if (pic) {
      t.cover = pic
      t.musicInfo.img = pic
    }
  }
  return items
}

/** QQ：新端点是否优先（默认是）。设 MIYIN_TX_PREFER_LEGACY=1 可回退为老端点优先。 */
function txPreferLegacy(): boolean {
  const v = String(process.env.MIYIN_TX_PREFER_LEGACY ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function txChannels(): UpstreamChannel<SearchTrack>[] {
  const v2: UpstreamChannel<SearchTrack> = {
    id: 'tx:soso-v2',
    label: 'QQ搜索 search_for_qq_cp',
    platform: 'tx',
    priority: 1,
    buildUrl: (c) =>
      `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w=${encodeURIComponent(c.keyword)}&p=${c.page}&n=${PAGE_MAX_ITEMS}&format=json`,
    headers: QQ_HEADERS,
    detectUpstreamError: (d: any) => (d?.code !== undefined && d.code !== 0 ? `code ${d.code}` : null),
    parse: (d: any) =>
      (d?.data?.song?.list || []).map(mapTxSong).filter((t: SearchTrack) => t.externalId),
  }
  const legacy: UpstreamChannel<SearchTrack> = {
    id: 'tx:soso-cp',
    label: 'QQ搜索 client_search_cp',
    platform: 'tx',
    priority: 2,
    // 老端点明显更慢（实测均值 ~3.1s vs ~0.2s），仅作为备用
    timeoutMs: 15_000,
    buildUrl: (c) =>
      `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(c.keyword)}&p=${c.page}&n=${PAGE_MAX_ITEMS}&format=json`,
    headers: QQ_HEADERS,
    detectUpstreamError: (d: any) => (d?.code !== undefined && d.code !== 0 ? `code ${d.code}` : null),
    parse: (d: any) =>
      (d?.data?.song?.list || []).map(mapTxSong).filter((t: SearchTrack) => t.externalId),
  }
  if (txPreferLegacy()) {
    // 老端点优先（能拿到 strMediaMid），新端点退为备用并收紧超时
    return [legacy, { ...v2, priority: 2, timeoutMs: 6_000 }]
  }
  return [v2, legacy]
}

const KG_HEADERS = { Referer: 'https://www.kugou.com/' }

/**
 * 酷狗业务态错误探测。`okStatuses` 必须按端点给定：
 * v3 系列以 `status=1` 为成功，旧 complexsearch v2 以 `status=0` 为成功信封。
 * 除 status 外还检查 `error_code` / `errcode`（如 `error_code=20006 err signature`）。
 */
export function kgErrorDetector(okStatuses: number[]) {
  return (d: any): string | null => {
    if (!d || typeof d !== 'object') return null
    if (d.error_code && String(d.error_code) !== '0') {
      return `${d.error_msg || d.error || 'upstream error'} (error_code=${d.error_code})`
    }
    if (d.errcode && String(d.errcode) !== '0') {
      return `${d.error || d.error_msg || 'upstream error'} (errcode=${d.errcode})`
    }
    if (d.status !== undefined && !okStatuses.includes(Number(d.status))) {
      return `upstream status=${d.status}`
    }
    return null
  }
}

/**
 * 酷我业务态错误探测（防御性）。
 *
 * 实测 `search.kuwo.cn/r.s` **不返回业务错误码**：非法参数也只是 `HIT:'0'` + `abslist:[]`
 * （合法的"无结果"）。但酷我**新版 web 接口**会返回 `{success:false, message:"The request is illegal!"}`，
 * 说明该平台确实存在业务态失败信封。这里做防御性识别，避免将来 r.s 改版后
 * 「HTTP 200 + success:false」被当成空结果静默吞掉（issue #34 同类风险）。
 *
 * ⚠️ 绝不能把 `HIT:'0'` 判成错误 —— 那是合法的"没搜到"。
 */
export function kwErrorDetector(d: any): string | null {
  if (!d || typeof d !== 'object') return null
  if (d.success === false) return String(d.message || d.msg || 'request rejected')
  if (d.error_code && String(d.error_code) !== '0') {
    return `${d.error_msg || d.error || 'upstream error'} (error_code=${d.error_code})`
  }
  if (d.code !== undefined && Number(d.code) >= 400) return `code ${d.code}`
  if (d.errcode && String(d.errcode) !== '0') return `${d.error || 'upstream error'} (errcode=${d.errcode})`
  return null
}

/** 酷狗 v3 小驼峰端点（mobileservice / mobilecdn） */
function kgV3Channel(id: string, label: string, origin: string, priority: number, extraQs: string): UpstreamChannel<SearchTrack> {
  return {
    id,
    label,
    platform: 'kg',
    priority,
    buildUrl: (c) =>
      `${origin}/api/v3/search/song?format=json&keyword=${encodeURIComponent(c.keyword)}&page=${c.page}&pagesize=${PAGE_MAX_ITEMS}&showtype=1${extraQs}`,
    headers: KG_HEADERS,
    detectUpstreamError: kgErrorDetector([1]),
    parse: (d: any) =>
      (d?.data?.info || [])
        .map(mapKgMobileSong)
        .filter((t: SearchTrack) => t.externalId),
  }
}

function kgChannels(): UpstreamChannel<SearchTrack>[] {
  return [
    // 主通道：实测 HTTPS 可用，v3 无需签名
    kgV3Channel('kg:mobileservice-v3', '酷狗搜索 mobileservice v3', 'https://mobileservice.kugou.com', 1, ''),
    // 备用：仅 HTTP 可用（HTTPS 握手失败），故显式降级到明文
    kgV3Channel('kg:mobilecdn-v3', '酷狗搜索 mobilecdn v3', 'http://mobilecdn.kugou.com', 2, '&version=9108'),
    // 末级：旧 v2，上游已加签名校验（error_code=20006），保留以备恢复
    {
      id: 'kg:complexsearch-v2',
      label: '酷狗搜索 complexsearch v2（旧）',
      platform: 'kg',
      priority: 3,
      buildUrl: (c) =>
        `https://complexsearch.kugou.com/v2/search/song?keyword=${encodeURIComponent(c.keyword)}&page=${c.page}&pagesize=${PAGE_MAX_ITEMS}&platform=WebFilter`,
      headers: KG_HEADERS,
      detectUpstreamError: kgErrorDetector([0]),
      parse: (d: any) =>
        (d?.data?.lists || []).map(mapKgLegacySong).filter((t: SearchTrack) => t.externalId),
    },
  ]
}

/**
 * 网易云搜索通道矩阵。
 *
 * - P1 `cloudsearch/pc`：字段 `ar` / `al`（`al.picUrl` 带封面），实测 ~284ms
 * - P2 `api/search/get/web`：字段 `artists` / `album`，**`album` 无 `picUrl`**（只有 `picId`）
 *   → 结果集等价但丢封面，靠 `enrichWyTracks` 批量补回
 *
 * ⚠️ 实测网易**不要求 `Referer`**（去掉也返回 200），与 QQ / 酷狗不同；
 * 这里仍带上以对齐浏览器行为。
 */
function wyChannels(): UpstreamChannel<SearchTrack>[] {
  const detect = (d: any) => (d?.code !== undefined && d.code !== 200 ? `code ${d.code}` : null)
  return [
    {
      id: 'wy:cloudsearch-pc',
      label: '网易云 cloudsearch',
      platform: 'wy',
      priority: 1,
      buildUrl: (c) => {
        const offset = (c.page - 1) * PAGE_MAX_ITEMS
        return `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(c.keyword)}&type=1&limit=${PAGE_MAX_ITEMS}&offset=${offset}`
      },
      headers: { Referer: 'https://music.163.com/' },
      detectUpstreamError: detect,
      parse: (d: any) => (d?.result?.songs || []).map(mapWySong),
    },
    {
      id: 'wy:search-get-web',
      label: '网易云 search/get/web（备用）',
      platform: 'wy',
      priority: 2,
      buildUrl: (c) => {
        const offset = (c.page - 1) * PAGE_MAX_ITEMS
        return `https://music.163.com/api/search/get/web?s=${encodeURIComponent(c.keyword)}&type=1&limit=${PAGE_MAX_ITEMS}&offset=${offset}`
      },
      headers: { Referer: 'https://music.163.com/' },
      detectUpstreamError: detect,
      parse: (d: any) => (d?.result?.songs || []).map(mapWySong),
    },
  ]
}

function kwChannels(): UpstreamChannel<SearchTrack>[] {
  return [
    {
      id: 'kw:r.s',
      label: '酷我 r.s',
      platform: 'kw',
      priority: 1,
      buildUrl: (c) =>
        `https://search.kuwo.cn/r.s?all=${encodeURIComponent(c.keyword)}&ft=music&client=kt&pn=${c.page - 1}&rn=${PAGE_MAX_ITEMS}&rformat=json&encoding=utf8`,
      detectUpstreamError: kwErrorDetector,
      parse: (d: any) => (d?.abslist || []).map(mapKwSong),
    },
    // ⚠️ 酷我暂无可用备用搜索端点（实测：新版 web 接口返回 "The request is illegal!"
    //    需 csrf/token；mobi.kuwo.cn 已 404）→ 保持单通道，靠业务态探测保证不静默
  ]
}

const platformChannels: Record<string, () => UpstreamChannel<SearchTrack>[]> = {
  wy: wyChannels,
  kw: kwChannels,
  kg: kgChannels,
  tx: txChannels,
}

/** 暴露接口矩阵，供健康检查 / 排障页面展示 */
export function describePlatformChannels(platform: string) {
  const factory = platformChannels[platform]
  if (!factory) return []
  return factory().map((c) => ({
    id: c.id,
    label: c.label,
    platform: c.platform,
    priority: c.priority,
  }))
}

/* ------------------------------------------------------------------ *
 * 搜索入口
 * ------------------------------------------------------------------ */

const searchCache = new Map<string, { at: number; items: SearchTrack[] }>()
const SEARCH_TTL_MS = 60_000
const SEARCH_CACHE_MAX = 800

export function clearSearchCache() {
  searchCache.clear()
}

/**
 * 各平台的后置增强：通道命中后补一次批量查询，把「拿不到但很关键」的字段补齐。
 *
 * - `tx`：批量补 `media_mid`（高音质取链必需）与真实音质档位
 * - `wy`：仅当封面缺失（走了备用通道）时批量补封面
 * - `kg`：封面已在 `trans_param.union_cover` 里随搜索返回，无需额外请求
 */
const platformEnrichers: Record<string, (items: SearchTrack[]) => Promise<SearchTrack[]>> = {
  tx: enrichTxTracks,
  wy: enrichWyTracks,
}

export type SearchDetailedResult = {
  items: SearchTrack[]
  channelId: string | null
  attempts: ChannelAttempt[]
  degraded: boolean
  stale: boolean
  /** tx 等平台的后置增强（补 media_mid / 真实档位）是否成功 */
  enriched: boolean
  enrichError?: string
}

/**
 * 走接口矩阵执行搜索。多通道自动降级；全通道失败抛 `UpstreamMatrixError`
 * （携带真实原始错误），不返回空结果掩盖原因。
 */
export async function searchPlatformDetailed(
  platform: string,
  keyword: string,
  page = 1,
  opts?: { signal?: AbortSignal },
): Promise<SearchDetailedResult> {
  if (opts?.signal?.aborted) {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    throw err
  }
  const factory = platformChannels[platform]
  if (!factory) throw createError({ statusCode: 400, statusMessage: `暂不支持平台: ${platform}` })
  const kw = keyword.trim()
  if (!kw) throw createError({ statusCode: 400, statusMessage: '请输入关键词' })

  const key = `${platform}:${kw}:${page}`
  const hit = searchCache.get(key)
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
    return {
      items: hit.items,
      channelId: null,
      attempts: [],
      degraded: false,
      stale: false,
      enriched: true,
    }
  }

  const ctx: ChannelContext = { keyword: kw, page, signal: opts?.signal }
  const outcome = await runChannelMatrix(factory(), ctx, {
    scope: 'search',
    // 过期缓存兜底：默认关闭（见 MIYIN_UPSTREAM_STALE_FALLBACK）
    staleFallback: () => hit?.items ?? null,
    enrich: platformEnrichers[platform],
    enrichId: `${platform}:enrich`,
    onAttempt: (a) => {
      if (!a.ok) return
      // 降级成功时记一条结构化日志，便于统计各通道真实可用率
      if (a.kind === 'success' && a.priority > 1) {
        console.warn(
          `[upstream] search ${platform} 通过备用通道 ${a.channelId} 命中（主通道不可用）`,
        )
      }
    },
  })

  for (const it of outcome.items) {
    it.artist = cleanArtist(it.artist)
    if (it.musicInfo) it.musicInfo.singer = cleanArtist(it.musicInfo.singer || it.artist)
  }

  if (outcome.items.length) {
    if (searchCache.size >= SEARCH_CACHE_MAX) {
      const oldest = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) searchCache.delete(oldest[0])
    }
    searchCache.set(key, { at: Date.now(), items: outcome.items })
  }
  return outcome
}

export async function searchPlatform(platform: string, keyword: string, page = 1, opts?: { signal?: AbortSignal }) {
  try {
    const res = await searchPlatformDetailed(platform, keyword, page, opts)
    return res.items
  } catch (err: any) {
    if (err?.statusCode === 400 || err?.name === 'AbortError') throw err
    // statusMessage 只能是短英文 reason phrase；真实原因全部放 message + data
    if (err instanceof UpstreamMatrixError) {
      const detail = summarizeAttempts(err.attempts)
      throw createError({
        statusCode: 502,
        statusMessage: 'Bad Gateway',
        message: `搜索失败(${platformLabel(platform)}): 全部上游通道不可用 · ${detail}`,
        data: { platform, scope: 'search', reason: detail, attempts: err.attempts },
      })
    }
    const detail = String(err?.message || err || 'unknown')
    throw createError({
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      message: `搜索失败(${platformLabel(platform)}): ${detail}`,
      data: { platform, scope: 'search', reason: detail },
    })
  }
}

export function listSearchablePlatforms() {
  return Object.keys(platformChannels)
}

export const PLATFORM_LABELS = PLATFORM_DISPLAY
