import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sec2-startup-'));
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
Object.assign(process.env, { DATA_DIR: sandbox, WORKSPACE_DIR: sandbox, FEISHU_TOOLS: 'false' });

let instance = 0;
async function loadWarning(profile, tools) {
  process.env.OWNER_TOOL_PROFILE = profile;
  process.env.ALLOWED_TOOLS = tools;
  return (await import(`../src/claude.js?sec2-startup=${++instance}`)).warnOwnerBroadBash;
}

test('启动配置块实际调用宽 Bash 告警，日志只写事件码', async (t) => {
  const warnOwnerBroadBash = await loadWarning('legacy', 'Bash(cat:*)');
  const warn = t.mock.method(console, 'error', () => {});
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('// 启动时打印真正生效的配置：');
  const end = source.indexOf('// 启动通知放在全部自检之后', start);
  assert.ok(start >= 0 && end > start, '应找到启动配置块');
  runInNewContext(source.slice(start, end), {
    console: { log() {}, error: console.error }, path,
    process: { env: {}, cwd: () => sandbox },
    fs: { readFileSync() { throw new Error('启动测试没有配置文件'); } },
    getRuntimeConfig: () => ({}), checkCliEnvironment: () => ({ bin: 'fake-claude' }),
    verifyFallbackAtStartup() {}, setAccountNotifier() {}, orphanReap: { killed: 0 },
    ownerToolsWarning: () => '', warnOwnerBroadBash,
  });
  assert.deepEqual(warn.mock.calls.map(({ arguments: args }) => args), [['owner_tools_broad_bash']]);
});

test('legacy 和 audit 识别命令及尾通配，strict 仍使用自己的工具表', async () => {
  const rules = [
    'Bash(sh:*)', 'Bash(bash -c:*)', 'Bash(/usr/bin/zsh *)', 'Bash(env:*)',
    'Bash(awk:*)', 'Bash(sed:*)', 'Bash(perl:*)', 'Bash(ruby:*)', 'Bash(xargs:*)',
    'Bash(find:*)', 'Bash(rg:*)', 'Bash(grep:*)', 'Bash(c*)', 'Bash(*cat*)', 'Bash(*)',
  ];
  for (const profile of ['legacy', 'audit', 'strict']) {
    for (const rule of rules) {
      const warn = await loadWarning(profile, `Read,${rule},Bash(lark-cli:*)`);
      const logs = [];
      warn((...args) => logs.push(args));
      const expected = profile === 'strict' ? [] : [['owner_tools_broad_bash']];
      assert.deepEqual(logs, expected, `${profile} ${rule}`);
    }
  }
});
