/**
 * 曲库检索能力层的归一化原语。
 *
 * 两个键服务不同目的，归一化规则**故意不同**：
 * - `dedupKey`   判身份：严格归一化，**去除括号及其内容** → 入队判重用（`稻香 (Live)` ≡ `稻香`）
 * - `searchText` 保可达性：基础归一化 + 去标点、**保留**括号内容 → 历史检索用
 *   （子串匹配天然让「稻香」命中「稻香(Live)」，保留后还能用「live」搜到现场版）
 *
 * 两者共用 `normalizeText()` 作为底座，因此不会出现两套"差不多但不一致"的归一化逻辑。
 */

/** 字段分隔符（Unit Separator）：避免 title / artist 拼接产生跨字段误命中 */
export const FIELD_SEP = '\u001f'

/** 全角 → 半角：覆盖全角空格 U+3000 与全角 ASCII 区（含 `（）` U+FF08/U+FF09） */
export function toHalfWidth(input: string) {
  let out = ''
  for (const ch of input || '') {
    const code = ch.codePointAt(0)!
    if (code === 0x3000) out += ' '
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0)
    else out += ch
  }
  return out
}

/** 基础归一化：全角→半角 → 小写 → 去除所有空白 */
export function normalizeText(input: string) {
  return toHalfWidth(input || '')
    .toLowerCase()
    .replace(/\s+/g, '')
}

/**
 * 判重归一化：基础归一化 + 去除括号及其内容。
 *
 * **已确认口径**：`稻香 (Live)` 与 `稻香` 判为相同曲。
 * 与 `server/services/trackMatcher.ts` 的 `norm()` 行为一致（后者直接复用本函数）。
 */
export function normalizeForDedup(input: string) {
  return normalizeText(input).replace(/[（(].*?[）)]/g, '')
}

/**
 * 检索归一化：基础归一化 + 去除标点（`\p{P}`）。
 * 只去标点、不去符号，避免 `C++` 一类标题被压成单字母导致检索发散。
 */
export function normalizeSearchToken(input: string) {
  return normalizeText(input).replace(/\p{P}/gu, '')
}

/** 主歌手：取第一个分隔符之前的部分（`周杰伦/方文山` → `周杰伦`） */
export function primaryArtist(artist: string) {
  return (artist || '').split(/[\/,&]/)[0] || ''
}

/**
 * 判重键：主歌手 + 标题。
 *
 * 标题去括号后为空时（如 `（伴奏）`）回退到保留括号的形态，
 * 否则同歌手的 `稻香（伴奏）` 与 `晴天（伴奏）` 会双双归一为「歌手 + 空」而互相误判。
 * 双字段都为空时返回 `''`，调用方应视为「无判重键」并跳过判重。
 */
export function buildDedupKey(artist: string, title: string) {
  const a = normalizeForDedup(primaryArtist(artist))
  const strippedTitle = normalizeForDedup(title)
  const t = strippedTitle || normalizeText(title)
  if (!a && !t) return ''
  return `${a}${FIELD_SEP}${t}`
}

/** 检索文本：标题 / 歌手 / 专辑归一化后以 Unit Separator 拼接（空字段跳过） */
export function buildSearchText(meta: {
  title?: string | null
  artist?: string | null
  album?: string | null
}) {
  return [meta.title, meta.artist, meta.album]
    .map((v) => normalizeSearchToken(String(v ?? '')))
    .filter(Boolean)
    .join(FIELD_SEP)
}

/** 查询分词：按空白切分 → 逐个归一化 → 去空 → 去重（去重可减少重复 LIKE 子句） */
export function tokenizeQuery(query: string) {
  const tokens = new Set<string>()
  for (const raw of (query || '').split(/\s+/)) {
    const token = normalizeSearchToken(raw)
    if (token) tokens.add(token)
  }
  return [...tokens]
}

/**
 * 关键词是否命中给定曲目元数据。
 *
 * 判据与服务端 `search_text LIKE '%token%' AND …` **严格一致**：
 * 每个 token 都必须是 `buildSearchText` 结果的子串；空 token 集合视为命中（退化为无过滤）。
 *
 * 队列页用它过滤 SSE 推送的增量任务，避免不匹配的任务被插进搜索结果列表。
 */
export function matchesTrackKeyword(
  meta: { title?: string | null; artist?: string | null; album?: string | null },
  keyword: string | null | undefined,
): boolean {
  const tokens = keyword ? tokenizeQuery(keyword) : []
  if (!tokens.length) return true
  const text = buildSearchText(meta)
  return tokens.every((token) => text.includes(token))
}
