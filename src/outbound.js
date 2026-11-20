// 出站能力：进度卡片原地更新、图片/文件回传、发送者姓名解析
import fs from 'node:fs';
import path from 'node:path';
import { withUuid, outboxPart, contentPart } from './send-key.js'; // BRIDGE-SEND-1 / SEND-2
import { defaultKeepDir, keepEntry, displayName, unsentNote } from './outbox-keep.js'; // BRIDGE-SEND-2


// ---- 出站脱敏：回复送出前抹掉密钥/令牌/内网地址，避免误发到群里 ----
const SECRET_PATTERNS = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, 'sk-ant-***'],
  // 不加前导 \b：密钥紧贴在 ASCII 字母/数字/下划线后面（如 KEY_bms_sk_…、xbms_sk_…）时 \b 不成立会漏抹
  [/bms_sk_[A-Za-z0-9_-]{8,}/g, 'bms_sk_***'],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, 'github_token_***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'jwt_***'],
  [/\b(?:Bearer|token|secret|password|api[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9_\-]{16,})["']?/gi, (m) => m.replace(/[A-Za-z0-9_\-]{16,}$/, '***')],
  [/\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '10.x.x.x'],
  [/\b192\.168\.\d{1,3}\.\d{1,3}\b/g, '192.168.x.x'],
  [/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, '172.x.x.x'],
];
// 运行时凭据（.env 里的真实值）也一并抹掉
const runtimeSecrets = [process.env.FEISHU_APP_SECRET, process.env.CLAUDE_CODE_OAUTH_TOKEN]
  .filter((v) => v && v.length >= 12);

export function redact(text) {
  let out = String(text ?? '');
  for (const v of runtimeSecrets) out = out.split(v).join('***');
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

const card = (text) => ({
  config: { wide_screen_mode: true },
  elements: [{ tag: 'markdown', content: redact(text).slice(0, 20000) }],
});

/**
 * 进度会话：首条进度发一张卡片，后续进度**原地更新同一张卡片**（不再刷屏）。
 * 返回 { update, finish }：update 推进度，finish 收尾（把卡片改成折叠态）。
 */
const PROGRESS_MIN_INTERVAL_MS = Number(process.env.PROGRESS_MIN_INTERVAL_MS ?? 3000);
const PROGRESS_MAX_LINES = 12; // 只留最近若干步，避免 payload 随步数线性膨胀

export function createProgressChannel(client, messageId) {
  let cardMessageId = null;
  let lastSentAt = 0;
  let pendingTimer = null;
  let closed = false;   // 收尾/取消后不得再推进度
  let inflight = null;  // 在途请求：慢网络下防止重复建卡
  const lines = [];

  // 节流：长任务里每条中间消息都发一次 API 既费配额又慢，
  // 3 秒内的连续进度合并成一次，最后一条用 trailing 定时器补发，保证不丢最新状态
  const update = async (text) => {
    if (closed) return; // 任务已取消或已收尾
    lines.push(text);
    const now = Date.now();
    const wait = PROGRESS_MIN_INTERVAL_MS - (now - lastSentAt);
    if (wait > 0) {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (!closed) flush().catch(() => {});
      }, wait);
      return;
    }
    await flush();
  };

  const flush = async () => {
    if (closed) return;
    lastSentAt = Date.now();
    const shown = lines.slice(-PROGRESS_MAX_LINES);
    const omitted = lines.length - shown.length;
    const body = [
      '🔄 **处理中**',
      '',
      ...(omitted > 0 ? [`…（前 ${omitted} 步已省略）`] : []),
      ...shown.map((l, i) => `${i === shown.length - 1 ? '🔄' : '✅'} ${l}`),
    ].join('\n');
    // 真串行链：把每次发送挂到上一次之后。
    // 早先写法是「await 当前 inflight 的快照」，三个并发 flush 里第三个会与第二个
    // 同时看到 inflight 为空而并行跑，仍然重复建卡。
    const send = (inflight ?? Promise.resolve()).then(async () => {
      if (closed) return;
      if (!cardMessageId) {
        const res = await client.im.v1.message.reply({
          path: { message_id: messageId },
          data: { msg_type: 'interactive', content: JSON.stringify(card(body)) },
        });
        cardMessageId = res?.data?.message_id ?? res?.message_id ?? null;
      } else {
        await client.im.v1.message.patch({
          path: { message_id: cardMessageId },
          data: { content: JSON.stringify(card(body)) },
        });
      }
    });
    inflight = send.catch(() => {}); // 链上永远是已消化异常的 promise，避免未处理拒绝
    try {
      await send;
    } catch (e) {
      console.error('[progress]', e?.message ?? e);
    }
  };

  // 收尾：把进度卡片改成折叠说明。取消/失败也必须调用，
  // 否则卡片会永远停在「🔄 处理中」，用户以为还在跑。
  const finish = async (status = 'done') => {
    if (closed) return;
    closed = true;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (inflight) await inflight.catch(() => {}); // 等在途请求落地，拿到 cardMessageId
    if (!cardMessageId || !lines.length) return;
    const head = status === 'cancelled'
      ? `🛑 **已取消**（进行到第 ${lines.length} 步）`
      : status === 'failed'
        ? `⚠️ **已中止**（进行到第 ${lines.length} 步）`
        : `✅ **已完成**（${lines.length} 步）`;
    const mark = status === 'done' ? '✅' : '·';
    try {
      const shown = lines.slice(-PROGRESS_MAX_LINES);
      const omitted = lines.length - shown.length;
      await client.im.v1.message.patch({
        path: { message_id: cardMessageId },
        data: { content: JSON.stringify(card([
          head,
          '',
          ...(omitted > 0 ? [`…（前 ${omitted} 步已省略）`] : []),
          ...shown.map((l) => `${mark} ${l}`),
        ].join('\n'))) },
      });
    } catch (e) {
      console.error('[progress-finish]', e?.message ?? e);
    }
  };

  return { update, finish };
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/**
 * 一次性迁移：v1.x 用 outbox 根目录做回传，升级到按会话隔离后，
 * 根目录里的残留文件既不会被发送也不会被清理，会一直躺在那儿。
 * 归拢到 _legacy/ 并告知调用方，让 owner 知道有东西需要处理。
 */
export function migrateLegacyOutbox(outboxRoot) {
  if (!fs.existsSync(outboxRoot)) return 0;
  let moved = 0;
  try {
    const legacy = path.join(outboxRoot, '_legacy');
    for (const name of fs.readdirSync(outboxRoot)) {
      const p = path.join(outboxRoot, name);
      if (name.startsWith('.') || name === '_legacy') continue;
      if (!fs.statSync(p).isFile()) continue; // 会话子目录不动
      fs.mkdirSync(legacy, { recursive: true });
      fs.renameSync(p, path.join(legacy, name));
      moved++;
    }
  } catch (e) {
    console.error('[outbox-migrate]', e?.message ?? e);
  }
  if (moved) console.log(`[outbox] 已把 ${moved} 个 v1.x 遗留文件移到 outbox/_legacy/（不会自动发送）`);
  return moved;
}

/**
 * 回传附件：机器人把要发的文件写进本轮专属的 outbox 子目录，本函数发送后清空。
 * 图片走图片消息（飞书直接预览），其余走文件消息。
 *
 * 必须按会话隔离：共享一个 outbox 时，定时任务生成的文件会滞留到下一条**任意**消息
 * 被顺手发走——周报图表可能就这么发给了随口问天气的同事，且发完即删无法追回。
 *
 * BRIDGE-SEND-2：opts.mode —— 缺省 = 发送；'hold'（失败轮）不发，全部挪进保留目录并返回说明；
 * 'discard'（取消轮）不发，全部清掉。发送模式下上传 / 发送失败的文件、子目录不再悄悄删掉，挪进保留目录，
 * 并补一条文字说明（文件名清洗过、不带路径）。回传目录顶层的符号链接与非普通文件一律不上传、直接删链接（不动目标）。
 * 返回 { sent, unsent, nested, links, lost, removed, note }。
 */
export async function flushOutbox(client, outboxDir, sendRaw, opts = {}) {
  const idemKey = opts?.idempotencyKey; // BRIDGE-SEND-1：每个文件的键 = 逻辑键 + 文件名与内容的哈希；不给键时请求体逐字不变
  const mode = opts?.mode === 'hold' || opts?.mode === 'discard' ? opts.mode : 'send';
  const keepOpts = { keepDir: opts?.keepDir ?? defaultKeepDir(), now: opts?.now };
  const result = { sent: 0, unsent: [], nested: 0, links: 0, lost: 0, removed: 0, note: '' };
  if (!fs.existsSync(outboxDir)) return result;
  const files = [];
  const dirs = [];
  const odd = []; // 符号链接 / 其它非普通文件
  for (const name of fs.readdirSync(outboxDir)) {
    if (name.startsWith('.')) continue;
    let st;
    try { st = fs.lstatSync(path.join(outboxDir, name)); } catch { continue; }
    if (st.isFile()) files.push(name);
    else if (st.isDirectory()) dirs.push(name);
    else odd.push(name);
  }

  if (mode === 'discard') {
    for (const name of [...files, ...dirs, ...odd]) {
      fs.rmSync(path.join(outboxDir, name), { recursive: true, force: true });
      result.removed++;
    }
    if (result.removed > 0) console.log(`[outbox] 取消的那一轮：清掉 ${result.removed} 个待发条目（不发送）`);
    return result;
  }

  const holdFile = (name) => {
    const ok = keepEntry(path.join(outboxDir, name), name, keepOpts);
    result.unsent.push(displayName(name));
    if (!ok) result.lost++;
  };
  if (mode === 'send') {
    for (const name of files) {
      const p = path.join(outboxDir, name);
      let failed = false;
      try {
        const ext = path.extname(name).toLowerCase();
        const part = idemKey ? outboxPart(name, fs.readFileSync(p)) : null;
        if (IMAGE_EXT.has(ext)) {
          const up = await client.im.v1.image.create({
            data: { image_type: 'message', image: openUpload(p) },
          });
          const key = up?.image_key ?? up?.data?.image_key;
          if (!key) throw new Error('上传图片未返回 image_key');
          await sendRaw(withUuid({ msg_type: 'image', content: JSON.stringify({ image_key: key }) }, idemKey, part));
        } else {
          const up = await client.im.v1.file.create({
            data: { file_type: 'stream', file_name: name, file: openUpload(p) },
          });
          const key = up?.file_key ?? up?.data?.file_key;
          if (!key) throw new Error('上传文件未返回 file_key');
          await sendRaw(withUuid({ msg_type: 'file', content: JSON.stringify({ file_key: key }) }, idemKey, part));
        }
        result.sent++;
      } catch (e) {
        console.error(`[outbox] 发送 ${name} 失败:`, e?.message ?? e);
        failed = true;
      }
      if (failed) holdFile(name);
      else fs.rmSync(p, { force: true }); // 发出去了才清掉，避免下次重复发送
    }
  } else {
    for (const name of files) holdFile(name);
  }
  for (const name of dirs) {
    const p = path.join(outboxDir, name);
    const n = countFilesStripLinks(p);
    if (n === 0) { fs.rmSync(p, { recursive: true, force: true }); continue; }
    result.nested += n;
    if (!keepEntry(p, name, keepOpts)) result.lost += n;
  }
  for (const name of odd) {
    fs.rmSync(path.join(outboxDir, name), { recursive: true, force: true }); // 删的是链接本身，不动目标
    result.links++;
  }

  const failedTurn = mode === 'hold';
  result.note = unsentNote({ names: result.unsent, nested: result.nested, lost: result.lost, links: result.links, failedTurn });
  if (failedTurn) {
    const k = result.unsent.length + result.nested;
    if (k > 0) console.log(`[outbox] 这一轮没完成：${k} 个待发文件没有发送，已移到保留目录`);
    return result;
  }
  if (result.unsent.length || result.nested || result.lost || result.links) {
    console.log(`[outbox] ${result.unsent.length} 个文件没发出去、子目录里 ${result.nested} 个文件未发送，已移到保留目录（${result.lost} 个没能留存）`);
    try {
      await sendRaw(withUuid({ msg_type: 'text', content: JSON.stringify({ text: redact(result.note) }) }, idemKey, contentPart('unsent', result.note)));
    } catch (e) {
      console.error('[outbox] 补发「没发出去」说明失败:', e?.message ?? e); // 文件已挪走，抛了重试也找不回
    }
  }
  return result;
}

// 上传用的读流。流是异步打开的：上传在读之前就失败（取 token 失败、网络断了）、文件随后被挪走 / 删掉时，
// 它会发一个没人监听的 'error'，直接让进程以未捕获异常退出。这里挂一个空监听（SDK 自己的监听照常工作，错误仍会传给它）。
function openUpload(p) {
  const s = fs.createReadStream(p);
  s.on('error', () => {});
  return s;
}

// 子目录里的文件数：lstat 递归数（不跟随链接，最多数 1000 个）；沿途遇到的符号链接直接删掉（不动目标）
function countFilesStripLinks(dir) {
  let n = 0;
  const walk = (d) => {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      if (n >= 1000) return;
      const p = path.join(d, name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) n++;
      else fs.rmSync(p, { force: true });
    }
  };
  walk(dir);
  return n;
}

