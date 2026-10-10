import { platformLabel } from '#shared/platforms'
import { SEARCH_PAGE_SIZE } from '#shared/searchPagination'
import {
  cleanArtist,
  kgErrorDetector,
  kwErrorDetector,
  parseLooseJson,
  type SearchTrack,
} from './platformSearch'
import {
  runChannelMatrix,
  summarizeAttempts,
  UpstreamMatrixError,
  type UpstreamChannel,
} from './upstreamChannels'

export type SearchAlbum = {
  id: string
  externalId: string
  title: string
  artist: string
  trackCount?: number
  cover?: string
  platform: string
  publishTime?: string
}

export type AlbumDetail = {
  album: SearchAlbum
  tracks: SearchTrack[]
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const QQ_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://y.qq.com/',
}

/** 一期 wy/tx/kw；二期含 kg */
export const ALBUM_CAPABLE_PLATFORMS = ['wy', 'tx', 'kw', 'kg'] as const
export type AlbumCapablePlatform = (typeof ALBUM_CAPABLE_PLATFORMS)[number]

/** 专辑曲目分页：单页条数（kg/kw）；与历史 kg pagesize 对齐 */
export const ALBUM_SONG_PAGE_SIZE = 500
/** 专辑曲目分页硬顶，防止上游 total 异常导致死循环 */
export const ALBUM_SONG_MAX_PAGES = 50

export function listAlbumCapablePlatforms(): AlbumCapablePlatform[] {
  return [...ALBUM_CAPABLE_PLATFORMS]
}

function dedupeAlbumSongs<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = keyOf(item).trim()
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push(item)
  }
  return out
}

