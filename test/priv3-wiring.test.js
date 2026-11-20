// BRIDGE-PRIV-3：index.js 的接线（W6–W10）。
// 做法同 sched-approval-wiring.test.js：把 src/index.js 里真实的代码段切出来，装进 Proxy 注入的作用域执行，依赖全是桩。
// W6 确认卡与调度器的创建顺序和选项；W7 发卡给 owner 的载荷；W8 describeTasks 的提示头；W9 tasksDecision 传 mode / resend；
// W10 卡片回调的路由（events.js 真实代码）与启动时的 owner 私聊会话确认。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEventHandlers } from '../src/events.js';
import { createApprovalCards } from '../src/sched-approval-card.js';
import { tasksCommandReply, listPlain, listWhen } from '../src/sched-approval.js';
import { bootOwnerDm, ownerDmBootLine } from '../src/owner-dm-store.js';
import { nextFireAt, parseWhen } from '../src/scheduler.js';

const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const OWNER = 'ou_owner';
const CHAT = 'oc_0123456789abcdef0123';
const DM = 'oc_ownerdm0000000001';
const HASH = 'a'.repeat(64);
const settle = async (n = 12) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
const proxyOf = (scope) => new Proxy(scope, { has: (t, k) => typeof k === 'string' && Object.hasOwn(t, k), get: (t, k) => (k === Symbol.unscopables ? undefined : t[k]) });
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function cut(start, end, { inclusive = false } = {}) {
  const a = SRC.indexOf(start);
  assert.ok(a >= 0, `index.js 里找不到：${start}`);
  const b = SRC.indexOf(end, a + start.length);
  assert.ok(b > a, `index.js 里找不到 ${start} 之后的：${JSON.stringify(end)}`);
  return SRC.slice(a, inclusive ? b + end.length : b);
}

