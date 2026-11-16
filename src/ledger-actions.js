// 心跳按钮 / 引用回复的确定性回写（BRIDGE-EV-1）。全部由桥接按固定规则处理，不调模型。
//
// 读台账与 heartbeat.js 的 loadTasks 同口径：lstat 拒软链、O_NOFOLLOW 打开、≤64KB；
// 只改目标字段并更新 updated_at，未知字段原样保留，同目录临时文件 + rename 原子写回。
// 本文件不 import heartbeat.js（heartbeat.js 反过来用它），校验函数由调用方传入，避免循环依赖。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 三个按钮 / 引用回复短语。「办完了」留给 VR-1。 */
export const LEDGER_ACTIONS = Object.freeze({ ack: '知道了', snooze1d: '推迟一天', drop: '不做了' });
export const ACTION_BY_PHRASE = Object.freeze(
  Object.fromEntries(Object.entries(LEDGER_ACTIONS).map(([a, label]) => [label, a])),
);

// 与 heartbeat.js 的 SLUG_FILE 同口径（这里不带 .json 扩展名）
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_TASK_BYTES = 64 * 1024;
const ACTIVE = new Set(['open', 'waiting']);
const DATE_HEAD = /^(\d{4})-(\d{2})-(\d{2})(.*)$/s;

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const localMinute = (d) => `${localDay(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/**
 * 卡片按钮（Card 2.0 callback）的 value 与样式。主操作 primary_filled、其余 default、危险操作 danger
 * （lark-im references/card/button「按钮主次（强制）」）。value 只放短字段：版本、动作、slug、消息 nonce。
 */
export function ledgerButtons(slug, nonce) {
  const value = (a) => ({ v: 1, a, s: slug, n: nonce });
  return [
    { label: LEDGER_ACTIONS.ack, type: 'primary_filled', value: value('ack') },
    { label: LEDGER_ACTIONS.snooze1d, type: 'default', value: value('snooze1d') },
    { label: LEDGER_ACTIONS.drop, type: 'danger', value: value('drop') },
  ];
}

/**
 * 读一条台账的原始 JSON（不做字段校验）。返回 { ok, raw, mode, file } 或 { ok:false, reason }；
 * reason 只点原因，不回显文件内容。
 */
export function readTaskRaw(tasksDir, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return { ok: false, reason: 'slug 不合规' };
  const file = path.join(tasksDir, `${slug}.json`);
  let text;
  let mode;
  try {
    const lst = fs.lstatSync(file);
    if (lst.isSymbolicLink()) return { ok: false, reason: '是软链接（台账只认普通文件）' };
    if (!lst.isFile()) return { ok: false, reason: '不是普通文件' };
    if (lst.size > MAX_TASK_BYTES) return { ok: false, reason: `超过 ${MAX_TASK_BYTES / 1024}KB` };
    // O_NOFOLLOW：lstat 之后被换成软链也不跟随
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > MAX_TASK_BYTES) return { ok: false, reason: '不是普通文件或超过上限' };
      mode = st.mode & 0o777;
      text = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { ok: false, reason: e?.code === 'ENOENT' ? '台账不存在' : `读取失败（${e?.code ?? 'error'}）` };
  }
  if (Buffer.byteLength(text) > MAX_TASK_BYTES) return { ok: false, reason: `超过 ${MAX_TASK_BYTES / 1024}KB` };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'JSON 解析失败' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: '顶层不是 JSON 对象' };
  return { ok: true, raw, mode, file };
}

/**
 * 台账时间文本加一个日历日：只动日期部分，时分、秒、时区后缀原样保留
 * （`2026-11-16T09:00` → `2026-11-17T09:00`，`2026-02-28` → `2026-03-01`）。不是日期开头返回 null。
 */
export function addOneDay(text) {
  const m = typeof text === 'string' ? text.trim().match(DATE_HEAD) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}${m[4]}`;
}

/** 校验一条台账能不能被按钮 / 引用回复处理：文件可读、字段合法（validate＝heartbeat 的 validateTask）、状态活跃。 */
export function checkActionable(tasksDir, slug, validate) {
  const r = readTaskRaw(tasksDir, slug);
  if (!r.ok) return r;
  const v = validate(r.raw, slug);
  if (!v?.ok) return { ok: false, reason: `台账不合法（${v?.reason ?? '校验失败'}）` };
  if (!ACTIVE.has(v.task.status)) return { ok: false, reason: `台账状态是 ${v.task.status}，已不在跟进中` };
  return { ...r, task: v.task };
}

