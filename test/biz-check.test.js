// BRIDGE-BMS-1：业务系统只读 Key 自检脚本（scripts/biz-check.js，npm run biz-check / bms-check）。
// 全程用注入的假 fetch 与假钥匙串读取：不碰真实钥匙串、不联网。假 Key 带 ZZTESTMARK，任何输出里都不许出现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCheck } from '../scripts/biz-check.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARK = 'ZZTESTMARK';
const KEYS = { bms: `bms_sk_${MARK}${'a'.repeat(24)}`, ias: `acc_${MARK}${'b'.repeat(33)}` };

function jsonResponse(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': `rid-${MARK}`, 'set-cookie': `s=${MARK}`, ...extra },
  });
}

function harness(routes, { keys = KEYS } = {}) {
  const calls = [];
  const lines = [];
  const errs = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init?.method, redirect: init?.redirect, auth: init?.headers?.Authorization });
    const r = routes[url];
    if (!r) throw Object.assign(new Error(`unexpected ${url}`), { cause: { code: 'ENOTFOUND' } });
    return typeof r === 'function' ? r() : r;
  };
  return {
    calls, lines, errs,
    run: (targets) => runCheck({ targets, fetch, readKey: (id) => keys[id] ?? null, out: (l) => lines.push(l), err: (l) => errs.push(l) }),
  };
}

const BMS_ME = 'https://crm.gdsgroup.tech/api/v1/auth/me';
const IAS_INDEX = 'https://finance.gds.ph/api/v1';
const okRoutes = () => ({
  [BMS_ME]: () => jsonResponse(200, { success: true, data: { user: { email: 'zhuge.liang@example.com', role: 'admin', name: `${MARK} 诸葛`, phone: '13800138000' } } }),
  [IAS_INDEX]: () => jsonResponse(200, { success: true, data: { name: 'IAS', version: '1', authenticatedAs: `${MARK} key`, scopes: ['read'], endpoints: ['/api/v1/ar'] } }),
});

function assertClean(h) {
  const all = [...h.lines, ...h.errs].join('\n');
  assert.ok(!all.includes(MARK), `输出里不能出现假 Key 标记：${all}`);
  assert.ok(!/bms_sk_|acc_[A-Za-z0-9]/.test(all), '输出里不能出现 Key 前缀');
  assert.ok(!/Bearer|Authorization|set-cookie|request-id|13800138000/i.test(all), '不回显请求头 / 响应头 / 原始响应');
}

test('14 自检成功：两个 target 各打一行打码结论，退出码 0；请求是固定 URL 的 GET、不跟随重定向、带 Bearer', async () => {
  const h = harness(okRoutes());
  assert.equal(await h.run(['bms', 'ias']), 0);
  assert.deepEqual(h.lines, [
    'BMS: HTTP 200 · role=admin · email=z***@example.com',
    'IAS: HTTP 200 · scopes=read · key=Z***',
  ]);
  assert.deepEqual(h.calls.map((c) => [c.url, c.method, c.redirect]), [[BMS_ME, 'GET', 'manual'], [IAS_INDEX, 'GET', 'manual']]);
  assert.equal(h.calls[0].auth, `Bearer ${KEYS.bms}`);
  assert.equal(h.calls[1].auth, `Bearer ${KEYS.ias}`);
  assert.deepEqual(h.errs, []);
  assertClean(h);
});

test('14 自检 401：固定原因、不回显对方报错原文，退出码 1', async () => {
  const h = harness({ [BMS_ME]: () => jsonResponse(401, { success: false, error: `Invalid API key ${MARK}`, code: `E_${MARK}` }) });
  assert.equal(await h.run(['bms']), 1);
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /^BMS: HTTP 401 · Key 无效、已吊销、已过期/);
  assert.ok(!h.lines[0].includes('Invalid API key'));
  assertClean(h);
});

test('14 自检钥匙串缺条目：固定说明 + 写入命令模板（不含密钥），0 次请求，退出码 1', async () => {
  const h = harness(okRoutes(), { keys: {} });
  assert.equal(await h.run(['bms']), 1);
  assert.equal(h.calls.length, 0);
  const text = h.lines.join('\n');
  assert.match(text, /钥匙串里没有可用的「com\.demry\.bms-agent\.readonly」（账号 bms-readonly），请 owner 写入/);
  assert.match(text, /security add-generic-password -U -a bms-readonly -s com\.demry\.bms-agent\.readonly .* -w$/m);
  assertClean(h);
});

