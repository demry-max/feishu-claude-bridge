// BRIDGE-PRIV-2：index.js 的接线（W1–W5）。
// 做法同 turn-wiring.test.js / scheduler-wiring.test.js：把 src/index.js 里真实的代码段切出来，装进 Proxy 注入的作用域执行，依赖全是桩。
// W1 handleMessage 的 /tasks 分支（P9–P11 与 owner 私聊）；W2 startScheduler 的选项；W3 tasksDecision 的忙判定（P6/P15）；
// W4 卡片回调不认 /tasks 按钮（P16）；W5 describeTasks 的确认标记。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { routeTurn } from '../src/lanes.js';
import { detectConfirm } from '../src/tool-policy.js';
import { createToolTurn } from '../src/tool-audit.js';
import { resolveTurn } from '../src/turn-context.js';
import { schedDestOf } from '../src/biz-wiring.js';
import * as mq from '../src/message-queue.js';
import { createShutdown, replyIfDraining } from '../src/shutdown.js';
import { createEventHandlers } from '../src/events.js';
import { tasksCommandReply } from '../src/sched-approval.js';
import { nextFireAt } from '../src/scheduler.js';

const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const OWNER = 'ou_owner';
const GUEST = 'ou_guest';
const DM = 'oc_ownerdm0000000001';
const GROUP = 'oc_group0000000000001';
const FULL_CHAT = 'oc_0123456789abcdef0123';
const settle = async (n = 12) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
const proxyOf = (scope) => new Proxy(scope, { has: (t, k) => typeof k === 'string' && Object.hasOwn(t, k), get: (t, k) => (k === Symbol.unscopables ? undefined : t[k]) });

function cut(start, end, { inclusive = false } = {}) {
  const a = SRC.indexOf(start);
  assert.ok(a >= 0, `index.js 里找不到：${start}`);
  const b = SRC.indexOf(end, a + start.length);
  assert.ok(b > a, `index.js 里找不到 ${start} 之后的：${JSON.stringify(end)}`);
  return SRC.slice(a, inclusive ? b + end.length : b);
}

