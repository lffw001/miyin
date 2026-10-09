import { getTaskStats } from '~~/server/services/downloadQueue'

function str(v: unknown) {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export default defineEventHandler((event) => {
  const query = getQuery(event)
  // 与 /api/downloads 使用同一组过滤条件，保证 tab 角标与检索结果一致
  return getTaskStats({
    playlistUrl: str(query.playlist_url),
    batchId: str(query.batch_id),
    q: str(query.q),
    platform: str(query.platform),
    quality: str(query.quality),
    since: str(query.since),
    until: str(query.until),
  })
})
