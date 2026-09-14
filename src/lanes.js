// 车道判定：哪些消息该切到执行模型。纯函数，只依赖 EXEC_TRIGGERS 环境变量。
// 模型选择本身在 claude.js（buildClaudeArgs）——这里只回答「这条消息是不是执行」。

// 哪些消息算「执行」必须是确定性的：前缀命令（/do /exec /run）或句首的明确触发词。
// 不让模型自己判断——猜错的代价是整轮跑在错误的模型上，且用户无从察觉。
// 自然语言触发词只认句首与词边界：「执行力」「google」「/donut」都不算。
export const DEFAULT_EXEC_TRIGGERS = [
  '/do', '/exec', '/run',
  '执行', '开始执行', '去执行', '去做', '动手', '照做',
  'go', 'go ahead', 'do it', 'run it',
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// 中文触发词后面允许接的语气词/指代词：「执行吧」「执行一下」「去做上面那个」都算；
// 「执行力」「执行官」这类复合词因后字不在此集合而不命中
const CJK_FOLLOW = '(?:吧|了|啦|呗|一下|一遍|这|那|它|上面|以上|第|全部|剩)';
function triggerRegex(trig) {
  const cjk = /\p{Script=Han}/u.test(trig);
  return cjk
    ? new RegExp(`^${escapeRe(trig)}(?=$|[\\s\\p{P}]|${CJK_FOLLOW})`, 'u')
    : new RegExp(`^${escapeRe(trig)}(?=$|[^\\p{L}\\p{N}_])`, 'iu');
}
// 触发词表按 EXEC_TRIGGERS 的当前值缓存：值没变就复用编译好的正则，变了就重建
let tableFor = null;
let table = [];
function triggerTable() {
  const raw = process.env.EXEC_TRIGGERS ?? '';
  if (tableFor === raw) return table;
  const custom = raw.split(',').map((s) => s.trim()).filter(Boolean);
  table = (custom.length ? custom : DEFAULT_EXEC_TRIGGERS)
    .map((trig) => ({ trig, re: triggerRegex(trig), cmd: trig.startsWith('/') }));
  tableFor = raw;
  return table;
}

/**
 * 判定一条消息该走哪条车道。返回 { lane: 'chat'|'exec', prompt }。
 * 命令式前缀（/do）会被剥掉；自然语言触发词是正文的一部分，原样保留。
 * 裸 /do 表示「执行上面已确认的计划」。
 */
export function routeTurn(text) {
  const t = String(text ?? '').trim();
  for (const { trig, re, cmd } of triggerTable()) {
    if (!re.test(t)) continue;
    if (!cmd) return { lane: 'exec', prompt: t };
    const rest = t.slice(trig.length).trim();
    return { lane: 'exec', prompt: rest || '按照上面已经确认的计划直接执行，完成后汇报结果。' };
  }
  return { lane: 'chat', prompt: t };
}

