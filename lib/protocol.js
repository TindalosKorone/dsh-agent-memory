/**
 * 写入协议校验（失败关闭）。
 *
 * 任何一项不满足 ⇒ 返回 { ok:false, code, text }，**绝不落盘**。
 * text 必须是「模型能照着改」的修复指引：给出违规字段、约束原文、以及一个可用的最小示例。
 */
export const KINDS = ['fact', 'lesson', 'preference', 'pointer'];
export const TITLE_MIN = 8;
export const TITLE_MAX = 120;
export const TAG_MIN = 1;
export const TAG_MAX = 12;
export const TAG_LEN_MAX = 32;
/** 标签归一化：只做 trim + 小写化（不做同义词归一，保证全库稳定复用）。 */
export function normalizeTag(tag) {
    return tag.trim().toLowerCase();
}
/** title 必须是单行：除 \n / \r 外，也把 Unicode 行分隔符一并拒绝。 */
const LINE_BREAK = /[\n\r\u2028\u2029]/;
/** 可照抄的最小可用调用示例（每个失败指引都带上它）。 */
export const EXAMPLE_CALL = '{"kind":"fact","title":"用户偏好深色主题","body":"用户在设置里选择了深色主题。","tags":["preference","ui"],"source":"session:demo"}';
function fail(code, detail, hint) {
    return {
        ok: false,
        code,
        text: `写入被拒（失败关闭，未落盘）。\n- 违规项：${detail}\n- 规则：${hint}\n- 修复后重试，可照抄的最小示例：${EXAMPLE_CALL}`,
    };
}
/**
 * 校验一条待写入记录。
 * 顺序：kind → title → body → tags → source（先报最靠前的错，指引不互相干扰）。
 */
export function validateDraft(input) {
    const src = input ?? {};
    // kind：四选一
    if (typeof src.kind !== 'string' || !KINDS.includes(src.kind)) {
        return fail('bad-kind', `kind = ${typeof src.kind === 'string' ? JSON.stringify(src.kind) : String(src.kind)}`, `kind 必须恰好是这四个之一：${KINDS.join(' | ')}`);
    }
    const kind = src.kind;
    // title：字符串，去首尾空白后 8..120 字符，且不得含换行
    if (typeof src.title !== 'string') {
        return fail('bad-title', `title 类型是 ${typeof src.title}，不是 string`, 'title 必须是 string');
    }
    if (LINE_BREAK.test(src.title)) {
        return fail('title-multiline', 'title 含换行符（\\n / \\r / U+2028 / U+2029）', 'title 必须是单行；需要写细节请放进 body');
    }
    const title = src.title.trim();
    if (title.length < TITLE_MIN) {
        return fail('title-too-short', `title 去空白后只有 ${title.length} 个字符：${JSON.stringify(title)}`, `title 去首尾空白后长度必须 >= ${TITLE_MIN}`);
    }
    if (title.length > TITLE_MAX) {
        return fail('title-too-long', `title 去空白后有 ${title.length} 个字符`, `title 去首尾空白后长度必须 <= ${TITLE_MAX}（超出部分请移到 body）`);
    }
    // body：非空
    if (typeof src.body !== 'string') {
        return fail('bad-body', `body 类型是 ${typeof src.body}，不是 string`, 'body 必须是 string');
    }
    const body = src.body.trim();
    if (body === '') {
        return fail('empty-body', 'body 去首尾空白后为空', 'body 必须非空；请把这条记忆的实际内容写进去');
    }
    // tags：有序数组，1..12 个，每个 1..32 字符，不得重复（按归一化后比较）
    if (!Array.isArray(src.tags)) {
        return fail('bad-tags', `tags 类型是 ${typeof src.tags}，不是数组`, `tags 必须是字符串数组，长度 ${TAG_MIN}..${TAG_MAX}，例如 ["preference","ui"]`);
    }
    if (src.tags.length < TAG_MIN) {
        return fail('tags-too-few', 'tags 为空数组', `tags 至少 ${TAG_MIN} 个（顺序有意义，按语义重要性排列）`);
    }
    if (src.tags.length > TAG_MAX) {
        return fail('tags-too-many', `tags 有 ${src.tags.length} 个`, `tags 最多 ${TAG_MAX} 个`);
    }
    const tags = [];
    const seen = new Set();
    for (let i = 0; i < src.tags.length; i += 1) {
        const raw = src.tags[i];
        if (typeof raw !== 'string') {
            return fail('bad-tag', `tags[${i}] 类型是 ${typeof raw}，不是 string`, `tags 每一项都必须是 string，单个长度 1..${TAG_LEN_MAX}`);
        }
        const tag = normalizeTag(raw);
        if (tag === '' || tag.length > TAG_LEN_MAX) {
            return fail('bad-tag', `tags[${i}] 归一化后长度为 ${tag.length}：${JSON.stringify(tag)}`, `每个 tag 去空白并小写化后长度必须 1..${TAG_LEN_MAX}`);
        }
        if (seen.has(tag)) {
            return fail('duplicate-tags', `tags 里 ${JSON.stringify(tag)} 重复出现（归一化后比较）`, 'tags 不得重复；重复项请合并，只保留一个');
        }
        seen.add(tag);
        tags.push(tag);
    }
    // source：非空字符串
    if (typeof src.source !== 'string') {
        return fail('bad-source', `source 类型是 ${typeof src.source}，不是 string`, 'source 必须是 string（出处：会话 / 文件 / URL）');
    }
    const source = src.source.trim();
    if (source === '') {
        return fail('empty-source', 'source 去首尾空白后为空', 'source 必须非空，写明出处，例如 session:abc123 或 file:src/index.ts');
    }
    return { ok: true, value: { kind, title, body, tags, source } };
}
/** 从 NDJSON 单行还原记录；不可用的行返回 undefined（坏行不该拖垮整库）。 */
export function normalizeStoredRecord(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const r = value;
    if (typeof r.id !== 'string' || r.id === '')
        return undefined;
    if (typeof r.ts !== 'number' || !Number.isFinite(r.ts))
        return undefined;
    if (typeof r.kind !== 'string' || !KINDS.includes(r.kind))
        return undefined;
    if (typeof r.title !== 'string' || typeof r.body !== 'string' || typeof r.source !== 'string')
        return undefined;
    if (!Array.isArray(r.tags))
        return undefined;
    const tags = r.tags.filter((t) => typeof t === 'string');
    const hits = typeof r.hits === 'number' && Number.isFinite(r.hits) && r.hits > 0 ? Math.floor(r.hits) : 0;
    // 重建为固定键序，保证落盘字节数稳定
    return { id: r.id, ts: r.ts, kind: r.kind, title: r.title, body: r.body, tags: [...tags], source: r.source, hits };
}