// 原子写回：同目录临时文件 + rename，保留原权限位；目标被换成软链时 rename 只替换链接本身，不写穿
function writeAtomic(file, raw, mode) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: mode || 0o644, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 已删 */ }
    throw e;
  }
}

/**
 * 往当天 journal（memory/journal/YYYY-MM-DD.md）追加一行。O_APPEND|O_NOFOLLOW，文件末尾没换行先补一个。
 * 失败只返回 false（journal 是记录，写不进去不影响回写本身）。
 */
export function appendJournal(journalDir, now, line) {
  if (!journalDir) return false;
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    const file = path.join(journalDir, `${localDay(now)}.md`);
    const flags = fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(file, flags, 0o600);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return false;
      let lead = '';
      if (st.size > 0) {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, st.size - 1);
        if (b[0] !== 0x0a) lead = '\n';
      }
      fs.writeSync(fd, `${lead}${String(line).replace(/[\r\n]+/g, ' ')}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行一次确定性回写。source：'button'（卡片按钮）或 'reply'（引用回复短语）。
 * - ack：不改台账文件（acked_at 由心跳写进自己的状态文件）
 * - snooze1d：next_check_at 与 escalate_after（有的话）各加一天；加完仍不晚于现在的（已逾期多日），改成现在加 24 小时；
 *   两个都没有时按现在加一天写 next_check_at。parseTime（可选，heartbeat 的 parseTime）用来判断「加完仍不晚于现在」，
 *   没传或解析不出时只按日期加一天
 * - drop：status 改成 dropped
 * 每次都在当天 journal 追加一行。返回 { ok, changed:[字段] } 或 { ok:false, reason }（不改任何文件）。
 */
export function applyLedgerAction({ tasksDir, journalDir, slug, action, now = new Date(), validate, parseTime, source = 'button', log = console.log }) {
  if (!Object.hasOwn(LEDGER_ACTIONS, action)) return { ok: false, reason: '未知动作' };
  if (typeof validate !== 'function') return { ok: false, reason: '缺少台账校验函数' };
  const c = checkActionable(tasksDir, slug, validate);
  if (!c.ok) return c;
  const raw = c.raw;
  const changed = [];
  if (action === 'snooze1d') {
    for (const f of ['next_check_at', 'escalate_after']) {
      if (typeof raw[f] !== 'string' || !raw[f].trim()) continue;
      let next = addOneDay(raw[f]);
      if (next === null) return { ok: false, reason: `${f} 不是日期开头，不知道怎么推迟` };
      const ms = typeof parseTime === 'function' ? parseTime(next) : null;
      // 原值加一天仍不晚于现在：从现在起推一天，否则推迟后当下仍到期、下一拍又提醒
      if (Number.isFinite(ms) && ms <= now.getTime()) next = localMinute(new Date(now.getTime() + 24 * 3600_000));
      raw[f] = next;
      changed.push(f);
    }
    if (!changed.length) {
      raw.next_check_at = localMinute(new Date(now.getTime() + 24 * 3600_000));
      changed.push('next_check_at');
    }
  } else if (action === 'drop') {
    raw.status = 'dropped';
    changed.push('status');
  }
  if (changed.length) {
    raw.updated_at = localMinute(now);
    changed.push('updated_at');
    const v = validate(raw, slug); // 写回前再校验一遍：改完的文件必须仍是合法台账
    if (!v?.ok) return { ok: false, reason: `改完不再是合法台账（${v?.reason ?? '校验失败'}），未写回` };
    try {
      writeAtomic(c.file, raw, c.mode);
    } catch (e) {
      return { ok: false, reason: `写回失败（${e?.code ?? 'error'}）` };
    }
  }
  const verb = source === 'reply' ? '回复' : '点了';
  if (!appendJournal(journalDir, now, `（桥接）光总${verb}『${LEDGER_ACTIONS[action]}』：tasks/${slug}.json`)) {
    log(`[heartbeat] journal 追加失败（tasks/${slug}.json 的『${LEDGER_ACTIONS[action]}』已${changed.length ? '写回' : '记下'}）`);
  }
  return { ok: true, changed };
}
