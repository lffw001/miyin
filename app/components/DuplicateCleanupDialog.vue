<script setup lang="ts">
import { qualityRank } from '#shared/quality'

export type DuplicateCleanupItem = {
  id: string
  title: string
  artist: string
  album: string | null
  platform: string
  quality: string | null
  status: string
  filePath: string | null
  fileSize: number | null
  updatedAt: string
}

export type DuplicateCleanupGroup = {
  dedupKey: string
  label: string
  items: DuplicateCleanupItem[]
}

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ deleted: [] }>()

const toast = useToast()
const loading = ref(false)
const deleting = ref(false)
const confirming = ref(false)
const groups = ref<DuplicateCleanupGroup[]>([])
const selected = ref<Set<string>>(new Set())
const deleteLocalFiles = ref(false)

const totalItems = computed(() => groups.value.reduce((sum, g) => sum + g.items.length, 0))
const selectedCount = computed(() => selected.value.size)

/**
 * 一组里保留哪条：音质最高优先，其次最新。
 * 音质未知（`highest` / null）视为最低优先级，避免把"未知"误当"最好"。
 */
function bestItemOf(items: DuplicateCleanupItem[]): DuplicateCleanupItem | null {
  const ranked = [...items].sort((a, b) => {
    const ra = qualityRank(a.quality)
    const rb = qualityRank(b.quality)
    const va = ra == null ? Number.MAX_SAFE_INTEGER : ra
    const vb = rb == null ? Number.MAX_SAFE_INTEGER : rb
    if (va !== vb) return va - vb
    return a.updatedAt < b.updatedAt ? 1 : -1
  })
  return ranked[0] ?? null
}

/** 默认：每组留一条最好的，其余勾上待删 */
function applyDefaultSelection() {
  const next = new Set<string>()
  for (const group of groups.value) {
    const keep = bestItemOf(group.items)
    for (const item of group.items) {
      if (item.id !== keep?.id) next.add(item.id)
    }
  }
  selected.value = next
  confirming.value = false
}

async function load() {
  loading.value = true
  try {
    const res = await $fetch<{ groups: DuplicateCleanupGroup[] }>('/api/downloads/duplicates')
    groups.value = res.groups || []
    applyDefaultSelection()
  } catch (e: unknown) {
    toast.error(apiErrorMessage(e, '加载重复记录失败'))
  } finally {
    loading.value = false
  }
}

watch(open, (value) => {
  if (value) void load()
  else confirming.value = false
})

function toggleOne(id: string, checked: boolean) {
  const next = new Set(selected.value)
  if (checked) next.add(id)
  else next.delete(id)
  selected.value = next
  confirming.value = false
}

function toggleGroup(group: DuplicateCleanupGroup, checked: boolean) {
  const next = new Set(selected.value)
  for (const item of group.items) {
    if (checked) next.add(item.id)
    else next.delete(item.id)
  }
  selected.value = next
  confirming.value = false
}

function clearSelection() {
  selected.value = new Set()
  confirming.value = false
}

function groupSelectedCount(group: DuplicateCleanupGroup) {
  return group.items.filter((item) => selected.value.has(item.id)).length
}

