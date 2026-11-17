// npm run register 端到端：用 --import 注入假 fetch，不联网。
// 覆盖：有效 pending 时不重新 begin、--restart 重来、--resume 用 pending 里的 domain、
// 成功后 .env 仍是 600 且输出里没有 Secret。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRegisterArgs, regUrl, savePending, loadPending } from '../scripts/lib/register-core.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'FAKESECRET_zzzz999';
const skip = process.platform === 'win32' ? '临时目录里用软链' : false;

// 假注册接口：每次调用把「action host」追加到 FAKE_CALLS 文件；FAKE_POLL=pending|done
const FAKE_FETCH = `
import fs from 'node:fs';
let seq = 0;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (!/oauth\\/v1\\/app\\/registration/.test(u.pathname)) throw new Error('unexpected url ' + url);
  const a = new URLSearchParams(init.body).get('action');
  fs.appendFileSync(process.env.FAKE_CALLS, a + ' ' + u.host + '\\n');
  const json = (o) => ({ json: async () => o });
  if (a === 'init') return json({ supported_auth_methods: ['client_secret'] });
  if (a === 'begin') { seq++; const id = process.pid + '-' + seq; return json({ device_code: 'DEV' + id, verification_uri_complete: 'https://example.invalid/qr?x=' + id, expire_in: 600, interval: 1 }); }
  if (a === 'poll') {
    if (process.env.FAKE_POLL === 'done') return json({ client_id: 'cli_fakeapp123', client_secret: '${SECRET}', user_info: { open_id: 'ou_fakeowner999' } });
    return json({ error: 'authorization_pending' });
  }
  throw new Error('unexpected action ' + a);
};
`;

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gh1-reg-'));
  fs.cpSync(path.join(REPO, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'src'), path.join(root, 'src'), 'dir');
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(root, '.env.example'), '# 模板\nFEISHU_APP_ID=\nFEISHU_APP_SECRET=\nOWNER_OPEN_ID=\n');
  fs.writeFileSync(path.join(root, 'fake-fetch.mjs'), FAKE_FETCH);
  const calls = path.join(root, 'calls.txt');
  fs.writeFileSync(calls, '');
  const go = (args, extraEnv = {}) => spawnSync(process.execPath,
    ['--import', path.join(root, 'fake-fetch.mjs'), path.join(root, 'scripts', 'register.js'), ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, FAKE_CALLS: calls, ...extraEnv }, timeout: 30_000 });
  const readCalls = () => fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean);
  const resetCalls = () => fs.writeFileSync(calls, '');
  return { root, go, readCalls, resetCalls };
}

test('register: parseRegisterArgs 认 --restart；regUrl 按 domain 选端点', () => {
  assert.equal(parseRegisterArgs(['--no-wait', '--restart']).restart, true);
  assert.equal(parseRegisterArgs(['--no-wait']).restart, false);
  assert.equal(regUrl('lark'), 'https://accounts.larksuite.com/oauth/v1/app/registration');
  assert.equal(regUrl('feishu'), 'https://accounts.feishu.cn/oauth/v1/app/registration');
  assert.equal(regUrl(undefined), 'https://accounts.feishu.cn/oauth/v1/app/registration');
});

test('register e2e: 连跑两次 --no-wait，第二次不发请求、给出同一条链接；--restart 才重新 begin', { skip }, () => {
  const { root, go, readCalls, resetCalls } = makeRoot();
  const r1 = go(['--no-wait']);
  assert.equal(r1.status, 2, r1.stdout + r1.stderr);
  const url1 = (r1.stdout.match(/https:\/\/example\.invalid\/\S+/) ?? [])[0];
  assert.ok(url1, r1.stdout);
  assert.equal(readCalls().filter((c) => c.startsWith('begin')).length, 1);
  const dc1 = loadPending(root).rec.device_code;

  resetCalls();
  const r2 = go(['--no-wait']);
  assert.equal(r2.status, 2, r2.stdout + r2.stderr);
  assert.deepEqual(readCalls(), [], '有效 pending 时不发任何请求');
  assert.ok(r2.stdout.includes(url1), '重新打印第一次的链接');
  assert.match(r2.stdout, /--resume/);
  assert.match(r2.stdout, /--restart/);
  assert.match(r2.stdout, /\d+ 秒/);
  assert.equal(loadPending(root).rec.device_code, dc1, 'pending 没被覆盖');

  // 无 TTY 不带参数同样按 start 处理，也不能重新 begin
  resetCalls();
  const r3 = go([]);
  assert.equal(r3.status, 2);
  assert.deepEqual(readCalls(), []);

  resetCalls();
  const r4 = go(['--no-wait', '--restart']);
  assert.equal(r4.status, 2, r4.stdout + r4.stderr);
  assert.equal(readCalls().filter((c) => c.startsWith('begin')).length, 1, '--restart 重新 begin');
  assert.notEqual(loadPending(root).rec.device_code, dc1);
  assert.ok(!r4.stdout.includes(url1));
});

test('register e2e: 过期的 pending 不拦，直接重新 begin', { skip }, () => {
  const { root, go, readCalls } = makeRoot();
  savePending(root, { deviceCode: 'old', expireIn: 1, url: 'https://example.invalid/old' }, Date.now() - 10_000);
  const r = go(['--no-wait']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(readCalls().filter((c) => c.startsWith('begin')).length, 1);
  assert.ok(!r.stdout.includes('/old'));
});

test('register e2e: --resume 成功 → .env 仍是 600、凭据写入、输出里没有 Secret；端点用 pending 里的 domain', { skip }, () => {
  const { root, go, readCalls } = makeRoot();
  savePending(root, { deviceCode: 'DEVX', interval: 1, expireIn: 600, url: 'https://example.invalid/qr', domain: 'lark' });
  // 当前环境是飞书，pending 是 lark：轮询必须打到 lark 的端点
  const r = go(['--resume', '--timeout', '10'], { FAKE_POLL: 'done', FEISHU_DOMAIN: 'feishu' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET), '输出里不能有 Secret');
  const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
  assert.match(env, /^FEISHU_APP_ID=cli_fakeapp123$/m);
  assert.match(env, /^OWNER_OPEN_ID=ou_fakeowner999$/m);
  assert.ok(env.includes(`FEISHU_APP_SECRET=${SECRET}`));
  assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600, '.env 必须保持 600');
  const polls = readCalls().filter((c) => c.startsWith('poll'));
  assert.ok(polls.length >= 1);
  for (const c of polls) assert.equal(c, 'poll accounts.larksuite.com');
  assert.match(r.stdout, /open\.larksuite\.com/, '后台地址也按 pending 的 domain');
  assert.equal(fs.existsSync(path.join(root, 'data', 'register-pending.json')), false);
});

test('register e2e: 已有 .env（644）时成功写入后也收紧到 600', { skip }, () => {
  const { root, go } = makeRoot();
  fs.writeFileSync(path.join(root, '.env'), 'FEISHU_APP_ID=\nFEISHU_APP_SECRET=\n', { mode: 0o644 });
  fs.chmodSync(path.join(root, '.env'), 0o644);
  savePending(root, { deviceCode: 'DEVY', interval: 1, expireIn: 600, url: 'https://example.invalid/qr' });
  const r = go(['--resume', '--timeout', '10'], { FAKE_POLL: 'done' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600);
});
