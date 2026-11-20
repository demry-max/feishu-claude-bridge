// 主用账号额度用尽 / 登录失效时自动换备用账号（可选，默认关闭）。
//
// 配置：
//   CLAUDE_FALLBACK_BIN           备用账号用的 claude 可执行文件；不设＝功能关闭，行为与没有本模块时完全一致
//   CLAUDE_FALLBACK_COOLDOWN_MIN  切到备用后多少分钟再试主用（缺省 30，1–720）
//
// 规则：
//   - 主用报「账号不可用」（额度用完 / 登录失效）→ 进入冷却，冷却期内所有新起的 CLI 子进程都用备用 bin；
//     选 bin 只在起子进程那一处（runClaudeOnce → spawnBinFor），所以私聊、执行道、群聊、访客、定时任务、心跳、复核、自诊断一视同仁。
//   - 冷却到期后下一轮先试主用：成功＝回到主用；仍不可用＝再次冷却，这一轮自动落到备用。
//   - 备用自己也报「账号不可用」或备用 bin 起不来 → 本轮不来回切、照现有路径抛错；同时清掉冷却，
//     下一轮先试主用（仍算同一次备用期，不重发通知）。
//   - 本轮还没有副作用（没调过工具、没发过进度消息）→ 立即用备用重试一次，不 sleep、不占网络重试名额；
//     已有副作用 → 不重放，提示「已切到备用账号，请再发一次 / 说“继续”」。
//   - 配置了备用时，主用或备用报会话不存在 → 每轮只一次不带 --resume 再试（两个 bin 最好共用同一个 CLI 配置目录，
//     否则换账号两边都会开新会话）。
//   - 未配置备用时（BRIDGE-RUN-1 M5）：原会话不存在、本轮还没动过手、也不是被取消 → 同样不带 --resume 重试一次，
//     新会话 id 随这一轮的 result 写回会话表，不再让这个会话键每一轮都报同一个错。
//     调用方显式传了非空 resumeId 的（每日新会话的交接轮续的是别人的会话）不这样做。
//   - 进入备用时私信 owner 一条固定文案，同一次连续的备用期只发一次；回到主用只打日志。
//     注入了免打扰判断且当时在免打扰时段 → 延后到时段结束再发；那之前已回到主用就不发。
//   - 状态只在内存：重启后从主用起，主用仍不可用会再收到一条通知。
// 日志闭集（不含消息内容、姓名、令牌、原始错误串；只有 [session] 那一行带会话键，与 claude.js 里别的 [session] 日志一致）：
//   [account] 主用不可用(quota|auth)，切到备用，冷却 N 分钟
//   [account] 冷却到期，试主用
//   [account] 回到主用
//   [account] 备用也不可用(quota|auth)
//   [account] 备用启动失败，回到主用路径
//   [account-notice] 免打扰时段，切换通知延后到时段结束
//   [account-notice] 切换通知发送失败
//   [session] <会话键> 原会话已不存在，已开新会话
import spawn from 'cross-spawn';
import { childEnv } from './child-env.js';

// 会话不存在：与同作者另一个桥接的实现一致（经真实 CLI 报错核对）。
// 注意（BRIDGE-RUN-1 M7）：下面的账号分类正则已经与那个桥接的实现分叉——这边按 test/fixtures/claude-auth-signatures.js
// 的 2.1.280 文案补全了登录故障、去掉了裸的 401 / 429、stderr 只认强信号；那边没有改。
// 两边不再逐条一致，别再假设「改动要两边一起改」就能对齐，要同步得人工对照夹具。
export const SESSION_NOT_FOUND = /No conversation found/i;

// 每个短语一条正则，方便逐条加注释、逐条删；拼成一条（忽略大小写）。
const anyOf = (list) => new RegExp(list.map((r) => r.source).join('|'), 'i');

