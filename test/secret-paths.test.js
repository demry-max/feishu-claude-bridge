import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envDenyRules } from '../src/biz-wiring.js';
import { disallowedOf, homeSecretsDeny } from './helpers/strip-secrets-deny.js';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sec-1-'));
const homeA = path.join(sandbox, 'account-a');
const homeB = path.join(sandbox, 'account-b');
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

Object.assign(process.env, {
  DATA_DIR: path.join(sandbox, 'data'),
  WORKSPACE_DIR: path.join(sandbox, 'ws'),
  GUEST_WORKSPACE_DIR: path.join(sandbox, 'guest-ws'),
  FEISHU_TOOLS: 'false',
  LARK_CLI: 'false',
});
delete process.env.OWNER_STRICT_DENY_WRITE_DIRS;

let instance = 0;
function loadClaude({ profile = 'legacy', tools, biz = false } = {}) {
  process.env.OWNER_TOOL_PROFILE = profile;
  process.env.BMS_TOOL_ENABLED = biz ? '1' : '0';
  if (tools === undefined) delete process.env.ALLOWED_TOOLS;
  else process.env.ALLOWED_TOOLS = tools;
  return import(`../src/claude.js?secret-paths=${++instance}`);
}

const oldDeny = (root) => [
  `Read(//${root.replace(/^\/+/, '')}/.env)`,
  `Read(//${root.replace(/^\/+/, '')}/.env.*)`,
  'Bash(security:*)', 'Bash(/usr/bin/security:*)',
];
const expectedFor = (home) => [
  ...oldDeny(repo),
  ...homeSecretsDeny(`//${home.replaceAll(path.sep, '/').replace(/^\/+/, '')}`),
];

function assertDeny(args, expected, label) {
  assert.equal(args.filter((a) => a === '--disallowedTools').length, 1, `${label} 必须只有一份拒绝表`);
  const denied = disallowedOf(args);
  for (const rule of expected) {
    assert.equal(denied.filter((r) => r === rule).length, 1, `${label} 必须恰有一条 ${rule}`);
  }
}

test('三档 owner、访客、心跳、交接与定时的 argv 都继承全部拒绝规则', async (t) => {
  t.mock.method(os, 'homedir', () => homeA);
  const cases = {
    owner: ['oc_owner', true, [], { chatType: 'p2p' }],
    guest: ['guest:oc_group:ou_peer', false, ['Read(./incoming/**)']],
    ownerGroup: ['oc_group', true, [], { chatType: 'group' }],
    heartbeat: ['sched:heartbeat', true, [], { toolProfile: 'heartbeat' }],
    handoff: ['daily-handoff', true, [], { toolProfile: 'handoff', resumeId: 'session' }],
    schedOwner: ['sched:job', true, [], { toolProfile: 'sched', schedDest: 'owner-p2p' }],
    schedOther: ['sched:job', true, [], { toolProfile: 'sched', schedDest: 'other' }],
  };
  const expected = expectedFor(homeA);
  for (const profile of ['legacy', 'audit', 'strict']) {
    for (const biz of [false, true]) {
      const { buildClaudeArgs } = await loadClaude({ profile, biz });
      const calls = profile === 'legacy' ? { ...cases, schedDiag: ['sched-diag:job', true] } : cases;
      for (const [name, call] of Object.entries(calls)) {
        const { args, cleanup } = buildClaudeArgs(...call);
        try {
          assertDeny(args, expected, `${profile}/${name}/biz=${biz}`);
        } finally {
          cleanup();
        }
      }
    }
  }
});

test('不同的运行时 HOME 改变 argv 中的密钥路径，仓库拒绝规则保留', async (t) => {
  const homedir = t.mock.method(os, 'homedir', () => homeA);
  for (const home of [homeA, homeB]) {
    homedir.mock.mockImplementation(() => home);
    const { buildClaudeArgs } = await loadClaude();
    const { args, cleanup } = buildClaudeArgs('oc_owner', true, [], { chatType: 'p2p' });
    try {
      assert.deepEqual(envDenyRules(repo), expectedFor(home));
      assert.deepEqual(disallowedOf(args), expectedFor(home));
    } finally {
      cleanup();
    }
  }
});

test('只读回放的三种 Claude 调用同样拒读密钥', async (t) => {
  t.mock.method(os, 'homedir', () => homeA);
  const { armArgs } = await import('../scripts/daily-session-replay.js');
  for (const kind of ['old', 'handoff', 'new']) {
    assertDeny(armArgs(kind, { session: 'session' }), expectedFor(homeA), `replay/${kind}`);
  }
});

async function startupWarnings(profile, tools) {
  const { warnOwnerBroadBash } = await loadClaude({ profile, tools });
  const warnings = [];
  warnOwnerBroadBash((...args) => warnings.push(args));
  return warnings;
}

test('legacy 与 audit 的宽 Bash 只告警一次并仅记录固定事件码', async () => {
  const broad = [
    'Read,Bash,Bash(cat:*),Glob', 'Read Bash(*) Glob', 'Bash(cat:*)',
    'Bash(/usr/bin/head *)', 'Bash(tail:*)', 'Bash(less:*)', 'Bash(cp:*)',
    'Bash(base64:*)', 'Bash(python*)', 'Bash(python3.12:*)', 'Bash(/opt/bin/node *)',
  ];
  for (const profile of ['legacy', 'audit']) {
    for (const tools of broad) {
      assert.deepEqual(await startupWarnings(profile, tools), [['owner_tools_broad_bash']], `${profile}/${tools}`);
    }
  }
});

test('安全的缺省工具、显式空工具及 strict 忽略的配置均不触发告警', async () => {
  for (const tools of [undefined, '', 'Read(./docs/Bash), Bash(lark-cli:*),Bash(catalog:*)']) {
    assert.deepEqual(await startupWarnings('legacy', tools), []);
    assert.deepEqual(await startupWarnings('audit', tools), []);
  }
  assert.deepEqual(await startupWarnings('strict', 'Read,Bash,Bash(cat:*)'), []);
});
