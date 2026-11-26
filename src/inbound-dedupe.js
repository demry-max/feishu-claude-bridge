// BRIDGE-STD-1 §3.1（W5 / C3 / C4）：入站消息去重落盘。
// 重启不能丢「已处理」的记录：丢了，飞书重推 / 补拉到的老消息会被再答一遍。所以每次登记都同步原子写盘（临时文件 + rename，0600），
// 不做延迟合并——延迟写盘时崩溃就是重答。量很小（私人助理一天几百条），整表重写也只是几十 KB。
// 写盘失败不抛：内存里照常记，日志每小时最多一行、不带 id；读盘遇到损坏 / 不认识的格式按空表起步、记一行，不崩。
// 依赖（fs / now / log）全部可注入。
import nodeFs from 'node:fs';
import path from 'node:path';

const HOUR = 3600 * 1000;
export const DEFAULT_KEEP_MS = 7 * 24 * HOUR;

/** 原子写 JSON（同目录临时文件 + rename，权限 mode）。失败时清掉临时文件并把错误抛给调用方——要不要降级由调用方定 */
export function writeJsonAtomic(file, value, { fs = nodeFs, mode = 0o600, pid = process.pid } = {}) {
  const tmp = `${file}.${pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value), { mode });
    try { fs.chmodSync(tmp, mode); } catch { /* 个别文件系统不支持：创建时的 mode 已经够 */ }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉也无妨 */ }
    throw e;
  }
}

/** 读 JSON 文件：{ status:'missing' } / { status:'corrupt' } / { status:'ok', value } */
export function readJsonFile(file, { fs = nodeFs } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { status: e?.code === 'ENOENT' ? 'missing' : 'corrupt' }; }
  try { return { status: 'ok', value: JSON.parse(raw) }; } catch { return { status: 'corrupt' }; }
}

/**
 * @param {object} o
 * @param {string} o.file          落盘文件（data/inbound-seen.json）
 * @param {number} [o.keepMs]      7 天内的都留
 * @param {number} [o.keepMin]     最近这么多条不论多老都留
 * @param {number} [o.cap]         硬上限（再新也只留最新的这么多条）
 */
export function createDedupeStore({ file, keepMs = DEFAULT_KEEP_MS, keepMin = 2000, cap = 20000, fs = nodeFs, now = Date.now, log = console.error } = {}) {
  const seen = new Map(); // id → 登记时刻 ms；Map 的插入顺序 ＝ 登记顺序，最老的在最前
  const base = path.basename(file);
  let lastWarnAt = -Infinity;
  const say = (line) => { try { log(line); } catch { /* 日志出错不影响去重 */ } };
  const warnHourly = (line) => {
    const t = now();
    if (t - lastWarnAt < HOUR) return;
    lastWarnAt = t;
    say(line);
  };

  function prune(t) {
    while (seen.size > cap) seen.delete(seen.keys().next().value);
    while (seen.size > keepMin) {
      const [id, at] = seen.entries().next().value;
      if (t - at <= keepMs) break; // 最老的都还在窗口内，后面的更在
      seen.delete(id);
    }
  }

  function load() {
    const r = readJsonFile(file, { fs });
    if (r.status === 'missing') return;
    const doc = r.value;
    if (r.status !== 'ok' || !doc || typeof doc !== 'object' || doc.v !== 1 || !Array.isArray(doc.ids)) {
      say(`[dedupe] ${base} 损坏或格式不认识，按空表起步`);
      return;
    }
    const good = doc.ids.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && e[0] && Number.isFinite(e[1]));
    if (good.length < doc.ids.length) say(`[dedupe] ${base} 里有 ${doc.ids.length - good.length} 条记录无法识别，已丢弃`);
    good.sort((a, b) => a[1] - b[1]); // 稳定排序：登记时刻相同的保持文件里的先后
    for (const [id, at] of good) { seen.delete(id); seen.set(id, at); }
    prune(now());
  }

  function persist() {
    try {
      writeJsonAtomic(file, { v: 1, ids: [...seen] }, { fs });
    } catch (e) {
      warnHourly(`[dedupe] 写 ${base} 失败（${e?.code ?? e?.name ?? '?'}），内存里照常记；重启后这期间的消息可能被重答`);
    }
  }

  load();
  return {
    /** 同步判重并登记：返回「是不是重复」。没有 id 的消息（不应出现）既不算重复也不登记 */
    checkAndMark(id) {
      if (typeof id !== 'string' || !id) return false;
      if (seen.has(id)) return true;
      const t = now();
      seen.set(id, t);
      prune(t);
      persist();
      return false;
    },
    has: (id) => seen.has(id),
    get size() { return seen.size; },
  };
}
