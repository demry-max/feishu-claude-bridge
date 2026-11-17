// BRIDGE-PUB-1：owner 的称呼可配置（OWNER_NAME）。
// 桥接发给 owner 的消息、发给模型的 prompt、日志里提到 owner 的地方都从这里取称呼，不在源码里写死某个人名。
// - 设了合法值：两处都用它（设成原先写死的那个称呼时，所有输出与改动前逐字相同）；
// - 没设：对 owner 说话的地方用「你」，向模型 / 日志描述 owner 的地方用「owner」；
// - 设了但不合法：按没设处理，启动后第一次用到时打一行 [config] ⚠️（不打原值，避免把控制字符带进日志）。
// 称呼会进 prompt 的围栏外文字，所以只放行字母、数字、组合附标与少量分隔符：
// 不能出现能闭合围栏 / 伪造标记的字符（< > ` 「」『』（）[] 等）和换行。

export const OWNER_NAME_MAX = 20;
export const DEFAULT_OWNER_SPOKEN = '你';
export const DEFAULT_OWNER_DESCRIBED = 'owner';

// 名字里允许的分隔符：空格、间隔号（· ・）、点、撇号（' ’）、连字符；只能夹在两个字母 / 数字之间，不能连用
const SEP = " ·・.'’-";
const NAME_RE = new RegExp(`^[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}]*(?:[${SEP.replace(/[-\\\]^]/g, '\\$&')}][\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}]*)*$`, 'u');
const BREAK_RE = /[\p{Cc}\p{Zl}\p{Zp}]/gu; // 换行、控制字符、行 / 段分隔符 → 空格
const FORMAT_RE = /\p{Cf}/gu; // 零宽、方向控制等格式字符 → 删掉

/**
 * 解析 OWNER_NAME。返回 { value, problem }：value 为 null 表示按没设处理；problem 非空表示设了但不合法（要告警）。
 * 先把换行、控制字符与行 / 段分隔符变成空格、删掉格式字符（零宽、方向控制），空白合并成一个空格并去首尾；
 * 剩下的为空＝没设；超过 OWNER_NAME_MAX 个字、或含白名单以外的字符＝不合法。
 */
export function parseOwnerName(raw) {
  if (raw === undefined || raw === null) return { value: null, problem: '' };
  const s = String(raw).replace(BREAK_RE, ' ').replace(FORMAT_RE, '').replace(/\s+/gu, ' ').trim();
  if (!s) return { value: null, problem: '' };
  if ([...s].length > OWNER_NAME_MAX) return { value: null, problem: `超过 ${OWNER_NAME_MAX} 个字` };
  if (!NAME_RE.test(s)) return { value: null, problem: '只能是字母 / 数字，中间可夹单个空格、·、.、\'、- 分隔' };
  return { value: s, problem: '' };
}

let cache = null; // { raw, value }
/** 当前生效的称呼（未设或不合法为 null）。同一个原值只解析、只告警一次。 */
export function ownerName(env = process.env, warn = console.error) {
  const raw = env?.OWNER_NAME;
  if (cache && cache.raw === raw) return cache.value;
  const { value, problem } = parseOwnerName(raw);
  if (problem) warn(`[config] ⚠️ OWNER_NAME 不合法（${problem}），已按未设处理：对你说话用「${DEFAULT_OWNER_SPOKEN}」，向模型描述用「${DEFAULT_OWNER_DESCRIBED}」`);
  cache = { raw, value };
  return value;
}

/** 对 owner 说话时的称呼（发给 owner 的消息、卡片）：未设为「你」 */
export const ownerSpoken = (env) => ownerName(env) ?? DEFAULT_OWNER_SPOKEN;
/** 向模型 / 日志 / 台账描述 owner 时的称呼：未设为「owner」 */
export const ownerDescribed = (env) => ownerName(env) ?? DEFAULT_OWNER_DESCRIBED;

/** 模板里的占位：OWNER＝向模型描述的称呼，YOU＝对 owner 说话的称呼 */
export const OWNER = Symbol('owner-described');
export const YOU = Symbol('owner-spoken');

const isAsciiAlnum = (c) => /^[A-Za-z0-9]$/.test(c ?? '');
const isHan = (c) => /^\p{Script=Han}$/u.test(c ?? '');
const needsGap = (a, b) => (isAsciiAlnum(a) && isHan(b)) || (isHan(a) && isAsciiAlnum(b));

/**
 * 带称呼的模板（标签函数）：`ownerText\`等${OWNER}回「确认」\``。
 * 只在称呼与相邻文字一边是 ASCII 字母数字、一边是汉字时补一个空格（「等 owner 回」「Alex 点了」）；
 * 称呼本身是汉字（如「王总」「你」）时不补，输出与写死时逐字相同。其它插值原样拼接、不补空格。
 */
export function ownerText(strings, ...vals) {
  const parts = [];
  strings.forEach((s, i) => {
    parts.push({ text: s, name: false });
    if (i < vals.length) {
      const v = vals[i];
      if (v === OWNER) parts.push({ text: ownerDescribed(), name: true });
      else if (v === YOU) parts.push({ text: ownerSpoken(), name: true });
      else parts.push({ text: String(v), name: false });
    }
  });
  let out = '';
  parts.forEach((p, i) => {
    if (!p.name) { out += p.text; return; }
    const before = out.at(-1);
    const rest = parts.slice(i + 1).map((q) => q.text).join('');
    const first = [...p.text][0];
    const last = [...p.text].at(-1);
    out += (needsGap(before, first) ? ' ' : '') + p.text + (needsGap(last, [...rest][0]) ? ' ' : '');
  });
  return out;
}
