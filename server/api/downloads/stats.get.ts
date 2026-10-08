import { getTaskStats } from '~~/server/services/downloadQueue'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const playlistUrl = typeof query.playlist_url === 'string' && query.playlist_url.trim() ? query.playlist_url.trim() : undefined
  const batchId = typeof query.batch_id === 'string' && query.batch_id.trim() ? query.batch_id.trim() : undefined
  // 与 /api/downloads 使用同一关键词，保证 tab 角标与检索结果一致
  const q = typeof query.q === 'string' && query.q.trim() ? query.q.trim() : undefined

  return getTaskStats({ playlistUrl, batchId, q })
})
