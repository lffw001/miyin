import { describe, it, expect } from 'vitest'
import {
  FIELD_SEP,
  normalizeText,
  normalizeForDedup,
  normalizeSearchToken,
  primaryArtist,
  buildDedupKey,
  buildSearchText,
  tokenizeQuery,
  matchesTrackKeyword,
} from '#shared/trackKey'

describe('normalizeText', () => {
  it('全角转半角、小写、去空白', () => {
    expect(normalizeText('　稻香　（Ｌｉｖｅ）　')).toBe('稻香(live)')
    expect(normalizeText('AB C')).toBe('abc')
    expect(normalizeText('')).toBe('')
  })

  it('全角空格与普通空格等价', () => {
    expect(normalizeText('稻香\u3000Live')).toBe(normalizeText('稻香 Live'))
  })
})

describe('normalizeForDedup', () => {
  it('去除括号及其内容（已确认口径：Live 与录音室版同曲）', () => {
    expect(normalizeForDedup('稻香 (Live)')).toBe('稻香')
    expect(normalizeForDedup('稻香')).toBe('稻香')
  })

  it('全角半角括号归一后一致', () => {
    expect(normalizeForDedup('稻香（Live）')).toBe(normalizeForDedup('稻香 (Live)'))
  })

  it('括号内空白不影响归一结果', () => {
    expect(normalizeForDedup('稻香( mix )')).toBe(normalizeForDedup('稻香(mix)'))
  })
})

describe('normalizeSearchToken', () => {
  it('去除标点但保留括号内内容', () => {
    expect(normalizeSearchToken('稻香 (Live)')).toBe('稻香live')
    expect(normalizeSearchToken('稻香！')).toBe('稻香')
  })

  it('不把符号类字符压掉，避免 C++ 变成 c', () => {
    expect(normalizeSearchToken('C++')).toBe('c++')
  })
})

describe('buildDedupKey', () => {
  it('Live 版与录音室版同键（用户确认口径的回归锚点）', () => {
    expect(buildDedupKey('周杰伦', '稻香 (Live)')).toBe(buildDedupKey('周杰伦', '稻香'))
  })

  it('全角半角括号、大小写、空格差异均同键', () => {
    const base = buildDedupKey('周杰伦', '稻香 (Live)')
    expect(buildDedupKey('周杰伦', '稻香（live）')).toBe(base)
    expect(buildDedupKey(' 周杰伦 ', ' 稻香  ( LIVE ) ')).toBe(base)
  })

  it('不同标题不同键', () => {
    expect(buildDedupKey('周杰伦', '稻香')).not.toBe(buildDedupKey('周杰伦', '晴天'))
  })

  it('不同歌手不同键', () => {
    expect(buildDedupKey('周杰伦', '稻香')).not.toBe(buildDedupKey('林俊杰', '稻香'))
  })

  it('多歌手段只取主歌手', () => {
    expect(buildDedupKey('周杰伦/方文山', '稻香')).toBe(buildDedupKey('周杰伦', '稻香'))
    expect(buildDedupKey('周杰伦, 方文山', '稻香')).toBe(buildDedupKey('周杰伦', '稻香'))
    expect(buildDedupKey('周杰伦 & 方文山', '稻香')).toBe(buildDedupKey('周杰伦', '稻香'))
  })

  it('括号内容一律被剥离：伴奏版 / 现场版都与录音室版同键（口径一致性）', () => {
    expect(buildDedupKey('周杰伦', '稻香（伴奏）')).toBe(buildDedupKey('周杰伦', '稻香'))
    expect(buildDedupKey('周杰伦', '稻香 (Live)')).toBe(buildDedupKey('周杰伦', '稻香'))
  })

  it('全部为括号的标题回退到保留括号形态，不与其它曲目误判', () => {
    const a = buildDedupKey('周杰伦', '（伴奏）')
    const b = buildDedupKey('周杰伦', '（纯音乐）')
    expect(a).not.toBe(b)
    expect(a).not.toBe(buildDedupKey('周杰伦', '稻香'))
  })

  it('双字段都为空时返回空串（调用方应视为无判重键）', () => {
    expect(buildDedupKey('', '')).toBe('')
    expect(buildDedupKey('   ', '   ')).toBe('')
  })
})

