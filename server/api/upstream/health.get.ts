import {
  getUpstreamChannelStats,
  getUpstreamRecentEvents,
  upstreamBreakerCooldownMs,
  upstreamBreakerThreshold,
  upstreamRetries,
  upstreamStaleFallbackEnabled,
  upstreamTimeoutMs,
} from '~~/server/services/upstreamChannels'
import { describePlatformChannels } from '~~/server/services/platformSearch'

/**
 * 上游通道健康检查。
 *
 * 用于确认「某个平台是不是正在降级」「哪个通道在失败」「失败的真实错误码是什么」。
 * 需要登录（鉴权中间件对 /api/* 默认生效）。
 *
 * 服务端日志侧：`[upstream]` 前缀的结构化日志会写入 stdout，
 * 飞牛 FPK 部署下落在 `/var/apps/miyin/var/app.log`。
 */
export default defineEventHandler(() => {
  const stats = getUpstreamChannelStats()

  // 声明了但还没被调用过的通道也要出现，方便确认矩阵配置是否生效
  const declared = ['wy', 'kw', 'kg', 'tx'].flatMap((p) =>
    describePlatformChannels(p).map((c) => ({
      channelId: c.id,
      label: c.label,
      platform: c.platform,
      priority: c.priority,
      declared: true,
    })),
  )

  const seen = new Set(stats.map((s) => s.channelId))
  const idle = declared.filter((d) => !seen.has(d.channelId))

  return {
    ok: true,
    ts: Date.now(),
    config: {
      timeoutMs: upstreamTimeoutMs(),
      retries: upstreamRetries(),
      breakerThreshold: upstreamBreakerThreshold(),
      breakerCooldownMs: upstreamBreakerCooldownMs(),
      staleFallbackEnabled: upstreamStaleFallbackEnabled(),
    },
    summary: {
      channelsTracked: stats.length,
      channelsWithFailures: stats.filter((s) => s.failures > 0).length,
      channelsCircuitOpen: stats.filter((s) => s.circuitOpen).length,
      totalBusinessErrors: stats.reduce((n, s) => n + s.businessErrors, 0),
      totalTimeouts: stats.reduce((n, s) => n + s.timeouts, 0),
    },
    channels: stats,
    idleChannels: idle,
    recentEvents: getUpstreamRecentEvents(50),
  }
})
