#!/usr/bin/env node
// 业务系统只读 Key 自检：每个 target 发一次固定的 GET（bms：/api/v1/auth/me；ias：/api/v1），每个只打印一行结论。
// - Key 只从本机钥匙串读进内存（与 MCP 服务同一个 readKeychainKey），不打印 Key、请求头、原始响应或对方的报错原文。
// - 成功：`BMS: HTTP 200 · role=<角色> · email=<首字母>***@<域>`、`IAS: HTTP 200 · scopes=<范围> · key=<首字>***`。
// - 失败：固定的一句原因（钥匙串缺条目时附写入命令模板，不含密钥）。
// 用法：npm run -s biz-check            # 两个都查
//       npm run -s biz-check -- ias     # 只查一个；npm run -s bms-check 等于 biz-check -- bms
// 退出码：所查的全部通过为 0，否则 1。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, TARGET_IDS, LIMITS, buildBizUrl, missingKeyText } from '../src/biz-targets.js';
import { bizRequest, readKeychainKey, tlsInsecure } from '../src/mcp-biz.js';

const USAGE = `用法：node scripts/biz-check.js [${TARGET_IDS.join(' | ')}]…（不带参数时全部检查）`;
const ROLE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/;
const SCOPE_RE = /^[a-z][a-z0-9_:.-]{0,30}$/;
const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}\.){1,6}[A-Za-z]{2,24}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function maskEmail(v) {
  if (typeof v !== 'string') return '?';
  const at = v.lastIndexOf('@');
  if (at < 1) return '?';
  const first = /^[A-Za-z0-9]$/.test(v[0]) ? v[0] : '*';
  const domain = v.slice(at + 1);
  return `${first}***@${DOMAIN_RE.test(domain) ? domain : '***'}`;
}

function maskName(v) {
  if (typeof v !== 'string' || v.length === 0) return '?';
  const first = Array.from(v)[0];
  return /^[\p{L}\p{N}]$/u.test(first) ? `${first}***` : '***';
}

function roleOf(u) {
  const pick = (r) => (typeof r === 'string' && ROLE_RE.test(r) ? r : null);
  if (!isObj(u)) return null;
  if (typeof u.role === 'string') return pick(u.role);
  if (isObj(u.role)) return pick(u.role.code) ?? pick(u.role.name);
  if (Array.isArray(u.roles)) {
    const rs = u.roles.map((r) => (isObj(r) ? pick(r.code) ?? pick(r.name) : pick(r))).filter(Boolean).slice(0, 3);
    return rs.length ? rs.join('+') : null;
  }
  return null;
}

// /auth/me 的外层包装没有写死：依次看 data.user、user、data、整体，取第一个带 email 或 role 的对象
function bmsUser(data) {
  for (const c of [data?.data?.user, data?.user, data?.data, data]) {
    if (isObj(c) && ('email' in c || 'role' in c || 'roles' in c)) return c;
  }
  return null;
}

function okLine(id, r) {
  const head = `${TARGETS[id].name}: HTTP ${r.status}`;
  if (id === 'bms') {
    const u = bmsUser(r.data);
    return `${head} · role=${roleOf(u) ?? '?'} · email=${maskEmail(u?.email)}`;
  }
  const d = isObj(r.data?.data) ? r.data.data : isObj(r.data) ? r.data : {};
  const scopes = Array.isArray(d.scopes) ? d.scopes.filter((s) => typeof s === 'string' && SCOPE_RE.test(s)).slice(0, 5) : [];
  return `${head} · scopes=${scopes.length ? scopes.join(',') : '?'} · key=${maskName(d.authenticatedAs)}`;
}

function httpReason(status) {
  if (status === 401) return 'Key 无效、已吊销、已过期，或来源 IP 不在 Key 允许的范围内';
  if (status === 403) return '被拒绝：这把 Key 没有权限，或请求被对方防火墙拦下';
  if (status === 404) return '自检接口不存在（主机或路径不对）';
  if (status === 429) return '请求太频繁，稍后再试';
  if (status >= 500) return '对方服务出错，稍后再试';
  return '请求没有成功';
}

function failLine(id, r) {
  const name = TARGETS[id].name;
  switch (r.kind) {
    case 'redirect': return `${name}: HTTP ${r.status ?? '?'} · 对方要求重定向，已拒绝跟随`;
    case 'timeout': return `${name}: 请求超时（${LIMITS.timeoutMs / 1000} 秒）`;
    case 'network': {
      const reason = typeof r.reason === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(r.reason) ? `（${r.reason}）` : '';
      return `${name}: 网络错误${reason}，请求没有完成`;
    }
    case 'too-large': return `${name}: HTTP ${r.status ?? '?'} · 响应过大，已丢弃`;
    case 'non-json':
      return r.status >= 200 && r.status < 300
        ? `${name}: HTTP ${r.status} · 返回的不是 JSON（可能被防火墙或登录页拦下）`
        : `${name}: HTTP ${r.status ?? '?'} · ${httpReason(r.status)}`;
    case 'empty': return `${name}: HTTP ${r.status} · 空响应`;
    case 'http-error': return `${name}: HTTP ${r.status ?? '?'} · ${httpReason(r.status)}`;
    default: return `${name}: 结果无法解析`;
  }
}

async function checkOne(id, { fetch, readKey }) {
  if (tlsInsecure()) {
    return { ok: false, lines: [`${TARGETS[id].name}: 已停用——本机设置了 NODE_TLS_REJECT_UNAUTHORIZED=0（关闭了 TLS 证书校验），去掉后再查`] };
  }
  let key = null;
  try { key = readKey(id); } catch { key = null; }
  if (typeof key !== 'string' || !TARGETS[id].keyFormat.test(key)) return { ok: false, lines: missingKeyText(id).split('\n') };
  const url = buildBizUrl(id, TARGETS[id].checkPath);
  const r = await bizRequest({ target: id, url, key, fetch });
  key = null;
  if (r.kind === 'json' && r.status >= 200 && r.status < 300) return { ok: true, lines: [okLine(id, r)] };
  return { ok: false, lines: [failLine(id, r)] };
}

/** 依次检查 targets；返回退出码（0 全部通过 / 1 有失败）。只往 out 写固定格式的结论行。 */
export async function runCheck({
  targets = TARGET_IDS,
  fetch = globalThis.fetch?.bind(globalThis),
  readKey = (id) => readKeychainKey(id),
  out = (line) => process.stdout.write(`${line}\n`),
  err = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const ids = [...targets];
  if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || !Object.hasOwn(TARGETS, id))) {
    err(USAGE);
    return 1;
  }
  if (typeof fetch !== 'function') {
    err('当前 Node 没有内置 fetch（需要 Node ≥ 18）');
    return 1;
  }
  let allOk = true;
  for (const id of ids) {
    let res;
    try {
      res = await checkOne(id, { fetch, readKey });
    } catch {
      res = { ok: false, lines: [`${TARGETS[id].name}: 自检没有完成（内部错误）`] };
    }
    for (const line of res.lines) out(line);
    if (!res.ok) allOk = false;
  }
  return allOk ? 0 : 1;
}

function isMain() {
  try {
    return fs.realpathSync(path.resolve(process.argv[1] ?? '')) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  process.exitCode = await runCheck({ targets: args.length ? args : TARGET_IDS });
}
