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
//   - 备用自己也报「账号不可用」→ 不来回切，照现有路径抛错。
//   - 本轮还没有副作用（没调过工具、没发过进度消息）→ 立即用备用重试一次，不 sleep、不占网络重试名额；
//     已有副作用 → 不重放，提示「已切到备用账号，请再发一次 / 说“继续”」。
//   - 备用报会话不存在 → 只对这一次不带 --resume 再试（两个 bin 最好共用同一个 CLI 配置目录，否则换账号会开新会话）。
//   - 进入备用时私信 owner 一条固定文案，同一次连续的备用期只发一次；回到主用只打日志。
// 日志闭集（不含消息内容、姓名、id、令牌、原始错误串）：
//   [account] 主用不可用(quota|auth)，切到备用，冷却 N 分钟
//   [account] 冷却到期，试主用
//   [account] 回到主用
//   [account] 备用也不可用(quota|auth)
import spawn from 'cross-spawn';

// 两条正则与同作者另一个桥接的实现一致（经真实 CLI 报错核对），改动要两边一起改
export const SESSION_NOT_FOUND = /No conversation found/i;
export const ACCOUNT_AUTH_UNAVAILABLE = /Not logged in|Run \/login|Invalid API key|OAuth token (?:has )?expired|authentication_error|\b401\b|Failed to authenticate|Login expired|OAuth token revoked|OAuth session expired/i;
export const ACCOUNT_UNAVAILABLE = /usage limit|limit reached|rate[ _]limit|\b429\b|out of extra usage|Not logged in|Run \/login|Invalid API key|OAuth token (?:has )?expired|authentication_error|\b401\b|You[’']ve hit your\b[^\n]{0,40}?\b(?:limit|budget)|spend limit reached|Failed to authenticate|Login expired|OAuth token revoked|OAuth session expired/i;

export const DEFAULT_COOLDOWN_MIN = 30;
const MIN_COOLDOWN_MIN = 1;
const MAX_COOLDOWN_MIN = 720;
const MAX_SPAWNS_PER_TURN = 3; // 主用 1 + 备用 1 + 备用无 --resume 1

/** 本轮用哪个账号：由 runWithAccount 写进 opts，runClaudeOnce 起子进程时读 */
export const ACCOUNT = Symbol('claude-account');

/** @returns {'quota'|'auth'|null} 会话不存在优先（那不是账号问题） */
export function classifyAccountError(text) {
  const s = String(text ?? '');
  if (SESSION_NOT_FOUND.test(s) || !ACCOUNT_UNAVAILABLE.test(s)) return null;
  return ACCOUNT_AUTH_UNAVAILABLE.test(s) ? 'auth' : 'quota';
}

/** 分类用的全文：截断前的错误结果 + errors 数组 + stderr（runClaudeOnce 挂在 err 上） */
const errorText = (e) => [e?.message ?? e, e?.cliErrors ?? '', e?.cliStderr ?? ''].join('\n');

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
function configure({ fallbackBin, cooldownMin, now = Date.now, log = console.log, notify = null } = {}) {
  const bin = String(fallbackBin ?? '').trim();
  cfg = { fallbackBin: bin, cooldownMin: cooldownMin ?? DEFAULT_COOLDOWN_MIN, now, log, notify };
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

/** owner 私信通道由 index.js 注入（本模块不认识飞书） */
export function setAccountNotifier(fn) {
  cfg.notify = typeof fn === 'function' ? fn : null;
}

/** 起子进程那一处调用：未配置时原样返回主用 bin */
export function spawnBinFor(primaryBin, opts = {}) {
  if (!state.enabled) return primaryBin;
  const account = opts?.[ACCOUNT] ?? (cfg.now() < state.fallbackUntil ? 'fallback' : 'primary');
  return account === 'fallback' ? cfg.fallbackBin : primaryBin;
}

/** 配置了备用时，出错结果里的 session_id 不回写会话表（会话不存在 / 额度错误时带回来的可能是空会话） */
export const skipErrorSession = (d) => state.enabled && Boolean(d?.is_error);

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

function enterFallback(kind) {
  const t = cfg.now();
  if (t < state.fallbackUntil) return; // 并发：另一轮刚切过，状态已一致，不续期、不重复日志与通知
  state.fallbackUntil = t + cfg.cooldownMin * 60_000;
  state.probeLogged = false;
  cfg.log(`[account] 主用不可用(${kind})，切到备用，冷却 ${cfg.cooldownMin} 分钟`);
  if (state.episode) return; // 同一次连续备用期（冷却到期试探失败）不重复通知
  state.episode = true;
  const notify = cfg.notify;
  if (!notify) return;
  // 不 await：发通知失败或慢都不影响这一轮对话
  Promise.resolve()
    .then(() => notify(accountNoticeText(kind, cfg.cooldownMin)))
    .catch(() => console.error('[account-notice] 切换通知发送失败'));
}

/**
 * 包住「跑一次 CLI」：未配置备用时直接调用、opts 原样传入（零变化）。
 * 账号层的重试在网络重试之内：不 sleep，不占 CLAUDE_MAX_RETRIES 名额。
 * @param {(opts: object) => Promise<any>} once
 */
export async function runWithAccount(once, opts = {}) {
  if (!state.enabled) return once(opts);
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
      if (room && account === 'fallback' && !freshSession && !e?.acted && SESSION_NOT_FOUND.test(text)) {
        freshSession = true; // 只这一次不带 --resume
        continue;
      }
      const kind = classifyAccountError(text);
      if (!kind) throw e;
      if (account === 'fallback') {
        cfg.log(`[account] 备用也不可用(${kind})`);
        throw e;
      }
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
    const out = spawn.sync(bin, ['--version'], { encoding: 'utf8', env: process.env });
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
