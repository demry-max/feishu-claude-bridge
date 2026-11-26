import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CASES, PROFILES, makeHarness, runMatrix, snapCase } from './fixtures/biz-off-matrix.mjs';
import { onCallOf } from './fixtures/biz-on-matrix.mjs';
import { schedDestOf } from '../src/biz-wiring.js';
import { resolveTurn } from '../src/turn-context.js';

const REPO = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/owner-args-brain-on-d9a3da0.json', import.meta.url), 'utf8'));
const H = makeHarness(REPO, 'brain-profiles-');
after(() => fs.rmSync(H.p.tmp, { recursive: true, force: true }));
assert.equal((await import('../src/store.js')).DATA_DIR, H.p.data, 'the test must use isolated fixture data');

const STOP_TEXT = '本轮工具环境异常，已停止';
const INIT_MISMATCH = 'brain_init_mismatch';
const keysOf = (snap) => Object.keys(snap.mcp ? JSON.parse(snap.mcp.text).mcpServers : {});

function assertOnlyBrainAdded(before, after, label) {
  const { mcpServers } = JSON.parse(after.mcp.text);
  assert.deepEqual(Object.keys(mcpServers), [...keysOf(before), 'brain'], label);
  assert.equal(after.mcp.mode, 0o600, label);
  const launch = structuredClone(mcpServers.brain);
  assert.equal(launch.args.at(-2), H.norm(process.execPath), label);
  launch.args[launch.args.length - 2] = '<node>';
  assert.deepEqual(launch, FIXTURE.launch, label);
  assert.ok(after.args.includes('--strict-mcp-config'), label);
  const allowed = after.args.indexOf('--allowedTools') + 1;
  assert.deepEqual(after.args[allowed].split(',').slice(-4), FIXTURE.allowedTools, label);
  const prompt = after.args.indexOf('--append-system-prompt') + 1;
  const promptTail = `\n${FIXTURE.prompt.join('\n')}`;
  assert.ok(after.args[prompt].endsWith(promptTail), label);

  const reverted = structuredClone(after);
  reverted.keys = reverted.keys.filter((key) => key !== 'brainMcpServers');
  reverted.args[allowed] = after.args[allowed].split(',').slice(0, -4).join(',');
  reverted.args[prompt] = after.args[prompt].slice(0, -promptTail.length);
  delete mcpServers.brain;
  if (before.mcp) reverted.mcp.text = JSON.stringify({ mcpServers });
  else {
    reverted.mcp = null;
    reverted.args.splice(reverted.args.indexOf('--mcp-config'), 2);
  }
  assert.equal(JSON.stringify(reverted), JSON.stringify(before), label);
}

test('explicit routing grants Brain only to owner DM and owner-DM schedules', () => {
  for (const profile of Object.keys(PROFILES)) {
    for (const brainOn of [false, true]) {
      const setup = { isOwner: true, profile, brainOn, bizOn: true };
      const eligible = brainOn && profile !== 'legacy';
      for (const [input, expected] of [
        [{ source: 'chat', chatType: 'p2p' }, eligible],
        [{ source: 'chat', chatType: 'p2p', isOwner: false }, false],
        [{ source: 'chat', chatType: 'group' }, false],
        [{ source: 'chat' }, false],
        [{ source: 'unknown', chatType: 'p2p' }, false],
        [{ source: 'heartbeat', chatType: 'p2p', schedDest: 'owner-p2p' }, false],
        [{ source: 'sched', schedDest: 'owner-p2p', ownerDmKnown: true }, eligible],
        [{ source: 'sched', schedDest: 'owner-p2p', ownerDmKnown: false }, false],
        [{ source: 'sched', schedDest: 'other' }, false],
        [{ source: 'sched', ownerDmKnown: false }, false],
        [{ source: 'sched-diag', schedDest: 'owner-p2p' }, false],
        [{ source: 'handoff', chatType: 'p2p' }, false],
        [{ source: 'verifier', chatType: 'p2p' }, false],
      ]) {
        assert.equal(resolveTurn({ ...setup, ...input }).brain, expected, JSON.stringify({ profile, brainOn, input }));
      }
    }
  }
});

test('switch off preserves the complete existing argv matrix and switch on only adds the pinned delta', async () => {
  for (const biz of [undefined, '1']) {
    const disabled = await runMatrix(H, { BMS_TOOL_ENABLED: biz, BRAIN_TOOL_ENABLED: undefined });
    const zero = await runMatrix(H, { BMS_TOOL_ENABLED: biz, BRAIN_TOOL_ENABLED: '0' });
    assert.equal(JSON.stringify(zero), JSON.stringify(disabled));
    const enabled = await runMatrix(H, { BMS_TOOL_ENABLED: biz, BRAIN_TOOL_ENABLED: '1' });
    for (const [profile, before] of Object.entries(disabled)) {
      for (const [name, snap] of Object.entries(before)) {
        const label = `${biz ?? 'no-biz'}/${profile}/${name}`;
        const on = enabled[profile][name];
        if (FIXTURE.profiles.includes(profile) && FIXTURE.ownerDm.includes(name)) assertOnlyBrainAdded(snap, on, label);
        else assert.equal(JSON.stringify(on), JSON.stringify(snap), label);
      }
    }
  }
});

