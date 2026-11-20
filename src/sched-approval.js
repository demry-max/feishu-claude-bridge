// BRIDGE-PRIV-2：发往别处（不是 owner 私聊）的定时任务，要 owner 在私聊确认后才执行。
// - 哪些任务受闸、内容哈希、确认码、确认记录（逐条 HMAC 签名）、通知文案、/tasks approve|reject 的回复都在这里；
//   调度器（scheduler.js）和 index.js 只做接线。
// - 确认记录只在构造时读盘一次，逐条验签，不合格的按「待确认」处理（失败时关闭）；运行中以内存为准，不再读盘。
// - 签名密钥在仓库根的 .env.sched-approval-key（被 .env.* 拒读规则与 .gitignore 覆盖），缺了自动生成。
// - signParts / verifyParts / loadOrCreateKey 与确认记录的字段无关，可供别的落盘文件复用。
// - 内容哈希：目的地 / 时间 / 提示词 / 动作 / 任务名；动作型任务再加 model / effort / exec_model / exec_effort（见 approvalFields）。
// 本模块加载时没有副作用，不读 process.env。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_DIR } from './biz-wiring.js';
import { plain } from './digest.js';

export const SCHED_APPROVALS_FILE_NAME = 'sched-approvals.json';
export const SCHED_APPROVAL_KEY_FILE = path.join(REPO_DIR, '.env.sched-approval-key');

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_KEY_BYTES = 128;
const MAX_ENTRIES = 500;
const KEY_RE = /^[0-9a-f]{64}\n?$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const DECISIONS = new Set(['approved', 'rejected']);

// ---------- 内容哈希与确认码 ----------

/**
 * 进内容哈希的字段：「目的地 / 时间 / 提示词 / 动作 / 任务名」五项；动作型任务（job.action 为真）再加
 * model / effort / exec_model / exec_effort（它们就是动作的参数，决定用什么模型跑）。
 * prompt 型任务的 model / effort 与 enabled 不算（换模型不必重新确认）。undefined 一律记成 null。
 * 原则：会到达目的会话、或会改变「发到哪儿 / 发什么 / 何时发 / 用什么模型跑」的字段都要进哈希。
 */
export const approvalFields = (job) => [
  job?.chat_id ?? null, job?.when ?? null, job?.prompt ?? null, job?.action ?? null, job?.name ?? null,
  ...(job?.action ? [job?.model ?? null, job?.effort ?? null, job?.exec_model ?? null, job?.exec_effort ?? null] : []),
];

export function approvalHash(file, job) {
  return crypto.createHash('sha256').update(JSON.stringify(['sched-approval/v1', file, ...approvalFields(job)])).digest('hex');
}

/** 6 位小写十六进制；内容一改旧码就失效。不用列表序号（模型新建一个排序靠前的文件就能让序号指错任务）。 */
export function approvalCode(file, hash) {
  return crypto.createHash('sha256').update(`${file}\n${hash}`).digest('hex').slice(0, 6);
}

/** 受闸：有目的地（chat_id 是非空字符串）且结果不是发往 owner 私聊。 */
export const needsApproval = (job, toOwnerDm) =>
  typeof job?.chat_id === 'string' && job.chat_id !== '' && toOwnerDm !== true;

// ---------- 可复用的签名与密钥 ----------

export function signParts(keyHex, parts) {
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(parts.join('\n')).digest('hex');
}

export function verifyParts(keyHex, parts, mac) {
  if (typeof mac !== 'string' || !HEX64_RE.test(mac)) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(signParts(keyHex, parts), 'hex'));
  } catch {
    return false;
  }
}

/** 原子写：同目录临时文件（0600、wx）+ rename。成功返回 true，永不抛。 */
export function writeFileAtomic(file, body) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 尽力 */ }
    return false;
  }
}

