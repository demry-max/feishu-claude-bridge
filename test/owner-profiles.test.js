// BRIDGE-PERM-1：OWNER_TOOL_PROFILE=legacy|audit|strict 下 owner/定时/心跳/访客的 claude CLI 参数，
// 以及确认通道、技能同步、审计采集（假 claude CLI 端到端）。
// legacy 的 argv 对照 test/fixtures/owner-args-perm-legacy.json——该夹具在基线 8a75262 上生成，未经本卡代码。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
// 所有 src 模块都在下面动态导入：环境变量必须先于模块加载设好（claude.js/store.js 在加载时读取）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-prof-'));
const ws = path.join(TMP, 'ws');
const gws = path.join(TMP, 'gws');
const data = path.join(TMP, 'data');
const home = path.join(TMP, 'home');
for (const d of [ws, gws, data, home]) fs.mkdirSync(d, { recursive: true });
process.env.WORKSPACE_DIR = ws;
process.env.GUEST_WORKSPACE_DIR = gws;
process.env.DATA_DIR = data;
process.env.HOME = home; // os.homedir() 跟随 HOME：ias-ops 规则与 ~/.claude/skills 都落在临时目录
const FAKE = path.join(TMP, 'fake-claude.sh');
fs.writeFileSync(FAKE, '#!/bin/sh\ncat > /dev/null\ncat "$FAKE_STREAM"\n', { mode: 0o755 });
process.env.CLAUDE_BIN = FAKE;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'owner-args-perm-legacy.json'), 'utf8'));
const { larkRules, LARK_POLICY } = await import('../src/tool-policy.js');

// 与夹具生成脚本完全相同的基准环境与用例
const BASE = {
  CLAUDE_MODEL: 'claude-test-chat', CLAUDE_EFFORT: 'high',
  CLAUDE_EXEC_MODEL: undefined, CLAUDE_EXEC_EFFORT: undefined,
  ALLOWED_TOOLS: undefined, LARK_CLI: undefined, NON_OWNER_TOOLS: undefined,
  GUEST_TOOLS: undefined, GUEST_DENIED_TOOLS: undefined, FEISHU_TOOLS: undefined,
  FEISHU_APP_ID: 'cli_test_app', FEISHU_APP_SECRET: 'test-app-secret', FEISHU_DOMAIN: undefined,
  OWNER_TOOL_PROFILE: undefined, OWNER_EXTRA_SKILLS: undefined, TOOL_AUDIT_SUMMARY_AT: undefined,
  // BRIDGE-PUB-1：strict 拒写的 owner 目录改成配置；这里设回原先写死的那个目录，下面 IAS 的断言保持不变
  OWNER_STRICT_DENY_WRITE_DIRS: path.join(home, 'code', 'ias-ops'),
};
const CASES = {
  ownerChat: { env: {}, call: ['oc_x', true, [], { lane: 'chat', resumeId: 'sess-1' }] },
  ownerChatNoFeishu: { env: { FEISHU_TOOLS: 'false' }, call: ['oc_x', true, [], { lane: 'chat', resumeId: 'sess-1' }] },
  ownerExecLark: {
    env: { LARK_CLI: 'true', CLAUDE_EXEC_MODEL: 'claude-test-exec' },
    call: ['oc_x', true, ['Read(./incoming/**)'], { lane: 'exec', resumeId: 'sess-1' }],
  },
  schedJob: {
    env: { LARK_CLI: 'true', CLAUDE_EXEC_MODEL: 'claude-test-exec' },
    call: ['sched:daily.json', true, [], { model: 'claude-test-sched', effort: 'low', toolProfile: 'sched' }],
  },
  schedDiag: {
    env: { LARK_CLI: 'true', CLAUDE_EXEC_MODEL: 'claude-test-exec' },
    call: ['sched-diag:daily.json', true, [], { model: 'claude-test-diag', effort: 'low' }],
  },
  heartbeat: {
    env: { LARK_CLI: 'true', CLAUDE_EXEC_MODEL: 'claude-test-exec' },
    call: ['sched:heartbeat', true, [], { toolProfile: 'heartbeat', model: 'claude-test-hb', effort: 'low' }],
  },
  guest: { env: { LARK_CLI: 'true' }, call: ['guest:oc_g:ou_y', false, [], {}] },
  guestFile: { env: { LARK_CLI: 'true' }, call: ['guest:oc_g:ou_y', false, ['Read(./incoming/**)'], {}] },
};