// 发送者姓名解析（群里知道是谁在说话）；失败或无权限时静默降级
const nameCache = new Map();
export async function resolveSenderName(client, openId) {
  if (!openId) return null;
  if (nameCache.has(openId)) return nameCache.get(openId);
  let name = null;
  try {
    const res = await client.contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    });
    name = res?.data?.user?.name ?? res?.user?.name ?? null;
  } catch {
    // 未开通通讯录权限时忽略
  }
  nameCache.set(openId, name);
  return name;
}

// ---- 语音回传（TTS）：macOS say 合成 → ffmpeg 转 opus → 飞书语音消息 ----
// 需要 macOS 的 say 与 ffmpeg（libopus）。失败时静默跳过，不影响文字回复。
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const TTS_VOICE = process.env.TTS_VOICE || 'Tingting'; // 中文女声；英文可用 Samantha
const TTS_MAX_CHARS = Number(process.env.TTS_MAX_CHARS || 500);

export async function sendVoice(client, text, sendRaw) {
  if (process.platform !== 'darwin') return false;
  // 去掉 markdown 记号，长文截断（语音过长反而难用）
  const plain = redact(text)
    .replace(/```[\s\S]*?```/g, '（代码块略）')
    .replace(/[*_`#>|]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TTS_MAX_CHARS);
  if (!plain) return false;

  const base = path.join(os.tmpdir(), `tts-${Date.now()}`);
  const aiff = `${base}.aiff`;
  const opus = `${base}.opus`;
  try {
    await execFileP('say', ['-v', TTS_VOICE, '-o', aiff, plain]);
    await execFileP(process.env.FFMPEG_BIN || 'ffmpeg', [
      '-y', '-i', aiff, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', opus,
    ]);
    const { stdout } = await execFileP(process.env.FFMPEG_BIN || 'ffmpeg', ['-i', opus], { encoding: 'utf8' }).catch((e) => ({ stdout: e.stderr ?? '' }));
    const m = String(stdout).match(/Duration: (\d+):(\d+):([\d.]+)/);
    const durationMs = m ? Math.round(((+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) * 1000)) : 1000;

    const up = await client.im.v1.file.create({
      data: { file_type: 'opus', file_name: 'reply.opus', duration: String(durationMs), file: fs.createReadStream(opus) },
    });
    const key = up?.file_key ?? up?.data?.file_key;
    if (!key) throw new Error('上传语音未返回 file_key');
    await sendRaw({ msg_type: 'audio', content: JSON.stringify({ file_key: key }) });
    return true;
  } catch (e) {
    console.error('[tts]', e?.message ?? e);
    return false;
  } finally {
    for (const f of [aiff, opus]) fs.rmSync(f, { force: true });
  }
}

// ---- Claude 登录故障：分类与话术 ----
// 与 ~/claude-login-watchdog 的 src/signatures.js 是同一套规则、同一套修复话术（跨仓不共享代码，各自实现）；
// 两边各用 test/fixtures/claude-auth-signatures.js（逐字节相同的夹具）钉一遍，改规则要两边一起改。
// 顺序有意义：瞬时刷新的文案里含「OAuth」「refresh」，必须先于登录失效判定。
const CLAUDE_TRANSIENT_REFRESH_RE = /another Claude Code process is refreshing/i;
const CLAUDE_KEYCHAIN_RE = /Keychain is not writable/i;
const CLAUDE_AUTH_RE =
  /Not logged in|Please run \/login|Failed to authenticate|OAuth (?:session|access token)[^\n]*expired|could not be refreshed|Invalid authentication credentials|re-?authenticate|OAuth authentication is currently not allowed|Invalid (?:API key|auth token)|API Error: 401\b|does not have access to Claude|OAuth token (?:has been )?revoked|disabled Claude subscription access/i;
// 登录故障里「组织停用了订阅访问」一类：重新登录解决不了，要找管理员 / 查订阅
const CLAUDE_SUBSCRIPTION_DISABLED_RE = /disabled Claude subscription access|OAuth authentication is currently not allowed/i;
const CLAUDE_NETWORK_RE =
  /API Error: 5\d\d\b|\b(?:502|503|504|529)\b|overloaded|Internal server error|Service Unavailable|Bad Gateway|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|Connection (?:error|lost|closed|reset)|network error|timed out|timeout|超时/i;

/** @returns {'transient_refresh'|'keychain'|'auth'|'network'|'none'} */
export function classifyClaudeError(text) {
  const s = String(text ?? '');
  if (CLAUDE_TRANSIENT_REFRESH_RE.test(s)) return 'transient_refresh';
  if (CLAUDE_KEYCHAIN_RE.test(s)) return 'keychain';
  if (CLAUDE_AUTH_RE.test(s)) return 'auth';
  if (CLAUDE_NETWORK_RE.test(s)) return 'network';
  return 'none';
}

/** 要人去重新登录 / 解锁钥匙串的那一类；瞬时刷新与网络都不算 */
export const isClaudeLoginFailure = (kind) => kind === 'auth' || kind === 'keychain';

/** 登录故障的修复方向：subscription＝组织停用了订阅访问（找管理员 / 查订阅），relogin＝重新登录 */
export function loginFixVariant(text) {
  return CLAUDE_SUBSCRIPTION_DISABLED_RE.test(String(text ?? '')) ? 'subscription' : 'relogin';
}

export const UNLOCK_KEYCHAIN_CMD = 'security unlock-keychain ~/Library/Keychains/login.keychain-db';
const LOGIN_KEYCHAIN = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');

/**
 * 登录钥匙串是否锁住：security show-keychain-info 退出码 ≠ 0 即锁住（9/21 实测 51）。
 * 查不了（非 macOS / 命令缺失 / 超时）返回 null，话术按「未知」处理。只读，不解锁、不改任何东西。
 */
export async function isLoginKeychainLocked({ exec = execFileP, keychainPath = LOGIN_KEYCHAIN } = {}) {
  try {
    await exec('/usr/bin/security', ['show-keychain-info', keychainPath], { timeout: 5000 });
    return false;
  } catch (e) {
    return typeof e?.code === 'number' ? true : null;
  }
}

/** 确定性修复步骤（与看门狗同一套意思）。variant=subscription：组织停用了订阅访问，重新登录解决不了 */
export function loginFixLines({ kind, keychainLocked, variant = 'relogin' }) {
  if (variant === 'subscription') {
    return [
      '这不是本机登录问题：组织停用了 Claude Code 的订阅访问。联系组织管理员恢复访问，或到 claude.ai 检查订阅状态。',
      '恢复后在 Mac 终端运行 `claude auth login`，再用 `claude auth status` 确认。',
    ];
  }
  if (keychainLocked === true || kind === 'keychain') {
    return [
      '需要你本人在 Mac 前输入登录密码：',
      `\`${UNLOCK_KEYCHAIN_CMD}\``,
      '然后运行 `claude auth login`。',
      '密码被拒绝＝钥匙串密码和开机密码不同步：打开「钥匙串访问」→ 选中「登录」钥匙串 → 编辑 →「更改钥匙串“登录”的密码」，改完再解锁。',
    ];
  }
  const lines = ['在 Mac 终端运行 `claude auth login` 重新登录，再用 `claude auth status` 确认 loggedIn 为 true。'];
  if (keychainLocked == null) lines.push(`若 \`claude auth login\` 报钥匙串错误，先运行 \`${UNLOCK_KEYCHAIN_CMD}\`（需要你本人输入登录密码）。`);
  return lines;
}

