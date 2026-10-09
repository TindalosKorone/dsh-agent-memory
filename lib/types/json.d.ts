/**
 * 输出契约小工具。
 *
 * 真机实测教训（与 dsh-agent-screen 同源）：宿主按「无损 JSON」整值校验工具返回值，
 * 任何值为 undefined 的键都会让整值被拒收。所以所有工具返回前一律过 prune()。
 *
 * 另一个已记录的坑：render 必须写在 output 对象**内部**（defineTool 读的是
 * options.output.render）。写成 output 的同级兄弟属性等同没给，运行时会报
 * `output.render failed: userRender is not a function`。
 */
/** 删掉值为 undefined 的键；不递归（本插件返回值都是浅层对象）。 */
export declare function prune<T extends Record<string, unknown>>(value: T): T;
/** 模型面渲染：统一渲染返回值里的 text 摘要；没有 text 时回退为 JSON。 */
export declare function RENDER(_args: unknown, value: unknown): {
    type: 'text';
    text: string;
}[];
