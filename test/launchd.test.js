// 开机自启（行为断言）。2026-09-13 安装反馈 P1：plist 模板要手改 5 处占位符，
// PATH 还硬编码了 Homebrew 路径——而 claude.js 注释里作者自己就踩过「launchd 的 PATH
// 排在前面的是另一份 claude」。已知的坑，模板却没消除它。现在由脚本用 process.execPath、
// 仓库目录和 which claude 的结果生成 plist，不再手改。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { buildPlist, defaultLabel } = await import('../src/launchd.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('buildPlist（纯函数）', () => {
  const base = {
    label: 'com.tester.feishu-claude-bridge',
    node: '/Users/tester/.local/node/bin/node',
    root: '/Users/tester/feishu & claude <bridge>',
    home: '/Users/tester',
    claudeDir: '/Users/tester/.npm-global/bin',
  };

  test('用真实 node 路径与仓库目录，不留占位符', () => {
    const xml = buildPlist(base);
    assert.ok(!/ABSOLUTE|USERNAME/.test(xml), '模板占位符不能残留');
    assert.match(xml, /<string>\/Users\/tester\/\.local\/node\/bin\/node<\/string>\s*<string>src\/index\.js<\/string>/);
    assert.match(xml, /<key>Label<\/key><string>com\.tester\.feishu-claude-bridge<\/string>/);
  });

  test('PATH 把 node 目录与 claude 所在目录排在最前，避免 launchd 用到另一份 claude', () => {
    const xml = buildPlist(base);
    const m = xml.match(/<key>PATH<\/key><string>([^<]+)<\/string>/);
    assert.ok(m, 'plist 里要有 PATH');
    const parts = m[1].split(':');
    assert.equal(parts[0], '/Users/tester/.local/node/bin');
    assert.equal(parts[1], '/Users/tester/.npm-global/bin');
    assert.ok(parts.includes('/usr/bin') && parts.includes('/bin'));
    assert.ok(!parts.includes('/opt/homebrew/bin') || parts.indexOf('/opt/homebrew/bin') > 1, 'Homebrew 不能排在实际安装之前');
  });

  test('路径里的 & < > 做 XML 转义（工作目录含特殊字符时 plist 才解析得了）', () => {
    const xml = buildPlist(base);
    assert.match(xml, /feishu &amp; claude &lt;bridge&gt;/);
    assert.ok(!xml.includes('feishu & claude <bridge>'));
  });

  test('日志落 ~/Library/Logs/<label>.log，RunAtLoad/KeepAlive 开启', () => {
    const xml = buildPlist(base);
    assert.match(xml, /\/Users\/tester\/Library\/Logs\/com\.tester\.feishu-claude-bridge\.log/);
    assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
  });

  test('找不到 claude 时 PATH 仍然合法（不含空段）', () => {
    const xml = buildPlist({ ...base, claudeDir: null });
    const p = xml.match(/<key>PATH<\/key><string>([^<]+)<\/string>/)[1];
    assert.ok(!p.split(':').includes(''), p);
  });

  test('默认 label 带当前用户名，LAUNCHD_LABEL 可覆盖', () => {
    assert.match(defaultLabel({ USER: 'alice' }), /^com\.alice\.feishu-claude-bridge$/);
    assert.equal(defaultLabel({ USER: 'alice', LAUNCHD_LABEL: 'com.x.y' }), 'com.x.y');
    assert.match(defaultLabel({ USER: 'we ird!' }), /^com\.[a-z0-9-]+\.feishu-claude-bridge$/, '用户名要清洗成合法 label');
  });
});

describe('install-service 脚本（真跑 --dry-run）', () => {
  test('--dry-run 打印 plist，用的是当前 node 与本仓库目录，不写 LaunchAgents', () => {
    const r = spawnSync(process.execPath, ['scripts/install-service.js', '--dry-run'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LAUNCHD_LABEL: 'com.dryrun.test' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /<plist/);
    assert.ok(r.stdout.includes(process.execPath), '要用实际运行的 node');
    assert.ok(r.stdout.includes(ROOT.replace(/&/g, '&amp;')), '要用本仓库目录');
    assert.ok(!fs.existsSync(path.join(process.env.HOME, 'Library', 'LaunchAgents', 'com.dryrun.test.plist')));
  });

  test('非 macOS 上明确拒绝并指向 Windows 脚本（源码断言）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'install-service.js'), 'utf8');
    assert.match(src, /darwin/);
    assert.match(src, /install-startup\.ps1/);
  });

  test('package.json 暴露 install-service / uninstall-service', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts['install-service']);
    assert.ok(pkg.scripts['uninstall-service']);
  });
});
