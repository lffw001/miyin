/**
 * 音质档位：**全仓唯一来源**。
 *
 * 注意与另外两处的区别 —— 三者语义不同，**不要合并**：
 * - `ALLOWED_QUALITIES`（`server/services/downloadState.ts`）= 用户可选**偏好**，含 `highest` 伪档，**无 `192k`**
 * - `DOWNLOAD_QUALITY_OPTIONS`（`app/utils/mediaLabels.ts`）= **UI 选项**，**无 `192k`**
 * - 本模块 = **实际产出档位**（`highest` 的降级阶梯），**含 `192k`**
 *
 * 为什么必须区分：`highest` 时音源可能返回 `192k`，且 `processTask` 完成时会把**实际音质**
 * 写回 `quality` 列 —— 所以已完成记录里可能是 `192k`。任何"比较两个音质高低"的逻辑
 * 都必须基于本模块，否则 `indexOf('192k') === -1` 会导致比较结果错乱。
 */

/** 音质从高到低（`highest` 的降级阶梯） */
export const QUALITY_LADDER = ['flac24bit', 'flac', '320k', '192k', '128k'] as const

export type ConcreteQuality = (typeof QUALITY_LADDER)[number]

/**
 * 音质高低排名：数值**越小越高**。
 *
 * `highest` / `null` / `''` / 非阶梯值一律返回 `null` = **未知**。
 * `highest` 是偏好不是产出档位，不能参与大小比较。
 */
export function qualityRank(quality: string | null | undefined): number | null {
  if (!quality) return null
  const idx = (QUALITY_LADDER as readonly string[]).indexOf(quality)
  return idx >= 0 ? idx : null
}

/**
 * 是否为「低音质覆盖高音质」（应默认拦截）。
 *
 * 任一档为未知（含 `highest` / `null`）→ 返回 `false`（**未知不拦截**）。
 */
export function isQualityInverted(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): boolean {
  const existingRank = qualityRank(existing)
  const incomingRank = qualityRank(incoming)
  if (existingRank == null || incomingRank == null) return false
  return incomingRank > existingRank
}

/**
 * 各档位的**最低合理码率**（kbps）。
 *
 * 判据：`体积 × 8 ÷ 时长` 估出的平均码率低于此值 ⇒ 内容配不上它声称的档位。
 * 实测锚点（《稻香》223s）：
 * - `ynx@flac24bit` 64578KB → **2372kbps**（合格；⚠️ ffprobe 实测为 **16bit/44.1kHz/6声道**，
 *   高码率来自多声道而非位深 —— **码率判据区分不了位深**，要校验 24bit 需另用 ffprobe，见 L3）
 * - `念心音源@flac` 25403KB → **933kbps**（真无损，合格）
 * - `Hei Music@flac24bit` 8731KB → **321kbps**（谎报，实为 320k mp3 → implausible）
 *
 * 取值**刻意保守**（偏低于真实值），避免短曲 / 静音段多的曲目被误判：
 * `flac24bit` 真 24/96 通常 ≥1500，这里只要求 1400。
 */
export const MIN_KBPS_BY_QUALITY: Readonly<Record<string, number>> = {
  flac24bit: 1400,
  flac: 700,
  '320k': 256,
  '192k': 160,
  '128k': 96,
}

/**
 * 「明显是试听片段」的码率上限（低于任何档位的最低值）。
 * 例如 938KB / 223s ≈ 34kbps —— 这不是"音质差"，而是内容被截断了。
 */
export const MIN_KBPS_ANY = 80

/** 由体积与时长估算平均码率（kbps）。任一参数缺失/非法返回 `null`（= 未知，不判定） */
export function estimateBitrateKbps(
  bytes: number | null | undefined,
  durationSec: number | null | undefined,
): number | null {
  if (bytes == null || bytes <= 0) return null
  if (durationSec == null || durationSec <= 0) return null
  return (bytes * 8) / durationSec / 1000
}

export type QualityPlausibility = 'ok' | 'implausible' | 'unknown'

/**
 * 内容是否配得上它声称的档位。
 *
 * - `unknown`：码率或档位未知（含 `highest`）→ **不判定**，与 `qualityRank` 的"未知不拦截"一致
 * - `implausible`：低于该档位下限 → **降级排序**但仍可作为兜底候选（短曲可能合法地偏低）
 * - `ok`：达标
 *
 * ⚠️ 注意「明显试听」要用 `MIN_KBPS_ANY` 单独判 —— 那是**硬拒绝**（内容被截断），
 * 不是"音质不够好"。
 */
export function qualityPlausibility(
  estKbps: number | null,
  quality: string | null | undefined,
): QualityPlausibility {
  if (estKbps == null || !quality) return 'unknown'
  const min = MIN_KBPS_BY_QUALITY[quality]
  if (min == null) return 'unknown'
  return estKbps >= min ? 'ok' : 'implausible'
}

/** 按实测码率反推最接近的真实档位，用于把结果写回 `quality` 列时避免沿用谎报档位 */
export function qualityFromBitrate(estKbps: number): string {
  if (estKbps >= MIN_KBPS_BY_QUALITY.flac24bit!) return 'flac24bit'
  if (estKbps >= MIN_KBPS_BY_QUALITY.flac!) return 'flac'
  if (estKbps >= MIN_KBPS_BY_QUALITY['320k']!) return '320k'
  if (estKbps >= MIN_KBPS_BY_QUALITY['192k']!) return '192k'
  return '128k'
}

/**
 * 用 ffprobe 实测参数修正「声称的档位」（L3）。
 *
 * ⚠️ **只修正记录的档位，不影响是否接受该文件** ——
 * 位深不符时若硬拒绝，遇上"所有音源都只给 16bit"就会什么都下不到，
 * 那比拿到一个 16bit 真无损更糟。
 *
 * 目前**只处理一种有确定证据的情况**：声称 `flac24bit` 但实测位深 < 24。
 * 依据：`ynx` 声称 `flac24bit`，ffprobe 实测是 **16bit/44.1kHz/6声道** ——
 * 高码率（2.2Mbps）来自**多声道**而非位深，码率判据区分不了，只能靠 ffprobe。
 *
 * 其余情况一律原样返回，不做超出证据的推断（例如 m4a 可能是 ALAC，不能当有损处理）。
 */
export function correctedQualityFromProbe(
  claimed: string | null | undefined,
  info: { bitsPerRawSample: number | null } | null | undefined,
): string | null | undefined {
  if (!claimed || !info) return claimed
  if (claimed === 'flac24bit' && info.bitsPerRawSample != null && info.bitsPerRawSample < 24) {
    return 'flac'
  }
  return claimed
}