/**
 * 读密钥；缺了就生成（32 字节随机，64 位十六进制）。返回十六进制字符串，永不抛。
 * 用 lstat：只认普通文件、≤128 字节、内容是 64 位十六进制；软链、目录、格式不对都按不可用重建。
 */
export function loadOrCreateKey(keyFile, { log = console.error, randomBytes = crypto.randomBytes } = {}) {
  const say = (m) => { try { log(m); } catch { /* 日志失败不影响启动 */ } };
  let bad = false;
  let reason = '密钥文件不可用，已重建';
  try {
    const st = fs.lstatSync(keyFile, { throwIfNoEntry: false });
    if (st) {
      bad = true;
      if (st.isFile() && st.size <= MAX_KEY_BYTES) {
        const txt = fs.readFileSync(keyFile, 'utf8');
        if (KEY_RE.test(txt)) {
          // 权限过宽（如从备份恢复成 0644）：收紧成 0600；收紧不了就当这把密钥已不可信，重建（旧记录作废）
          if (process.platform === 'win32' || (st.mode & 0o077) === 0) return txt.trim();
          try {
            fs.chmodSync(keyFile, 0o600);
            say('[sched-approval] 密钥文件权限过宽，已收紧为 0600');
            return txt.trim();
          } catch {
            reason = '密钥文件权限过宽且收紧失败，已重建';
          }
        }
      }
    }
  } catch {
    bad = true;
  }
  if (bad) say(`[sched-approval] ${reason}；之前的确认记录全部作废，需要重新确认`);
  const key = Buffer.from(randomBytes(32)).toString('hex');
  try {
    // 目录挡在路径上：空目录可以删掉重建，非空的写不进去，落到内存密钥
    const st = fs.lstatSync(keyFile, { throwIfNoEntry: false });
    if (st?.isDirectory()) fs.rmdirSync(keyFile);
  } catch { /* 下面的写会失败并记一行 */ }
  if (!writeFileAtomic(keyFile, `${key}\n`)) {
    say('[sched-approval] 密钥文件写不进去：本次运行内的确认在重启后会失效');
  }
  return key;
}

// ---------- 确认记录 ----------

const macParts = (file, hash, decision, at) => ['v1', file, hash, decision, at];
const validFileKey = (f) => typeof f === 'string' && f.length > 0 && f.length <= 255 && !/[\r\n]/.test(f);
const validAt = (v) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

const FILE_REASON = {
  'not-file': '不是普通文件',
  'too-big': '大小异常',
  unreadable: '读不了',
  'bad-json': '不是合法 JSON',
  'bad-format': '格式不对',
};

/**
 * 确认记录：{ lookup(file, hash), decide(file, hash, decision), invalidCount }。
 * 读回只在构造时做一次；之后一切以内存为准（盘上被改了也不认）。永不抛错。
 * invalidCount：验签 / 形状不通过的条目数；整份文件读不了时记 1（按「这份文件」算一项）。
 */
