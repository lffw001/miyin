import { listTasks, getTaskStats } from '~~/server/services/downloadQueue'

function str(v: unknown) {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const tab = typeof query.tab === 'string' && ['running', 'completed', 'failed'].includes(query.tab)
    ? (query.tab as 'running' | 'completed' | 'failed')
    : undefined
  const status = str(query.status)
  const playlistUrl = str(query.playlist_url)
  const batchId = str(query.batch_id)
  /** 关键词检索；作用域为当前 tab（由 tab 参数限定） */
  const q = str(query.q)
  /** 增强筛选：平台 / 音质 / 入队日期（YYYY-MM-DD，含当天） */
  const platform = str(query.platform)
  const quality = str(query.quality)
  const since = str(query.since)
  const until = str(query.until)
  const page = query.page != null ? Number(query.page) : undefined
  const pageSize = query.pageSize != null ? Number(query.pageSize) : (query.page_size != null ? Number(query.page_size) : undefined)
  const limit = query.limit != null ? Number(query.limit) : undefined
  /**
   * 检索范围：
   * - `all` 跨 tab（忽略 tab / status），结果包含各分类的任务
   * - 其它 按当前 tab（默认，保持既有行为）
   */
  const scopeAll = query.scope === 'all'

  /** 列表与统计共用同一组过滤条件（tab/status 由 scope 决定，不进 filters） */
  const filters = { playlistUrl, batchId, q, platform, quality, since, until }

  const items = listTasks({
    tab: scopeAll ? undefined : tab,
    status: scopeAll ? undefined : status,
    ...filters,
    page,
    pageSize,
    limit,
  })

  // 如果带了分页参数，附带统计信息返回
  if (page && pageSize) {
    const stats = getTaskStats(filters)
    let total = stats.total
    if (scopeAll) {
      // 跨 tab：total 就是命中总数（各分类之和），与列表一致
      total = stats.total
    } else if (tab === 'running') {
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
      /** 跨 tab 时附上分类分布，供前端展示「归属分类」 */
      byGroup: {
        running: stats.running + stats.queued,
        completed: stats.completed,
        failed: stats.failed + stats.cancelled,
      },
    }
  }

  return { items }
})