// ---------- W6 ----------
const cardsSrc = cut('// BRIDGE-PRIV-3：确认卡的索引与点击处理', 'const scheduler = startScheduler({');
const blockSrc = cut('const scheduler = startScheduler({', '\n});', { inclusive: true });
const turnSrc = cut('function schedTurnFor(source, job) {', '\n}\n', { inclusive: true });
function schedWith({ env = {}, sent = [], startHook } = {}) {
  const captured = {};
  const scope = {
    createApprovalCards, redact: (s) => s, sendToOwner: async () => {}, loadOwner: () => OWNER, OWNER_OPEN_ID: OWNER,
    sendApprovalCardToOwner: async (card) => { sent.push(card); return { data: { message_id: 'om_wired000001' } }; },
    process: { env },
    startScheduler: (opts) => { captured.opts = opts; startHook?.(opts); return { stop() {}, approvalMode: 'x' }; },
    SCHEDULES_DIR: '/tmp/x-jobs', SCHED_STATE_FILE: '/tmp/x-state.json',
    resolveTurn: () => ({}), schedDestOf: () => 'other', ownerDmChatId: DM, OWNER_TOOL_PROFILE: 'legacy', BIZ_ON: false,
    console: { log() {}, error() {} },
  };
  // eslint-disable-next-line no-new-func
  const out = new Function('scope', `with (scope) {\n${turnSrc}\n${cardsSrc}\n${blockSrc}\nreturn { approvalCards, scheduler };\n}`)(proxyOf(scope));
  return { ...out, opts: captured.opts, scope };
}
describe('W6 确认卡与调度器的接线', () => {
  test('approvalMode 取自 SCHED_APPROVAL_MODE（原样传，由调度器判）；没设就是 undefined', () => {
    assert.equal(schedWith({ env: { SCHED_APPROVAL_MODE: 'button' } }).opts.approvalMode, 'button');
    assert.equal(schedWith({ env: { SCHED_APPROVAL_MODE: ' Bogus ' } }).opts.approvalMode, ' Bogus ');
    assert.equal(schedWith({ env: {} }).opts.approvalMode, undefined);
    assert.equal(schedWith({ env: {} }).opts.requireApproval, true);
  });
  test('确认卡对象在调度器创建之前就绪：startScheduler 同步（首拍）调 sendApprovalCard 也不会撞 TDZ', async () => {
    const sent = [];
    let result;
    const w = schedWith({ sent, startHook: (opts) => { result = opts.sendApprovalCard({ file: 'a.json', hash: HASH, job: { name: '晨报', when: '0 8 * * *', prompt: 'P', chat_id: CHAT }, destUnknown: false }); } });
    assert.equal(await result, true);
    assert.equal(sent.length, 1);
    assert.equal(w.approvalCards.size, 1);
    assert.equal(typeof w.opts.sendApprovalCard, 'function');
  });
  test('点击经同一个 approvalCards：scheduler 取自外层 const（延迟求值），文字行走 sendToOwner', async () => {
    const sent = [];
    const texts = [];
    const decides = [];
    let w;
    const fake = {
      approvalCandidates: () => [{ file: 'a.json', name: '晨报', code: 'abc123', hash: HASH, state: 'pending', announced: true, destTail: '0123', when: '0 8 * * *', expired: false }],
      approvalStore: { decide: (...a) => { decides.push(a); return { ok: true, persisted: true }; } },
      resendApprovalCard: () => 'gone',
    };
    w = schedWith({ sent, startHook: () => {} });
    w.scope.sendToOwner = async (t) => { texts.push(t); };
    // 重新装配：把假调度器放进 startScheduler 的返回值
    const scope2 = { ...w.scope, startScheduler: () => fake, sendToOwner: async (t) => { texts.push(t); } };
    // eslint-disable-next-line no-new-func
    const out = new Function('scope', `with (scope) {\n${turnSrc}\n${cardsSrc}\n${blockSrc}\nreturn { approvalCards };\n}`)(proxyOf(scope2));
    await out.approvalCards.issue({ file: 'a.json', hash: HASH, job: { name: '晨报', when: '0 8 * * *', prompt: 'P', chat_id: CHAT }, destUnknown: false });
    const card = sent.at(-1);
    const n = card.body.elements.at(-1).columns[0].elements[0].behaviors[0].value.n;
    const res = out.approvalCards.handleClick({ isOwner: true, messageId: 'om_wired000001', value: { v: 1, k: 'sched-approval', a: 'approve', n, f: 'a.json' } });
    assert.equal(res.toast.content, '已确认');
    assert.deepEqual(decides, [['a.json', HASH, 'approved']]);
    await settle();
    assert.equal(texts.length, 1);
    assert.match(texts[0], /^✅ 已确认定时任务「晨报」/);
  });
});

// ---------- W7 ----------
const sendCardSrc = cut('async function sendApprovalCardToOwner(card) {', '\n}\n', { inclusive: true });
describe('W7 确认卡以应用身份发给 owner（open_id）', () => {
  const make = (owner, created) => {
    const scope = { OWNER_OPEN_ID: owner, loadOwner: () => '', client: { im: { v1: { message: { create: async (p) => { created.push(p); return { data: { message_id: 'om_x' } }; } } } } } };
    // eslint-disable-next-line no-new-func
    return new Function('scope', `with (scope) {\n${sendCardSrc}\nreturn sendApprovalCardToOwner;\n}`)(proxyOf(scope));
  };
  test('载荷：receive_id_type=open_id、msg_type=interactive、content 是卡片 JSON；返回飞书应答', async () => {
    const created = [];
    const card = { schema: '2.0', body: { elements: [] } };
    const res = await make(OWNER, created)(card);
    assert.deepEqual(res, { data: { message_id: 'om_x' } });
    assert.deepEqual(created, [{ params: { receive_id_type: 'open_id' }, data: { receive_id: OWNER, msg_type: 'interactive', content: JSON.stringify(card) } }]);
  });
  test('没有 owner：抛错（issue 会接住并退回文字通知），不发', async () => {
    const created = [];
    await assert.rejects(() => make('', created)({}), /owner/);
    assert.deepEqual(created, []);
  });
  test('OWNER_OPEN_ID 为空时用 loadOwner() 的落盘 owner', async () => {
    const created = [];
    const scope = { OWNER_OPEN_ID: '', loadOwner: () => 'ou_disk', client: { im: { v1: { message: { create: async (p) => { created.push(p); return {}; } } } } } };
    // eslint-disable-next-line no-new-func
    const fn = new Function('scope', `with (scope) {\n${sendCardSrc}\nreturn sendApprovalCardToOwner;\n}`)(proxyOf(scope));
    await fn({});
    assert.equal(created[0].data.receive_id, 'ou_disk');
  });
});