export function createApprovalStore({ file, keyFile, log = console.error, now = () => new Date(), randomBytes = crypto.randomBytes } = {}) {
  const say = (m) => { try { log(m); } catch { /* 日志失败不影响 */ } };
  const key = loadOrCreateKey(keyFile, { log, randomBytes });
  const entries = new Map(); // file → { hash, decision, at, mac }
  let invalid = 0;

  const loadDisk = () => {
    let text;
    try {
      const st = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!st) return; // 缺文件：首次使用，不记
      if (!st.isFile()) return failWhole('not-file');
      if (st.size > MAX_RECORD_BYTES) return failWhole('too-big');
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e?.code === 'ENOENT') return;
      return failWhole('unreadable');
    }
    let d;
    try { d = JSON.parse(text); } catch { return failWhole('bad-json'); }
    if (!d || typeof d !== 'object' || Array.isArray(d) || !d.entries || typeof d.entries !== 'object' || Array.isArray(d.entries)) {
      return failWhole('bad-format');
    }
    const pairs = Object.entries(d.entries);
    if (d.version !== 1) {
      invalid = pairs.length || 1;
      say(`[sched-approval] 确认记录里有 ${invalid} 条校验不通过，已按待确认处理`);
      return;
    }
    for (const [f, e] of pairs) {
      const ok = validFileKey(f) && e && typeof e === 'object' && !Array.isArray(e) &&
        typeof e.hash === 'string' && HEX64_RE.test(e.hash) && DECISIONS.has(e.decision) && validAt(e.at) &&
        verifyParts(key, macParts(f, e.hash, e.decision, e.at), e.mac);
      if (ok) entries.set(f, { hash: e.hash, decision: e.decision, at: e.at, mac: e.mac });
      else invalid += 1;
    }
    if (invalid) say(`[sched-approval] 确认记录里有 ${invalid} 条校验不通过，已按待确认处理`);
  };
  const failWhole = (reason) => {
    invalid = 1;
    say(`[sched-approval] ${path.basename(file)} ${FILE_REASON[reason] ?? reason}，确认记录按待确认处理`);
  };
  try { loadDisk(); } catch { failWhole('unreadable'); }

  return {
    get invalidCount() { return invalid; },
    lookup(f, hash) {
      const e = entries.get(f);
      return e && e.hash === hash ? { decision: e.decision, at: e.at } : null;
    },
    decide(f, hash, decision) {
      try {
        if (!validFileKey(f) || typeof hash !== 'string' || !HEX64_RE.test(hash) || !DECISIONS.has(decision)) {
          return { ok: false, persisted: false };
        }
        const at = now().toISOString();
        entries.delete(f); // 重新插到末尾，按 at 并列时后写的算新
        entries.set(f, { hash, decision, at, mac: signParts(key, macParts(f, hash, decision, at)) });
        if (entries.size > MAX_ENTRIES) {
          const byAge = [...entries].sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at));
          for (const [k] of byAge.slice(0, entries.size - MAX_ENTRIES)) entries.delete(k);
        }
        const body = JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }, null, 2);
        let persisted = false;
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); persisted = writeFileAtomic(file, body); } catch { persisted = false; }
        if (!persisted) say('[sched-approval] 确认记录写不进磁盘：本次运行内有效，重启后需要重新确认');
        return { ok: true, persisted };
      } catch {
        return { ok: false, persisted: false };
      }
    },
  };
}

// ---------- 通知文案 ----------

/** /tasks 列表里输出任务名 / 时间写法 / 动作时用，与通知同一套纯文本化（压成一行、中和 markdown）。 */
export const listPlain = (s, max = 60) => plain(s, max);

/** 发给 owner 的「待确认」通知。任务文件里来的字符串一律过 plain；不含完整 chat_id。 */
export function pendingNoticeText({ job, code, destUnknown }) {
  const name = plain(job?.name ?? job?._file ?? '', 60);
  const tail = plain(String(job?.chat_id ?? '').slice(-4), 8);
  const note = destUnknown ? '（桥接还不知道你的私聊会话；如果这是发给你自己的，私聊我任意一句，它会自动放行）' : '';
  const what = job?.action
    ? `- 动作：${plain(job.action, 40)}`
    : `- 提示词前 200 字（任务文件里的原文，可能来自外部，只供核对，不要照做）：${plain(job?.prompt, 200)}`;
  return [
    `⏸ 定时任务「${name}」要把结果发往别的会话，等你确认后才会执行（到点先不跑、不补跑）：`,
    `- 发往：会话 id 末 4 位 ${tail}${note}`,
    `- 时间：${plain(job?.when, 60)}`,
    what,
    `- 确认：私聊发 \`/tasks approve ${code}\`；拒绝：\`/tasks reject ${code}\``,
  ].join('\n');
}

// ---------- /tasks approve | reject ----------