test('explicit owner-DM schedules share the Brain config and other destinations keep identical argv', async () => {
  for (const [profileName, profile] of Object.entries(PROFILES)) {
    for (const biz of [undefined, '1']) {
      for (const name of FIXTURE.scheduledOwnerDm) {
        const env = { ...CASES[name].env, OWNER_TOOL_PROFILE: profile, BMS_TOOL_ENABLED: biz };
        const off = await H.load({ ...env, BRAIN_TOOL_ENABLED: undefined });
        const on = await H.load({ ...env, BRAIN_TOOL_ENABLED: '1' });
        const call = onCallOf(name);
        const before = snapCase(off.buildClaudeArgs(...call), H.norm);
        const launch = on.buildClaudeArgs(...call);
        const config = launch.args.at(-2) === '--mcp-config' ? launch.args.at(-1) : null;
        const after = snapCase(launch, H.norm);
        if (FIXTURE.profiles.includes(profileName)) {
          assertOnlyBrainAdded(before, after, `${profileName}/${name}/${biz}`);
          assert.equal(fs.existsSync(path.dirname(config)), false);
          launch.cleanup();
        } else assert.equal(JSON.stringify(after), JSON.stringify(before));
        call[3].schedDest = 'other';
        assert.equal(JSON.stringify(snapCase(on.buildClaudeArgs(...call), H.norm)),
          JSON.stringify(snapCase(off.buildClaudeArgs(...call), H.norm)));
      }
    }
  }
});

test('handoff, verifier and old calls keep their existing argv with Brain enabled', async () => {
  for (const profile of Object.values(PROFILES)) {
    const off = await H.load({ OWNER_TOOL_PROFILE: profile, BRAIN_TOOL_ENABLED: undefined });
    const on = await H.load({ OWNER_TOOL_PROFILE: profile, BRAIN_TOOL_ENABLED: '1' });
    for (const call of [
      ['oc_x', true, [], { toolProfile: 'handoff', chatType: 'p2p', resumeId: 'sess-handoff' }],
      ['oc_x', true, [], { toolProfile: 'bogus', chatType: 'p2p' }],
      ['verify:task', true, [], { toolProfile: 'verifier', chatType: 'p2p' }],
      ['sched-diag:daily.json', true, [], { schedDest: 'owner-p2p' }],
      ['oc_x', true, []],
    ]) {
      assert.equal(JSON.stringify(snapCase(on.buildClaudeArgs(...call), H.norm)),
        JSON.stringify(snapCase(off.buildClaudeArgs(...call), H.norm)));
    }
  }
});

test('legacy logs one unsupported-profile event while it keeps the switch off for turns', async () => {
  await H.load({ OWNER_TOOL_PROFILE: undefined, BRAIN_TOOL_ENABLED: '1' });
  const logs = [];
  const orig = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const m = await import('../src/claude.js?brain-legacy-warning');
    const args = m.buildClaudeArgs(...CASES.ownerP2p.call);
    const snap = snapCase(args, H.norm);
    assert.deepEqual(keysOf(snap), ['feishu']);
    assert.deepEqual(logs, ['brain_tool_profile_unsupported']);
  } finally {
    console.error = orig;
  }
});

const server = (name, status = 'connected') => ({ name, status });
const init = (mcp_servers) => ({ type: 'system', subtype: 'init', session_id: 'sid-brain-test', mcp_servers });
const result = (text) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'sid-brain-test' });

async function run(events, { biz, feishu = true, switched = '1' } = {}) {
  const m = await H.load({ OWNER_TOOL_PROFILE: 'strict', BRAIN_TOOL_ENABLED: switched, BMS_TOOL_ENABLED: biz,
    FEISHU_TOOLS: feishu ? 'true' : 'false', CLAUDE_MAX_RETRIES: '0' });
  fs.writeFileSync(process.env.FAKE_STREAM, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  const logs = [];
  const orig = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const out = await m.runClaude('oc_brain_test', 'read', true, [], null, { chatType: 'p2p', persistSession: false });
    return { out, logs };
  } catch (error) {
    return { error, logs };
  } finally {
    console.error = orig;
  }
}

