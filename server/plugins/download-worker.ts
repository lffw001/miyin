import { startDownloadWorker } from '../services/downloadQueue'
import { getSettings } from '../services/settingsService'
import { ensureDownloadDirWritable } from '../utils/downloadDir'
import { backfillTrackKeysInBackground } from '../utils/db'

export default defineNitroPlugin(() => {
  try {
    ensureDownloadDirWritable(getSettings().downloadDir)
  } catch (err: any) {
    console.error(
      '[miyin] 下载目录当前不可写，创建下载任务将失败：',
      err?.message || err,
    )
  }
  startDownloadWorker()

  // 曲库检索能力层：历史检索键分批后台回填，不阻塞服务起监听
  void backfillTrackKeysInBackground()
    .then((filled) => {
      if (filled > 0) {
        console.log(`[miyin] 已回填 ${filled} 条下载记录的检索键`)
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[miyin] 回填检索键失败（不影响下载功能）：', message)
    })
})