// 登录失效（auth）的强信号：result 文本、errors、stderr 三路都认
const AUTH_STRONG = [
  /Not logged in/,
  /Run \/login/,
  /Invalid API key/,
  /Invalid auth token/, // 2.1.280：外部 auth token 无效
  /OAuth token (?:has )?expired/,
  /OAuth token (?:has been )?revoked/, // 含 `API Error: 403 OAuth token has been revoked`
  /authentication_error/,
  /Failed to authenticate/,
  /Login expired/, // 也命中 `Anthropic profile login expired`
  /OAuth session expired/,
  /OAuth authentication is currently not allowed/, // 组织不允许 OAuth
  /Keychain[^\n]{0,40}not writable/, // macOS 钥匙串不可写（-25293）
  /does not have access to Claude/, // 账号无权访问 Claude
  /disabled Claude subscription access/, // 组织停用了订阅访问
];
// 只在 result 文本 / errors 里认的数字形态：必须带 `API Error:` 前缀。
// 裸的 \b401\b 会把「工单 WO-401」当登录失效；stderr 里还常混着别的工具（lark-cli 等）自己的 HTTP 状态码
const AUTH_RESULT_ONLY = [/API Error:\s*401\b/];
// 额度用完（quota）的强信号：三路都认
const QUOTA_STRONG = [
  /usage limit/,
  /limit reached/,
  /out of extra usage/,
  /You[’']ve hit your\b[^\n]{0,40}?\b(?:limit|budget)/,
  /spend limit reached/,
];
// 只在 result 文本 / errors 里认的限流形态：stderr 里别的工具报的 rate limit / HTTP 429 不是 claude 账号的额度问题
const QUOTA_RESULT_ONLY = [/rate[ _]limit/, /API Error:\s*429\b/];

const AUTH_RESULT = anyOf([...AUTH_STRONG, ...AUTH_RESULT_ONLY]);
const AUTH_STDERR = anyOf(AUTH_STRONG);
const QUOTA_RESULT = anyOf([...QUOTA_STRONG, ...QUOTA_RESULT_ONLY]);
const QUOTA_STDERR = anyOf(QUOTA_STRONG);
// 保留原导出名（result 文本口径），免得外部引用断掉
export const ACCOUNT_AUTH_UNAVAILABLE = AUTH_RESULT;
export const ACCOUNT_UNAVAILABLE = anyOf([...AUTH_STRONG, ...AUTH_RESULT_ONLY, ...QUOTA_STRONG, ...QUOTA_RESULT_ONLY]);

export const DEFAULT_COOLDOWN_MIN = 30;
const MIN_COOLDOWN_MIN = 1;
const MAX_COOLDOWN_MIN = 720;
const MAX_SPAWNS_PER_TURN = 3; // 主用 1 + 备用 1 + 无 --resume 1
const DEFAULT_NOTICE_RECHECK_MS = 5 * 60_000;
const SPAWN_FAILED_PREFIX = 'claude CLI 启动失败'; // claude.js 起子进程失败时的报错开头

/** 本轮用哪个账号：由 runWithAccount 写进 opts，runClaudeOnce 起子进程时读 */
export const ACCOUNT = Symbol('claude-account');

const asText = (x) => String(x ?? '');

/**
 * 分两路看文本，口径不同（BRIDGE-RUN-1 M7）：
 *   resultText  result 事件的文本（含 errors 数组）。这是 claude 自己对账号状态的说法，认全部形态，
 *               包括 `API Error: 401` / `API Error: 429` 与 rate_limit 字样；
 *   stderrText  子进程 stderr。里面常混着 Bash / MCP / lark-cli 等别的工具的输出，只认强信号
 *               （额度用完的几句固定话、登录失效的几句固定话），不认裸的 HTTP 状态码和 rate limit。
 * 只传一个参数＝按 result 文本口径看。
 * 会话不存在（任何一路出现）优先：那不是账号问题。两类信号都有时 auth 优先（登录失效了，额度无从谈起）。
 * @returns {'quota'|'auth'|null}
 */
export function classifyAccountError(resultText, stderrText = '') {
  const r = asText(resultText);
  const s = asText(stderrText);
  if (SESSION_NOT_FOUND.test(r) || SESSION_NOT_FOUND.test(s)) return null;
  if (AUTH_RESULT.test(r) || AUTH_STDERR.test(s)) return 'auth';
  if (QUOTA_RESULT.test(r) || QUOTA_STDERR.test(s)) return 'quota';
  return null;
}

/** 分类用的全文：截断前的错误结果 + errors 数组 + stderr（runClaudeOnce 挂在 err 上）。只用来找「会话不存在」 */
const errorText = (e) => [e?.message ?? e, e?.cliErrors ?? '', e?.cliStderr ?? ''].join('\n');

// 进程没出 result 就退出时，runClaudeOnce 的报错形如 `claude CLI 失败(code N): ` + stderr 头 500 字：
// 那一段本质上是 stderr，不能当 result 文本看，否则 stderr 里的弱信号会经 message 绕过 stderr 的严格口径
const CRASH_WRAPPER = /^claude CLI 失败\(code [^)]*\):/;
function classifyError(e) {
  const msg = asText(e?.message ?? e);
  const stderr = typeof e?.cliStderr === 'string' ? e.cliStderr : '';
  const resultPart = CRASH_WRAPPER.test(msg) && stderr ? '' : msg;
  return classifyAccountError([resultPart, e?.cliErrors ?? ''].join('\n'), stderr);
}