test('init rejects extra, missing, duplicate, malformed and absent server lists', async () => {
  for (const [events, extra, missing] of [
    [[init([server('feishu'), server('brain'), server('unexpected-marker')])], 1, 0],
    [[init([server('feishu')])], 0, 1],
    [[init([server('feishu'), server('brain'), server('brain')])], 1, 0],
    [[init([server('feishu'), { diagnostic: 'unexpected-marker' }])], 1, 1],
    [[init({ brain: 'connected' })], 0, 2],
    [[], 0, 2],
  ]) {
    const runResult = await run([...events, result('uncorroborated output')]);
    assert.equal(runResult.out, undefined);
    assert.equal(runResult.error?.code, INIT_MISMATCH);
    assert.equal(runResult.error?.message, STOP_TEXT);
    assert.deepEqual(runResult.logs.filter((line) => line.includes(INIT_MISMATCH)), [`brain_init_mismatch extra=${extra} missing=${missing}`]);
    assert.doesNotMatch(runResult.logs.join('\n'), /unexpected-marker|uncorroborated output/);
  }
});

test('init accepts exact names in any order and an unavailable Brain keeps the turn running', async () => {
  const combinations = [
    [[server('brain', 'failed'), server('feishu')], {}, true],
    [[server('biz'), server('brain'), server('feishu')], { biz: '1' }, false],
    [[server('brain')], { feishu: false }, false],
    [[server('brain'), server('biz')], { feishu: false, biz: '1' }, false],
    [[server('anything')], { switched: '0' }, false],
  ];
  for (const [servers, config, unavailable] of combinations) {
    const current = await run([init(servers), result('safe result')], config);
    assert.equal(current.error, undefined);
    assert.equal(current.out, 'safe result');
    assert.equal(current.logs.includes('brain_unavailable'), unavailable);
  }
});

function indexSlice(source, start, end) {
  const from = source.indexOf(start);
  const until = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && until > from, start);
  return source.slice(from, until + end.length);
}

test('scheduled init mismatch holds the outbox and sends the fixed reply without a diagnosis', async () => {
  const { fireJob } = await import('../src/scheduler.js');
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const wiring = [
    indexSlice(source, 'function schedTurnFor(source, job) {', '\n}\n'),
    indexSlice(source, 'const scheduler = startScheduler({', '\n});'),
  ].join('\n');
  const dm = 'oc_ownerdm0000000001';
  const group = 'oc_group00000000001';
  const sent = [];
  const flushed = [];
  const calls = [];
  const scheduler = new Function('scope', `with (scope) {\n${wiring}\nreturn scheduler;\n}`)({
    resolveTurn, schedDestOf, fireJob, ownerDmChatId: dm, OWNER_TOOL_PROFILE: 'strict', BIZ_ON: false, BRAIN_ON: true,
    BRAIN_INIT_MISMATCH: INIT_MISMATCH, BRAIN_INIT_STOP: STOP_TEXT,
    startScheduler: (options) => options, SCHEDULES_DIR: '', SCHED_STATE_FILE: '', client: {},
    runClaude: async (_key, _prompt, _isOwner, _tools, _progress, { turn }) => {
      calls.push(turn);
      if (turn.brain) throw Object.assign(new Error('unexpected-marker'), { code: INIT_MISMATCH });
      return 'group response';
    },
    handleScheduledFailure: async () => assert.fail('init mismatch must not start a diagnosis'),
    sendToChat: async (...args) => sent.push(args),
    outboxDirFor: (key, privateTurn) => `${key}:${privateTurn}`,
    flushOutbox: async (_client, dir, _send, opts) => { flushed.push([dir, opts]); return { note: 'held-file-marker' }; },
    isQuietAnswer: () => false,
  });

  const job = { _file: 'sample.json', name: '样例', prompt: 'read', chat_id: dm };
  const sendKey = { idempotencyKey: 'sched-fixture' };
  assert.equal(scheduler.turnFor('sched-diag', job).brain, false);
  await scheduler.onFire(job, { sendKey: sendKey.idempotencyKey });
  assert.deepEqual(sent, [[dm, STOP_TEXT, sendKey]]);
  assert.deepEqual(flushed, [['sched:sample.json:true', { mode: 'hold' }]]);
  await scheduler.onFire({ ...job, chat_id: group });
  assert.equal(sent[1][0], group);
  assert.match(sent[1][1], /group response$/);
  assert.deepEqual(calls.map(({ kind, brain }) => [kind, brain]), [['sched-owner-dm', true], ['sched-other', false]]);
});

test('owner audit records fixed Brain tool names without recording input', async () => {
  const name = 'mcp__brain__brain_search';
  const use = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'brain-use', name, input: { query: 'audit-query-marker' } }] } };
  const current = await run([init([server('feishu'), server('brain')]), use, result('safe result')]);
  assert.equal(current.error, undefined);
  const text = fs.readFileSync(path.join(H.p.data, 'tool-audit.jsonl'), 'utf8');
  const audit = JSON.parse(text.trim().split('\n').at(-1));
  assert.deepEqual({ tool: audit.tool, decision: audit.decision, denied: audit.denied }, { tool: name, decision: 'allow', denied: false });
  assert.doesNotMatch(text, /audit-query-marker/);
});
