/**
 * 标定脚本的负样本词表与生成器（**纯函数、零依赖、零 IO**）。
 *
 * 为什么单独一个文件：负样本必须**与记忆库内容彻底无关**，而「无关」这件事要能被机器判红 ——
 * 生成器没有任何入参（`buildNegativeQueries.length === 0`），词表是硬编码的冻结常量，
 * 于是「某个查询词是从库里取来的」这种退化在结构上不可能发生。test/calibrate.test.mjs 直接
 * import 本模块做确定性 / 词表闭包 / 「只含跨域词」三重断言（不启动脚本、更不碰真实库）。
 *
 * 词表纪律：
 *  - 只收**跨域日常词**（天气 / 烹饪 / 旅行 / 体育 / 音乐 / 园艺 / 宠物 / 财务 / 交通 / 健康），
 *    与「Android 壳 / 插件 / 渲染 / 注入 / 门禁 / 记忆系统」这一族主题无交集；
 *  - 中英混排（库是中文长尾语料，只喂纯英文负样本会把噪声地板估低 —— 中文单字也会被分词器切出来）；
 *  - **冻结**：改词表就会改标定出的分位数 ⇒ 改之前先想清楚地基是不是变了。
 */
/** 目标负样本总数（含 NEGATIVE_HEAD 的 12 个）。需求下限是 ≥200，这里留出余量。 */
export const NEGATIVE_QUERY_TARGET = 240

/**
 * 固定的 12 个头部负样本 = 原标定脚本用的那 12 个查询（顺序原样保留）。
 * 保留它们的意义：报告里的「敏感性对照 A：只取前 12 个」就是**旧脚本口径本身**，
 * 于是 A 与 B 的差就是「样本量从 12 涨到 N」带来的估计漂移，而不是换了一批词导致的。
 */
export const NEGATIVE_HEAD = Object.freeze([
  '今天天气怎么样',
  '今晚吃什么比较好',
  'quantum chromodynamics lecture notes',
  'how to bake sourdough bread',
  'unrelated filler words only',
  'zzqq xxvv nonexistent-token',
  'zz0q-nonexistent-token-0',
  'zz1q-nonexistent-token-1',
  'zz2q-nonexistent-token-2',
  'zz3q-nonexistent-token-3',
  'zz4q-nonexistent-token-4',
  'zz5q-nonexistent-token-5',
])

/** 跨域常用词表：固定、冻结、与库主题无关（10 个域 × 6 个词）。 */
export const CROSS_DOMAIN_VOCAB = Object.freeze({
  weather: Object.freeze(['天气预报', '今天有雨', '气温骤降', '台风路径', '空气质量', 'sunny forecast']),
  cooking: Object.freeze(['红烧排骨', '烤箱温度', '发酵面团', '高压锅炖汤', '食材采购', 'sourdough starter']),
  travel: Object.freeze(['高铁车次', '民宿预订', '护照签证', '行李托运', '海岛度假', 'travel itinerary']),
  sports: Object.freeze(['马拉松配速', '篮球比分', '足球转会', '羽毛球拍', '奥运赛程', 'swimming laps']),
  music: Object.freeze(['吉他调弦', '钢琴练习曲', '交响乐门票', '歌词押韵', '合成器音色', 'vinyl record']),
  gardening: Object.freeze(['多肉浇水', '番茄育苗', '月季修剪', '土壤酸碱度', 'compost bin', 'greenhouse']),
  pets: Object.freeze(['猫咪驱虫', '仓鼠笼子', '鹦鹉饲料', '宠物美容', 'vet appointment', 'dog leash training']),
  finance: Object.freeze(['基金定投', '汇率换算', '记账软件', '个人所得税', '储蓄利率', 'mortgage rate']),
  transport: Object.freeze(['地铁换乘', '自行车链条', '堵车绕行', '停车费', '航班延误', 'electric scooter']),
  health: Object.freeze(['睡眠时长', '血压测量', '维生素补充', '跑步拉伤', '体检报告', 'dentist checkup']),
})

/** 固定连接词（中英都有 ⇒ 查询串长短与语种都有分布，不集中在单一形态）。 */
export const CONNECTORS = Object.freeze(['和', '以及', '跟', ' or ', ' vs ', ' about '])

/** 域名的固定顺序（Object.keys 的顺序在 ES 里是插入序，但仍显式排序以免词表改序影响生成结果）。 */
export const VOCAB_DOMAINS = Object.freeze(Object.keys(CROSS_DOMAIN_VOCAB).sort())

/** 扁平化词表：固定顺序 = 域名升序 → 域内原始顺序。 */
export function vocabularyTerms() {
  const out = []
  for (const domain of VOCAB_DOMAINS) {
    for (const text of CROSS_DOMAIN_VOCAB[domain]) out.push({ domain, text })
  }
  return out
}

/**
 * 生成负样本查询：**纯函数、确定性**（同一次运行 / 两次运行逐字节一致；无随机数、无时间、无 IO）。
 *
 * 构词规则（固定、可复算）：
 *   query(i, step) = terms[i].text + CONNECTORS[(i+step) % 6] + terms[(i+step+1) % n].text
 *   外层 step 从 0 递增（先枚举相邻词对，再枚举跨距 2、3 …），内层 i 走遍整张词表；
 *   同域配对只在 step>0 时跳过（尽量保持「跨域组合」），生成到 NEGATIVE_QUERY_TARGET 为止；
 *   重复串（可能与头部 12 个撞）按**首次出现**去重，所以结果仍是确定序列。
 */
export function buildNegativeQueries() {
  const out = [...NEGATIVE_HEAD]
  const seen = new Set(out)
  const terms = vocabularyTerms()
  const n = terms.length
  if (n === 0) return out
  const push = (query) => {
    if (seen.has(query)) return
    seen.add(query)
    out.push(query)
  }
  for (let step = 0; step < n; step += 1) {
    for (let i = 0; i < n; i += 1) {
      const a = terms[i]
      const b = terms[(i + step + 1) % n]
      if (step > 0 && a.domain === b.domain) continue
      const connector = CONNECTORS[(i + step) % CONNECTORS.length]
      push(`${a.text}${connector}${b.text}`)
      if (out.length >= NEGATIVE_QUERY_TARGET) return out
    }
  }
  // 词表小到凑不满目标时**如实少给**（绝不拿库内内容补数）：调用方按实际长度报告。
  return out
}