export function parseCooldownMin(env = process.env, warn = console.error) {
  const raw = env?.CLAUDE_FALLBACK_COOLDOWN_MIN;
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  if (s === '') return DEFAULT_COOLDOWN_MIN;
  if (!/^\d{1,4}$/.test(s) || Number(s) < MIN_COOLDOWN_MIN || Number(s) > MAX_COOLDOWN_MIN) {
    warn(`[config] ⚠️ CLAUDE_FALLBACK_COOLDOWN_MIN=${JSON.stringify(s.slice(0, 40))} 不合法（要 ${MIN_COOLDOWN_MIN}–${MAX_COOLDOWN_MIN} 的整数分钟），按默认 ${DEFAULT_COOLDOWN_MIN} 分钟`);
    return DEFAULT_COOLDOWN_MIN;
  }
  return Number(s);
}

const KIND_LABEL = { quota: '额度用完', auth: '登录失效' };
export function accountNoticeText(kind, cooldownMin) {
  return `主用账号${KIND_LABEL[kind] ?? '不可用'}，已自动切到备用账号，约 ${cooldownMin} 分钟后会再试主用账号。`;
}
const midTurnMessage = (kind) =>
  `主用账号${KIND_LABEL[kind] ?? '不可用'}，本轮已执行到一半，为避免重复写入未自动重放。\n（已切到备用账号，请再发一次，或说“继续”）`;

// ---- 进程内状态（单例；configureAccountFallback 整体替换，测试与启动自检用） ----
let cfg;
let state;
let noticeTimer = null; // 免打扰时段延后发送的复查定时器（同时最多一个）
function clearNoticeTimer() {
  if (noticeTimer) clearInterval(noticeTimer);
  noticeTimer = null;
}
function configure({ fallbackBin, cooldownMin, now = Date.now, log = console.log, notify = null } = {}) {
  clearNoticeTimer();
  const bin = String(fallbackBin ?? '').trim();
  cfg = {
    fallbackBin: bin, cooldownMin: cooldownMin ?? DEFAULT_COOLDOWN_MIN, now, log, notify,
    isQuiet: () => false, noticeRecheckMs: DEFAULT_NOTICE_RECHECK_MS, pendingKind: null,
  };
  // episode：一次连续的备用期（进入时通知一次，主用试探成功才结束）
  state = { enabled: bin !== '', fallbackUntil: 0, episode: false, probeLogged: false };
}
export function configureAccountFallback(opts = {}) {
  configure(opts);
}
// 未配置备用时不解析冷却时长（也就不会为它打告警）——与没有本功能时的日志逐字一致
configure({
  fallbackBin: process.env.CLAUDE_FALLBACK_BIN,
  cooldownMin: String(process.env.CLAUDE_FALLBACK_BIN ?? '').trim() ? parseCooldownMin(process.env) : DEFAULT_COOLDOWN_MIN,
});

export const isAccountFallbackEnabled = () => state.enabled;

/**
 * owner 私信通道由 index.js 注入（本模块不认识飞书）。
 * isQuiet：此刻是否在免打扰时段（沿用心跳的设置）；为真时切换通知延后，每 recheckMs 复查一次。
 */
export function setAccountNotifier(fn, { isQuiet = () => false, recheckMs = DEFAULT_NOTICE_RECHECK_MS } = {}) {
  cfg.notify = typeof fn === 'function' ? fn : null;
  cfg.isQuiet = typeof isQuiet === 'function' ? isQuiet : () => false;
  cfg.noticeRecheckMs = recheckMs;
}

/** 起子进程那一处调用：未配置时原样返回主用 bin */
export function spawnBinFor(primaryBin, opts = {}) {
  if (!state.enabled) return primaryBin;
  const account = opts?.[ACCOUNT] ?? (cfg.now() < state.fallbackUntil ? 'fallback' : 'primary');
  return account === 'fallback' ? cfg.fallbackBin : primaryBin;
}

/**
 * 配置了备用时，没动过手的出错结果里的 session_id 不回写会话表（会话不存在 / 额度错误时带回来的可能是空会话）；
 * 本轮已调过工具或发过进度（acted）的照常回写，下一轮才能接着这段会话。
 */