// ---------- W1 ----------
let w1Factory;
function handleFactory() {
  if (w1Factory) return w1Factory;
  const code = [
    cut('const chatQueues = new Map();', 'async function reply(messageId, text) {'),
    cut('async function react(messageId, emoji) {', '\n}\n', { inclusive: true }),
    cut('async function handleMessage(data', '\nconst eventDispatcher'),
    cut('const shutdown = createShutdown({', '\n});', { inclusive: true }),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  w1Factory = new Function('scope', `with (scope) {\n${code}\nreturn { trackedHandleMessage };\n}`);
  return w1Factory;
}
function bridge() {
  const r = { replies: [], calls: [], decisions: [], described: 0, n: 0 };
  const scope = {
    console: { log() {}, error() {} },
    process: { env: {} },
    createOwnerMessageQueue: mq.createOwnerMessageQueue, messageQueueEnabled: mq.messageQueueEnabled,
    mergeQueuedTurns: mq.mergeQueuedTurns, MERGED_NO_CONFIRM: mq.MERGED_NO_CONFIRM, withClearedNote: mq.withClearedNote,
    routeTurn, detectConfirm, createToolTurn, OWNER_TOOL_PROFILE: 'legacy', resolveTurn, BIZ_ON: false,
    createShutdown: (o) => createShutdown({ ...o, pollMs: 1000, exit: () => {}, now: () => 0, timers: { setTimeout: () => ({}), clearTimeout: () => {} } }),
    shutdownGraceSec: () => 120, replyIfDraining,
    heartbeat: { isInflight: () => false, stop: () => {} },
    HEARTBEAT_KEY: 'sched:heartbeat', VERIFY_KEY: 'sched:verify',
    client: { im: { v1: { messageReaction: { create: async () => ({ code: 0 }) } } } },
    reply: async (mid, text) => { r.replies.push(text); },
    isDuplicate: () => false, getBotOpenId: async () => 'ou_bot', isAllowed: () => true,
    OWNER_OPEN_ID: OWNER, loadOwner: () => OWNER, saveOwner: () => true, ALLOW_USERS: [],
    workspaceFor: (priv) => (priv ? '/tmp/sw-ws' : '/tmp/sw-ws-guest'),
    buildPrompt: async (_c, message) => ({ prompt: message.__text, attachments: [] }),
    describeError: (e) => ({ text: String(e?.message ?? e), hint: '' }),
    heartbeatReplyShortcut: async () => null, privateHeartbeatCommand: () => null,
    sessionInfo: () => 'status', HELP_TEXT: '帮助',
    describeTasks: () => { r.described += 1; return 'DESCRIBE-TASKS'; },
    tasksDecision: (text) => { r.decisions.push(text); return 'TASKS-DECISION'; },
    getRuntimeConfig: () => ({ model: 'm', effort: 'e', execModel: '' }), setRuntimeConfig: () => ({}), checkCliEnvironment: () => null,
    MODEL_ALIASES: {}, EFFORT_LEVELS: [], voiceChats: new Set(),
    resetSession: () => {}, isRunning: () => false, cancelRun: () => false, abortRetries: () => false,
    sessionKeysWithPrefix: () => [], runningKeysWithPrefix: () => [],
    runClaude: async (key, prompt, isOwner) => { r.calls.push({ key, prompt, isOwner }); return '答复'; },
    redact: (s) => s, resolveSenderName: async () => '张三',
    recallHint: () => '', WORKSPACE_DIR: '/tmp/sw-ws',
    shouldRecycleSession: () => false, consumeMemoryNudge: () => false,
    formatInboundLog: () => '[in]', createProgressChannel: () => ({ update: () => {}, finish: async () => {} }),
    flushOutbox: async () => {}, outboxDirFor: () => '/tmp/sw-outbox', sendVoice: async () => {},
    claudeFailureReply: async (m) => `⚠️ ${m}`,
  };
  Object.assign(r, handleFactory()(proxyOf(scope)));
  r.send = async (text, o = {}) => {
    r.n += 1;
    const type = o.type ?? 'p2p';
    const message = {
      message_id: `om_${r.n}`, chat_id: type === 'p2p' ? DM : GROUP, chat_type: type, message_type: 'text',
      create_time: String(Date.now()), mentions: type === 'p2p' ? [] : [{ id: { open_id: 'ou_bot' } }], __text: text,
    };
    r.replies.length = 0;
    await r.trackedHandleMessage({ message, sender: { sender_id: { open_id: o.sender ?? OWNER } } });
    await settle();
    return [...r.replies];
  };
  return r;
}

describe('W1 handleMessage 的 /tasks 分支（P9–P11）', () => {
  test('owner 群聊 / 别人私聊 / 别人群聊：原文拒绝，不进 tasksDecision / describeTasks / 模型；owner 私聊才进', async () => {
    const b = bridge();
    assert.deepEqual(await b.send('/tasks approve abc123', { type: 'group' }), ['定时任务只在私聊里查看'], 'P9');
    assert.deepEqual(await b.send('/tasks reject abc123', { type: 'group' }), ['定时任务只在私聊里查看'], 'P9（reject）');
    assert.deepEqual(await b.send('/tasks', { type: 'group' }), ['定时任务只在私聊里查看'], 'P9（无参数）');
    assert.deepEqual(await b.send('/tasks approve abc123', { type: 'p2p', sender: GUEST }), ['只有 owner 可以查看定时任务。'], 'P10');
    assert.deepEqual(await b.send('/tasks approve abc123', { type: 'group', sender: GUEST }), ['群会话里只有 owner 能使用会话控制指令（可以私聊我使用）。'], 'P11');
    assert.deepEqual(b.decisions, []);
    assert.equal(b.described, 0);
    assert.equal(b.calls.length, 0, '没有任何一条进模型');
    assert.deepEqual(await b.send('/tasks approve abc123'), ['TASKS-DECISION']);
    assert.deepEqual(b.decisions, ['/tasks approve abc123']);
    assert.equal(b.described, 0);
    assert.deepEqual(await b.send('/tasks'), ['DESCRIBE-TASKS']);
    assert.equal(b.described, 1);
    assert.deepEqual(b.decisions, ['/tasks approve abc123'], '无参数的 /tasks 不走 tasksDecision');
    assert.equal(b.calls.length, 0, 'owner 私聊的 /tasks 也不进模型');
  });
  test('以 /tasks 开头但不是该命令的文本不被吞（/tasksfoo 照常进模型）', async () => {
    const b = bridge();
    await b.send('/tasksfoo');
    assert.equal(b.decisions.length, 0);
    assert.equal(b.calls.length, 1);
  });
});

// ---------- W2 ----------
const turnSrc = cut('function schedTurnFor(source, job) {', '\n}\n', { inclusive: true });
const blockSrc = cut('const scheduler = startScheduler({', '\n});', { inclusive: true });
describe('W2 startScheduler 的选项', () => {
  test('requireApproval 为 true；turnFor 仍按引用传（就是 schedTurnFor 本身）', () => {
    const captured = {};
    const scope = {
      resolveTurn, schedDestOf, ownerDmChatId: DM, OWNER_TOOL_PROFILE: 'legacy', BIZ_ON: false,
      startScheduler: (opts) => { captured.opts = opts; return { stop() {} }; },
      SCHEDULES_DIR: '/tmp/x-jobs', SCHED_STATE_FILE: '/tmp/x-state.json', sendToOwner: async () => {},
    };
    // eslint-disable-next-line no-new-func
    const out = new Function('scope', `with (scope) {\n${turnSrc}\n${blockSrc}\nreturn { schedTurnFor };\n}`)(proxyOf(scope));
    assert.equal(captured.opts.requireApproval, true);
    assert.equal(captured.opts.turnFor, out.schedTurnFor);
    assert.equal(captured.opts.schedulesDir, '/tmp/x-jobs');
    assert.equal(captured.opts.approvalKeyFile, undefined, '生产路径用默认密钥位置，不另指定');
  });
});

// ---------- W3 ----------
const decisionSrc = cut('function tasksDecision(text) {', '\n}\n', { inclusive: true });
function decisionOf(keys, { store = { calls: [], decide(...a) { this.calls.push(a); return { ok: true, persisted: true } } } } = {}) {
  const cands = [{ file: 'a.json', name: '晨报', code: 'abc123', hash: 'h'.repeat(64), state: 'pending', announced: true, destTail: '0123', when: '0 8 * * *', expired: false }];
  const scope = { runningKeysWithPrefix: (p) => { assert.equal(p, ''); return keys; }, tasksCommandReply, scheduler: { approvalCandidates: () => cands, approvalStore: store } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('scope', `with (scope) {\n${decisionSrc}\nreturn tasksDecision;\n}`)(proxyOf(scope));
  return { fn, store };
}
describe('W3 tasksDecision 的忙判定（P6 / P15）', () => {
  const busyKeys = {
    '私聊自己那一轮': [DM], 'sched:': ['sched:a.json'], '心跳': ['sched:heartbeat'], '交接': [`handoff:${DM}`], '自诊断': ['sched-diag:a.json'], '验收': ['sched:verify'],
    '混着 guest': ['guest:oc_g:ou_x', 'sched:a.json'],
  };
  for (const [tag, keys] of Object.entries(busyKeys)) {
    test(`${tag}在跑：approve 被拒、不记；reject 照常`, () => {
      const { fn, store } = decisionOf(keys);
      const out = fn('/tasks approve abc123');
      assert.match(out, /^现在有 \d+ 个带你权限的任务在跑。/);
      assert.equal(store.calls.length, 0);
      assert.match(fn('/tasks reject abc123'), /^🚫 已拒绝/);
      assert.equal(store.calls.length, 1);
    });
  }
  test('只有访客回合或没有回合在跑：approve 生效；数的是不以 guest: 开头的键', () => {
    for (const keys of [[], ['guest:oc_g:ou_x'], ['guest:a', 'guest:b']]) {
      const { fn, store } = decisionOf(keys);
      assert.match(fn('/tasks approve abc123'), /^✅ 已确认/);
      assert.equal(store.calls.length, 1);
    }
    const { fn } = decisionOf(['sched:a', 'sched:b', 'guest:x']);
    assert.match(fn('/tasks approve abc123'), /^现在有 2 个/);
  });
  test('scheduler 没有确认能力（旧句柄 / 桩）：按找不到处理，不抛', () => {
    const scope = { runningKeysWithPrefix: () => [], tasksCommandReply, scheduler: {} };
    // eslint-disable-next-line no-new-func
    const fn = new Function('scope', `with (scope) {\n${decisionSrc}\nreturn tasksDecision;\n}`)(proxyOf(scope));
    assert.match(fn('/tasks approve abc123'), /^没找到等你确认的这个任务/);
  });
});

// ---------- W4 ----------
describe('W4 卡片回调不认 /tasks 按钮（P16，现有行为）', () => {
  test('任何形如 tasks approve/reject 的按钮 value：返回「已失效」，不调 submitAction，不碰确认 store', async () => {
    const store = { decide() { throw new Error('不该被调用'); }, lookup() { throw new Error('不该被调用'); } };
    const hb = {
      validateCardAction: () => ({ ok: false, reason: 'unknown-card' }),
      submitAction: () => { throw new Error('不该被调用'); },
      countEvent: () => 0,
    };
    const logs = [];
    const ev = createEventHandlers({ getOwner: () => OWNER, heartbeat: () => hb, log: (l) => logs.push(l) });
    for (const value of [{ kind: 'tasks', a: 'approve', c: 'abc123' }, { kind: 'tasks', a: 'reject', c: 'abc123' }, JSON.stringify({ kind: 'tasks', a: 'approve', c: 'abc123' }), { a: 'approve', slug: 'a' }]) {
      const out = await ev.cardAction({ operator: { open_id: OWNER }, context: { open_message_id: 'om_1' }, action: { value } });
      assert.deepEqual(out, { toast: { type: 'warning', content: '已失效' } });
    }
    const none = createEventHandlers({ getOwner: () => OWNER, heartbeat: () => null, log: () => {} });
    assert.deepEqual(await none.cardAction({ operator: { open_id: OWNER }, action: { value: { kind: 'tasks', a: 'approve', c: 'abc123' } } }), { toast: { type: 'warning', content: '已失效' } });
    assert.ok(logs.every((l) => !l.includes('abc123')), '日志不含确认码');
    void store;
  });
});

// ---------- W5 ----------
const describeSrc = cut('function describeTasks() {', '\n}\n', { inclusive: true });
function describeWith({ jobs, state = {}, gateOf }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w5-'));
  const dir = path.join(root, 'jobs');
  fs.mkdirSync(dir);
  for (const [f, j] of Object.entries(jobs)) fs.writeFileSync(path.join(dir, f), JSON.stringify(j));
  const stateFile = path.join(root, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const scope = { fs, path, nextFireAt, SCHEDULES_DIR: dir, SCHED_STATE_FILE: stateFile, scheduler: { approvalOf: gateOf } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('scope', `with (scope) {\n${describeSrc}\nreturn describeTasks;\n}`)(proxyOf(scope));
  try { return fn(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
describe('W5 describeTasks 的确认标记', () => {
  const job = (extra = {}) => ({ name: '晨报', when: '0 8 * * *', prompt: 'SECRET-PROMPT', chat_id: FULL_CHAT, enabled: true, ...extra });
  test('三种状态各一行；待确认有提示头；不执行的任务「下次」写明；输出没有完整 chat_id / 提示词', () => {
    const states = { 'a.json': 'pending', 'b.json': 'rejected', 'c.json': 'approved' };
    const out = describeWith({
      jobs: { 'a.json': job({ name: 'A' }), 'b.json': job({ name: 'B' }), 'c.json': job({ name: 'C' }) },
      gateOf: (j) => ({ state: states[j._file], code: `${j._file[0]}00000` }),
    });
    const lines = out.split('\n');
    assert.equal(lines[1], '有 1 个任务要把结果发往别处，等你确认：私聊发 `/tasks approve <确认码>`');
    assert.ok(out.includes('  确认：待确认（确认码 a00000）'));
    assert.ok(out.includes('  确认：已拒绝（确认码 b00000）'));
    assert.ok(out.includes('  确认：已确认'));
    assert.ok(!out.includes('确认：已确认（确认码'), '已确认不带确认码');
    assert.ok(out.includes('  下次：不执行（待确认）'));
    assert.ok(out.includes('  下次：不执行（已拒绝）'));
    assert.equal(out.split('下次：不执行').length - 1, 2, '已确认的仍显示真实下次时间');
    assert.ok(!out.includes(FULL_CHAT) && !out.includes('SECRET-PROMPT'));
  });
  test('没有待确认：没有提示头；不受闸的任务没有「确认」行；已停用的任务不查', () => {
    const asked = [];
    const out = describeWith({
      jobs: { 'a.json': job({ name: 'A' }), 'b.json': job({ name: 'B', enabled: false }) },
      gateOf: (j) => { asked.push(j._file); return j._file === 'a.json' ? null : { state: 'pending', code: 'x' }; },
    });
    assert.ok(!out.includes('等你确认'));
    assert.ok(!out.includes('确认：'));
    assert.deepEqual(asked, ['a.json'], '已停用的不查');
  });
  test('skipped-pending 的标签', () => {
    const out = describeWith({
      jobs: { 'a.json': job({ name: 'A', when: '2020-01-01T08:00' }) },
      state: { 'a.json': { at: '2020-01-01T00:00:00.000Z', when: '2020-01-01T08:00', status: 'skipped-pending' } },
      gateOf: () => ({ state: 'approved', code: 'x' }),
    });
    assert.ok(out.includes('（确认前已过点，未执行）'));
  });
  test('scheduler 没有 approvalOf（旧句柄）：输出与以前一致，不抛', () => {
    const out = describeWith({ jobs: { 'a.json': job({ name: 'A' }) }, gateOf: undefined });
    assert.ok(out.includes('**A**') && !out.includes('确认：'));
  });
});