describe('buildSearchText', () => {
  it('拼接标题 / 歌手 / 专辑，空字段跳过，保留括号内容', () => {
    expect(buildSearchText({ title: '稻香 (Live)', artist: '周杰伦', album: '魔杰座' })).toBe(
      `稻香live${FIELD_SEP}周杰伦${FIELD_SEP}魔杰座`,
    )
    expect(buildSearchText({ title: '稻香', artist: '周杰伦' })).toBe(`稻香${FIELD_SEP}周杰伦`)
    expect(buildSearchText({ title: '稻香', artist: '周杰伦', album: null })).toBe(
      `稻香${FIELD_SEP}周杰伦`,
    )
  })

  it('检索可达性：稻香与 live 都是同一 search_text 的子串', () => {
    const text = buildSearchText({ title: '稻香 (Live)', artist: '周杰伦' })
    expect(text.includes(normalizeSearchToken('稻香'))).toBe(true)
    expect(text.includes(normalizeSearchToken('live'))).toBe(true)
  })
})

describe('tokenizeQuery', () => {
  it('按空白切分并归一化', () => {
    expect(tokenizeQuery('周杰伦  稻香')).toEqual(['周杰伦', '稻香'])
    expect(tokenizeQuery('周杰伦　稻香')).toEqual(['周杰伦', '稻香'])
  })

  it('去标点、去空、去重', () => {
    expect(tokenizeQuery('周杰伦！ 稻香 稻香')).toEqual(['周杰伦', '稻香'])
    expect(tokenizeQuery('   ')).toEqual([])
    expect(tokenizeQuery('')).toEqual([])
  })

  it('词序无关：两种输入产出同一 token 集合', () => {
    const a = tokenizeQuery('周杰伦 稻香')
    const b = tokenizeQuery('稻香 周杰伦')
    expect([...a].sort()).toEqual([...b].sort())
  })
})

describe('primaryArtist', () => {
  it('取第一个分隔符前的部分', () => {
    expect(primaryArtist('周杰伦/方文山')).toBe('周杰伦')
    expect(primaryArtist('周杰伦,方文山')).toBe('周杰伦')
    expect(primaryArtist('周杰伦&方文山')).toBe('周杰伦')
    expect(primaryArtist('周杰伦')).toBe('周杰伦')
    expect(primaryArtist('')).toBe('')
  })
})

describe('matchesTrackKeyword（队列页 SSE 过滤判据）', () => {
  const track = { title: '稻香 (Live)', artist: '周杰伦', album: '魔杰座' }

  it('命中标题 / 歌手 / 专辑', () => {
    expect(matchesTrackKeyword(track, '稻香')).toBe(true)
    expect(matchesTrackKeyword(track, '周杰伦')).toBe(true)
    expect(matchesTrackKeyword(track, '魔杰座')).toBe(true)
    expect(matchesTrackKeyword(track, 'live')).toBe(true)
  })

  it('不命中无关关键词', () => {
    expect(matchesTrackKeyword(track, '晴天')).toBe(false)
    expect(matchesTrackKeyword(track, '林俊杰')).toBe(false)
  })

  it('多关键词 AND：缺少任一 token 即不命中', () => {
    expect(matchesTrackKeyword(track, '周杰伦 稻香')).toBe(true)
    expect(matchesTrackKeyword(track, '周杰伦 晴天')).toBe(false)
  })

  it('空关键词与纯标点关键词都退化为命中（等同于无过滤）', () => {
    expect(matchesTrackKeyword(track, '')).toBe(true)
    expect(matchesTrackKeyword(track, undefined)).toBe(true)
    expect(matchesTrackKeyword(track, '   ')).toBe(true)
    expect(matchesTrackKeyword(track, '%')).toBe(true)
  })

  it('全角 / 大小写差异不影响判定', () => {
    expect(matchesTrackKeyword(track, 'ＬＩＶＥ')).toBe(true)
    expect(matchesTrackKeyword(track, '周杰伦　稻香')).toBe(true)
  })
})