function setEnv(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
let seq = 0;
async function load(env = {}) {
  setEnv({ ...BASE, ...env });
  return import(`../src/claude.js?op=${++seq}`);
}

function snap(r) {
  const norm = (s) => String(s).split(ws).join('<workspace>').split(gws).join('<guest-workspace>').split(REPO).join('<repo>');
  const i = r.args.indexOf('--mcp-config');
  let mcp = null;
  if (i >= 0) {
    const cfg = JSON.parse(fs.readFileSync(r.args[i + 1], 'utf8'));
    const f = cfg.mcpServers.feishu;
    mcp = {
      servers: Object.keys(cfg.mcpServers), type: f.type,
      command: f.command === process.execPath ? '<node>' : norm(f.command),
      args: f.args.map(norm), envKeys: Object.keys(f.env),
    };
  }
  r.cleanup();
  return {
    args: r.args.map((a, k) => (r.args[k - 1] === '--mcp-config' ? '<mcp-config>' : norm(a))),
    cwd: norm(r.cwd), model: r.model, effort: r.effort, lane: r.lane, mcp,
  };
}
const fixtureOf = (name) => {
  const { env, call, ...rest } = FIXTURE.cases[name];
  return rest;
};
const val = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (args, flag) => (val(args, flag) ?? '').split(',').filter(Boolean);
function inspect(r) {
  // 读出 MCP 配置后立即清理临时文件（与生产一样 0600、可幂等删除）
  const file = val(r.args, '--mcp-config');
  const out = { args: r.args, mcp: null, mode: null };
  if (file) {
    out.mcp = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.feishu;
    out.mode = fs.statSync(file).mode & 0o777;
  }
  r.cleanup();
  r.cleanup();
  return out;
}
const prefixRules = (e) => ['', '--as user ', '--as bot ']
  .map((p) => `Bash(lark-cli ${p}${[e.domain, e.cmd, e.method].filter(Boolean).join(' ')}:*)`);
const rulesOfClass = (...cls) => LARK_POLICY.filter((e) => cls.includes(e.class)).flatMap(prefixRules);

const STRICT_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash,WebSearch,ToolSearch,Skill';
// BRIDGE-PERM-2 Q1-B：strict 对话不再放行 Edit(./skills/**)（技能提权路）
const CHAT_BASE = ['Read', 'Grep', 'Glob', 'WebSearch', 'Edit(./memory/**)', 'Edit(./schedules/**)',
  'Edit(./outbox/**)', 'Edit(./tasks/**)'];
const ACCOUNT = ['Artifact', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'PushNotification', 'SendMessage',
  'Workflow', 'ListAgents', 'ScheduleWakeup', 'DesignSync', 'Monitor', 'EnterWorktree', 'ExitWorktree', 'NotebookEdit', 'Agent', 'Task'];
const IAS = `Edit(//${home.replace(/^\/+/, '')}/code/ias-ops/**)`;
const COMMON_DENY = [...ACCOUNT, 'WebFetch', 'Bash(lark-cli api:*)', 'Bash(lark-cli auth logout:*)', 'Bash(codex:*)',
  'Bash(nohup:*)', 'Bash(npx:*)', IAS, 'Edit(./CLAUDE.md)', 'Edit(./.claude/**)'];
const SCHED_DENY = ['Edit(./schedules/**)', 'Edit(./tasks/**)', 'Edit(./skills/**)'];
const MCP_SCHED = ['doc_read', 'sheet_read', 'bitable_tables', 'bitable_fields', 'bitable_records', 'mail_attachment_download']
  .map((t) => `mcp__feishu__${t}`);
const HOOK = path.join(REPO, 'src', 'hooks', 'untrusted-note.js');
const sorted = (a) => [...a].sort();

function assertHook(args) {
  const s = JSON.parse(val(args, '--settings'));
  const post = s.hooks.PostToolUse;
  assert.equal(post.length, 1);
  assert.equal(post[0].matcher, 'Bash');
  assert.equal(post[0].hooks.length, 1);
  assert.equal(post[0].hooks[0].type, 'command');
  assert.ok(post[0].hooks[0].command.includes(HOOK), post[0].hooks[0].command);
  assert.equal(post[0].hooks[0].timeout, 2);
}
function assertIsolated(args) {
  assert.equal(val(args, '--setting-sources'), 'project');
  assert.ok(args.includes('--strict-mcp-config'));
}

// ---------- 测 1：legacy 回归 ----------
test('测1 legacy：未设/legacy/非法值时 owner 对话、执行、定时等 argv 与基线夹具逐字一致', async () => {
  for (const profile of [undefined, 'legacy', 'bogus']) {
    const errs = [];
    const orig = console.error;
    console.error = (...a) => { errs.push(a.map(String).join(' ')); };
    let m;
    try { m = await load({ OWNER_TOOL_PROFILE: profile }); } finally { console.error = orig; }
    assert.equal(m.OWNER_TOOL_PROFILE, 'legacy', String(profile));
    assert.equal(errs.filter((l) => l.includes('OWNER_TOOL_PROFILE')).length, profile === 'bogus' ? 1 : 0, '非法值只记一行日志');
    for (const [name, c] of Object.entries(CASES)) {
      const mm = await load({ ...c.env, OWNER_TOOL_PROFILE: profile });
      const got = snap(mm.buildClaudeArgs(...structuredClone(c.call)));
      assert.deepEqual(got, fixtureOf(name), `${profile}/${name}`);
      // 心跳的基线 argv 本就带 --settings/--setting-sources ''（上面已与夹具逐字比对），这里只查走 owner 档分派的用例
      if (c.call[1] === true && c.call[3]?.toolProfile !== 'heartbeat') {
        assert.ok(!got.args.includes('--settings'), name);
        assert.ok(!got.args.includes('--setting-sources'), name);
        assert.ok(!got.args.includes('--strict-mcp-config'), name);
      }
      if (got.mcp) assert.ok(!got.mcp.envKeys.includes('FEISHU_MCP_FENCE'), name);
    }
  }
});

// ---------- 测 2：audit ----------
test('测2 audit：隔离用户设置、lark-cli 全放行（不看 LARK_CLI）、不加 --tools/--disallowedTools、挂 PostToolUse 钩子', async () => {
  for (const lark of [undefined, 'false', 'true']) {
    const m = await load({ OWNER_TOOL_PROFILE: 'audit', LARK_CLI: lark });
    assert.equal(m.OWNER_TOOL_PROFILE, 'audit');
    const chat = inspect(m.buildClaudeArgs('oc_x', true, ['Read(./incoming/**)'], { lane: 'chat', resumeId: 'sess-1' }));
    const sched = inspect(m.buildClaudeArgs('sched:daily.json', true, [], { model: 'claude-test-sched', effort: 'low', toolProfile: 'sched' }));
    for (const r of [chat, sched]) {
      assertIsolated(r.args);
      const allowed = list(r.args, '--allowedTools');
      for (const t of ['Bash(lark-cli:*)', 'Bash(lark-cli)', 'mcp__feishu', 'Read', 'Edit(./memory/**)']) assert.ok(allowed.includes(t), `${lark}:${t}`);
      assert.ok(!r.args.includes('--tools'));
      assert.ok(!r.args.includes('--disallowedTools'));
      assertHook(r.args);
      assert.equal(r.mcp.env.FEISHU_MCP_FENCE, '1');
      assert.equal(r.mode, 0o600);
      assert.ok(r.args.includes('--mcp-config'));
      const sp = val(r.args, '--append-system-prompt');
      assert.match(sp, /audit/);
      assert.match(sp, /全局参数写在子命令后面/);
    }
    assert.ok(list(chat.args, '--allowedTools').includes('Read(./incoming/**)'));
    // 对话与定时的工具参数相同（只有模型/档位/会话/提示词不同）
    assert.deepEqual(list(sched.args, '--allowedTools'), list(chat.args, '--allowedTools').filter((t) => t !== 'Read(./incoming/**)'));
    assert.equal(val(chat.args, '--resume'), 'sess-1');
    assert.equal(val(sched.args, '--resume'), undefined);
    assert.equal(val(sched.args, '--model'), 'claude-test-sched');
  }
  // ALLOWED_TOOLS 在 audit 下仍生效
  const m = await load({ OWNER_TOOL_PROFILE: 'audit', ALLOWED_TOOLS: 'Read,Grep' });
  const r = inspect(m.buildClaudeArgs('oc_x', true, [], { lane: 'chat' }));
  assert.deepEqual(list(r.args, '--allowedTools'), ['Read', 'Grep', 'Bash(lark-cli:*)', 'Bash(lark-cli)', 'mcp__feishu']);
  const nf = await load({ OWNER_TOOL_PROFILE: 'audit', FEISHU_TOOLS: 'false' });
  const r2 = inspect(nf.buildClaudeArgs('oc_x', true, [], { lane: 'chat' }));
  assert.ok(r2.args.includes('--strict-mcp-config'));
  assert.ok(!r2.args.includes('--mcp-config'));
  assert.ok(!list(r2.args, '--allowedTools').includes('mcp__feishu'));
});

// ---------- 测 3：strict 对话 ----------
test('测3 strict 对话：9 个内置工具、lark 按子命令放行（无确认级）、禁掉 WebFetch/codex/nohup/ias-ops；忽略 ALLOWED_TOOLS 与 LARK_CLI', async () => {
  const m = await load({ OWNER_TOOL_PROFILE: 'strict', ALLOWED_TOOLS: 'Bash,WebFetch', LARK_CLI: 'true' });
  assert.equal(m.OWNER_TOOL_PROFILE, 'strict');
  const r = inspect(m.buildClaudeArgs('oc_x', true, [], { lane: 'chat', resumeId: 'sess-1' }));
  assertIsolated(r.args);
  assert.equal(val(r.args, '--tools'), STRICT_TOOLS);
  const allowed = list(r.args, '--allowedTools');
  assert.deepEqual(sorted(allowed), sorted([...CHAT_BASE, ...larkRules('chat'), 'mcp__feishu']));
  // Q1-B：技能写入路（Edit/Write(./skills/**)）不在对话白名单里
  for (const t of ['Bash(lark-cli:*)', 'Bash(lark-cli)', 'Bash', 'WebFetch', 'Edit(./skills/**)', 'Write(./skills/**)']) assert.ok(!allowed.includes(t), t);
  assert.ok(allowed.includes('Bash(lark-cli im +messages-send:*)'));
  assert.ok(allowed.includes('Bash(lark-cli --as user im +messages-send:*)'));
  for (const rule of rulesOfClass('confirm', 'deny')) assert.ok(!allowed.includes(rule), rule);
  const deny = list(r.args, '--disallowedTools');
  assert.deepEqual(sorted(deny), sorted(COMMON_DENY));
  for (const t of ['WebFetch', 'Bash(codex:*)', 'Bash(nohup:*)', IAS]) assert.ok(deny.includes(t), t);
  assert.ok(IAS.startsWith('Edit(//') && IAS.includes(path.join(home, 'code', 'ias-ops').slice(1)));
  for (const t of SCHED_DENY) assert.ok(!deny.includes(t), `对话不该禁 ${t}`);
  assertHook(r.args);
  assert.equal(r.mcp.env.FEISHU_MCP_FENCE, '1');
  assert.deepEqual(Object.keys(r.mcp.env).sort(), ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DOMAIN', 'FEISHU_MCP_FENCE']);
  assert.equal(r.mode, 0o600);
  assert.ok(!r.args.some((a) => a.includes('test-app-secret')), '凭据不进 argv');
  assert.equal(val(r.args, '--resume'), 'sess-1');
  assert.equal(val(r.args, '--model'), 'claude-test-chat');
  const sp = val(r.args, '--append-system-prompt');
  assert.match(sp, /strict/);
  assert.match(sp, /「确认」/);
  assert.match(sp, /全局参数写在子命令后面/);
  // 附件只读规则照常追加
  const withFile = inspect(m.buildClaudeArgs('oc_x', true, ['Read(./incoming/**)'], { lane: 'chat' }));
  assert.ok(list(withFile.args, '--allowedTools').includes('Read(./incoming/**)'));
  // 执行车道只换模型，不换权限
  const ex = await load({ OWNER_TOOL_PROFILE: 'strict', CLAUDE_EXEC_MODEL: 'claude-test-exec' });
  const e = inspect(ex.buildClaudeArgs('oc_x', true, [], { lane: 'exec' }));
  assert.equal(val(e.args, '--model'), 'claude-test-exec');
  assert.deepEqual(sorted(list(e.args, '--allowedTools')), sorted(allowed));
  // FEISHU_TOOLS=false：不带 MCP，但仍 --strict-mcp-config
  const nf = await load({ OWNER_TOOL_PROFILE: 'strict', FEISHU_TOOLS: 'false' });
  const n = inspect(nf.buildClaudeArgs('oc_x', true, [], { lane: 'chat' }));
  assert.ok(n.args.includes('--strict-mcp-config'));
  assert.ok(!n.args.includes('--mcp-config'));
  assert.ok(!list(n.args, '--allowedTools').some((t) => t.startsWith('mcp__')));
});

// ---------- 测 4：strict 定时 ----------
test('测4 strict 定时：只读 lark + memory/outbox 写；禁 schedules/tasks/skills；MCP 只 6 个读工具；任务字段改不动 argv', async () => {
  const m = await load({ OWNER_TOOL_PROFILE: 'strict', LARK_CLI: 'true', CLAUDE_EXEC_MODEL: 'claude-test-exec' });
  const call = ['sched:daily.json', true, [], { model: 'claude-test-sched', effort: 'low', toolProfile: 'sched' }];
  const r = inspect(m.buildClaudeArgs(...structuredClone(call)));
  assertIsolated(r.args);
  assert.equal(val(r.args, '--tools'), STRICT_TOOLS);
  const allowed = list(r.args, '--allowedTools');
  assert.deepEqual(sorted(allowed), sorted(['Edit(./memory/**)', 'Edit(./outbox/**)', ...larkRules('sched'), ...MCP_SCHED]));
  for (const rule of rulesOfClass('write', 'confirm', 'chat-only', 'deny')) assert.ok(!allowed.includes(rule), rule);
  assert.ok(!allowed.includes('mcp__feishu'));
  assert.deepEqual(sorted(allowed.filter((t) => t.startsWith('mcp__'))), sorted(MCP_SCHED));
  const deny = list(r.args, '--disallowedTools');
  for (const t of [...COMMON_DENY, ...SCHED_DENY]) assert.ok(deny.includes(t), t);
  for (const t of ['Bash(lark-cli im +messages-send:*)', 'Bash(lark-cli --as user im +messages-send:*)',
    'mcp__feishu__doc_append', 'mcp__feishu__sheet_write']) assert.ok(deny.includes(t), `定时纵深拒绝 ${t}`);
  for (const t of allowed) assert.ok(!deny.includes(t), `同一条既放行又拒绝：${t}`);
  assert.equal(val(r.args, '--model'), 'claude-test-sched');
  assert.equal(val(r.args, '--resume'), undefined);
  assert.match(val(r.args, '--append-system-prompt'), /只读/);
  assertHook(r.args);
  // 任务文件里的字段（以及 confirm/附件规则）都改不动定时的 argv
  const base = snap(m.buildClaudeArgs(...structuredClone(call)));
  for (const extra of [{ tools: 'owner' }, { profile: 'chat' }, { confirm: true }, { lane: 'chat' }]) {
    const c = structuredClone(call);
    Object.assign(c[3], extra);
    assert.deepEqual(snap(m.buildClaudeArgs(...c)), base, JSON.stringify(extra));
  }
  const c2 = structuredClone(call);
  c2[2] = ['Read(./incoming/**)'];
  assert.deepEqual(snap(m.buildClaudeArgs(...c2)), base, '定时忽略附加规则');
  // 不带 toolProfile、只靠 sched: 前缀也按定时处理
  const noProf = inspect(m.buildClaudeArgs('sched:daily.json', true, [], { model: 'claude-test-sched' }));
  assert.deepEqual(sorted(list(noProf.args, '--allowedTools')), sorted(allowed));
  // onFire 只带固定的 toolProfile:'sched'，不读任务文件的任何权限字段
  const src = fs.readFileSync(path.join(REPO, 'src', 'index.js'), 'utf8');
  assert.match(src, /\{ model: job\.model, effort: job\.effort, toolProfile: 'sched' \}/);
  assert.ok(!/job\.(tools|profile|toolProfile)\b/.test(src));
});

// ---------- 测 5：确认通道 ----------
test('测5 确认通道：strict 私聊「确认 发吧」本轮加确认级规则，下一轮没有；群/定时/心跳不加；legacy、audit 不变', async () => {
  const confirmRules = larkRules('chat', { confirm: true }).filter((r) => !larkRules('chat').includes(r));
  assert.ok(confirmRules.length >= 45);
  const m = await load({ OWNER_TOOL_PROFILE: 'strict' });
  const turn = async (text, chatType, isOwner = true) => {
    const calls = [];
    const t = m.createToolTurn({
      profile: m.OWNER_TOOL_PROFILE, isOwner, chatType, prompt: text,
      confirm: m.detectConfirm(text, chatType, isOwner),
      runClaude: async (...a) => { calls.push(a); return 'ok'; }, redact: (s) => s,
    });
    await t.runClaude(isOwner ? 'oc_x' : 'guest:oc_g:ou_y', t.prompt, isOwner, [], null, { lane: 'chat' });
    return { prompt: t.prompt, opts: calls[0][5], passed: calls[0][1] };
  };
  const t1 = await turn('确认 发吧', 'p2p');
  assert.equal(t1.prompt, '发吧');
  assert.equal(t1.passed, '发吧');
  assert.equal(t1.opts.confirm, true);
  assert.equal(t1.opts.lane, 'chat');
  const r1 = inspect(m.buildClaudeArgs('oc_x', true, [], t1.opts));
  const a1 = list(r1.args, '--allowedTools');
  for (const rule of confirmRules) assert.ok(a1.includes(rule), rule);
  assert.match(val(r1.args, '--append-system-prompt'), /已回复「确认」/);
  for (const rule of rulesOfClass('deny')) assert.ok(!a1.includes(rule), rule);
  // 下一轮（普通消息）失效
  const t2 = await turn('好的，再看下日程', 'p2p');
  assert.notEqual(t2.opts.confirm, true);
  const a2 = list(inspect(m.buildClaudeArgs('oc_x', true, [], t2.opts)).args, '--allowedTools');
  for (const rule of confirmRules) assert.ok(!a2.includes(rule), rule);
  // 群聊里 owner 说「确认」不算
  const g = await turn('确认 发吧', 'group');
  assert.equal(g.prompt, '确认 发吧');
  assert.notEqual(g.opts.confirm, true);
  // 非 owner：原样透传
  const guestTurn = m.createToolTurn({ profile: 'strict', isOwner: false, chatType: 'p2p', prompt: '确认', confirm: m.detectConfirm('确认', 'p2p', false), runClaude: m.runClaude, redact: (s) => s });
  assert.equal(guestTurn.runClaude, m.runClaude);
  assert.equal(guestTurn.prompt, '确认');
  // 定时、心跳：opts 里硬塞 confirm 也不加
  const s = list(inspect(m.buildClaudeArgs('sched:daily.json', true, [], { toolProfile: 'sched', confirm: true })).args, '--allowedTools');
  for (const rule of confirmRules) assert.ok(!s.includes(rule), rule);
  const hb = snap(m.buildClaudeArgs('sched:heartbeat', true, [], { toolProfile: 'heartbeat', model: 'claude-test-hb', effort: 'low', confirm: true }));
  const hbm = await load({ ...CASES.heartbeat.env, OWNER_TOOL_PROFILE: 'strict' });
  assert.deepEqual(snap(hbm.buildClaudeArgs('sched:heartbeat', true, [], { toolProfile: 'heartbeat', model: 'claude-test-hb', effort: 'low', confirm: true })), fixtureOf('heartbeat'));
  assert.ok(!hb.args.some((a) => confirmRules.includes(a)));
  // legacy / audit：确认不改 argv，也不改提示词
  for (const profile of ['legacy', 'audit']) {
    const mm = await load({ OWNER_TOOL_PROFILE: profile });
    const plain = snap(mm.buildClaudeArgs('oc_x', true, [], { lane: 'chat', resumeId: 'sess-1' }));
    const conf = snap(mm.buildClaudeArgs('oc_x', true, [], { lane: 'chat', resumeId: 'sess-1', confirm: true }));
    assert.deepEqual(conf, plain, profile);
    if (profile === 'legacy') assert.deepEqual(plain, fixtureOf('ownerChat'));
    const calls = [];
    const runClaude = async (...a) => { calls.push(a); return 'ok'; };
    const t = mm.createToolTurn({ profile: mm.OWNER_TOOL_PROFILE, isOwner: true, chatType: 'p2p', prompt: '确认 发吧', confirm: mm.detectConfirm('确认 发吧', 'p2p', true), runClaude, redact: (x) => x });
    assert.equal(t.prompt, '确认 发吧', profile);
    const opts = { lane: 'chat' };
    await t.runClaude('oc_x', t.prompt, true, [], null, opts);
    assert.notEqual(calls[0][5].confirm, true, profile);
    if (profile === 'legacy') {
      assert.equal(t.runClaude, runClaude, 'legacy 原样透传 runClaude');
      assert.equal(calls[0][5], opts);
      assert.equal(t.withReceipt('答'), '答');
    }
  }
});

// ---------- 测 14：心跳、访客、sched-diag ----------
test('测14 心跳与访客 argv 三档都不变；sched-diag legacy 等于基线、audit/strict 走无工具档', async () => {
  // 心跳 / 访客：三档 argv 逐字不变
  for (const profile of ['legacy', 'audit', 'strict']) {
    for (const name of ['heartbeat', 'guest', 'guestFile']) {
      const c = CASES[name];
      const m = await load({ ...c.env, OWNER_TOOL_PROFILE: profile });
      assert.deepEqual(snap(m.buildClaudeArgs(...structuredClone(c.call))), fixtureOf(name), `${profile}/${name}`);
    }
  }
  // sched-diag：legacy 逐字等于基线；audit/strict 改走「无任何工具」的自诊断档（BRIDGE-PERM-2 Q2）
  const d = CASES.schedDiag;
  const legacy = await load({ ...d.env, OWNER_TOOL_PROFILE: 'legacy' });
  assert.deepEqual(snap(legacy.buildClaudeArgs(...structuredClone(d.call))), fixtureOf('schedDiag'), 'legacy/schedDiag');
  for (const profile of ['audit', 'strict']) {
    const m = await load({ ...d.env, OWNER_TOOL_PROFILE: profile });
    const r = m.buildClaudeArgs(...structuredClone(d.call));
    const args = r.args;
    r.cleanup();
    assert.equal(r.cwd, ws, `${profile}/schedDiag 在 workspace 里跑`);
    assert.equal(val(args, '--tools'), '', `${profile}/schedDiag 不带任何工具`);
    assert.equal(val(args, '--setting-sources'), '', `${profile}/schedDiag 不读项目设置`);
    assert.ok(args.includes('--strict-mcp-config'), `${profile}/schedDiag --strict-mcp-config`);
    assert.ok(!args.includes('--mcp-config'), `${profile}/schedDiag 不挂 MCP`);
    assert.ok(!args.includes('--allowedTools'), `${profile}/schedDiag 不预批工具`);
    assert.equal(val(args, '--model'), 'claude-test-diag', `${profile}/schedDiag 透传模型`);
    assert.match(val(args, '--append-system-prompt'), /没有任何工具/, `${profile}/schedDiag 系统提示标明无工具`);
  }
});

// ---------- 端到端：假 claude CLI 跑流解析 ----------
const LEAK = 'ZZ_SECRET_MARK';
const STREAM = [
  { type: 'system', subtype: 'init', session_id: 's-e2e' },
  { type: 'assistant', message: { content: [
    { type: 'text', text: '先看看群消息' },
    { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'lark-cli im +chat-messages-list --chat-id oc_leak42 | jq .' } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: `${LEAK} 群里的消息` }] } },
  { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: `lark-cli --as user im +messages-send --chat-id oc_leak42 --text "${LEAK} 明天十点开会"` } },
  ] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: false, content: '{"message_id":"om_leak9"}' }] } },
  { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: `lark-cli api POST /open-apis/${LEAK}` } },
    { type: 'tool_use', id: 'tu4', name: 'WebFetch', input: { url: `https://example.invalid/${LEAK}` } },
    { type: 'tool_use', id: 'tu5', name: 'Read', input: { file_path: `/secret/${LEAK}.md` } },
  ] } },
  { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'tu3', is_error: true, content: `denied ${LEAK}` },
    { type: 'tool_result', tool_use_id: 'tu4', is_error: true, content: 'denied' },
    { type: 'tool_result', tool_use_id: 'tu5', is_error: false, content: LEAK },
  ] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '已发送' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: '已发送', session_id: 's-e2e', permission_denials: [
    { tool_name: 'Bash', tool_use_id: 'tu3', tool_input: { command: `lark-cli api POST /open-apis/${LEAK}` } },
    { tool_name: 'WebFetch', tool_use_id: 'tu4', tool_input: { url: `https://example.invalid/${LEAK}` } },
    { tool_name: 'Bash', tool_use_id: 'tu9', tool_input: { command: 'lark-cli auth logout' } },
  ] },
];
process.env.FAKE_STREAM = path.join(TMP, 'stream.jsonl');
fs.writeFileSync(process.env.FAKE_STREAM, STREAM.map((e) => JSON.stringify(e)).join('\n') + '\n');
const AUDIT = path.join(data, 'tool-audit.jsonl');
const readAudit = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8') : '');
const KEYS = ['cmd', 'decision', 'denied', 'domain', 'kind', 'method', 'tool', 'ts'];

