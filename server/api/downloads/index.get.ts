import { listTasks, getTaskStats } from '~~/server/services/downloadQueue'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const tab = typeof query.tab === 'string' && ['running', 'completed', 'failed'].includes(query.tab)
    ? (query.tab as 'running' | 'completed' | 'failed')
    : undefined
  const status = typeof query.status === 'string' && query.status.trim() ? query.status.trim() : undefined
  const playlistUrl = typeof query.playlist_url === 'string' && query.playlist_url.trim() ? query.playlist_url.trim() : undefined
  const batchId = typeof query.batch_id === 'string' && query.batch_id.trim() ? query.batch_id.trim() : undefined
  /** 关键词检索；作用域为当前 tab（由 tab 参数限定） */
  const q = typeof query.q === 'string' && query.q.trim() ? query.q.trim() : undefined
  const page = query.page != null ? Number(query.page) : undefined
  const pageSize = query.pageSize != null ? Number(query.pageSize) : (query.page_size != null ? Number(query.page_size) : undefined)
  const limit = query.limit != null ? Number(query.limit) : undefined

  const items = listTasks({
    tab,
    status,
    playlistUrl,
    batchId,
    q,
    page,
    pageSize,
    limit,
  })

  // 如果带了分页参数，附带统计信息返回
  if (page && pageSize) {
    // 统计必须携带与列表相同的过滤条件，否则 total / totalPages 会按全量计算
    const stats = getTaskStats({ playlistUrl, batchId, q })
    let total = stats.total
    if (tab === 'running') {
      total = stats.running + stats.queued
    } else if (tab === 'completed') {
      total = stats.completed
    } else if (tab === 'failed') {
      total = stats.failed + stats.cancelled
    } else if (status) {
      total = (stats as Record<string, number>)[status] || 0
    }
    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    }
  }

  return { items }
})