const errHead = (msg) => String(msg ?? '').trim().split('\n')[0].slice(0, 200);

/** 私聊里 Claude 调用失败时回给用户的话 */
export async function claudeFailureReply(msg, { checkKeychain = isLoginKeychainLocked } = {}) {
  const kind = classifyClaudeError(msg);
  if (kind === 'transient_refresh') {
    return '⚠️ Claude 的登录令牌正在由另一个 claude 进程刷新（瞬时状态，不是登录失效）。过半分钟再发一次。';
  }
  if (!isClaudeLoginFailure(kind)) return `⚠️ Claude 调用失败：${msg}`;
  const variant = loginFixVariant(msg);
  if (variant === 'subscription') {
    return ['⚠️ Claude 的订阅访问被组织停用了。', `报错：\`${errHead(msg)}\``, '', ...loginFixLines({ kind, variant }), '', '恢复后重发这条消息。'].join('\n');
  }
  const keychainLocked = kind === 'keychain' ? true : await checkKeychain();
  const head = keychainLocked === true
    ? '⚠️ Mac 的登录钥匙串被锁住了，Claude 读不到登录凭据。'
    : '⚠️ Mac 上的 Claude 登录失效了。';
  return [head, `报错：\`${errHead(msg)}\``, '', ...loginFixLines({ kind, keychainLocked }), '', '修好后重发这条消息。'].join('\n');
}

