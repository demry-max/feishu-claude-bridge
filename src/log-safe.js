// BRIDGE-STD-1（C9）：日志里的 id 只留末 6 位，日志文件只给本人读。
// 三件事：① tail6——逐处截短用（主力）；② installConsoleIdMask——console 层的兜底，防漏网的完整 oc_/ou_/on_ id；
// ③ tightenLogFds——启动时把 stdout/stderr 指向的日志文件收紧到 0600（launchd 的日志文件由它自己创建，默认 0644）。
// 本文件不 import 本仓库任何模块。
import nodeFs from 'node:fs';

/** `…` + 末 6 位；没有 id 返回 ? */
export const tail6 = (id) => (id ? `…${String(id).slice(-6)}` : '?');

const ID_RE = /\b(oc|ou|on)_[A-Za-z0-9]{6,}/g;

/** 把字符串里完整的 oc_ / ou_ / on_ id 换成 `<前缀>_…<末 6 位>`；已经截过的（`ou_…abc123`）不再变，om_ 不动 */
export function maskIds(text) {
  return String(text).replace(ID_RE, (m, p) => `${p}_…${m.slice(-6)}`);
}

// SDK 打请求错误时把请求体（config.data）和飞书回显的字段值（field_violations[].value）一起交给 console：这两处装着消息正文，整个换掉
const BODY_AT = { config: 'data', field_violations: 'value' };

/**
 * 一个参数脱 id、去请求正文。字符串与 Error（取栈）直接脱；数组和普通对象逐层复制着脱——SDK 的默认 logger 把参数装在数组里交给 console，
 * 报错对象（带请求参数、URL）嵌在里面。类实例原样交出去；原对象不改；环引用和超过 8 层的部分记 […]。
 */
function maskArg(a, path = [], under = '') {
  try {
    if (typeof a === 'string') return maskIds(a);
    if (a instanceof Error) return maskIds(a.stack ?? String(a));
    const list = Array.isArray(a);
    if (!list && !(a && typeof a === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(a)))) return a;
    if (path.length >= 8 || path.includes(a)) return '[…]';
    const next = (v, k) => maskArg(v, [...path, a], k);
    if (list) return a.map((v) => next(v, under));
    return Object.fromEntries(Object.entries(a).map(([k, v]) => [maskIds(k), BODY_AT[under] === k && v !== undefined ? '[正文未记]' : next(v, k)]));
  } catch { return a; /* 拿不到栈 / 对象有毒：原样交出去，日志不能因此崩 */ }
}

const INSTALLED = Symbol.for('feishu-bridge.console-id-mask');
// owner 候选换数据源（§3.5 第 1 点）之前不遮这两种行：setup / doctor 靠里面的完整 open_id 认 owner（checks.js findOwnerCandidates）
const KEEP_RE = /^\[owner\] (拒绝认领：|owner\.json 缺失)/;

/** 包一层 console.log/info/warn/error：每个参数先过 maskArg（KEEP_RE 的行除外）。重复安装只生效一次。逐处截短是主力，这里只兜底 */
export function installConsoleIdMask(target = console) {
  if (target[INSTALLED]) return target;
  for (const name of ['log', 'info', 'warn', 'error']) {
    const orig = target[name];
    if (typeof orig !== 'function') continue;
    target[name] = (...args) => orig.apply(target, typeof args[0] === 'string' && KEEP_RE.test(args[0]) ? args : args.map((a) => maskArg(a)));
  }
  target[INSTALLED] = true;
  return target;
}

/**
 * 启动时收紧 stdout / stderr 指向的日志文件：是普通文件、属于当前用户、权限不是 0600 才 fchmod；管道、终端不碰。
 * fchmod 失败只记一行日志（不带路径），不影响启动。
 */
export function tightenLogFds({ fds = [1, 2], fstat = nodeFs.fstatSync, fchmod = nodeFs.fchmodSync, uid = process.getuid?.(), log = console.error } = {}) {
  const fixed = [];
  let failed = 0;
  if (typeof uid !== 'number') return { fixed, failed };
  for (const fd of fds) {
    let st;
    try { st = fstat(fd); } catch { continue; }
    if (!st?.isFile?.() || st.uid !== uid || (st.mode & 0o777) === 0o600) continue;
    try { fchmod(fd, 0o600); fixed.push(fd); } catch { failed += 1; }
  }
  if (failed) { try { log('[log] 日志文件权限没能收紧到 0600，请手动 chmod 600'); } catch { /* 日志也坏了：不管 */ } }
  return { fixed, failed };
}
