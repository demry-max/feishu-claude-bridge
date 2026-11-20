// BRIDGE-MISC-1：卸载脚本认对服务（label 读 .env、plist 指向别的目录就拒绝、不存在不发 bootout）。
// 全部用临时 root / 临时 HOME 与假 launchctl，不调真 launchctl。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { planUninstall, applyUninstall } = await import('../scripts/uninstall-service.js');
const { buildPlist, plistPath } = await import('../src/launchd.js');

let root; let home;
beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'uninst-'));
  root = path.join(base, 'bridge'); home = path.join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
});
afterEach(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

const writeEnv = (text) => fs.writeFileSync(path.join(root, '.env'), text);
const writePlist = (label, wd) => {
  const p = plistPath(label, home);
  fs.writeFileSync(p, buildPlist({ label, node: '/usr/bin/node', root: wd, home }));
  return p;
};
const fakes = () => {
  const f = { launchctl: [], unlink: [], logs: [] };
  f.deps = { launchctl: (a) => f.launchctl.push(a), unlink: (p) => f.unlink.push(p), log: (m) => f.logs.push(m), uid: 501 };
  return f;
};

describe('label', () => {
  test('U1 .env 里的 LAUNCHD_LABEL 生效（shell 没设）；shell 显式设置的优先', () => {
    writeEnv('LAUNCHD_LABEL=com.acme.bridge-2\nSECRET_X=hunter2\n');
    const p = planUninstall({ root, home, env: { USER: 'alice' } });
    assert.equal(p.label, 'com.acme.bridge-2');
    assert.equal(p.source, '.env 的 LAUNCHD_LABEL');
    const q = planUninstall({ root, home, env: { USER: 'alice', LAUNCHD_LABEL: 'com.shell.x' } });
    assert.equal(q.label, 'com.shell.x');
    assert.match(q.source, /shell/);
  });

  test('U1b 都没设 → 默认 label', () => {
    const p = planUninstall({ root, home, env: { USER: 'alice' } });
    assert.equal(p.label, 'com.alice.feishu-claude-bridge');
    assert.match(p.source, /默认/);
  });
});

describe('判定与执行', () => {
  test('U2 plist 指向本目录 → remove；bootout 在前、unlink 在后', () => {
    writeEnv('LAUNCHD_LABEL=com.acme.bridge-2\n');
    const target = writePlist('com.acme.bridge-2', root);
    const plan = planUninstall({ root, home, env: {} });
    assert.equal(plan.action, 'remove');
    const f = fakes();
    assert.equal(applyUninstall(plan, f.deps), 0);
    assert.deepEqual(f.launchctl, [['bootout', 'gui/501/com.acme.bridge-2']]);
    assert.deepEqual(f.unlink, [target]);
  });

  test('U3 指向别的目录 → refuse，什么都不调，退出码 1；--force → remove', () => {
    writeEnv('LAUNCHD_LABEL=com.acme.bridge\n');
    writePlist('com.acme.bridge', '/some/other/clone');
    const plan = planUninstall({ root, home, env: {} });
    assert.equal(plan.action, 'refuse');
    assert.match(plan.reason, /这个 label 属于 \/some\/other\/clone；确实要卸载加 --force/);
    const f = fakes();
    assert.equal(applyUninstall(plan, f.deps), 1);
    assert.deepEqual(f.launchctl, []);
    assert.deepEqual(f.unlink, []);
    const forced = planUninstall({ root, home, env: {}, force: true });
    assert.equal(forced.action, 'remove');
    const g = fakes();
    assert.equal(applyUninstall(forced, g.deps), 0);
    assert.equal(g.launchctl.length, 1);
    assert.equal(g.unlink.length, 1);
  });

  test('U4 plist 不存在 → absent，不调 launchctl，提示 label 与来源', () => {
    writeEnv('LAUNCHD_LABEL=com.acme.bridge-2\n');
    const plan = planUninstall({ root, home, env: {} });
    assert.equal(plan.action, 'absent');
    const f = fakes();
    assert.equal(applyUninstall(plan, f.deps), 0);
    assert.deepEqual(f.launchctl, []);
    assert.deepEqual(f.unlink, []);
    const out = f.logs.join('\n');
    assert.ok(out.includes('com.acme.bridge-2') && out.includes('.env'));
    assert.match(out, /未找到/);
  });

  test('U4b 解析不出 WorkingDirectory → refuse；--force 才 remove', () => {
    writeEnv('LAUNCHD_LABEL=com.acme.bridge\n');
    fs.writeFileSync(plistPath('com.acme.bridge', home), '<plist><dict><key>Label</key><string>x</string></dict></plist>');
    assert.equal(planUninstall({ root, home, env: {} }).action, 'refuse');
    assert.equal(planUninstall({ root, home, env: {}, force: true }).action, 'remove');
  });

  test('plist 读不出来（readFile 抛错）→ refuse', () => {
    writePlist('com.x.y', root);
    const plan = planUninstall({ root, home, env: { LAUNCHD_LABEL: 'com.x.y' }, readFile: () => { throw new Error('EACCES'); } });
    assert.equal(plan.action, 'refuse');
  });

  test('A4 输出不含 .env 里 LAUNCHD_LABEL 以外的值', () => {
    writeEnv('LAUNCHD_LABEL=com.acme.bridge\nFEISHU_APP_SECRET=s3cr3t-value\nCLAUDE_CODE_OAUTH_TOKEN=tok-abc\n');
    writePlist('com.acme.bridge', '/other');
    const f = fakes();
    applyUninstall(planUninstall({ root, home, env: {} }), f.deps);
    const g = fakes();
    applyUninstall(planUninstall({ root, home: path.join(home, 'nope'), env: {} }), g.deps);
    const all = [...f.logs, ...g.logs].join('\n');
    assert.ok(!all.includes('s3cr3t-value') && !all.includes('tok-abc'));
  });
});

describe('脚本本身', () => {
  const mac = process.platform === 'darwin';

  test('U5 --dry-run 真跑：打印判定，不删任何文件', { skip: !mac }, () => {
    const label = 'com.test.misc1-dry';
    const target = writePlist(label, '/some/other/clone');
    const run = (args) => spawnSync(process.execPath, ['scripts/uninstall-service.js', ...args], {
      cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: home, LAUNCHD_LABEL: label },
    });
    const r = run(['--dry-run']);
    assert.equal(r.status, 1, r.stderr);   // refuse：退出码与真跑一致
    assert.match(r.stdout, new RegExp(label));
    assert.ok(r.stdout.includes(target));
    assert.match(r.stdout, /refuse/);
    assert.ok(fs.existsSync(target), 'dry-run 不删 plist');
    // 指向本目录：remove，退出码 0，仍不删
    fs.writeFileSync(target, buildPlist({ label, node: '/usr/bin/node', root: REPO, home }));
    const r2 = run(['--dry-run']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /remove/);
    assert.ok(fs.existsSync(target));
    // 不存在：absent
    fs.unlinkSync(target);
    const r3 = run(['--dry-run']);
    assert.equal(r3.status, 0);
    assert.match(r3.stdout, /absent/);
  });

  test('U6 import 不产生副作用（不调 launchctl、不读写 HOME 外的文件）', () => {
    const bin = path.join(path.dirname(root), 'bin'); fs.mkdirSync(bin);
    const marker = path.join(path.dirname(root), 'launchctl-called');
    fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    const before = fs.readdirSync(home, { recursive: true }).sort();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(path.join(REPO, 'scripts/uninstall-service.js'))}); console.log(Object.keys(m).sort().join(','));`], {
      cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'applyUninstall,planUninstall');
    assert.ok(!fs.existsSync(marker), 'import 不能调 launchctl');
    assert.deepEqual(fs.readdirSync(home, { recursive: true }).sort(), before);
  });
});