async function fetchText(url: string, init?: RequestInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        ...(init?.headers || {}),
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(url: string, init?: RequestInit) {
  const text = await fetchText(url, init)
  return parseLooseJson(text)
}

function artistsJoin(list: any, key = 'name') {
  if (!list) return '未知'
  if (typeof list === 'string') return cleanArtist(list)
  if (Array.isArray(list)) {
    return cleanArtist(
      list
        .map((a) => {
          if (a == null) return ''
          if (typeof a === 'string') return a
          if (typeof a === 'object') return a[key] || a.name || ''
          return String(a)
        })
        .filter(Boolean)
        .join(' / ') || '未知',
    )
  }
  // wy cloudsearch 专辑 artist 常为单对象 { name }
  if (typeof list === 'object') {
    const name = list[key] || list.name
    if (name) return cleanArtist(String(name))
  }
  return cleanArtist(String(list))
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

function polishTracks(tracks: SearchTrack[]) {
  for (const it of tracks) {
    it.artist = cleanArtist(it.artist)
    if (it.musicInfo) it.musicInfo.singer = cleanArtist(it.musicInfo.singer || it.artist)
  }
  return tracks
}

/** wy 专辑搜索结果映射（供单测） */
export function mapWySearchAlbums(raw: any[]): SearchAlbum[] {
  return (raw || []).map((a: any) => {
    const id = String(a.id)
    // artists 为数组更稳；artist 常为单对象，勿 String(obj)
    const artist = artistsJoin(a.artists?.length ? a.artists : a.artist)
    const trackCount = Number(a.size ?? a.songCount ?? 0) || undefined
    return {
      id: `wy:${id}`,
      externalId: id,
      title: a.name || '未知',
      artist,
      trackCount,
      cover: a.picUrl || a.blurPicUrl,
      platform: 'wy',
      publishTime: a.publishTime ? String(a.publishTime) : undefined,
    }
  })
}

/** wy 单曲映射（专辑详情曲目，与单曲搜索同形 musicInfo） */
export function mapWySong(s: any, albumTitle = '', albumCover?: string): SearchTrack {
  const id = String(s.id)
  const cover = s.al?.picUrl || albumCover
  return {
    id: `wy:${id}`,
    externalId: id,
    title: s.name || '未知',
    artist: artistsJoin(s.ar || s.artists),
    album: s.al?.name || albumTitle || '',
    duration: Math.round((s.dt || s.duration || 0) / 1000),
    platform: 'wy',
    cover,
    qualitys: ['128k', '320k', 'flac'],
    musicInfo: {
      name: s.name,
      singer: artistsJoin(s.ar || s.artists),
      albumName: s.al?.name || albumTitle || '',
      songmid: id,
      hash: id,
      source: 'wy',
      img: cover,
      interval: formatInterval(s.dt || s.duration),
    },
  }
}

/** wy 专辑详情映射（供单测）；兼容 /api/v1/album 响应 */
export function mapWyAlbumDetail(data: any): AlbumDetail {
  const albumRaw = data?.album || data
  const albumId = String(albumRaw?.id || '')
  const albumTitle = albumRaw?.name || '未知'
  const cover = albumRaw?.picUrl || albumRaw?.blurPicUrl
  const songs = data?.songs || albumRaw?.songs || []
  const artist = artistsJoin(
    albumRaw?.artists?.length ? albumRaw.artists : albumRaw?.artist,
  )
  const album: SearchAlbum = {
    id: `wy:${albumId}`,
    externalId: albumId,
    title: albumTitle,
    artist,
    trackCount: Number(albumRaw?.size ?? songs.length) || songs.length || undefined,
    cover,
    platform: 'wy',
    publishTime: albumRaw?.publishTime ? String(albumRaw.publishTime) : undefined,
  }
  const tracks = polishTracks(songs.map((s: any) => mapWySong(s, albumTitle, cover)))
  return { album, tracks }
}

/**
 * 网易云专辑搜索通道矩阵。
 * 实测两端点 `type=10` 返回**完全相同**的 album 字段集（含 `picUrl`），故结果等价，
 * 可共用 `mapWySearchAlbums`。备用端点仅在主通道失败时触发。
 */
function wyAlbumChannels(): UpstreamChannel<SearchAlbum>[] {
  const detect = (d: any) => (d?.code !== undefined && d.code !== 200 ? `code ${d.code}` : null)
  const make = (
    id: string,
    label: string,
    path: string,
    priority: number,
  ): UpstreamChannel<SearchAlbum> => ({
    id,
    label,
    platform: 'wy',
    priority,
    buildUrl: (c) => {
      const offset = (c.page - 1) * SEARCH_PAGE_SIZE
      return `https://music.163.com${path}?s=${encodeURIComponent(c.keyword)}&type=10&limit=${SEARCH_PAGE_SIZE}&offset=${offset}`
    },
    headers: { Referer: 'https://music.163.com/' },
    detectUpstreamError: detect,
    parse: (d: any) => mapWySearchAlbums(d?.result?.albums || []),
  })
  return [
    make('wy:cloudsearch-album', '网易云专辑 cloudsearch', '/api/cloudsearch/pc', 1),
    make('wy:search-album-web', '网易云专辑 search/get/web（备用）', '/api/search/get/web', 2),
  ]
}

async function searchWyAlbums(keyword: string, page: number): Promise<SearchAlbum[]> {
  const outcome = await runChannelMatrix(wyAlbumChannels(), { keyword, page }, { scope: 'albumSearch' })
  return outcome.items
}

async function getWyAlbumDetail(albumId: string): Promise<AlbumDetail> {
  // /api/album/{id} 常返回 -462（需绑手机）；v1 可直接拿 songs。
  // 网易专辑详情为单次全量接口，请求侧无 pagesize 截断；超大合集极少见。
  const url = `https://music.163.com/api/v1/album/${encodeURIComponent(albumId)}`
  const data = await fetchJson(url, { headers: { Referer: 'https://music.163.com/' } })
  if (data?.code && data.code !== 200) {
    throw new Error(data.msg || data.message || data?.data?.blockText || `code ${data.code}`)
  }
  const detail = mapWyAlbumDetail(data)
  if (!detail.tracks.length) throw new Error('专辑曲目为空')
  return detail
}

/** tx 专辑搜索映射（client_search_cp t=8 字段多为 albumMID / singerName） */
export function mapTxSearchAlbums(raw: any[]): SearchAlbum[] {
  return (raw || []).map((a: any) => {
    const mid = String(a.albumMID || a.albummid || a.album_mid || a.mid || '')
    const artist =
      a.singerName ||
      artistsJoin(a.singer_list || a.singer) ||
      '未知'
    const trackCount = Number(a.song_count ?? a.songnum ?? 0) || undefined
    const cover =
      a.albumPic ||
      (mid ? `https://y.qq.com/music/photo_new/T002R300x300M000${mid}.jpg` : undefined)
    return {
      id: `tx:${mid}`,
      externalId: mid,
      title: a.albumName || a.albumname || a.name || '未知',
      artist: cleanArtist(String(artist)),
      trackCount,
      cover,
      platform: 'tx',
      publishTime: a.publicTime || a.pubtime ? String(a.publicTime || a.pubtime) : undefined,
    }
  })
}

/**
 * 由 QQ 专辑详情条目的 `size*` 字段反推真实可得档位。
 * 详情接口自带 `size128` / `size320` / `sizeflac` / `sizeape`，无需额外请求。
 */
function txQualitysFromAlbumSong(s: any): string[] {
  const out: string[] = []
  if (Number(s?.size128) > 0) out.push('128k')
  if (Number(s?.size320) > 0) out.push('320k')
  if (Number(s?.sizeflac) > 0 || Number(s?.sizeape) > 0) out.push('flac')
  return out.length ? out : ['128k', '320k']
}

/** tx 专辑详情曲目映射（含完整 musicInfo） */
export function mapTxAlbumSong(s: any, albumTitle = '', albummid = ''): SearchTrack {
  const mid = String(s.songmid || s.mid || '')
  const cover = albummid ? `https://y.qq.com/music/photo_new/T002R300x300M000${albummid}.jpg` : undefined
  return {
    id: `tx:${mid}`,
    externalId: mid,
    title: s.songname || s.name || '未知',
    artist: artistsJoin(s.singer),
    album: s.albumname || albumTitle || '',
    duration: Number(s.interval || 0),
    platform: 'tx',
    cover,
    qualitys: txQualitysFromAlbumSong(s),
    musicInfo: {
      name: s.songname || s.name,
      singer: artistsJoin(s.singer),
      albumName: s.albumname || albumTitle || '',
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

export function mapTxAlbumDetail(data: any, albumId: string): AlbumDetail {
  const info = data?.data || data
  const albummid = String(info?.mid || albumId)
  const albumTitle = info?.name || info?.title || '未知'
  const cover = albummid ? `https://y.qq.com/music/photo_new/T002R300x300M000${albummid}.jpg` : undefined
  const list = info?.list || info?.songlist || []
  // 详情接口歌手多为 singername 字符串，不是 singer 数组
  const artist =
    info?.singername ||
    artistsJoin(info?.singer) ||
    '未知'
  const album: SearchAlbum = {
    id: `tx:${albummid}`,
    externalId: albummid,
    title: albumTitle,
    artist: cleanArtist(String(artist)),
    trackCount: Number(info?.total_song_num ?? list.length) || list.length || undefined,
    cover,
    platform: 'tx',
    publishTime: info?.aDate || info?.pub_time ? String(info?.aDate || info?.pub_time) : undefined,
  }
  const tracks = polishTracks(list.map((s: any) => mapTxAlbumSong(s, albumTitle, albummid)))
  return { album, tracks }
}

/**
 * QQ 专辑搜索通道矩阵。
 * 实测两端点 `t=8` 结果完全一致（同样 21 条、albumMID 相同），
 * 但新端点快约 7 倍（~0.4s vs ~3.1s），故新端点为主、老端点兜底。
 * 代价：新端点不返回 `song_count` / `albumPic` / `singer_list`。
 * `albumMID` 仍在，封面可由 albumMID 拼接得到，仅曲目数退化为「未知」。
 */
function txAlbumChannels(): UpstreamChannel<SearchAlbum>[] {
  const make = (
    id: string,
    label: string,
    origin: string,
    priority: number,
    timeoutMs?: number,
  ): UpstreamChannel<SearchAlbum> => ({
    id,
    label,
    platform: 'tx',
    priority,
    timeoutMs,
    buildUrl: (c) =>
      `${origin}?w=${encodeURIComponent(c.keyword)}&p=${c.page}&n=${SEARCH_PAGE_SIZE}&format=json&t=8`,
    headers: QQ_HEADERS,
    detectUpstreamError: (d: any) => (d?.code !== undefined && d.code !== 0 ? `code ${d.code}` : null),
    parse: (d: any) => mapTxSearchAlbums(d?.data?.album?.list || []),
  })
  return [
    make(
      'tx:soso-album-v2',
      'QQ专辑搜索 search_for_qq_cp',
      'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp',
      1,
    ),
    make(
      'tx:soso-album-cp',
      'QQ专辑搜索 client_search_cp',
      'https://c.y.qq.com/soso/fcgi-bin/client_search_cp',
      2,
      15_000,
    ),
  ]
}

async function searchTxAlbums(keyword: string, page: number): Promise<SearchAlbum[]> {
  const outcome = await runChannelMatrix(txAlbumChannels(), { keyword, page }, { scope: 'albumSearch' })
  return outcome.items
}

async function getTxAlbumDetail(albumId: string): Promise<AlbumDetail> {
  // QQ 专辑详情为单次全量 list，请求侧无 pagesize；total_song_num 与 list 对齐由上游保证。
  const url =
    `https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?` +
    `albummid=${encodeURIComponent(albumId)}&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0`
  const data = await fetchJson(url, { headers: QQ_HEADERS })
  // 实测成功码为 0；非法 albummid 返回 HTTP 200 + code 1101 "para error!"（不能当空专辑吞掉）
  if (data?.code !== undefined && data.code !== 0) {
    const sub = data.subcode && data.subcode !== data.code ? ` subcode ${data.subcode}` : ''
    throw new Error(`${data.message || 'upstream error'} (code ${data.code}${sub})`)
  }
  const detail = mapTxAlbumDetail(data, albumId)
  if (!detail.tracks.length) throw new Error('专辑曲目为空')
  return detail
}

/** kw 专辑搜索映射 */
export function mapKwSearchAlbums(raw: any[]): SearchAlbum[] {
  return (raw || []).map((a: any) => {
    const id = String(a.ALBUMID || a.albumid || a.id || '').replace(/^ALBUM_/, '')
    const pic = a.web_albumpic_short || a.pic
    return {
      id: `kw:${id}`,
      externalId: id,
      title: decode(a.NAME || a.ALBUM || a.name || '未知'),
      artist: decode(a.ARTIST || a.artist || '未知'),
      trackCount: a.SONGNUM ? Number(a.SONGNUM) : undefined,
      cover: pic ? `https://img2.kuwo.cn/star/albumcover/${pic}` : undefined,
      platform: 'kw',
      publishTime: a.RELEASEDATE || a.releaseDate ? String(a.RELEASEDATE || a.releaseDate) : undefined,
    }
  })
}

export function mapKwAlbumSong(s: any, albumTitle = '', albumCover?: string): SearchTrack {
  const id = String(s.MUSICRID || s.DC_TARGETID || s.id || '').replace('MUSIC_', '')
  const pic = s.web_albumpic_short
  const cover = pic ? `https://img2.kuwo.cn/star/albumcover/${pic}` : albumCover
  return {
    id: `kw:${id}`,
    externalId: id,
    title: decode(s.NAME || s.SONGNAME || s.name),
    artist: decode(s.ARTIST || s.artist),
    album: decode(s.ALBUM || albumTitle),
    duration: Number(s.DURATION || s.duration || 0),
    platform: 'kw',
    cover,
    qualitys: ['128k', '320k'],
    musicInfo: {
      name: decode(s.NAME || s.SONGNAME || s.name),
      singer: decode(s.ARTIST || s.artist),
      albumName: decode(s.ALBUM || albumTitle),
      songmid: id,
      hash: id,
      source: 'kw',
      img: cover,
      interval: formatIntervalFromSec(Number(s.DURATION || s.duration || 0)),
    },
  }
}

export function mapKwAlbumDetail(data: any, albumId: string): AlbumDetail {
  const albumRaw = data?.album || data?.data?.album || {}
  const id = String(albumRaw?.albumid || albumRaw?.id || albumId)
  const albumTitle = decode(albumRaw?.name || albumRaw?.ALBUM || '未知')
  const pic = albumRaw?.pic || albumRaw?.web_albumpic_short
  const albumCover = pic ? `https://img2.kuwo.cn/star/albumcover/${pic}` : undefined
  const album: SearchAlbum = {
    id: `kw:${id}`,
    externalId: id,
    title: albumTitle,
    artist: decode(albumRaw?.artist || albumRaw?.ARTIST || '未知'),
    trackCount: albumRaw?.songnum ? Number(albumRaw.songnum) : undefined,
    cover: albumCover,
    platform: 'kw',
  }
  const songList = data?.musiclist || data?.data?.musiclist || data?.abslist || []
  const tracks = polishTracks(songList.map((s: any) => mapKwAlbumSong(s, albumTitle, albumCover)))
  return { album, tracks }
}

/**
 * 酷我专辑搜索通道矩阵。
 * ⚠️ 酷我暂无可用备用专辑端点（与歌曲搜索同源限制：新 web 接口需 token、
 *    旧 mobi 接口 404）→ 保持单通道，靠 `kwErrorDetector` 保证失败不静默。
 */
function kwAlbumChannels(): UpstreamChannel<SearchAlbum>[] {
  return [
    {
      id: 'kw:r.s-album',
      label: '酷我专辑 r.s',
      platform: 'kw',
      priority: 1,
      buildUrl: (c) =>
        `https://search.kuwo.cn/r.s?all=${encodeURIComponent(c.keyword)}&ft=album&client=kt&pn=${c.page - 1}&rn=${SEARCH_PAGE_SIZE}&rformat=json&encoding=utf8`,
      detectUpstreamError: kwErrorDetector,
      parse: (d: any) => mapKwSearchAlbums(d?.abslist || d?.albumlist || []),
    },
  ]
}

async function searchKwAlbums(keyword: string, page: number): Promise<SearchAlbum[]> {
  const outcome = await runChannelMatrix(kwAlbumChannels(), { keyword, page }, { scope: 'albumSearch' })
  return outcome.items
}

async function getKwAlbumDetail(albumId: string): Promise<AlbumDetail> {
  // albuminfo 在部分合集上可能按 rn 截断；pn 从 0 起分页拉全，硬顶防死循环。
  const allSongs: any[] = []
  let albumRaw: Record<string, unknown> = {}
  let firstData: any = null
  let total = Number.POSITIVE_INFINITY

  for (let page = 0; page < ALBUM_SONG_MAX_PAGES && allSongs.length < total; page++) {
    const url =
      `https://search.kuwo.cn/r.s?stype=albuminfo&albumid=${encodeURIComponent(albumId)}` +
      `&pn=${page}&rn=${ALBUM_SONG_PAGE_SIZE}&encoding=utf8&rformat=json`
    const data = await fetchJson(url)
    // 防御性业务态检查：避免「HTTP 200 + 业务失败」被当成"空专辑"静默吞掉
    const bizErr = kwErrorDetector(data)
    if (bizErr) throw new Error(bizErr)
    if (page === 0) {
      firstData = data
      albumRaw = (data?.album || data?.data?.album || {}) as Record<string, unknown>
      const songnum = Number(albumRaw.songnum)
      if (Number.isFinite(songnum) && songnum > 0) total = songnum
    }
    const songList: any[] = data?.musiclist || data?.data?.musiclist || data?.abslist || []
    if (!songList.length) break
    const before = allSongs.length
    allSongs.push(...songList)
    const deduped = dedupeAlbumSongs(allSongs, (s) =>
      String(s.MUSICRID || s.DC_TARGETID || s.id || ''),
    )
    allSongs.length = 0
    allSongs.push(...deduped)
    if (allSongs.length === before) break
    if (songList.length < ALBUM_SONG_PAGE_SIZE) break
  }

  const merged = {
    ...(firstData || {}),
    album: { ...albumRaw, songnum: Number.isFinite(total) ? total : allSongs.length },
    musiclist: allSongs,
  }
  const detail = mapKwAlbumDetail(merged, albumId)
  if (!detail.tracks.length) throw new Error('专辑曲目为空')
  return detail
}

/** kg 专辑搜索映射（mobilecdn v3：albumid / albumname / singername / songcount / imgurl） */
export function mapKgSearchAlbums(raw: any[]): SearchAlbum[] {
  return (raw || []).map((a: any) => {
    const id = String(a.AlbumID || a.albumid || a.album_id || '')
    const img = a.imgurl || a.Image || a.album_img
    return {
      id: `kg:${id}`,
      externalId: id,
      title: a.AlbumName || a.albumname || '未知',
      artist: cleanArtist(String(a.SingerName || a.singername || artistsJoin(a.singer) || '未知')),
      trackCount: Number(a.SongCount ?? a.songcount ?? 0) || undefined,
      cover: typeof img === 'string' ? img.replace('{size}', '240') : undefined,
      platform: 'kg',
      publishTime: a.PublishTime || a.publishtime ? String(a.PublishTime || a.publishtime) : undefined,
    }
  })
}

/** kg 专辑曲目：filename 多为「歌手 - 歌名」，hash/duration 小写 */
export function mapKgAlbumSong(s: any, albumTitle = '', albumCover?: string): SearchTrack {
  const hash = String(s.FileHash || s.HQFileHash || s.hash || '')
  let title = s.SongName || s.OriSongName || s.name || s.songname || ''
  let artist = s.SingerName || s.singername || artistsJoin(s.Singers, 'name')
  if ((!title || title === '未知') && s.filename) {
    const fn = String(s.filename)
    const sep = fn.indexOf(' - ')
    if (sep > 0) {
      artist = artist && artist !== '未知' ? artist : fn.slice(0, sep)
      title = fn.slice(sep + 3)
    } else {
      title = fn
    }
  }
  if (!title) title = '未知'
  if (!artist) artist = '未知'
  const duration = Number(s.Duration || s.duration || 0)
  const cover = s.Image?.replace('{size}', '240') || albumCover
  return {
    id: `kg:${hash}`,
    externalId: hash,
    title,
    artist: cleanArtist(String(artist)),
    album: s.AlbumName || s.albumname || albumTitle || '',
    duration,
    platform: 'kg',
    cover,
    qualitys: ['128k', '320k'],
    musicInfo: {
      name: title,
      singer: cleanArtist(String(artist)),
      albumName: s.AlbumName || s.albumname || albumTitle || '',
      hash,
      songmid: hash,
      source: 'kg',
      img: cover,
      interval: formatIntervalFromSec(duration),
    },
  }
}

/**
 * kg 专辑详情：mobilecdn `/api/v3/album/song` 返回 `{ data: { total, info: songs[] } }`，
 * 无独立专辑元数据；albumTitle 由调用方在搜结果中传入时可覆盖。
 */
export function mapKgAlbumDetail(
  data: any,
  albumId: string,
  meta?: { title?: string; artist?: string; cover?: string },
): AlbumDetail {
  const payload = data?.data || data
  // 旧形状兼容：info 为对象 + lists 为曲目
  const list: any[] = Array.isArray(payload?.info)
    ? payload.info
    : payload?.lists || payload?.songs || []
  const infoObj = !Array.isArray(payload?.info) && payload?.info ? payload.info : {}
  const id = String(infoObj?.albumid || infoObj?.album_id || albumId)
  const albumTitle = meta?.title || infoObj?.albumname || infoObj?.name || `专辑 ${id}`
  const artist =
    meta?.artist ||
    infoObj?.singername ||
    artistsJoin(infoObj?.authors) ||
    '未知'
  const cover =
    meta?.cover ||
    infoObj?.img?.replace?.('{size}', '240') ||
    infoObj?.sizable_cover?.replace?.('{size}', '240')
  const total = Number(payload?.total ?? infoObj?.songcount ?? list.length) || list.length
  const album: SearchAlbum = {
    id: `kg:${id}`,
    externalId: id,
    title: albumTitle,
    artist: cleanArtist(String(artist)),
    trackCount: total || undefined,
    cover,
    platform: 'kg',
    publishTime: infoObj?.publishtime ? String(infoObj.publishtime) : undefined,
  }
  const tracks = polishTracks(list.map((s: any) => mapKgAlbumSong(s, albumTitle, cover)))
  return { album, tracks }
}

/**
 * 酷狗专辑搜索通道矩阵。
 * 主通道改为 `mobileservice`（HTTPS 可用，实测 ~0.27s），
 * 备通道为原有 `mobilecdn`（仅 HTTP 可握手，且慢约 10 倍）。
 * `complexsearch /v2/search/album` 已 404，不再作为候选。
 */
function kgAlbumChannels(): UpstreamChannel<SearchAlbum>[] {
  const make = (
    id: string,
    label: string,
    origin: string,
    priority: number,
    extraQs: string,
  ): UpstreamChannel<SearchAlbum> => ({
    id,
    label,
    platform: 'kg',
    priority,
    buildUrl: (c) =>
      `${origin}/api/v3/search/album?keyword=${encodeURIComponent(c.keyword)}&page=${c.page}&pagesize=${SEARCH_PAGE_SIZE}&iscorrect=1${extraQs}`,
    headers: { Referer: 'https://www.kugou.com/' },
    detectUpstreamError: kgErrorDetector([1]),
    parse: (d: any) => mapKgSearchAlbums(d?.data?.info || d?.data?.lists || []),
  })
  return [
    make('kg:mobileservice-album-v3', '酷狗专辑搜索 mobileservice v3', 'https://mobileservice.kugou.com', 1, ''),
    make('kg:mobilecdn-album-v3', '酷狗专辑搜索 mobilecdn v3', 'http://mobilecdn.kugou.com', 2, '&version=9108'),
  ]
}

async function searchKgAlbums(keyword: string, page: number): Promise<SearchAlbum[]> {
  const outcome = await runChannelMatrix(kgAlbumChannels(), { keyword, page }, { scope: 'albumSearch' })
  return outcome.items
}

function kgAlbumSongList(payload: any): any[] {
  if (Array.isArray(payload?.info)) return payload.info
  return payload?.lists || payload?.songs || []
}

async function getKgAlbumDetail(albumId: string): Promise<AlbumDetail> {
  // mobilecdn album/song 单页最多 pagesize 条；>500 须翻页，硬顶防死循环。
  const allSongs: any[] = []
  let total = Number.POSITIVE_INFINITY
  const headers = { Referer: 'https://www.kugou.com/' }

  for (let page = 1; page <= ALBUM_SONG_MAX_PAGES && allSongs.length < total; page++) {
    const url =
      `http://mobilecdn.kugou.com/api/v3/album/song?albumid=${encodeURIComponent(albumId)}` +
      `&page=${page}&pagesize=${ALBUM_SONG_PAGE_SIZE}&version=9108`
    const data = await fetchJson(url, { headers })
    const payload = data?.data || data
    if (page === 1) {
      const t = Number(payload?.total ?? payload?.info?.songcount)
      if (Number.isFinite(t) && t > 0) total = t
    }
    const list = kgAlbumSongList(payload)
    if (!list.length) break
    const before = allSongs.length
    allSongs.push(...list)
    const deduped = dedupeAlbumSongs(allSongs, (s) =>
      String(s.FileHash || s.HQFileHash || s.hash || ''),
    )
    allSongs.length = 0
    allSongs.push(...deduped)
    if (allSongs.length === before) break
    if (list.length < ALBUM_SONG_PAGE_SIZE) break
  }

  const detail = mapKgAlbumDetail(
    {
      data: {
        total:
          Number.isFinite(total) && total !== Number.POSITIVE_INFINITY
            ? total
            : allSongs.length,
        info: allSongs,
      },
    },
    albumId,
  )
  if (!detail.tracks.length) throw new Error('专辑曲目为空')
  return detail
}

const albumSearchAdapters: Record<
  AlbumCapablePlatform,
  (kw: string, page: number) => Promise<SearchAlbum[]>
> = {
  wy: searchWyAlbums,
  tx: searchTxAlbums,
  kw: searchKwAlbums,
  kg: searchKgAlbums,
}

const albumDetailAdapters: Record<AlbumCapablePlatform, (albumId: string) => Promise<AlbumDetail>> = {
  wy: getWyAlbumDetail,
  tx: getTxAlbumDetail,
  kw: getKwAlbumDetail,
  kg: getKgAlbumDetail,
}

const albumSearchCache = new Map<string, { at: number; items: SearchAlbum[] }>()
const albumDetailCache = new Map<string, { at: number; detail: AlbumDetail }>()
const ALBUM_TTL_MS = 60_000

export function clearAlbumCache() {
  albumSearchCache.clear()
  albumDetailCache.clear()
}

function isAlbumCapable(platform: string): platform is AlbumCapablePlatform {
  return (ALBUM_CAPABLE_PLATFORMS as readonly string[]).includes(platform)
}

export async function searchAlbums(platform: string, keyword: string, page = 1) {
  if (!isAlbumCapable(platform)) {
    throw createError({ statusCode: 400, statusMessage: `暂不支持专辑搜索: ${platform}` })
  }
  if (!keyword.trim()) throw createError({ statusCode: 400, statusMessage: '请输入关键词' })
  const key = `album:${platform}:${keyword.trim()}:${page}`
  const hit = albumSearchCache.get(key)
  if (hit && Date.now() - hit.at < ALBUM_TTL_MS) return hit.items
  try {
    const items = await albumSearchAdapters[platform](keyword.trim(), page)
    for (const it of items) {
      it.artist = cleanArtist(it.artist)
    }
    albumSearchCache.set(key, { at: Date.now(), items })
    return items
  } catch (err: any) {
    if (err instanceof UpstreamMatrixError) {
      const detail = summarizeAttempts(err.attempts)
      throw createError({
        statusCode: 502,
        statusMessage: 'Bad Gateway',
        message: `专辑搜索失败(${platformLabel(platform)}): 全部上游通道不可用 · ${detail}`,
        data: { platform, scope: 'albumSearch', reason: detail, attempts: err.attempts },
      })
    }
    const detail = String(err?.message || err || 'unknown')
    throw createError({
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      message: `专辑搜索失败(${platformLabel(platform)}): ${detail}`,
      data: { platform, scope: 'albumSearch', reason: detail },
    })
  }
}

export async function getAlbumDetail(platform: string, albumId: string) {
  if (!isAlbumCapable(platform)) {
    throw createError({ statusCode: 400, statusMessage: `暂不支持专辑详情: ${platform}` })
  }
  const id = String(albumId || '').trim()
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少 albumId' })
  const key = `albumDetail:${platform}:${id}`
  const hit = albumDetailCache.get(key)
  if (hit && Date.now() - hit.at < ALBUM_TTL_MS) return hit.detail
  try {
    const detail = await albumDetailAdapters[platform](id)
    albumDetailCache.set(key, { at: Date.now(), detail })
    return detail
  } catch (err: any) {
    const detail = String(err?.message || err || 'unknown')
    throw createError({
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      message: `专辑详情失败(${platformLabel(platform)}): ${detail}`,
      data: { platform, albumId: id, reason: detail },
    })
  }
}