test('测4/7 审计采集（strict 对话 + 定时）：只记 8 个字段、按策略判定、标出被拒、无参数无 chat_id；legacy 什么都不写', async () => {
  fs.rmSync(AUDIT, { force: true });
  const legacy = await load({ OWNER_TOOL_PROFILE: undefined });
  const lev = [];
  assert.equal(await legacy.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat', onToolEvent: (e) => lev.push(e) }), '已发送');
  assert.equal(readAudit(), '', 'legacy 不写审计');
  assert.equal(lev.length, 0, 'legacy 不采集');

  const m = await load({ OWNER_TOOL_PROFILE: 'strict' });
  const ev = [];
  assert.equal(await m.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat', onToolEvent: (e) => ev.push(e) }), '已发送');
  const raw = readAudit();
  assert.ok(!raw.includes(LEAK) && !raw.includes('oc_leak42') && !raw.includes('om_leak9') && !raw.includes('明天'), raw);
  const recs = raw.trim().split('\n').map((l) => JSON.parse(l));
  for (const r of recs) assert.deepEqual(Object.keys(r).sort(), KEYS);
  const pick = (r) => [r.kind, r.tool, r.domain, r.cmd, r.method, r.decision, r.denied];
  assert.deepEqual(recs.map(pick), [
    ['chat', 'Bash', 'im', '+chat-messages-list', null, 'allow', false],
    ['chat', 'Bash', 'im', '+messages-send', null, 'allow', false],
    ['chat', 'Bash', 'api', null, null, 'deny', true],
    ['chat', 'WebFetch', null, null, null, 'deny', true],
    ['chat', 'Read', null, null, null, 'allow', false],
    ['chat', 'Bash', 'auth', 'logout', null, 'deny', true],
  ]);
  for (const r of recs) assert.ok(!Number.isNaN(Date.parse(r.ts)));
  // onToolEvent 拿到的是内存里的原始事件（供回执用），不落盘
  assert.deepEqual(ev.filter((e) => e.phase === 'use').map((e) => e.id), ['tu1', 'tu2', 'tu3', 'tu4', 'tu5']);
  assert.equal(ev.find((e) => e.id === 'tu2' && e.phase === 'use').input.command.includes('明天十点开会'), true);
  assert.deepEqual(ev.filter((e) => e.phase === 'result').map((e) => [e.id, e.isError]),
    [['tu1', false], ['tu2', false], ['tu3', true], ['tu4', true], ['tu5', false]]);
  assert.deepEqual(ev.filter((e) => e.phase === 'denied').map((e) => e.id), ['tu3', 'tu4', 'tu9']);

  fs.rmSync(AUDIT, { force: true });
  assert.equal(await m.runClaude('sched:daily.json', 'x', true, [], null, { model: 'claude-test-sched', effort: 'low', toolProfile: 'sched' }), '已发送');
  const srecs = readAudit().trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(srecs.every((r) => r.kind === 'sched'));
  assert.deepEqual(srecs.slice(0, 2).map(pick), [
    ['sched', 'Bash', 'im', '+chat-messages-list', null, 'allow', false],
    ['sched', 'Bash', 'im', '+messages-send', null, 'deny', false],
  ]);

  // 心跳与 sched-diag 不采集
  fs.rmSync(AUDIT, { force: true });
  await m.runClaude('sched:heartbeat', 'x', true, [], null, { toolProfile: 'heartbeat', model: 'claude-test-hb', effort: 'low' });
  await m.runClaude('sched-diag:daily.json', 'x', true, [], null, { model: 'claude-test-diag', effort: 'low' });
  assert.equal(readAudit(), '');

  // audit 档同样记录（判定按 strict 预演：发消息放行、api 将拒绝）
  const a = await load({ OWNER_TOOL_PROFILE: 'audit' });
  await a.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat' });
  const arecs = readAudit().trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(arecs.map((r) => r.decision), ['allow', 'allow', 'deny', 'deny', 'allow', 'deny']);
  fs.rmSync(AUDIT, { force: true });
});

test('测13 回执端到端：strict 下成功发消息附在回复后（只露尾 4 位 + 前 20 字，经 redact），且不进审计文件', async () => {
  fs.rmSync(AUDIT, { force: true });
  const m = await load({ OWNER_TOOL_PROFILE: 'strict' });
  const t = m.createToolTurn({
    profile: m.OWNER_TOOL_PROFILE, isOwner: true, chatType: 'p2p', prompt: '发一下',
    confirm: m.detectConfirm('发一下', 'p2p', true), runClaude: m.runClaude,
    redact: (s) => String(s).split(LEAK).join('***'),
  });
  const answer = await t.runClaude('oc_x', t.prompt, true, [], null, { lane: 'chat' });
  const out = t.withReceipt(answer);
  assert.equal(out, '已发送\n\n— 本轮以你名义：发消息 1 条（→ …ak42「*** 明天十点开会」）');
  assert.ok(!out.includes('oc_leak42'));
  const raw = readAudit();
  assert.ok(raw.length > 0);
  assert.ok(!raw.includes('本轮以你名义') && !raw.includes('ak42') && !raw.includes('明天'));
  fs.rmSync(AUDIT, { force: true });
});

test('测12 技能同步：OWNER_EXTRA_SKILLS 只复制合法且非符号链接的 lark-*；legacy 什么都不复制', async () => {
  const skills = path.join(home, '.claude', 'skills');
  for (const n of ['lark-im', 'foo', 'lark-real']) {
    fs.mkdirSync(path.join(skills, n), { recursive: true });
    fs.writeFileSync(path.join(skills, n, 'SKILL.md'), `# ${n}\n`);
  }
  fs.mkdirSync(path.join(home, '.claude', 'x'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'x', 'SKILL.md'), '# x\n');
  fs.symlinkSync(path.join(skills, 'lark-real'), path.join(skills, 'lark-link'));
  const dest = path.join(ws, '.claude', 'skills');
  const LIST = 'lark-im,../x,foo,lark-link';

  fs.rmSync(path.join(ws, '.claude'), { recursive: true, force: true });
  const legacy = await load({ OWNER_TOOL_PROFILE: 'legacy', OWNER_EXTRA_SKILLS: LIST });
  await legacy.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat' });
  assert.ok(!fs.existsSync(path.join(dest, 'lark-im')), 'legacy 不复制');

  const errs = [];
  const orig = console.error;
  const m = await load({ OWNER_TOOL_PROFILE: 'strict', OWNER_EXTRA_SKILLS: LIST });
  console.error = (...a) => { errs.push(a.map(String).join(' ')); };
  try { await m.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat' }); } finally { console.error = orig; }
  assert.deepEqual(fs.readdirSync(dest).sort(), ['lark-im']);
  assert.equal(fs.readFileSync(path.join(dest, 'lark-im', 'SKILL.md'), 'utf8'), '# lark-im\n');
  assert.ok(errs.some((l) => l.includes('lark-link')), '符号链接跳过要记日志');
  assert.ok(!fs.existsSync(path.join(ws, '.claude', 'x')));

  // 直接调用：缺失的源跳过、默认清单只含 lark-*
  fs.rmSync(dest, { recursive: true, force: true });
  const copied = m.syncExtraSkills({ home, workspace: ws, list: 'lark-im,lark-missing' });
  assert.deepEqual(copied, ['lark-im']);
  assert.ok(m.DEFAULT_EXTRA_SKILLS.split(',').every((n) => /^lark-[a-z-]{1,40}$/.test(n)));
  assert.equal(m.DEFAULT_EXTRA_SKILLS, 'lark-shared,lark-im,lark-approval,lark-calendar,lark-mail,lark-doc,lark-sheets,lark-drive,lark-contact,lark-whiteboard');
  fs.rmSync(path.join(ws, '.claude'), { recursive: true, force: true });
});

test('接线：index.js 确认判定在 routeTurn 之后、调用保持守卫字面、回执接在回复上、日报定时器在文件末尾', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'index.js'), 'utf8');
  const iRoute = src.indexOf('const route = routeTurn(prompt);');
  const iConfirm = src.indexOf('detectConfirm(prompt, message.chat_type, isOwner)');
  const iGroup = src.indexOf("if (message.chat_type !== 'p2p') {\n    const name = await resolveSenderName");
  assert.ok(iRoute > 0 && iConfirm > iRoute && iGroup > iConfirm, '确认判定夹在 routeTurn 与群名前缀之间');
  const ALIAS = 'const runClaude = toolTurn.runClaude;';
  const iAlias = src.indexOf(ALIAS);
  assert.ok(iAlias > 0 && src.indexOf(ALIAS, iAlias + 1) === -1, '别名行恰好出现一次');
  const lines = src.split('\n');
  const li = lines.findIndex((l) => l.includes(ALIAS));
  assert.equal(lines[li + 1].trim(), 'const answer = await runClaude(sessionKey, prompt, isOwner, extraTools, progress.update, { lane: route.lane });', '别名行的下一行就是调用行');
  assert.ok(iAlias > iConfirm, '别名在确认判定之后');
  assert.match(src, /await reply\(message\.message_id, toolTurn\.withReceipt\(answer \|\| '（Claude 返回了空回复）'\)\);/);
  const iSelf = src.lastIndexOf('scopeSelfCheck().finally(');
  const iTimer = src.lastIndexOf('startToolAuditSummary(');
  assert.ok(iSelf > 0 && iTimer > iSelf, '日报定时器在 scopeSelfCheck().finally(...) 之后');
  const imports = src.split('\n').filter((l) => /^import .* from '\.\/claude\.js';$/.test(l));
  assert.equal(imports.length, 2, 'claude.js 只多一行 import');
});
