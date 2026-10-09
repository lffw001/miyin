<script setup lang="ts">
import { qualityLabel } from '~/utils/mediaLabels'

export type DuplicateReviewExisting = {
  id: string
  title: string
  artist: string
  platform: string
  quality: string | null
  status: string
  filePath: string | null
  fileExists: boolean | null
  updatedAt: string
}

export type DuplicateReviewItem = {
  /** 原始提交下标：用于把逐条裁决回填到提交数组 */
  index: number
  title: string
  artist: string
  album?: string | null
  reason: 'exact' | 'inflight' | 'batch'
  qualityInverted: boolean
  existing: DuplicateReviewExisting | null
}

export type DuplicateDecision = 'skip' | 'replace'

const open = defineModel<boolean>('open', { default: false })

const props = withDefaults(
  defineProps<{
    items: DuplicateReviewItem[]
    /** 音质保护开关（关闭时不拦截降级） */
    protectQuality?: boolean
  }>(),
  { protectQuality: true },
)

const emit = defineEmits<{
  /** 确认：返回「提交下标 → 裁决」 */
  confirm: [decisions: Map<number, DuplicateDecision>]
  cancel: []
  /** 写入 duplicatePolicy='skip'，设置页可改回 */
  mute: []
}>()

const REASON_LABELS: Record<DuplicateReviewItem['reason'], string> = {
  exact: '完全同名',
  inflight: '在途任务',
  batch: '本批次内重复',
}

/** 音质倒挂（低覆盖高）默认拦截，④A */
function isReplaceBlocked(item: DuplicateReviewItem) {
  if (!props.protectQuality) return false
  return item.qualityInverted
}

function defaultDecision(item: DuplicateReviewItem): DuplicateDecision {
  // 保守默认：不覆盖既有文件
  return 'skip'
}

const decisions = ref<Map<number, DuplicateDecision>>(new Map())

watch(
  () => [props.items, open.value] as const,
  () => {
    if (!open.value) return
    const next = new Map<number, DuplicateDecision>()
    for (const item of props.items) {
      next.set(item.index, isReplaceBlocked(item) ? 'skip' : defaultDecision(item))
    }
    decisions.value = next
  },
  { immediate: true },
)

const groups = computed(() => {
  const order: DuplicateReviewItem['reason'][] = ['exact', 'inflight', 'batch']
  return order
    .map((reason) => ({ reason, label: REASON_LABELS[reason], rows: props.items.filter((i) => i.reason === reason) }))
    .filter((g) => g.rows.length > 0)
})

const replaceCount = computed(
  () => [...decisions.value.values()].filter((d) => d === 'replace').length,
)
const skipCount = computed(() => props.items.length - replaceCount.value)
/** 只有单条时不需要批量按钮（R-f：单曲复用同一组件） */
const isSingle = computed(() => props.items.length <= 1)

function setDecision(index: number, value: DuplicateDecision) {
  const next = new Map(decisions.value)
  next.set(index, value)
  decisions.value = next
}

function setAll(value: DuplicateDecision) {
  const next = new Map<number, DuplicateDecision>()
  for (const item of props.items) {
    next.set(item.index, value === 'replace' && isReplaceBlocked(item) ? 'skip' : value)
  }
  decisions.value = next
}