/**
 * 定时任务失败的收尾：登录类故障跳过 haiku 自诊断（它也要调 claude，只会同样失败），
 * 直接发确定性修复步骤；其它失败照旧自诊断。
 * @returns {Promise<{diagnosed:boolean, kind:string}>}
 */
export async function handleScheduledFailure({ err, jobName, send, runDiagnosis, checkKeychain = isLoginKeychainLocked, log = console.error }) {
  const kind = classifyClaudeError(err);
  if (isClaudeLoginFailure(kind)) {
    log(`[sched] 任务失败（Claude 登录故障，跳过自诊断）: ${redact(err)}`);
    const variant = loginFixVariant(err);
    const keychainLocked = variant === 'subscription' ? null : kind === 'keychain' ? true : await checkKeychain();
    await send([
      `⚠️ **定时任务失败**：${jobName}（Claude 登录故障，已跳过自诊断）`,
      '',
      `报错：\`${String(err).slice(0, 300)}\``,
      '',
      '**修复**',
      ...loginFixLines({ kind, keychainLocked, variant }),
      '',
      '修好后这个任务下次到点照常运行。',
    ].join('\n'));
    return { diagnosed: false, kind };
  }
  log(`[sched] 任务失败，启动自诊断: ${redact(err)}`);
  let diag = '';
  try {
    diag = await runDiagnosis();
  } catch (e2) {
    diag = `（诊断也失败了：${String(e2?.message ?? e2).slice(0, 200)}）`;
  }
  await send(`⚠️ **定时任务失败**：${jobName}\n\n报错：\`${String(err).slice(0, 300)}\`\n\n**自诊断**\n${diag}`);
  return { diagnosed: true, kind };
}

/**
 * 入站消息日志行：先脱敏再截断（反过来会把截断后不足 8 位的密钥尾巴留在日志里），换行折成 ⏎ 保持一行。
 * 起因：owner 私聊贴过一整把 bms_sk_… 密钥，旧写法原样记进了 ~/Library/Logs/feishu-claude-bridge.log。
 */
export function formatInboundLog({ who, chatType, messageType, exec = false, text }) {
  const body = redact(text).replace(/\r?\n/g, ' ⏎ ').slice(0, 80);
  return `[msg] ${who} @ ${chatType} [${messageType}]${exec ? ' [exec]' : ''}: ${body}`;
}