test('14 自检：钥匙串读到格式不对的值当作缺条目（不发请求、不回显那个值）', async () => {
  const h = harness(okRoutes(), { keys: { bms: `sk-${MARK}-wrong-prefix`, ias: `${KEYS.ias}\nextra` } });
  assert.equal(await h.run(['bms', 'ias']), 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.lines.join('\n'), /com\.demry\.ias-agent\.readonly/);
  assertClean(h);
});

test('14 自检：一个通过一个缺 Key → 退出码 1，通过的那行照常打印', async () => {
  const h = harness(okRoutes(), { keys: { bms: KEYS.bms } });
  assert.equal(await h.run(['bms', 'ias']), 1);
  assert.equal(h.lines[0], 'BMS: HTTP 200 · role=admin · email=z***@example.com');
  assert.equal(h.calls.length, 1);
  assertClean(h);
});

test('14 自检：302 不跟随、非 JSON 不展示、网络错误只给错误码；都退出 1', async () => {
  const cases = [
    [() => new Response(null, { status: 302, headers: { location: `https://evil.example/${MARK}` } }), /^BMS: HTTP 302 · 对方要求重定向，已拒绝跟随$/],
    [() => new Response(`<html>${MARK} login</html>`, { status: 200, headers: { 'content-type': 'text/html' } }), /^BMS: HTTP 200 · 返回的不是 JSON/],
    [() => { throw Object.assign(new Error(`connect ${MARK}`), { cause: { code: 'ECONNREFUSED' } }); }, /^BMS: 网络错误（ECONNREFUSED），请求没有完成$/],
    [() => jsonResponse(503, { success: false, error: `busy ${MARK}` }), /^BMS: HTTP 503 · 对方服务出错/],
  ];
  for (const [route, re] of cases) {
    const h = harness({ [BMS_ME]: route });
    assert.equal(await h.run(['bms']), 1);
    assert.equal(h.calls.length, 1, '只请求一次，不跟随跳转');
    assert.match(h.lines[0], re);
    assertClean(h);
  }
});

test('14 自检：NODE_TLS_REJECT_UNAUTHORIZED=0 时直接拒绝，0 次请求', async () => {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const h = harness(okRoutes());
    assert.equal(await h.run(['bms', 'ias']), 1);
    assert.equal(h.calls.length, 0);
    assert.match(h.lines.join('\n'), /NODE_TLS_REJECT_UNAUTHORIZED=0/);
    assertClean(h);
  } finally {
    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
  }
});

test('14 自检：环境变量改不了主机（BMS_ORIGIN / BMS_HOST / HTTPS_PROXY 等）', async () => {
  const names = ['BMS_ORIGIN', 'BMS_HOST', 'BMS_BASE_URL', 'IAS_ORIGIN', 'IAS_HOST', 'HTTPS_PROXY'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) process.env[n] = 'https://evil.example';
  try {
    const h = harness(okRoutes());
    assert.equal(await h.run(['bms', 'ias']), 0);
    assert.deepEqual(h.calls.map((c) => c.url), [BMS_ME, IAS_INDEX]);
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
});

test('14 自检：缺字段时打 ?，怪值不原样回显（角色、邮箱域名过白名单）', async () => {
  const h = harness({
    [BMS_ME]: () => jsonResponse(200, { data: { role: `admin<script>${MARK}`, email: `${MARK}@evil domain` } }),
    [IAS_INDEX]: () => jsonResponse(200, { data: { scopes: [`read;${MARK}`] } }),
  });
  assert.equal(await h.run(['bms', 'ias']), 0);
  assert.deepEqual(h.lines, ['BMS: HTTP 200 · role=? · email=Z***@***', 'IAS: HTTP 200 · scopes=? · key=?']);
  assert.ok(!h.lines.join('\n').includes('ZZTESTMARK'));
});

test('14 自检：未知 target 打用法、退出 1、不发请求；package.json 暴露 biz-check 与 bms-check', async () => {
  const h = harness(okRoutes());
  assert.equal(await h.run(['crm']), 1);
  assert.equal(h.calls.length, 0);
  assert.match(h.errs.join('\n'), /^用法：/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['biz-check'], 'node scripts/biz-check.js');
  assert.equal(pkg.scripts['bms-check'], 'node scripts/biz-check.js bms');
  // 真进程：未知参数在读钥匙串、联网之前就退出
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'biz-check.js'), 'nope'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^用法：/);
});

test('14 自检脚本源码：不读 .env、不用 dotenv、不打印 headers / 原始响应', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'biz-check.js'), 'utf8');
  assert.ok(!/dotenv|\.env['"`]/.test(src));
  assert.ok(!/headers/.test(src.replace(/^\/\/.*$/gm, '')), '脚本自己不碰 headers（都在 bizRequest 里）');
  assert.ok(!/console\.(log|error)\(/.test(src));
});
