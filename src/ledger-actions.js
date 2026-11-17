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

// ================================================================ BRIDGE-VR-1：验收、升级阶梯、日结撤销
// 只新增，不动上面 EV-1 的三个动作、短语表与 applyLedgerAction（EV-1 按钮与回复逐字不变）。

/** 新动作的中文名（journal / 日志 / 回复里用）。不并进 LEDGER_ACTIONS：EV-1 的心跳消息不认这些动作。 */
export const VR_ACTIONS = Object.freeze({
  done: '办完了', // 升级阶梯第四个按钮：open / waiting / verify → done，done_evidence 由桥接写 kind=owner
  accept: '验收', // 验收卡片：verify → done
  reopen: '没办完', // 验收卡片：verify → open，明天再看
  vdrop: '不做了', // 验收卡片：verify → dropped
  undo: '撤销', // 日结：自动判定办完的 done → open，明天再看（只认按钮）
});
/** 验收卡片的引用回复短语（与卡片三个按钮对应）。 */
export const VERIFY_PHRASES = Object.freeze({ 验收: 'accept', 通过: 'accept', 好了: 'accept', 没办完: 'reopen', 不做了: 'vdrop' });
/** 升级阶梯消息的引用回复短语：EV-1 三个 + 「办完了」。 */
export const LADDER_PHRASES = Object.freeze({ ...ACTION_BY_PHRASE, 办完了: 'done' });
/** 任一动作的中文名（EV-1 + VR-1）；不认识返回 null。 */
export const actionLabel = (a) => (Object.hasOwn(LEDGER_ACTIONS, a) ? LEDGER_ACTIONS[a] : Object.hasOwn(VR_ACTIONS, a) ? VR_ACTIONS[a] : null);

const CIRCLED = ['①', '②', '③', '④', '⑤'];
export const circled = (i) => CIRCLED[i] ?? `(${i + 1})`;
const DAY_MS = 24 * 3600_000;

/** 验收卡片三个按钮：✅ 验收（主）/ ↩ 没办完 / 🗑 不做了（危险）。value 与 EV-1 同形 { v, a, s, n }。 */
export function verifyButtons(slug, nonce) {
  const value = (a) => ({ v: 1, a, s: slug, n: nonce });
  return [
    { label: '✅ 验收', type: 'primary_filled', value: value('accept') },
    { label: '↩ 没办完', type: 'default', value: value('reopen') },
    { label: '🗑 不做了', type: 'danger', value: value('vdrop') },
  ];
}

/** 升级阶梯消息的按钮：EV-1 三个原样在前，加一个「办完了」。 */
export function ladderButtons(slug, nonce) {
  return [...ledgerButtons(slug, nonce), { label: VR_ACTIONS.done, type: 'primary', value: { v: 1, a: 'done', s: slug, n: nonce } }];
}

/** 日结的撤销按钮：每条自动判定办完的一个，按日结里的圈号编号（最多 5 个）。 */
export function undoButtons(slugs, nonce) {
  return slugs.slice(0, CIRCLED.length).map((s, i) => ({ label: `撤销${circled(i)}`, type: 'default', value: { v: 1, a: 'undo', s, n: nonce } }));
}

// 每个动作要求的当前状态与改成的状态；demote / autodone 是桥接内部动作（不出现在按钮与短语里）
const VR_RULES = Object.freeze({
  done: { from: ['open', 'waiting', 'verify'], to: 'done' },
  accept: { from: ['verify'], to: 'done' },
  reopen: { from: ['verify'], to: 'open', recheck: true },
  vdrop: { from: ['verify'], to: 'dropped' },
  undo: { from: ['done'], to: 'open', recheck: true },
  demote: { from: ['done'], to: 'verify' },
  autodone: { from: ['verify'], to: 'done' },
});
export const VR_INTERNAL = Object.freeze(['demote', 'autodone']);

