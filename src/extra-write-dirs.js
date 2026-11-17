// BRIDGE-PUB-1：OWNER_STRICT_DENY_WRITE_DIRS——owner 自己在别处另有、strict 档必须写不了的目录（逗号分隔的绝对路径，默认空）。
// 以前 strict 的拒绝清单里写死了 owner 个人的一个目录；公开仓库里不该有，改成配置。
// 只驱动 strict 档 --disallowedTools 里的 Edit(//<目录>/**)：legacy / audit 的 argv 不受影响（它们本来就没有这条）。
// 规则会拼进逗号分隔的 CLI 参数，所以路径必须干净：绝对路径、规范化后不是 /、家目录及其上级、桥接目录及其上级，
// 不与 owner / 访客工作区重叠（否则 strict 连自己的工作区都写不了），不含空白、逗号、括号、通配符与控制字符。
// 不合格的逐条忽略并打一行 [config] ⚠️（值做 JSON 转义，控制字符不会原样进日志）。
import path from 'node:path';

const BAD_CHARS = /[\s,()*?[\]{}!\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

/** 日志里显示的值：JSON 转义，再把 JSON 不转义的格式字符 / 行段分隔符也转成 \\uXXXX，不让它们原样进日志 */
const quote = (v) => JSON.stringify(v).replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`);

/** 一条路径的问题（空串＝合格）。dir 已 trim。 */
function problemOf(dir, norm, { home, bridgeRoot, workspaces }) {
  if (!dir.startsWith('/')) return '不是绝对路径（不展开 ~）';
  if (BAD_CHARS.test(dir)) return '含空白、逗号、括号、通配符、反斜杠或控制字符';
  if (norm === '/') return '不能是根目录';
  if (home && within(path.posix.resolve(home), norm)) return '不能是家目录或其上级';
  if (bridgeRoot && within(path.posix.resolve(bridgeRoot), norm)) return '不能是桥接目录或其上级';
  for (const w of workspaces ?? []) {
    if (!w) continue;
    const ws = path.posix.resolve(w);
    if (within(ws, norm) || within(norm, ws)) return '与工作区重叠';
  }
  return '';
}

/**
 * 解析 OWNER_STRICT_DENY_WRITE_DIRS → 规范化后的绝对路径数组（去重、保持顺序）。
 * @param {string|undefined} raw
 * @param {{home?: string, bridgeRoot?: string, workspaces?: string[], warn?: (msg: string) => void}} ctx
 */
export function parseExtraWriteDirs(raw, { home, bridgeRoot, workspaces = [], warn = console.error } = {}) {
  const out = [];
  for (const item of String(raw ?? '').split(',')) {
    const dir = item.trim();
    if (!dir) continue;
    const norm = dir.startsWith('/') ? path.posix.resolve(dir) : dir;
    const problem = problemOf(dir, norm, { home, bridgeRoot, workspaces });
    if (problem) {
      warn(`[config] ⚠️ OWNER_STRICT_DENY_WRITE_DIRS 忽略 ${quote(dir)}：${problem}`);
      continue;
    }
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

/** strict 档拒绝清单里的写法：Edit(//<去掉前导 / 的绝对路径>/**)（与原先写死的那条同一格式） */
export const extraWriteDenyRules = (dirs) => dirs.map((d) => `Edit(//${d.replace(/^\/+/, '')}/**)`);
