import { findDuplicates } from '~~/server/services/duplicateGuard'
import { buildDedupKey } from '#shared/trackKey'

type Body = {
  items?: Array<{
    title?: string
    artist?: string
    album?: string | null
    quality?: string | null
  }>
}

/**
 * 批量重复预检：入队弹窗（C2）与搜索结果页「已在库」徽标（C3）共用。
 *
 * ③B 已确认判重不校验文件是否仍在磁盘；**文件存在性只在此处 stat**（R-b），
 * 因为这里只处理少量、已确认重复的条目，成本可忽略。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<Body>(event)
  const items = (body?.items || []).filter((item) => item?.title && item?.artist)
  if (!items.length) return { checked: 0, duplicates: [] }

  const hits = findDuplicates(
    items.map((item) => ({
      title: item.title!,
      artist: item.artist!,
      album: item.album ?? null,
      quality: item.quality ?? null,
    })),
    { withFileStat: true },
  )

  const duplicates = items.flatMap((item, index) => {
    const hit = hits.get(buildDedupKey(item.artist!, item.title!))
    if (!hit) return []
    return [
      {
        index,
        dedupKey: hit.dedupKey,
        reason: hit.reason,
        qualityInverted: hit.qualityInverted,
        existing: hit.existing,
      },
    ]
  })

  return { checked: items.length, duplicates }
})