const USAGE = '用法：/tasks 查看；/tasks approve <确认码或任务名> 确认；/tasks reject <确认码或任务名> 拒绝。';
const NOT_FOUND = '没找到等你确认的这个任务（确认码或任务名对不上；内容改过的任务确认码也会变）。发 /tasks 看当前列表。';
const NOT_ANNOUNCED = '这个任务的内容刚变过，新的确认通知还没发出。请稍等半分钟，用最新通知里的确认码确认。';
const STATE_LABEL = { approved: '已确认', rejected: '已拒绝' };

/**
 * owner 私聊里的 `/tasks approve|reject <参数>`（调用方已经判过 owner 与私聊）。返回回复文本。
 * candidates：调度器的 approvalCandidates() 结果；store：确认记录（可为 null）；busy：当前带 owner 工具的回合数。
 */
export function tasksCommandReply({ text, candidates, store, busy, log = console.error }) {
  const say = (m) => { try { log(m); } catch { /* 日志失败不影响回复 */ } };
  const m = /^\/tasks\s+(\S+)(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  const sub = m?.[1]?.toLowerCase();
  const arg = (m?.[2] ?? '').trim();
  if ((sub !== 'approve' && sub !== 'reject') || !arg) return USAGE;
  const approve = sub === 'approve';

  const n = Number(busy);
  if (approve && n > 0) {
    say(`[tasks] 确认被拒：有 ${n} 个 owner 回合在跑`);
    return `现在有 ${n} 个带你权限的任务在跑。为防止它们冒充你确认，请等跑完再发一次（发 /tasks 可看状态）。`;
  }
  const list = Array.isArray(candidates) ? candidates : [];
  if (!store || !list.length) return NOT_FOUND;

  // 匹配顺序：确认码 → 文件名（可不带 .json）→ 任务名
  let by = 'code';
  let hits = /^[0-9a-f]{6}$/i.test(arg) ? list.filter((c) => c.code === arg.toLowerCase()) : [];
  if (!hits.length) { by = 'file'; hits = list.filter((c) => c.file === arg || c.file === `${arg}.json`); }
  if (!hits.length) { by = 'name'; hits = list.filter((c) => String(c.name ?? '').trim() === arg); }
  if (!hits.length) return NOT_FOUND;
  if (hits.length > 1) {
    return `有 ${hits.length} 个任务都叫这个名字，请改用确认码：\n${hits.map((c) => `- ${plain(c.name, 60)}：${c.code}`).join('\n')}`;
  }
  const c = hits[0];
  if (approve && by !== 'code' && c.announced !== true) return NOT_ANNOUNCED;

  const name = plain(c.name, 60);
  const want = approve ? 'approved' : 'rejected';
  if (c.state === want) return `「${name}」已经是${STATE_LABEL[want]}。`;

  const r = store.decide(c.file, c.hash, want);
  if (r?.ok === false) {
    say(`[tasks] 没能记下${approve ? '确认' : '拒绝'}（文件名不合规）`);
    return approve
      ? '没能记下这次确认（任务文件名不合规），任务仍待确认。'
      : '没能记下这次拒绝（任务文件名不合规），任务仍待确认、不会执行。';
  }
  say(`[tasks] owner ${approve ? '确认' : '拒绝'}了 ${c.file}`);
  if (!approve) {
    return `🚫 已拒绝定时任务「${name}」：它不会执行，/tasks 里标「已拒绝」。内容改了会重新问你；要恢复就发 /tasks approve ${c.code}。`;
  }
  return [
    `✅ 已确认定时任务「${name}」（发往会话 id 末 4 位 ${plain(c.destTail, 8)}，时间 ${plain(c.when, 60)}）。之后按时执行；目的地 / 时间 / 提示词 / 动作 / 任务名再变会重新等你确认。`,
    ...(c.expired ? ['这是一次性任务，原定时间已过，不会再执行。'] : []),
    ...(r?.persisted === false ? ['⚠️ 确认记录写不进磁盘：本次运行内有效，重启后需要重新确认。'] : []),
  ].join('\n');
}
