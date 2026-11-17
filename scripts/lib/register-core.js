// npm run register 的纯逻辑（参数、模式选择、待授权记录、轮询结果分类），便于单测。
// 只用 Node 内置模块。
import fs from 'node:fs';
import path from 'node:path';

export const PENDING_FILE = 'register-pending.json';

export function parseRegisterArgs(argv = []) {
  const has = (f) => argv.includes(f);
  const i = argv.indexOf('--timeout');
  const timeout = i >= 0 ? Number(argv[i + 1]) : NaN;
  return {
    wait: has('--wait'),
    noWait: has('--no-wait'),
    resume: has('--resume'),
    force: has('--force'),
    restart: has('--restart'),
    timeoutSec: Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.floor(timeout), 900) : null,
  };
}

/**
 * 选模式：
 *   resume —— 显式 --resume：轮询上次 --no-wait 留下的设备码
 *   start  —— --no-wait，或没有 TTY 且没写 --wait：只打印扫码链接、存设备码，立刻退出（退出码 2）
 *   wait   —— 交互终端默认：打印二维码并原地等待（老行为）
 * 没有 TTY 时默认 start：AI agent / CI 里跑的命令会被缓冲输出，原地阻塞 10 分钟的话人根本看不到链接。
 */
export function chooseMode(opts, { isTTY = false } = {}) {
  if (opts.resume) return 'resume';
  if (opts.noWait) return 'start';
  if (opts.wait) return 'wait';
  return isTTY ? 'wait' : 'start';
}

/** 已有凭据时再注册会在飞书里多建一个应用；默认拒绝，--force 才继续 */
export function guardExisting(values, { force = false } = {}) {
  if (force) return null;
  if (values.FEISHU_APP_ID && values.FEISHU_APP_SECRET) {
    return '.env 里已有 FEISHU_APP_ID / FEISHU_APP_SECRET：再注册会新建另一个飞书应用，并覆盖现有凭据。' +
      '确实要新建请加 --force（npm run register -- --force）；只想检查现有应用请用 npm run setup。';
  }
  return null;
}

export function pendingPath(root) {
  return path.join(root, 'data', PENDING_FILE);
}

/** 设备码能换出应用密钥，按凭据对待：data/ 已被 .gitignore 忽略，文件权限 600 */
export function savePending(root, { deviceCode, interval, expireIn, url, domain }, now = Date.now()) {
  const p = pendingPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const rec = { device_code: deviceCode, interval: interval || 5, expires_at: now + (expireIn || 600) * 1000, url, domain: domain || 'feishu' };
  fs.writeFileSync(p, JSON.stringify(rec, null, 2), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* Windows */ }
  return rec;
}

/** 读待授权记录；不存在 / 损坏 / 过期都返回 { error } */
export function loadPending(root, now = Date.now()) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(pendingPath(root), 'utf8'));
  } catch {
    return { error: 'missing' };
  }
  if (!rec?.device_code) return { error: 'missing' };
  if (!(rec.expires_at > now)) return { error: 'expired', rec };
  return { rec };
}

export function clearPending(root) {
  try { fs.unlinkSync(pendingPath(root)); } catch { /* 已不存在 */ }
}

/** 轮询结果分类：done / pending / slow_down / error */
export function classifyPoll(p) {
  if (p?.client_id && p?.client_secret) return { kind: 'done', appId: p.client_id, appSecret: p.client_secret, openId: p.user_info?.open_id ?? null };
  if (p?.error === 'authorization_pending') return { kind: 'pending' };
  if (p?.error === 'slow_down') return { kind: 'slow_down' };
  if (p?.error) return { kind: 'error', message: `${p.error} ${p.error_description ?? ''}`.trim() };
  return { kind: 'pending' };
}

/** 注册接口端点：lark = 国际版，其它一律飞书 */
export function regUrl(domain) {
  return domain === 'lark'
    ? 'https://accounts.larksuite.com/oauth/v1/app/registration'
    : 'https://accounts.feishu.cn/oauth/v1/app/registration';
}

export function consoleUrl(domain) {
  return domain === 'lark' ? 'https://open.larksuite.com/app' : 'https://open.feishu.cn/app';
}

export function scopeImportJson(scopes) {
  return JSON.stringify({ scopes: { tenant: scopes, user: [] } });
}