export const skipErrorSession = (d, acted = false) => state.enabled && Boolean(d?.is_error) && !acted;

function chooseAccount() {
  if (cfg.now() < state.fallbackUntil) return { account: 'fallback', probe: false };
  if (state.episode) {
    if (!state.probeLogged) {
      state.probeLogged = true;
      cfg.log('[account] 冷却到期，试主用');
    }
    return { account: 'primary', probe: true };
  }
  return { account: 'primary', probe: false };
}

function primarySucceeded(probe) {
  // 只有「冷却到期后的试探」成功才算回到主用；冷却前就在主用上起跑的长轮不算。
  // 试探期间另一轮又把冷却续上了，以那次为准，不回切。
  if (!probe || !state.episode || cfg.now() < state.fallbackUntil) return;
  state.episode = false;
  state.fallbackUntil = 0;
  state.probeLogged = false;
  cfg.log('[account] 回到主用');
}

// 备用不可用 / 起不来：清冷却，下一轮先试主用；episode 保留（不重发通知）
function resetCooldownAfterFallbackFailure() {
  state.fallbackUntil = 0;
  state.probeLogged = false;
}

function quietNow() {
  try {
    return Boolean(cfg.isQuiet());
  } catch {
    return false; // 判断出错按非免打扰处理：宁可发，不丢
  }
}

function sendNotice(kind) {
  const notify = cfg.notify;
  if (!notify) return;
  // 不 await：发通知失败或慢都不影响这一轮对话
  Promise.resolve()
    .then(() => notify(accountNoticeText(kind, cfg.cooldownMin)))
    .catch(() => console.error('[account-notice] 切换通知发送失败'));
}

function deferNotice(kind) {
  cfg.pendingKind = kind;
  cfg.log('[account-notice] 免打扰时段，切换通知延后到时段结束');
  if (noticeTimer) return;
  noticeTimer = setInterval(() => {
    if (!state.episode) {
      clearNoticeTimer(); // 免打扰期间已回到主用：丢弃不发
      return;
    }
    if (quietNow()) return;
    clearNoticeTimer();
    sendNotice(cfg.pendingKind);
  }, cfg.noticeRecheckMs);
  noticeTimer.unref?.();
}

function enterFallback(kind) {
  const t = cfg.now();
  if (t < state.fallbackUntil) return; // 并发：另一轮刚切过，状态已一致，不续期、不重复日志与通知
  state.fallbackUntil = t + cfg.cooldownMin * 60_000;
  state.probeLogged = false;
  cfg.log(`[account] 主用不可用(${kind})，切到备用，冷却 ${cfg.cooldownMin} 分钟`);
  if (state.episode) return; // 同一次连续备用期（冷却到期试探失败）不重复通知
  state.episode = true;
  if (!cfg.notify) return;
  if (quietNow()) {
    deferNotice(kind);
    return;
  }
  clearNoticeTimer(); // 上一次备用期延后的那条作废，只发这一条
  sendNotice(kind);
}

/** BRIDGE-RUN-2：告诉调用方「这一轮改用新会话了」（meta.onRenewed）；回调出错不影响本轮 */
function notifyRenewed(meta) {
  try { meta?.onRenewed?.(); } catch { /* 回调出错不影响本轮 */ }
}

/**
 * 未配置备用：第一次调用 opts 原样传入，与没有本功能时一致。只多一件事（BRIDGE-RUN-1 M5）——
 * 原会话已不存在（会话表里的 id 被清掉、换了 CLI 配置目录……）、本轮还没动过手、也不是被取消时，
 * 不带 --resume 重试一次：新会话的 id 随这一轮的 result 写回会话表，这个会话键下一轮起就正常了，
 * 不必等人发现后手动 /new。不 sleep、不占 CLAUDE_MAX_RETRIES 名额。
 * 调用方显式传了非空 resumeId（每日新会话的交接轮续的是别人的会话，不是本会话键自己的）时不这样做：
 * 那种场景下悄悄换成空会话，会把交接内容丢掉而没人知道。
 */
async function runWithoutFallback(once, opts, meta) {
  try {
    return await once(opts);
  } catch (e) {
    const explicitResume = typeof opts?.resumeId === 'string' && opts.resumeId !== '';
    if (e?.cancelled || e?.acted || explicitResume || !SESSION_NOT_FOUND.test(errorText(e))) throw e;
    // console.log 取调用时的值：测试与别处会替换它，不能在模块加载时绑定
    if (meta?.key) console.log(`[session] ${meta.key} 原会话已不存在，已开新会话`);
    notifyRenewed(meta);
    return once({ ...opts, resumeId: '' });
  }
}

