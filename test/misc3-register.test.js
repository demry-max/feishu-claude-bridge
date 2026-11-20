// BRIDGE-MISC-3（V10）：扫码注册拿到凭据后 .env 写不进去：不报成功、不写 owner 文件、不清待取记录、不泄露 / 不另存 Secret。
// 假注册接口（--import 注入假 fetch），不联网；.env 写失败用「.env.tmp 被占成目录」造，不靠 chmod，root 下也成立。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { savePending, loadPending } from '../scripts/lib/register-core.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'FAKESECRET_misc3_4242';
const skip = process.platform === 'win32' ? '临时目录里用软链' : false;

const FAKE_FETCH = `
globalThis.fetch = async (url, init) => {
  const a = new URLSearchParams(init.body).get('action');
  const json = (o) => ({ json: async () => o });
  if (a === 'init') return json({ supported_auth_methods: ['client_secret'] });
  if (a === 'begin') return json({ device_code: 'DEVNEW', verification_uri_complete: 'https://example.invalid/qr', expire_in: 600, interval: 1 });
  if (a === 'poll') return json({ client_id: 'cli_fakeapp123', client_secret: '${SECRET}', user_info: { open_id: 'ou_fakeowner999' } });
  throw new Error('unexpected action ' + a);
};
`;

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'misc3-reg-'));
  fs.cpSync(path.join(REPO, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'src'), path.join(root, 'src'), 'dir');
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(root, '.env.example'), '# 模板\nFEISHU_APP_ID=\nFEISHU_APP_SECRET=\nOWNER_OPEN_ID=\n');
  fs.writeFileSync(path.join(root, '.env'), 'FEISHU_APP_ID=\nFEISHU_APP_SECRET=\n', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'fake-fetch.mjs'), FAKE_FETCH);
  const go = (args) => spawnSync(process.execPath,
    ['--import', path.join(root, 'fake-fetch.mjs'), path.join(root, 'scripts', 'register.js'), ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root }, timeout: 30_000 });
  const breakEnv = () => fs.mkdirSync(path.join(root, '.env.tmp'));
  const fixEnv = () => fs.rmdirSync(path.join(root, '.env.tmp'));
  return { root, go, breakEnv, fixEnv };
}

/** 整个临时根目录（不跟软链、跳过 node_modules / src）里有没有文件含 Secret */
function filesContaining(dir, needle, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'src' || name === 'fake-fetch.mjs') continue; // 假接口夹具本身带着假 Secret
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) filesContaining(p, needle, out);
    else if (fs.readFileSync(p, 'utf8').includes(needle)) out.push(p);
  }
  return out;
}
const pendingFile = (root) => path.join(root, 'data', 'register-pending.json');
const ownerFile = (root) => path.join(root, 'data', 'owner.json');

test('R1 --resume：.env 写不进去 → 退出码 1、不报成功、不泄露 Secret、待取记录与 .env 不动、不写 owner 文件', { skip }, () => {
  const { root, go, breakEnv } = makeRoot();
  savePending(root, { deviceCode: 'DEVKEEP', interval: 1, expireIn: 600, url: 'https://example.invalid/qr' });
  const envBefore = fs.readFileSync(path.join(root, '.env'));
  breakEnv();
  const r = go(['--resume', '--timeout', '10']);
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 1, out);
  assert.ok(!out.includes(SECRET), '输出里不能有 Secret');
  assert.ok(!out.includes('凭据已写入'));
  assert.ok(!out.includes('应用创建成功'));
  assert.ok(!out.includes('已写入 .env'));
  assert.ok(!out.includes('批量导入'), '不打印后续 scope 指引');
  assert.equal(loadPending(root).rec.device_code, 'DEVKEEP', '待取记录仍在、设备码不变');
  assert.ok(fs.readFileSync(path.join(root, '.env')).equals(envBefore), '.env 字节不变');
  assert.equal(fs.existsSync(ownerFile(root)), false);
  assert.deepEqual(filesContaining(root, SECRET), [], '没有任何文件含 Secret');
  assert.match(out, /没有写进 \.env/);
  assert.match(out, /没有打印，也没有另存/);
  assert.match(out, /npm run register -- --resume/);
  assert.match(out, /--no-wait --restart/);
  assert.match(out, /删掉这次多出来的应用/);
});

test('R2 R1 之后修好目录再 --resume：退出码 0、.env 写入且 600、待取记录清掉', { skip }, () => {
  const { root, go, breakEnv, fixEnv } = makeRoot();
  savePending(root, { deviceCode: 'DEVKEEP', interval: 1, expireIn: 600, url: 'https://example.invalid/qr' });
  breakEnv();
  assert.equal(go(['--resume', '--timeout', '10']).status, 1);
  fixEnv();
  const r = go(['--resume', '--timeout', '10']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
  assert.match(env, /^FEISHU_APP_ID=cli_fakeapp123$/m);
  assert.ok(env.includes(`FEISHU_APP_SECRET=${SECRET}`));
  assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(pendingFile(root)), false);
  assert.equal(fs.existsSync(ownerFile(root)), true);
});

test('R3 --wait：等待模式同样失败 → 退出码 1、不含 Secret、不写 owner、没有待取记录、提示重新运行并删多余应用', { skip }, () => {
  const { root, go, breakEnv } = makeRoot();
  breakEnv();
  const r = go(['--wait']);
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 1, out);
  assert.ok(!out.includes(SECRET));
  assert.ok(!out.includes('凭据已写入'));
  assert.equal(fs.existsSync(ownerFile(root)), false);
  assert.equal(fs.existsSync(pendingFile(root)), false, '等待模式不新增待取记录');
  assert.deepEqual(filesContaining(root, SECRET), []);
  assert.match(out, /重新运行 npm run register/);
  assert.match(out, /删掉这次多出来的应用/);
  assert.ok(!/--resume/.test(r.stderr), '等待模式没有待取记录，不指向 --resume');
});