function fmtSize(n: number | null) {
  if (n == null || n <= 0) return ''
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtDate(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function doDelete() {
  if (!selectedCount.value || deleting.value) return
  if (!confirming.value) {
    confirming.value = true
    return
  }
  deleting.value = true
  try {
    const count = selectedCount.value
    await $fetch('/api/downloads/batch-delete', {
      method: 'POST',
      body: { ids: [...selected.value], deleteLocalFiles: deleteLocalFiles.value },
    })
    toast.success(
      `已清理 ${count} 条重复记录` + (deleteLocalFiles.value ? '（含本地文件）' : ''),
    )
    emit('deleted')
    await load()
  } catch (e: unknown) {
    toast.error(apiErrorMessage(e, '清理失败'))
  } finally {
    deleting.value = false
    confirming.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (!open.value) return
  if (e.key === 'Escape') open.value = false
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" role="presentation" @click.self="open = false">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-dialog-title">
        <div class="handle" aria-hidden="true" />
        <div class="header">
          <h2 id="cleanup-dialog-title" class="title">清理重复下载记录</h2>
          <p class="desc">
            入队判重只对新增任务生效，这里列出的是此前已经下重的记录。默认每组保留音质最高的一条。
          </p>
        </div>

        <p v-if="loading" class="state muted">加载中…</p>
        <p v-else-if="!groups.length" class="state muted">没有发现重复的下载记录 🎉</p>

        <template v-else>
          <p class="summary muted">
            共 {{ groups.length }} 组 · {{ totalItems }} 条记录 · 已选 {{ selectedCount }} 条待删除
          </p>

          <div class="list">
            <div v-for="group in groups" :key="group.dedupKey" class="group">
              <div class="group-head">
                <label class="group-check">
                  <input
                    type="checkbox"
                    :checked="groupSelectedCount(group) === group.items.length"
                    @change="toggleGroup(group, ($event.target as HTMLInputElement).checked)"
                  />
                  <span class="group-label">{{ group.label }}</span>
                </label>
                <span class="muted">{{ group.items.length }} 条</span>
              </div>

              <label v-for="item in group.items" :key="item.id" class="row">
                <input
                  type="checkbox"
                  :checked="selected.has(item.id)"
                  @change="toggleOne(item.id, ($event.target as HTMLInputElement).checked)"
                />
                <span class="row-main">
                  <span class="row-title">{{ item.title }}</span>
                  <span class="muted row-meta">
                    {{ item.artist }}
                    ｜{{ platformLabel(item.platform) }}
                    <template v-if="item.quality">｜{{ qualityLabel(item.quality) }}</template>
                    <template v-if="fmtSize(item.fileSize)">｜{{ fmtSize(item.fileSize) }}</template>
                    ｜{{ fmtDate(item.updatedAt) }}
                  </span>
                  <span v-if="item.filePath" class="muted path">{{ item.filePath }}</span>
                </span>
              </label>
            </div>
          </div>

          <div class="options">
            <label class="opt">
              <input v-model="deleteLocalFiles" type="checkbox" @change="confirming = false" />
              同时删除本地文件
            </label>
            <p v-if="deleteLocalFiles" class="warn">
              删除后文件将从下载目录移除，无法在应用内恢复。
            </p>
          </div>
        </template>

        <div class="footer">
          <div class="footer-left">
            <button v-if="groups.length" class="btn btn-ghost" type="button" @click="applyDefaultSelection">
              保留最佳
            </button>
            <button v-if="groups.length" class="btn btn-ghost" type="button" @click="clearSelection">
              全不选
            </button>
          </div>
          <div class="footer-right">
            <button class="btn btn-ghost" type="button" @click="open = false">关闭</button>
            <button
              class="btn"
              :class="{ 'btn-danger': confirming }"
              type="button"
              :disabled="!selectedCount || deleting"
              @click="doDelete"
            >
              {{
                confirming
                  ? `确认删除 ${selectedCount} 条`
                  : `删除选中（${selectedCount}）`
              }}
            </button>
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
  width: min(640px, 100%);
  max-height: min(86dvh, 720px);
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
  margin-bottom: 10px;
  flex-shrink: 0;
}
.title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.desc,
.state {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
.state {
  padding: 24px 0;
  text-align: center;
}
.summary {
  margin: 0 0 8px;
  font-size: 12px;
  flex-shrink: 0;
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
}
.group + .group {
  border-top: 1px solid var(--border);
}
.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: color-mix(in oklab, var(--accent) 8%, transparent);
  font-size: 12px;
}
.group-check {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  min-width: 0;
}
.group-label {
  font-weight: 600;
  color: var(--accent);
  word-break: break-word;
}
.row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  cursor: pointer;
  font-size: 13px;
}
.row-main {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.row-title {
  font-weight: 500;
  word-break: break-word;
}
.row-meta,
.path {
  font-size: 12px;
  word-break: break-all;
}
.path {
  opacity: 0.75;
}
.options {
  flex-shrink: 0;
  margin-bottom: 10px;
}
.opt {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}
.warn {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--danger, #dc2626);
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
@media (max-width: 768px) {
  .overlay {
    align-items: flex-end;
    padding: 0;
  }
  .dialog {
    width: 100%;
    max-width: none;
    max-height: min(90dvh, 720px);
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
