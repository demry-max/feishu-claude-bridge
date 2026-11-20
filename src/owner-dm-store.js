// BRIDGE-DMID-1：owner 私聊的 chat_id 落盘（data/owner-dm.json），重启后定时任务立即能判出「结果发往 owner 私聊」。
// - 只在 index.js 里「已通过 owner 校验且 chat_type === 'p2p'」那一处记下（信任来源不变）；这里不判断身份，只管存取。
// - 文件同时存 owner 的 open_id：读回时与当前配置（OWNER_OPEN_ID || owner.json）不一致就丢弃，防止换 owner / 换应用后沿用旧 id。
// - 读回失败（缺失、损坏、格式不对、不可读、不是普通文件）一律按「未知」处理＝回到落盘之前的行为；不抛错。
// - 日志与 /status 都不出现 chat_id 或 open_id 本身。
// 本模块加载时没有副作用。
import fs from 'node:fs';
import path from 'node:path';
import { signParts, verifyParts, loadOrCreateKey } from './sched-approval.js'; // BRIDGE-PRIV-3：签名复用确认记录的密钥与 HMAC（无循环：sched-approval.js 不依赖本模块）

export const OWNER_DM_FILE_NAME = 'owner-dm.json';
/** 飞书 chat_id 的实际形态是 oc_ + 32 位小写十六进制；这里放宽到 16–64 位小写字母数字，别的一律不认。 */
export const OWNER_DM_CHAT_ID_RE = /^oc_[a-z0-9]{16,64}$/;
const MAX_BYTES = 4096;

const validChat = (v) => typeof v === 'string' && OWNER_DM_CHAT_ID_RE.test(v);
// 第一段与确认记录的 'v1' 不同：两种记录的签名不能互换；owner 的 open_id 进签名，换 owner 后旧记录验不过
const macParts = (chatId, ownerId, at) => ['owner-dm/v1', chatId, String(ownerId), at];
const validOwner = (v) => typeof v === 'string' && v !== '' && v.length <= 256;

const REASON_TEXT = {
  'not-file': '不是普通文件',
  'too-big': '大小异常',
  unreadable: '读不了',
  'bad-json': '不是合法 JSON',
  'bad-format': '格式不对',
  'owner-mismatch': '与当前 owner 不一致',
  'no-owner': '当前没有登记 owner',
  unsigned: '没有签名',
  'bad-sig': '签名对不上（可能被改动过）',
};

/**
 * 启动时读回（传了 key 才验签：没有 mac → 'unsigned'，验不过 → 'bad-sig'；没传 key 与以前逐字相同）。返回 { chatId, ownerId, reason }：reason 为 'ok' 时 chatId 有值，否则 chatId 为 null。
 * 缺文件（首次安装）不记日志；其它原因记一行（不含文件内容）。
 */
export function loadOwnerDm(file, ownerId, { log = (...a) => console.error(...a), key } = {}) {
  const fail = (reason) => {
    if (reason !== 'missing') {
      try { log(`[owner-dm] ${path.basename(file)} ${REASON_TEXT[reason] ?? reason}，owner 私聊目的地按未知处理`); } catch { /* 日志失败不影响启动 */ }
    }
    return { chatId: null, ownerId: null, reason };
  };
  let text;
  try {
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st) return fail('missing');
    if (!st.isFile()) return fail('not-file'); // 软链、目录都不跟随
    if (st.size > MAX_BYTES) return fail('too-big');
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return fail(e?.code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  let d;
  try { d = JSON.parse(text); } catch { return fail('bad-json'); }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !validChat(d.chat_id)) return fail('bad-format');
  if (typeof key === 'string') {
    if (d.mac === undefined || d.mac === null) return fail('unsigned');
    if (typeof d.saved_at !== 'string' || !verifyParts(key, macParts(d.chat_id, d.owner_open_id, d.saved_at), d.mac)) return fail('bad-sig');
  }
  if (!validOwner(ownerId)) return fail('no-owner');
  if (d.owner_open_id !== ownerId) return fail('owner-mismatch');
  return { chatId: d.chat_id, ownerId, reason: 'ok' };
}

/** 原子写（同目录临时文件 0600 + rename），永不抛出；成功返回 true。 */
export function saveOwnerDm(file, chatId, ownerId, { key } = {}) {
  if (!validChat(chatId) || !validOwner(ownerId)) return false;
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    const at = new Date().toISOString();
    const rec = { chat_id: chatId, owner_open_id: ownerId, saved_at: at };
    const body = JSON.stringify(typeof key === 'string' ? { ...rec, mac: signParts(key, macParts(chatId, ownerId, at)) } : rec, null, 2);
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600); // umask 再松也收紧到 0600
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 尽力 */ }
    return false;
  }
}