function fmtDate(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function onConfirm() {
  open.value = false
  emit('confirm', decisions.value)
}

function onCancel() {
  open.value = false
  emit('cancel')
}

function onMute() {
  open.value = false
  emit('mute')
  emit('confirm', decisions.value)
}

function onKeydown(e: KeyboardEvent) {
  if (!open.value) return
  if (e.key === 'Escape') onCancel()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open && items.length" class="overlay" role="presentation" @click.self="onCancel">
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dup-dialog-title">
        <div class="handle" aria-hidden="true" />
        <div class="header">
          <h2 id="dup-dialog-title" class="title">发现 {{ items.length }} 首疑似重复</h2>
          <p class="desc">
            这些歌曲在下载记录中已存在。替换会重新下载并覆盖现有文件（下载成功后才覆盖），跳过则不入队。
          </p>
        </div>

        <div class="list">
          <div v-for="group in groups" :key="group.reason" class="group">
            <p class="group-title">{{ group.label }}（{{ group.rows.length }}）</p>

            <div v-for="item in group.rows" :key="item.index" class="row">
              <div class="row-main">
                <p class="new-title">{{ item.title }} <span class="muted">· {{ item.artist }}</span></p>
                <p v-if="item.existing" class="existing">
                  <span class="tag">已有</span>
                  {{ item.existing.title }} · {{ item.existing.artist }}
                  <span v-if="item.existing.quality" class="muted">
                    ｜{{ qualityLabel(item.existing.quality) }}
                  </span>
                  <span class="muted">｜{{ fmtDate(item.existing.updatedAt) }}</span>
                </p>
                <p v-if="item.existing?.fileExists === false" class="warn">原记录的文件已不在磁盘上</p>
                <p v-if="isReplaceBlocked(item)" class="warn">
                  已有音质高于本次请求，替换会降低音质，已默认跳过
                </p>
              </div>

              <div class="row-actions">
                <label class="opt">
                  <input
                    type="radio"
                    :name="`dup-${item.index}`"
                    :checked="decisions.get(item.index) === 'skip'"
                    @change="setDecision(item.index, 'skip')"
                  />
                  <span>跳过</span>
                </label>
                <label class="opt" :class="{ disabled: isReplaceBlocked(item) }">
                  <input
                    type="radio"
                    :name="`dup-${item.index}`"
                    :checked="decisions.get(item.index) === 'replace'"
                    :disabled="isReplaceBlocked(item)"
                    @change="setDecision(item.index, 'replace')"
                  />
                  <span>替换</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <div class="footer">
          <div class="footer-left">
            <template v-if="!isSingle">
              <button class="btn btn-ghost" type="button" @click="setAll('skip')">全部跳过</button>
              <button class="btn btn-ghost" type="button" @click="setAll('replace')">全部替换</button>
            </template>
          </div>
          <div class="footer-right">
            <span class="summary muted">跳过 {{ skipCount }} · 替换 {{ replaceCount }}</span>
            <button class="btn btn-ghost" type="button" @click="onMute">不再提醒</button>
            <button class="btn btn-ghost" type="button" @click="onCancel">取消</button>
            <button class="btn" type="button" @click="onConfirm">确认</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: color-mix(in oklab, #0f172a 40%, transparent);
  backdrop-filter: blur(2px);
}
.dialog {
  width: min(560px, 100%);
  max-height: min(84dvh, 640px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: calc(var(--radius, 10px) + 4px);
  padding: 20px;
  box-shadow: var(--shadow, 0 10px 30px rgb(0 0 0 / 20%));
}
.handle {
  display: none;
}
.header {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
  flex-shrink: 0;
}
.title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.desc {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
}
.group + .group {
  border-top: 1px solid var(--border);
}
.group-title {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  background: color-mix(in oklab, var(--accent) 8%, transparent);
}
.row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  justify-content: space-between;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  font-size: 13px;
}
.row-main {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.new-title {
  margin: 0;
  font-weight: 600;
  word-break: break-word;
}
.existing {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
  word-break: break-word;
}
.tag {
  display: inline-block;
  padding: 0 4px;
  margin-right: 4px;
  font-size: 11px;
  border-radius: 4px;
  background: var(--border);
  color: var(--text);
}
.warn {
  margin: 0;
  font-size: 12px;
  color: var(--danger, #dc2626);
}
.muted {
  color: var(--muted);
}
.row-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
  font-size: 12px;
}
.opt {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.opt.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.footer {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.footer-left,
.footer-right {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.footer .btn {
  padding: 7px 14px;
  font-size: 13px;
  border-radius: 8px;
}
.summary {
  font-size: 12px;
}
@media (max-width: 768px) {
  .overlay {
    align-items: flex-end;
    padding: 0;
  }
  .dialog {
    width: 100%;
    max-width: none;
    max-height: min(88dvh, 680px);
    border-radius: 16px 16px 0 0;
    padding: 10px 16px calc(16px + env(safe-area-inset-bottom, 0px));
  }
  .handle {
    display: block;
    width: 36px;
    height: 4px;
    border-radius: 999px;
    background: var(--border);
    margin: 2px auto 10px;
    flex-shrink: 0;
  }
  .row {
    flex-direction: column;
  }
  .footer {
    flex-direction: column;
    align-items: stretch;
  }
  .footer-left,
  .footer-right {
    justify-content: space-between;
  }
  .footer .btn {
    flex: 1;
    min-height: 40px;
  }
}
</style>