/**
 * 包住「跑一次 CLI」：未配置备用时只做上面那一次「不带 --resume 重试」，其余直接调用。
 * 账号层的重试在网络重试之内：不 sleep，不占 CLAUDE_MAX_RETRIES 名额。
 * @param {(opts: object) => Promise<any>} once
 * @param {object} [opts]
 * @param {{key?: string, onRenewed?: () => void}} [meta] key：会话键，只用来给「原会话已不存在」那行日志署名；
 *   onRenewed（BRIDGE-RUN-2）：这一轮因「原会话已不存在」改成不带 --resume 重开时调用一次，调用方据此提示用户上下文已换新（出错被吞）
 */
export async function runWithAccount(once, opts = {}, meta = {}) {
  if (!state.enabled) return runWithoutFallback(once, opts, meta);
  let { account, probe } = chooseAccount();
  let freshSession = false;
  for (let spawns = 1; ; spawns++) {
    const o = { ...opts, [ACCOUNT]: account, ...(freshSession ? { resumeId: '' } : {}) };
    try {
      const out = await once(o);
      if (account === 'primary') primarySucceeded(probe);
      return out;
    } catch (e) {
      if (e?.cancelled) throw e; // /cancel、/new、优雅退出：不切换、不重试
      const text = errorText(e);
      const room = spawns < MAX_SPAWNS_PER_TURN; // 硬上界：一轮最多起 3 个子进程
      if (room && !freshSession && !e?.acted && SESSION_NOT_FOUND.test(text)) {
        freshSession = true; // 每轮只这一次不带 --resume（主用、备用都适用）
        notifyRenewed(meta);
        continue;
      }
      const kind = classifyError(e); // result / errors 与 stderr 分两路、口径不同（M7）
      if (account === 'fallback') {
        if (kind) {
          cfg.log(`[account] 备用也不可用(${kind})`);
          resetCooldownAfterFallbackFailure();
        } else if (String(e?.message ?? '').startsWith(SPAWN_FAILED_PREFIX)) {
          cfg.log('[account] 备用启动失败，回到主用路径');
          resetCooldownAfterFallbackFailure();
        }
        throw e;
      }
      if (!kind) throw e;
      enterFallback(kind);
      if (e?.acted) {
        e.message = midTurnMessage(kind);
        throw e;
      }
      if (!room) throw e;
      account = 'fallback';
      probe = false;
    }
  }
}

/** /status 的一行；未配置备用时为空串 */
export function accountStatusLine() {
  if (!state.enabled) return '';
  const until = state.fallbackUntil;
  if (cfg.now() < until) {
    const hhmm = new Date(until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `\n- 当前账号: 备用（${hhmm} 后再试主用）`;
  }
  return state.episode ? '\n- 当前账号: 备用（下一轮先试主用）' : '\n- 当前账号: 主用';
}

/**
 * 启动自检：对备用 bin 跑一次 --version（与 checkCliEnvironment 对 CLAUDE_BIN 的写法一致）。
 * 失败只告警，并视为未配置备用。未配置时返回 null、不打任何日志。
 */
export function verifyFallbackAtStartup({ log = console.log, warn = console.error } = {}) {
  if (!state.enabled) return null;
  const bin = cfg.fallbackBin;
  let version = null;
  let problem = null;
  try {
    const out = spawn.sync(bin, ['--version'], { encoding: 'utf8', env: childEnv() }); // BRIDGE-RUN-1（H3）：不把桥接的配置与飞书凭据递给备用 CLI
    if (out.error) problem = `无法运行：${out.error.message}`;
    else {
      version = (String(out.stdout ?? '').match(/(\d+\.\d+\.\d+)/) ?? [])[1] ?? null;
      if (out.status !== 0 || !version) problem = `--version 未输出版本号（退出码 ${out.status}）`;
    }
  } catch (e) {
    problem = `自检失败：${e?.message ?? e}`;
  }
  if (problem) {
    state.enabled = false;
    warn(`[config] ⚠️ 备用 claude CLI ${bin} ${problem}，本次运行视为未配置备用账号`);
    return { ok: false, bin, version, problem };
  }
  log(`[config] 备用 claude CLI：${bin} (${version})`);
  return { ok: true, bin, version, problem: null };
}