/** 启动日志那一行（不含 id）。 */
export function ownerDmBootLine(boot) {
  if (boot?.chatId && boot?.reason === 'recovered') return '[biz] owner 私聊目的地：已按 owner 账号重新确认';
  return boot?.chatId
    ? '[biz] owner 私聊目的地：已从落盘恢复'
    : '[biz] owner 私聊目的地：未知（等 owner 私聊一次）';
}

/**
 * 运行时：index.js 在 owner 私聊消息里调 remember(chatId, ownerId)；值（含 owner）没变不写盘，写失败下一条再试。
 * statusLine({ isOwner, chatType })：只在 owner 私聊返回一行，否则空串。
 */
export function createOwnerDmRecorder({ file, boot, log = (...a) => console.error(...a), save = (f, c, o) => saveOwnerDm(f, c, o, { key: boot?.signKey }) } = {}) {
  const restored = boot?.chatId ?? null;
  let current = restored;
  let persisted = restored && boot?.ownerId && boot?.saved !== false ? `${restored}\n${boot.ownerId}` : null; // 恢复了但写盘失败：下一条 owner 私聊再写
  let warned = null; // 同一个值的同一类问题只记一次
  const warnOnce = (key, msg) => {
    if (warned === key) return;
    warned = key;
    try { log(msg); } catch { /* 日志失败不影响对话 */ }
  };
  return {
    remember(chatId, ownerId) {
      try {
        current = chatId ?? current;
        if (!validChat(chatId) || !validOwner(ownerId)) {
          warnOnce(`bad\n${chatId}`, '[owner-dm] owner 私聊会话 ID 形态不认识，不落盘（本次运行内照常可用）');
          return;
        }
        const key = `${chatId}\n${ownerId}`;
        if (key === persisted) return;
        if (save(file, chatId, ownerId)) {
          persisted = key;
          warned = null;
          return;
        }
        warnOnce(`fail\n${key}`, `[owner-dm] 写入 ${path.basename(file)} 失败，下一条 owner 私聊再试`);
      } catch {
        // 永不抛：这里在消息回调里，抛出去就是 uncaughtException
      }
    },
    statusLine({ isOwner, chatType } = {}) {
      if (!isOwner || chatType !== 'p2p') return '';
      const v = !current ? '未知' : current === restored ? '已知（来自落盘）' : '已知（本次会话）';
      return `\n- owner 私聊目的地: ${v}`;
    },
  };
}

const TEXT_UNSIGNED = '🔐 桥接已重新记下和你的私聊会话（用来判断定时任务的结果是不是发给你本人），不用回复。';
const TEXT_TAMPERED = '⚠️ 私聊会话记录被改动过（签名对不上），已按你的账号重新记下并恢复。';

/**
 * 启动时读回并验签；不采信（没有签名 / 签名不对 / 缺文件 / owner 不一致等）时，按 owner 的 open_id 以应用身份发一条私聊，
 * 用发送应答里的 chat_id 恢复并签名落盘。永不抛。返回 { chatId, ownerId, reason, signKey, ... }（reason 'recovered' = 已恢复）。
 * 发送失败 / 超过 timeoutMs / 应答里没有合规的 chat_id → 按未知（等 owner 下一条真实私聊）。没有登记 owner 不发。
 * 超时定时器不 unref：await 期间没有别的东西撑住事件循环时，unref 会让进程悬空退出。
 */
export async function bootOwnerDm({ file, ownerId, keyFile, send, log = (...a) => console.error(...a), timeoutMs = 10_000 } = {}) {
  const say = (m) => { try { log(m); } catch { /* 日志失败不影响启动 */ } };
  const key = loadOrCreateKey(keyFile, { log });
  const b = loadOwnerDm(file, ownerId, { log, key });
  if (b.reason === 'ok' || b.reason === 'no-owner' || typeof send !== 'function' || !validOwner(ownerId)) return { ...b, signKey: key };
  const text = b.reason === 'bad-sig' ? TEXT_TAMPERED : TEXT_UNSIGNED;
  const unknown = (why) => {
    say(`[owner-dm] 重新确认私聊会话失败（${why}），按未知处理`);
    return { ...b, signKey: key };
  };
  let timer;
  try {
    const res = await Promise.race([
      send({ params: { receive_id_type: 'open_id' }, data: { receive_id: ownerId, msg_type: 'text', content: JSON.stringify({ text }) } }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
    const chat = res?.data?.chat_id;
    if (!validChat(chat)) return unknown('应答里没有可用的会话 id');
    const saved = saveOwnerDm(file, chat, ownerId, { key });
    say(`[owner-dm] 已按 owner 账号重新记下私聊会话${saved ? '' : '（写盘失败，本次运行内有效）'}`);
    return { chatId: chat, ownerId, reason: 'recovered', prev: b.reason, saved, signKey: key };
  } catch (e) {
    return unknown(e?.message === 'timeout' ? '超时' : '发送失败');
  } finally {
    clearTimeout(timer);
  }
}
