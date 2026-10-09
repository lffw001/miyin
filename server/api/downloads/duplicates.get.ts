import { findDuplicateGroups } from '~~/server/services/duplicateGuard'

/**
 * 已下载记录里归一化同键的分组（C4）。
 * 重复只可能来自「判重引入之前」的历史数据，用于事后批量清理。
 */
export default defineEventHandler((event) => {
  const query = getQuery(event)
  const platform =
    typeof query.platform === 'string' && query.platform.trim() ? query.platform.trim() : undefined
  const limitRaw = query.limit != null ? Number(query.limit) : undefined
  const limit = limitRaw && limitRaw > 0 ? Math.min(limitRaw, 500) : undefined

  const groups = findDuplicateGroups({ platform, limit })
  return {
    groups,
    totalGroups: groups.length,
    totalItems: groups.reduce((sum, group) => sum + group.items.length, 0),
  }
})
