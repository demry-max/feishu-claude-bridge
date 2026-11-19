// BRIDGE-DMID-1：owner 私聊的 chat_id 落盘（data/owner-dm.json），重启后定时任务立即能判出「结果发往 owner 私聊」。
// - 只在 index.js 里「已通过 owner 校验且 chat_type === 'p2p'」那一处记下（信任来源不变）；这里不判断身份，只管存取。
// - 文件同时存 owner 的 open_id：读回时与当前配置（OWNER_OPEN_ID || owner.json）不一致就丢弃，防止换 owner / 换应用后沿用旧 id。
// - 读回失败（缺失、损坏、格式不对、不可读、不是普通文件）一律按「未知」处理＝回到落盘之前的行为；不抛错。
// - 日志与 /status 都不出现 chat_id 或 open_id 本身。
// 本模块加载时没有副作用。
import fs from 'node:fs';
import path from 'node:path';

export const OWNER_DM_FILE_NAME = 'owner-dm.json';
/** 飞书 chat_id 的实际形态是 oc_ + 32 位小写十六进制；这里放宽到 16–64 位小写字母数字，别的一律不认。 */
export const OWNER_DM_CHAT_ID_RE = /^oc_[a-z0-9]{16,64}$/;
const MAX_BYTES = 4096;

const validChat = (v) => typeof v === 'string' && OWNER_DM_CHAT_ID_RE.test(v);
const validOwner = (v) => typeof v === 'string' && v !== '' && v.length <= 256;

const REASON_TEXT = {
  'not-file': '不是普通文件',
  'too-big': '大小异常',
  unreadable: '读不了',
  'bad-json': '不是合法 JSON',
  'bad-format': '格式不对',
  'owner-mismatch': '与当前 owner 不一致',
  'no-owner': '当前没有登记 owner',
};

/**
 * 启动时读回。返回 { chatId, ownerId, reason }：reason 为 'ok' 时 chatId 有值，否则 chatId 为 null。
 * 缺文件（首次安装）不记日志；其它原因记一行（不含文件内容）。
 */
export function loadOwnerDm(file, ownerId, { log = (...a) => console.error(...a) } = {}) {
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
  if (!validOwner(ownerId)) return fail('no-owner');
  if (d.owner_open_id !== ownerId) return fail('owner-mismatch');
  return { chatId: d.chat_id, ownerId, reason: 'ok' };
}

/** 原子写（同目录临时文件 0600 + rename），永不抛出；成功返回 true。 */
export function saveOwnerDm(file, chatId, ownerId) {
  if (!validChat(chatId) || !validOwner(ownerId)) return false;
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    const body = JSON.stringify({ chat_id: chatId, owner_open_id: ownerId, saved_at: new Date().toISOString() }, null, 2);
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
  return boot?.chatId
    ? '[biz] owner 私聊目的地：已从落盘恢复'
    : '[biz] owner 私聊目的地：未知（等 owner 私聊一次）';
}

/**
 * 运行时：index.js 在 owner 私聊消息里调 remember(chatId, ownerId)；值（含 owner）没变不写盘，写失败下一条再试。
 * statusLine({ isOwner, chatType })：只在 owner 私聊返回一行，否则空串。
 */
export function createOwnerDmRecorder({ file, boot, log = (...a) => console.error(...a), save = saveOwnerDm } = {}) {
  const restored = boot?.chatId ?? null;
  let current = restored;
  let persisted = restored && boot?.ownerId ? `${restored}\n${boot.ownerId}` : null;
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
