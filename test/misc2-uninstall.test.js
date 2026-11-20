// BRIDGE-MISC-2 S03：卸载脚本来源提示与 label 合并口径一致；plist WorkingDirectory 尾斜杠按 path.resolve 归一。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planUninstall } from '../scripts/uninstall-service.js';

const mk = (envText) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'misc2-un-'));
  if (envText !== undefined) fs.writeFileSync(path.join(root, '.env'), envText);
  return root;
};
const xml = (d) => `<plist><dict><key>WorkingDirectory</key><string>${d}</string></dict></plist>`;

test('U1 shell 里 LAUNCHD_LABEL 是空串、.env 有值：label 为默认，来源写默认并提到空串，不写「.env 的 LAUNCHD_LABEL」', () => {
  const root = mk('LAUNCHD_LABEL=com.acme.bridge-2\n');
  const p = planUninstall({ root, home: root, env: { LAUNCHD_LABEL: '' }, exists: () => false });
  assert.match(p.label, /^com\..+\.feishu-claude-bridge$/);
  assert.notEqual(p.label, 'com.acme.bridge-2');
  assert.match(p.source, /默认/);
  assert.match(p.source, /空串/);
  assert.doesNotMatch(p.source, /^\.env 的 LAUNCHD_LABEL/);
  const q = planUninstall({ root, home: root, env: {}, exists: () => false });
  assert.equal(q.label, 'com.acme.bridge-2');
  assert.equal(q.source, '.env 的 LAUNCHD_LABEL');
  const r = planUninstall({ root, home: root, env: { LAUNCHD_LABEL: 'com.shell.x' }, exists: () => false });
  assert.equal(r.source, 'shell 环境变量 LAUNCHD_LABEL');
  fs.rmSync(root, { recursive: true, force: true });
});

test('U1b 两处都没有：来源是默认（不提空串）', () => {
  const root = mk('');
  const p = planUninstall({ root, home: root, env: {}, exists: () => false });
  assert.equal(p.source, '默认（com.<用户名>.feishu-claude-bridge）');
  const q = planUninstall({ root, home: root, env: { LAUNCHD_LABEL: '' }, exists: () => false });
  assert.equal(q.source, '默认（com.<用户名>.feishu-claude-bridge）');
  fs.rmSync(root, { recursive: true, force: true });
});

test('U2 plist WorkingDirectory 带尾斜杠 / ./ 仍算本目录 → remove；另一个目录加尾斜杠 → refuse', () => {
  const root = mk('');
  const plan = (dir) => planUninstall({ root, home: root, env: {}, exists: () => true, readFile: () => xml(dir) });
  assert.equal(plan(`${root}/`).action, 'remove');
  assert.equal(plan(`${root}/./`).action, 'remove');
  assert.equal(plan(root).action, 'remove');
  assert.equal(plan(`${root}-other/`).action, 'refuse');
  fs.rmSync(root, { recursive: true, force: true });
});
