import {
  enqueueDownloadChecked,
  type DuplicateAction,
} from '~~/server/services/downloadQueue'

const ACTIONS: readonly DuplicateAction[] = ['skip', 'replace', 'enqueue']

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  if (!body?.title || !body?.artist || !body?.platform || !body?.musicInfo) {
    throw createError({ statusCode: 400, statusMessage: '缺少必要字段' })
  }
  // 判重走 checked 入口：缺省裁决按 duplicatePolicy，prompt 下服务端回落 skip（D3）
  const action = ACTIONS.includes(body.duplicateAction)
    ? (body.duplicateAction as DuplicateAction)
    : undefined
  return enqueueDownloadChecked(body, action ? { action } : undefined)
})