/** 与 checkActionable 同口径，但按动作要求的状态判断（accept 只认 verify、undo 只认 done 等）。 */
export function checkVerifiable(tasksDir, slug, action, validate) {
  const rule = Object.hasOwn(VR_RULES, action) ? VR_RULES[action] : null;
  if (!rule) return { ok: false, reason: '未知动作' };
  if (typeof validate !== 'function') return { ok: false, reason: '缺少台账校验函数' };
  const r = readTaskRaw(tasksDir, slug);
  if (!r.ok) return r;
  const v = validate(r.raw, slug);
  if (!v?.ok) return { ok: false, reason: `台账不合法（${v?.reason ?? '校验失败'}）` };
  if (!rule.from.includes(v.task.status)) return { ok: false, reason: `台账状态是 ${v.task.status}，不能『${actionLabel(action) ?? action}』` };
  return { ...r, task: v.task };
}

/**
 * 往当天 journal 追加一段（标题行 + 若干条目行）。文件非空时先空一行；每行内的换行压成空格。
 * 失败只返回 false。
 */
export function appendJournalBlock(journalDir, now, lines) {
  if (!journalDir || !Array.isArray(lines) || !lines.length) return false;
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
        lead = b[0] === 0x0a ? '\n' : '\n\n';
      }
      fs.writeSync(fd, `${lead}${lines.map((l) => String(l).replace(/[\r\n]+/g, ' ')).join('\n')}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * VR-1 动作的确定性回写（按钮 / 引用回复 / 桥接内部）。只改 status、updated_at 与动作需要的字段：
 * - done：done_evidence 由桥接写 { kind:'owner', ref:'', summary:'光总确认办完（按钮|引用回复）' }（模型写的 kind=owner 不算数，只有这里写的算）
 * - reopen / undo：next_check_at 改成现在加 24 小时（明天再看）；done_evidence 原样保留
 * - accept / vdrop / demote / autodone：只改 status
 * guard(raw)（可选）返回非空字符串＝拒绝（例如核对期间依据被改过）。
 * journal：光总的动作记「（桥接）光总点了『X』」；autodone 记「（桥接）自动验收通过（规则|模型）」；demote 不记（心跳日志里有）。
 * 返回 { ok, changed, task } 或 { ok:false, reason }（不改任何文件）。
 */
export function applyVerifyAction({ tasksDir, journalDir, slug, action, now = new Date(), validate, source = 'button', via, guard, log = console.log }) {
  const c = checkVerifiable(tasksDir, slug, action, validate);
  if (!c.ok) return c;
  const raw = c.raw;
  if (typeof guard === 'function') {
    const why = guard(raw);
    if (why) return { ok: false, reason: String(why) };
  }
  const rule = VR_RULES[action];
  const changed = ['status'];
  raw.status = rule.to;
  if (rule.recheck) {
    raw.next_check_at = localMinute(new Date(now.getTime() + DAY_MS));
    changed.push('next_check_at');
  }
  if (action === 'done') {
    raw.done_evidence = { kind: 'owner', ref: '', summary: source === 'reply' ? '光总确认办完（引用回复）' : '光总确认办完（按钮）' };
    changed.push('done_evidence');
  }
  raw.updated_at = localMinute(now);
  changed.push('updated_at');
  const v = validate(raw, slug);
  if (!v?.ok) return { ok: false, reason: `改完不再是合法台账（${v?.reason ?? '校验失败'}），未写回` };
  try {
    writeAtomic(c.file, raw, c.mode);
  } catch (e) {
    return { ok: false, reason: `写回失败（${e?.code ?? 'error'}）` };
  }
  let line = null;
  if (action === 'autodone') line = `（桥接）自动验收通过（${via === 'model' ? '模型' : '规则'}）：tasks/${slug}.json`;
  else if (action !== 'demote') line = `（桥接）光总${source === 'reply' ? '回复' : '点了'}『${VR_ACTIONS[action]}』：tasks/${slug}.json`;
  if (line && !appendJournal(journalDir, now, line)) log(`[heartbeat] journal 追加失败（tasks/${slug}.json 已写回）`);
  return { ok: true, changed, task: v.task };
}