// ---------- W8 ----------
const describeSrc = cut('function describeTasks() {', '\n}\n', { inclusive: true });
function describeWith(approvalMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w8-'));
  const dir = path.join(root, 'jobs');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ name: 'A', when: '0 8 * * *', prompt: 'P', chat_id: CHAT, enabled: true }));
  const stateFile = path.join(root, 'state.json');
  fs.writeFileSync(stateFile, '{}');
  const scope = { fs, path, nextFireAt, SCHEDULES_DIR: dir, SCHED_STATE_FILE: stateFile, scheduler: { approvalMode, approvalOf: () => ({ state: 'pending', code: 'a00000' }) }, listPlain, listWhen, parseWhen };
  // eslint-disable-next-line no-new-func
  const fn = new Function('scope', `with (scope) {\n${describeSrc}\nreturn describeTasks;\n}`)(proxyOf(scope));
  try { return fn(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
describe('W8 /tasks 列表的提示头随模式变', () => {
  test('button：点确认卡上的按钮、找不到卡片发 /tasks approve 重发；其余（command / 缺省）一字不改', () => {
    assert.equal(describeWith('button').split('\n')[1], '有 1 个任务要把结果发往别处，等你确认：点确认卡上的［确认］按钮（找不到卡片就发 `/tasks approve <确认码>` 重发）');
    for (const m of ['command', undefined, 'bogus']) assert.equal(describeWith(m).split('\n')[1], '有 1 个任务要把结果发往别处，等你确认：私聊发 `/tasks approve <确认码>`');
    assert.ok(describeWith('button').includes('  确认：待确认（确认码 a00000）'));
    assert.ok(!describeWith('button').includes(CHAT));
  });
});

// ---------- W9 ----------
const decisionSrc = cut('function tasksDecision(text) {', '\n}\n', { inclusive: true });
function decisionWith({ approvalMode, resendApprovalCard, keys = [] }) {
  const calls = { decide: [], resend: [] };
  const cands = [{ file: 'a.json', name: '晨报', code: 'abc123', hash: HASH, state: 'pending', announced: true, destTail: '0123', when: '0 8 * * *', expired: false }];
  const scheduler = {
    approvalMode, approvalCandidates: () => cands,
    approvalStore: { decide: (...a) => { calls.decide.push(a); return { ok: true, persisted: true }; } },
    ...(resendApprovalCard ? { resendApprovalCard: (c) => { calls.resend.push(c.file); return resendApprovalCard; } } : {}),
  };
  const scope = { runningKeysWithPrefix: () => keys, tasksCommandReply, scheduler };
  // eslint-disable-next-line no-new-func
  const fn = new Function('scope', `with (scope) {\n${decisionSrc}\nreturn tasksDecision;\n}`)(proxyOf(scope));
  return { fn, calls };
}
describe('W9 tasksDecision 传 mode 与 resend', () => {
  test('button：approve 只补发、不记；忙时也补发；调度器没有 resend（旧句柄）→ 没找到', () => {
    const a = decisionWith({ approvalMode: 'button', resendApprovalCard: 'sent', keys: ['owner:x', 'owner:y'] });
    assert.match(a.fn('/tasks approve abc123'), /^请点确认卡上的［确认］按钮：已把「晨报」的确认卡重新发给你。$/);
    assert.deepEqual([a.calls.decide, a.calls.resend], [[], ['a.json']]);
    const b = decisionWith({ approvalMode: 'button' });
    assert.match(b.fn('/tasks approve abc123'), /^没找到等你确认的这个任务/);
    assert.deepEqual(b.calls.decide, []);
  });
  test('button：reject 照旧记（忙时仍拒绝）', () => {
    const a = decisionWith({ approvalMode: 'button', resendApprovalCard: 'sent' });
    assert.match(a.fn('/tasks reject abc123'), /^🚫 已拒绝/);
    assert.deepEqual(a.calls.decide, [['a.json', HASH, 'rejected']]);
    assert.deepEqual(a.calls.resend, []);
  });
  test('command / 缺省：approve 照旧记，忙时拒绝，从不调 resend', () => {
    for (const mode of ['command', undefined]) {
      const a = decisionWith({ approvalMode: mode, resendApprovalCard: 'sent' });
      assert.match(a.fn('/tasks approve abc123'), /^✅ 已确认/);
      assert.deepEqual(a.calls.decide, [['a.json', HASH, 'approved']]);
      const busy = decisionWith({ approvalMode: mode, resendApprovalCard: 'sent', keys: ['owner:x'] });
      assert.match(busy.fn('/tasks approve abc123'), /^现在有 1 个带你权限的任务在跑/);
      assert.deepEqual([busy.calls.decide, busy.calls.resend], [[], []]);
    }
  });
});

// ---------- W10 ----------
const evSrc = cut('const ev = createEventHandlers({', '\n', {});
describe('W10 卡片回调路由（events.js 真实代码 + index.js 里那一行的选项）', () => {
  function evWith({ hbCalls = [], clicks = [] } = {}) {
    let approvalCards; // 与 index.js 一样：在注册事件之后才创建，选项里是延迟取
    const scope = {
      createEventHandlers, OWNER_OPEN_ID: OWNER, loadOwner: () => '', console: { log() {}, error() {} },
      heartbeat: { validateCardAction: (a) => { hbCalls.push(a); return { ok: false, why: 'x' }; } },
      get approvalCards() { return approvalCards; },
    };
    // eslint-disable-next-line no-new-func
    const { ev } = new Function('scope', `with (scope) {\n${evSrc}\nreturn { ev };\n}`)(proxyOf(new Proxy(scope, {})));
    approvalCards = { handleClick: (a) => { clicks.push(a); return { toast: { type: 'success', content: '已确认' } }; } };
    return ev;
  }
  const act = (k, op = OWNER) => ({ operator: { open_id: op }, context: { open_message_id: 'om_c1' }, action: { value: JSON.stringify({ v: 1, k, a: 'approve', n: '0'.repeat(16), f: 'a.json' }) } });
  test('k=sched-approval：交给确认卡模块（isOwner / messageId / value 齐全），不碰心跳', async () => {
    const hbCalls = []; const clicks = [];
    const ev = evWith({ hbCalls, clicks });
    assert.deepEqual(await ev.cardAction(act('sched-approval')), { toast: { type: 'success', content: '已确认' } });
    assert.equal(clicks.length, 1);
    assert.equal(clicks[0].isOwner, true);
    assert.equal(clicks[0].messageId, 'om_c1');
    assert.equal(clicks[0].value.k, 'sched-approval');
    assert.deepEqual(hbCalls, []);
  });
  test('操作者不是 owner：isOwner=false 照样交给确认卡模块（由它回「已失效」）', async () => {
    const clicks = [];
    const ev = evWith({ clicks });
    await ev.cardAction(act('sched-approval', 'ou_someone_else'));
    assert.equal(clicks[0].isOwner, false);
  });
  test('其余回调仍走心跳；确认卡模块没就绪 / 抛错 → 已失效', async () => {
    const hbCalls = []; const clicks = [];
    const ev = evWith({ hbCalls, clicks });
    await ev.cardAction(act('hb-something'));
    assert.equal(hbCalls.length, 1);
    assert.deepEqual(clicks, []);
    const h = createEventHandlers({ getOwner: () => OWNER, heartbeat: () => null, schedApproval: () => null, log: () => {} });
    const stale = await h.cardAction(act('sched-approval'));
    assert.equal(stale.toast.type, 'warning');
    const h2 = createEventHandlers({ getOwner: () => OWNER, heartbeat: () => null, schedApproval: () => ({ handleClick: () => { throw new Error('x'); } }), log: () => {} });
    assert.equal((await h2.cardAction(act('sched-approval'))).toast.type, 'warning');
  });
});

// ---------- 启动时的 owner 私聊会话确认 ----------
const bootSrc = cut('const ownerDmBoot = await bootOwnerDm(', '\nlet ownerDmChatId');
describe('W10b 启动：验签不过时按 owner 的 open_id 发一条私聊，并把应答里的会话 id 当作 owner 私聊', () => {
  async function bootWith({ create, ownerEnv = OWNER, diskOwner = '' }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w10b-'));
    const logs = [];
    const scope = {
      bootOwnerDm, OWNER_DM_FILE: path.join(dir, 'owner-dm.json'), OWNER_OPEN_ID: ownerEnv, loadOwner: () => diskOwner,
      SCHED_APPROVAL_KEY_FILE: path.join(dir, 'key'), client: { im: { v1: { message: { create } } } }, console: { error: (...a) => logs.push(a.join(' ')), log() {} },
    };
    try {
      // eslint-disable-next-line no-new-func
      const out = await new AsyncFunction('scope', `with (scope) {\n${bootSrc}\nreturn ownerDmBoot;\n}`)(proxyOf(scope));
      return { out, logs, dir, file: scope.OWNER_DM_FILE, key: scope.SCHED_APPROVAL_KEY_FILE };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  test('没有记录：发给 owner（receive_id_type=open_id），用应答里的 chat_id；密钥在传入的位置', async () => {
    const created = [];
    const { out } = await bootWith({ create: async (p) => { created.push(p); return { data: { chat_id: 'oc_fedcba9876543210fedcba9876543210' } }; } });
    assert.equal(created.length, 1);
    assert.equal(created[0].params.receive_id_type, 'open_id');
    assert.equal(created[0].data.receive_id, OWNER);
    assert.equal(out.chatId, 'oc_fedcba9876543210fedcba9876543210');
    assert.equal(ownerDmBootLine(out), '[biz] owner 私聊目的地：已按 owner 账号重新确认');
  });
  test('owner 取 OWNER_OPEN_ID，没有就取 loadOwner()；都没有则不发', async () => {
    const created = [];
    const create = async (p) => { created.push(p); return { data: { chat_id: 'oc_fedcba9876543210fedcba9876543210' } }; };
    await bootWith({ create, ownerEnv: '', diskOwner: 'ou_disk' });
    assert.equal(created[0].data.receive_id, 'ou_disk');
    created.length = 0;
    const { out } = await bootWith({ create, ownerEnv: '', diskOwner: '' });
    assert.deepEqual(created, []);
    assert.equal(out.chatId, null);
  });
  test('发送失败：启动不被拦住，按未知处理，日志不含 id', async () => {
    const { out, logs } = await bootWith({ create: async () => { throw new Error('net oc_zzz ou_zzz'); } });
    assert.equal(out.chatId, null);
    assert.ok(logs.some((l) => l.includes('重新确认私聊会话失败（发送失败）')));
    assert.ok(!logs.join('\n').includes('zzz'));
  });
});
