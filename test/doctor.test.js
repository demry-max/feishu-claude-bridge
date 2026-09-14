// 安装体检 npm run doctor（行为断言）。2026-09-13 安装反馈：全新机器上 9 处要人工介入，
// 其中 OWNER_OPEN_ID 补写、workspace 目录可以全自动；Node/npm/登录/scope 至少要明确提示。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const { checkNode, checkNpm, checkEnvFile, parseAuthStatus } = await import('../src/doctor.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));

describe('单项检查（纯函数）', () => {
  test('Node < 18 判失败并给出免 sudo 的安装命令（按平台）', () => {
    const r = checkNode('v16.20.0', 'darwin', 'arm64');
    assert.equal(r.ok, false);
    assert.match(r.fix, /nodejs\.org\/dist/);
    assert.match(r.fix, /darwin-arm64/);
    assert.ok(!/sudo/.test(r.fix));
    assert.equal(checkNode('v18.0.0', 'darwin', 'arm64').ok, true);
    assert.equal(checkNode('v24.21.0', 'linux', 'x64').ok, true);
  });

  test('npm ≥ 11 时说明 install-scripts 警告是预期的，不是安装失败', () => {
    const r = checkNpm('11.4.0');
    assert.equal(r.ok, true);
    assert.match(r.note, /install-scripts/);
    assert.equal(checkNpm('10.9.0').note, null);
  });

  test('.env 缺必填项时逐项列出', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, '.env'), 'FEISHU_APP_ID=cli_x\nFEISHU_APP_SECRET=\n');
    const r = checkEnvFile(dir);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['FEISHU_APP_SECRET', 'OWNER_OPEN_ID']);
  });

  test('.env 不存在时判失败并提示 register', () => {
    const r = checkEnvFile(tmpDir());
    assert.equal(r.ok, false);
    assert.match(r.fix, /register/);
  });

  test('OWNER_OPEN_ID 为空但 data/owner.json 有值时自动补进 .env', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, '.env'), 'FEISHU_APP_ID=cli_x\nFEISHU_APP_SECRET=s\nOWNER_OPEN_ID=\n');
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data', 'owner.json'), JSON.stringify({ open_id: 'ou_from_json' }));
    const r = checkEnvFile(dir);
    assert.equal(r.ok, true);
    assert.equal(r.autofilled, 'ou_from_json');
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /^OWNER_OPEN_ID=ou_from_json$/m);
  });

  test('claude auth status 的 JSON 能解析出是否登录；非 JSON 视为未知而不是未登录', () => {
    assert.equal(parseAuthStatus('{"loggedIn":true,"email":"a@b"}').loggedIn, true);
    assert.equal(parseAuthStatus('{"loggedIn":false}').loggedIn, false);
    assert.equal(parseAuthStatus('garbage').loggedIn, null);
  });
});

describe('scripts/doctor.js（真跑）', () => {
  test('在本仓库上跑得通，输出含每个检查项，退出码反映结果', () => {
    const r = spawnSync(process.execPath, ['scripts/doctor.js', '--no-network'], { cwd: ROOT, encoding: 'utf8' });
    assert.ok([0, 1].includes(r.status), r.stderr);
    for (const k of ['Node', 'npm', 'claude', '.env', '工作区']) assert.ok(r.stdout.includes(k), `缺检查项 ${k}\n${r.stdout}`);
  });
  test('package.json 暴露 doctor', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts.doctor);
  });
});
