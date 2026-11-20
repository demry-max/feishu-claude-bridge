// BRIDGE-INBOUND-1（V04）：入口兜底层。假 reply / log，不联网。兜底不撤去重（R1）：飞书超时重推同一 id 仍按重复丢弃。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { routeTurn } from '../src/lanes.js';
import { detectConfirm } from '../src/tool-policy.js';
import { createToolTurn } from '../src/tool-audit.js';
import { resolveTurn } from '../src/turn-context.js';
import * as mq from '../src/message-queue.js';
import { createShutdown, replyIfDraining } from '../src/shutdown.js';
import { createInboundGuard, INBOUND_FAILED_REPLY, errorKind, errorStage, waitAtMost } from '../src/inbound-guard.js';

const FULL_ID = 'om_x100b5a1c2d3e4f5g6h7i8j9k0l';
const data = (extra = {}) => ({ message: { message_id: FULL_ID, chat_type: 'group', message_type: 'text', content: '{"text":"正文 ABC"}', ...extra }, sender: {} });
const secretErr = () => Object.assign(new Error('读 /Users/x/secret.txt 失败：正文 ABC'), { code: 'EACCES' });
function mk({ replyImpl, logImpl } = {}) {
  const r = { replies: [], forgets: [], logs: [] };
  const guard = createInboundGuard({
    reply: replyImpl ?? (async (id, text) => { r.replies.push([id, text]); }),
    forget: (id) => { r.forgets.push(id); }, // 工厂已不接受这个参数；留着只为断言它从未被调用（撤去重不得回来）
    log: logImpl ?? ((line) => { r.logs.push(line); }),
  });
  return { r, guard };
}

describe('G 入口兜底', () => {
  test('G1 正常结束：不回复、不记；返回值透传', async () => {
    const { r, guard } = mk();
    assert.equal(await guard(data(), async () => 42), 42);
    assert.deepEqual([r.replies, r.forgets, r.logs], [[], [], []]);
  });

  test('G2 异步抛错：不撤去重、回固定文案、日志恰好一行（无原文 / 完整 id / 正文）、guard 不被拒', async () => {
    const { r, guard } = mk();
    const out = await guard(data(), async () => { throw secretErr(); });
    assert.equal(out, undefined);
    assert.deepEqual(r.forgets, [], '没有调用任何撤去重');
    assert.deepEqual(r.replies, [[FULL_ID, '这条消息处理失败了，请再发一次']]);
    assert.equal(INBOUND_FAILED_REPLY, '这条消息处理失败了，请再发一次');
    assert.equal(r.logs.length, 1);
    const line = r.logs[0];
    assert.match(line, /^\[inbound\] /);
    assert.match(line, /stage=\S+ kind=EACCES chat=group type=text replied=yes id=…/);
    assert.ok(line.endsWith(`id=…${FULL_ID.slice(-6)}`), line);
    for (const bad of [FULL_ID, '/Users', 'secret.txt', '正文', 'ABC', '读 ']) assert.ok(!line.includes(bad), `日志不应含 ${bad}：${line}`);
    for (const bad of ['/Users', 'secret', 'EACCES', '正文']) assert.ok(!r.replies[0][1].includes(bad), '回复不带错误原文');
  });

  test('G3 同步抛错（handle 不是 async）：同 G2', async () => {
    const { r, guard } = mk();
    const out = await guard(data(), () => { throw secretErr(); });
    assert.equal(out, undefined);
    assert.deepEqual(r.forgets, []);
    assert.equal(r.replies.length, 1);
    assert.equal(r.logs.length, 1);
    assert.match(r.logs[0], /replied=yes/);
  });

  test('G4 回复也失败：replied=no，guard 仍不抛；log 自己抛错也不抛出', async () => {
    const a = mk({ replyImpl: async () => { throw new Error('send down'); } });
    await assert.doesNotReject(a.guard(data(), async () => { throw secretErr(); }));
    assert.equal(a.r.logs.length, 1);
    assert.match(a.r.logs[0], /replied=no/);
    assert.deepEqual(a.r.forgets, [], '回复失败也不撤去重');
    assert.ok(!a.r.logs[0].includes('send down'));

    const c = mk({ logImpl: () => { throw new Error('log boom'); } });
    await assert.doesNotReject(c.guard(data(), async () => { throw secretErr(); }));
    assert.equal(c.r.replies.length, 1);
    // reply 同步抛错也算失败
    const d = mk({ replyImpl: () => { throw new Error('sync reply'); } });
    await assert.doesNotReject(d.guard(data(), async () => { throw secretErr(); }));
    assert.match(d.r.logs[0], /replied=no/);
  });

  test('G5 没有 message_id：不回复，日志照记', async () => {
    const { r, guard } = mk();
    await guard({ message: { chat_type: 'p2p', message_type: 'text' } }, async () => { throw secretErr(); });
    await guard({}, async () => { throw secretErr(); });
    assert.deepEqual([r.replies, r.forgets], [[], []]);
    assert.equal(r.logs.length, 2);
    assert.match(r.logs[0], /chat=p2p type=text replied=no id=\?/);
    assert.match(r.logs[1], /chat=\? type=\? replied=no id=\?/);
  });

  test('G6 kind 取法：e.code → 飞书接口码（api<码>）→ e.name', async () => {
    assert.equal(errorKind(Object.assign(new Error('x'), { code: 'ECONNRESET' })), 'ECONNRESET');
    assert.equal(errorKind(Object.assign(new Error('x'), { response: { data: { code: 230001 } } })), 'api230001');
    assert.equal(errorKind(new TypeError('x')), 'TypeError');
    assert.equal(errorKind(null), '?');
    const { r, guard } = mk();
    await guard(data(), async () => { throw Object.assign(new Error('msg 里的 /Users/x'), { response: { data: { code: 99991672, msg: '原文' } } }); });
    assert.match(r.logs[0], /kind=api99991672 /);
    assert.ok(!r.logs[0].includes('原文'));
  });

  test('G6b stage：栈里有 runTurn 记 turn，否则 message，没有栈记 ?', () => {
    assert.equal(errorStage({ stack: 'Error\n    at runTurn (file:///x/src/index.js:1:1)' }), 'turn');
    assert.equal(errorStage({ stack: 'Error\n    at handleMessage (file:///x/src/index.js:1:1)' }), 'message');
    assert.equal(errorStage({}), '?');
  });

  // index.js 里真实的 seen / isDuplicate / 兜底实例（切段法）
  function realGuard() {
    const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const a = SRC.indexOf('const seen = new Set();');
    const b = SRC.indexOf('// ---- 每个会话串行处理', a);
    assert.ok(a >= 0 && b > a);
    const replies = []; const errors = []; let replyFails = false;
    // eslint-disable-next-line no-new-func
    const api = new Function('scope', `with (scope) {\n${SRC.slice(a, b)}\nreturn { isDuplicate, inboundGuard };\n}`)({
      createInboundGuard,
      reply: async (id, text) => { if (replyFails) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); replies.push([id, text]); },
      console: { error: (s) => errors.push(s), log() {} },
    });
    return { SRC, api, replies, errors, failReplies: (v) => { replyFails = v; } };
  }

  test('G7 接线：index.js 里真实的 seen / isDuplicate / 兜底实例——出错后同 id 仍算重复（不撤去重）；正常结束的也算重复', async () => {
    const { SRC, api, replies, errors } = realGuard();
    assert.equal(api.isDuplicate('om_1'), false);
    assert.equal(api.isDuplicate('om_1'), true);
    await api.inboundGuard({ message: { message_id: 'om_1' } }, async () => { throw new Error('boom'); });
    assert.equal(api.isDuplicate('om_1'), true, '出错后同 id 重推仍被挡（飞书 3 秒超时重推 + 命令副作用，撤去重会叠成两次）');
    assert.deepEqual(replies, [['om_1', '这条消息处理失败了，请再发一次']]);
    assert.equal(errors.length, 1);
    assert.equal(api.isDuplicate('om_2'), false);
    await api.inboundGuard({ message: { message_id: 'om_2' } }, async () => 'done');
    assert.equal(api.isDuplicate('om_2'), true, '正常处理完的仍算重复');
    // 注册处：trackedHandleMessage 交给兜底（只这一条是源码断言）
    assert.match(SRC, /'im\.message\.receive_v1': \(data\) => inboundGuard\(data, trackedHandleMessage\)/);
    assert.ok(!/createInboundGuard\(\{[^}]*forget/.test(SRC), '兜底实例不再传 forget');
  });

  test('G8 重推叠加：处理函数「先去重、计数一次副作用、再抛错」，同一事件经兜底投两次 → 副作用只 1 次、第二次被去重挡下、固定文案只回一次', async () => {
    const { api, replies, failReplies } = realGuard();
    let effects = 0;
    const handle = async (d) => { if (api.isDuplicate(d.message.message_id)) return 'dup'; effects += 1; throw Object.assign(new Error('回复超时'), { code: 'ETIMEDOUT' }); };
    const ev = { message: { message_id: 'om_cancel_1', chat_type: 'p2p', message_type: 'text' } };
    const r1 = await api.inboundGuard(ev, handle);
    const r2 = await api.inboundGuard(ev, handle); // 飞书超时重推
    assert.equal(r1, undefined);
    assert.equal(r2, 'dup', '重推按重复丢弃');
    assert.equal(effects, 1, '副作用只执行一次');
    assert.deepEqual(replies, [['om_cancel_1', INBOUND_FAILED_REPLY]], '固定文案只回一次');
    // 兜底自己的回复也发不出去：同样不撤、不重做
    failReplies(true);
    const ev2 = { message: { message_id: 'om_cancel_2', chat_type: 'p2p', message_type: 'text' } };
    await api.inboundGuard(ev2, handle);
    assert.equal(await api.inboundGuard(ev2, handle), 'dup');
    assert.equal(effects, 2);
  });
});

// ---- 「先执行、后回复」的命令分支：回复失败不抛，兜底不对用户说「请再发一次」（R1，协调者补充 2）----
// 把 handleMessage 的真实代码段装进注入作用域（同 turn-wiring.test.js 的做法），reply 恒失败，兜底的回复走另一个桩
const INDEX_SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
function cutSrc(start, end, { inclusive = false } = {}) {
  const a = INDEX_SRC.indexOf(start);
  assert.ok(a >= 0, `index.js 里找不到：${start}`);
  const b = INDEX_SRC.indexOf(end, a + start.length);
  assert.ok(b > a, `index.js 里找不到 ${start} 之后的：${JSON.stringify(end)}`);
  return INDEX_SRC.slice(a, inclusive ? b + end.length : b);
}
let cmdFactory;
function commandFactory() {
  if (cmdFactory) return cmdFactory;
  const code = [
    cutSrc('const chatQueues = new Map();', 'async function reply(messageId, text) {'),
    cutSrc('async function react(messageId, emoji) {', '\n}\n', { inclusive: true }),
    cutSrc('async function handleMessage(data', '\nconst eventDispatcher'),
    cutSrc('const shutdown = createShutdown({', '\n});', { inclusive: true }),
    'function __setDaily(d) { dailySession = d; }',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  cmdFactory = new Function('scope', `with (scope) {\n${code}\nreturn { trackedHandleMessage, __setDaily };\n}`);
  return cmdFactory;
}
const OWNER_ID = 'ou_owner';
const DM_CHAT = 'oc_ownerdm0000000001';
function cmdBridge({ env = {}, owner = OWNER_ID } = {}) {
  const r = { attempts: [], effects: [], errors: [], guardReplies: [], logs: [], n: 0 };
  const voiceChats = new Set();
  const scope = {
    console: { log: (...a) => r.logs.push(a.map(String).join(' ')), error: (...a) => r.errors.push(a.map((x) => String(x?.message ?? x)).join(' ')) },
    process: { env },
    createOwnerMessageQueue: mq.createOwnerMessageQueue, messageQueueEnabled: mq.messageQueueEnabled,
    mergeQueuedTurns: mq.mergeQueuedTurns, MERGED_NO_CONFIRM: mq.MERGED_NO_CONFIRM, withClearedNote: mq.withClearedNote,
    routeTurn, detectConfirm, createToolTurn, OWNER_TOOL_PROFILE: 'legacy', resolveTurn, BIZ_ON: false,
    createShutdown: (o) => createShutdown({ ...o, pollMs: 1000, exit: () => {}, now: () => 0, timers: { setTimeout: () => ({}), clearTimeout: () => {} } }),
    shutdownGraceSec: () => 120, replyIfDraining,
    heartbeat: { isInflight: () => false, stop: () => {} }, scheduler: { stop: () => {}, inflightCount: () => 0 },
    HEARTBEAT_KEY: 'sched:heartbeat', VERIFY_KEY: 'sched:verify',
    client: { im: { v1: { messageReaction: { create: async () => ({ code: 0 }) } } } },
    reply: async (mid, text) => { r.attempts.push([mid, text]); throw Object.assign(new Error('回复超时 /Users/x/secret'), { code: 'ETIMEDOUT' }); },
    isDuplicate: () => false, getBotOpenId: async () => 'ou_bot', isAllowed: () => true,
    OWNER_OPEN_ID: owner, loadOwner: () => owner || null, saveOwner: () => { r.effects.push('saveOwner'); return true; }, ALLOW_USERS: [],
    workspaceFor: () => '/tmp/ib1-ws',
    buildPrompt: async (_c, message) => ({ prompt: message.__text, attachments: [] }),
    describeError: (e) => ({ text: String(e?.message ?? e), hint: '' }),
    heartbeatReplyShortcut: async () => { r.effects.push('shortcut'); return { reply: '✅ 已记' }; },
    privateHeartbeatCommand: (_t, text) => { if (/\b(on|off)\b/.test(text)) r.effects.push('heartbeat-switch'); return '💓 心跳'; },
    sessionInfo: () => '**会话状态**', describeTasks: () => '定时任务：无',
    tasksDecision: (text) => { r.effects.push(`tasks:${text}`); return '✅ 已批准'; },
    HELP_TEXT: '帮助',
    getRuntimeConfig: () => ({ model: 'm', effort: 'e', execModel: '' }),
    setRuntimeConfig: (o) => { r.effects.push(`runtime:${JSON.stringify(o)}`); return { model: 'm', effort: 'e', execModel: 'x', execEffort: '' }; },
    checkCliEnvironment: () => ({}), MODEL_ALIASES: {}, EFFORT_LEVELS: ['low', 'high'], voiceChats,
    resetSession: (k) => r.effects.push(`reset:${k}`), isRunning: () => false,
    cancelRun: (k) => { r.effects.push(`cancel:${k}`); return true; }, abortRetries: () => false,
    sessionKeysWithPrefix: () => [], runningKeysWithPrefix: () => [],
    runClaude: async () => { r.effects.push('runClaude'); return '答复'; },
    redact: (x) => x, resolveSenderName: async () => '张三', recallHint: () => '', WORKSPACE_DIR: '/tmp/ib1-ws',
    shouldRecycleSession: () => false, consumeMemoryNudge: () => false, formatInboundLog: () => '[in]',
    createProgressChannel: () => ({ update: () => {}, finish: async () => {} }),
    flushOutbox: async () => {}, outboxDirFor: () => '/tmp/ib1-outbox', sendVoice: async () => {}, claudeFailureReply: async (m) => m,
    stripLocalPaths: (x) => x,
  };
  const proxy = new Proxy(scope, { has: (t, k) => typeof k === 'string' && Object.hasOwn(t, k), get: (t, k) => (k === Symbol.unscopables ? undefined : t[k]) });
  const api = commandFactory()(proxy);
  const guard = createInboundGuard({ reply: async (id, text) => { r.guardReplies.push([id, text]); }, log: (l) => r.errors.push(l) });
  r.setDaily = api.__setDaily;
  r.voice = voiceChats;
  r.send = async (text, o = {}) => {
    r.n += 1;
    const message = { message_id: `om_${r.n}`, chat_id: DM_CHAT, chat_type: 'p2p', message_type: 'text', create_time: String(Date.now()), mentions: [], parent_id: o.parent, __text: text };
    await guard({ message, sender: { sender_id: { open_id: OWNER_ID } } }, (d) => api.trackedHandleMessage(d));
    for (let i = 0; i < 8; i += 1) await new Promise((res) => setImmediate(res));
  };
  return r;
}
const FIXED = INBOUND_FAILED_REPLY;
const noPrompt = (r) => assert.deepEqual(r.guardReplies, [], `兜底不该说「请再发一次」：${JSON.stringify(r.guardReplies)}`);
const noted = (r) => assert.ok(r.errors.some((l) => l === '[inbound] 命令已执行，回复没发出去'), `该有一行日志：${JSON.stringify(r.errors)}`);

describe('C 命令已生效、回复失败：不抛、记一行日志、兜底不叫用户重发', () => {
  test('C0 对照：只读命令（/status）回复失败 → 照旧抛到兜底，回固定文案', async () => {
    const r = cmdBridge();
    await r.send('/status');
    assert.equal(r.guardReplies.length, 1);
    assert.equal(r.guardReplies[0][1], FIXED);
    await r.send('/tasks');
    await r.send('/heartbeat status');
    await r.send('/model');
    assert.equal(r.guardReplies.length, 4, '只读命令回复失败仍提示重发（重发是安全的）');
  });
  test('C1 /new：已重置，不叫重发', async () => {
    const r = cmdBridge(); await r.send('/new');
    assert.ok(r.effects.some((e) => e.startsWith('reset:'))); noPrompt(r); noted(r);
  });
  test('C2 /cancel：已取消，不叫重发', async () => {
    const r = cmdBridge(); await r.send('/cancel');
    assert.ok(r.effects.some((e) => e.startsWith('cancel:'))); noPrompt(r); noted(r);
  });
  test('C3 /voice：已切换，不叫重发（重发会切回去）', async () => {
    const r = cmdBridge(); await r.send('/voice');
    assert.ok(r.voice.has(DM_CHAT)); noPrompt(r); noted(r);
    await r.send('/voice off'); assert.ok(!r.voice.has(DM_CHAT)); noPrompt(r);
  });
  test('C4 /model <模型> 与 /model exec：已切换；回复失败后不再发第二条「⚠️」', async () => {
    const r = cmdBridge(); await r.send('/model fable');
    assert.ok(r.effects.some((e) => e.startsWith('runtime:'))); noPrompt(r); noted(r);
    assert.equal(r.attempts.length, 1, '只试了一次回复，没有落到 catch 里再发 ⚠️');
    const r2 = cmdBridge(); await r2.send('/model high'); noPrompt(r2); assert.equal(r2.attempts.length, 1);
    const r3 = cmdBridge(); await r3.send('/model exec sonnet');
    assert.ok(r3.effects.some((e) => e.startsWith('runtime:'))); noPrompt(r3); noted(r3); assert.equal(r3.attempts.length, 1);
  });
  test('C5 /tasks approve|reject：决定已落，不叫重发', async () => {
    const r = cmdBridge(); await r.send('/tasks approve abc');
    assert.deepEqual(r.effects, ['tasks:/tasks approve abc']); noPrompt(r); noted(r);
  });
  test('C6 /heartbeat on|off：开关已切，不叫重发', async () => {
    const r = cmdBridge(); await r.send('/heartbeat off');
    assert.deepEqual(r.effects, ['heartbeat-switch']); noPrompt(r); noted(r);
    await r.send('/heartbeat on'); assert.equal(r.effects.length, 2); noPrompt(r);
  });
  test('C7 /session rotate：交接已入队，不叫重发（DAILY_SESSION=on）', async () => {
    const r = cmdBridge();
    r.setDaily({ beforeTurn: ({ prompt }) => prompt, failureNote: () => '', onManualNew: () => {}, statusLine: () => '',
      command: async (_k, text) => { r.effects.push(`daily:${text}`); return '⏳ 正在交接'; } });
    await r.send('/session rotate');
    assert.deepEqual(r.effects, ['daily:/session rotate']); noPrompt(r); noted(r);
  });
  test('C8 引用回复心跳的快捷操作：台账已回写，不叫重发', async () => {
    const r = cmdBridge(); await r.send('知道了', { parent: 'om_hb' });
    assert.deepEqual(r.effects, ['shortcut']); noPrompt(r); noted(r);
  });
  test('C9 首个私聊者认领 owner：已登记，不叫重发', async () => {
    const r = cmdBridge({ env: { ALLOW_OWNER_CLAIM: 'true' }, owner: '' });
    await r.send('你好');
    assert.deepEqual(r.effects, ['saveOwner']); noPrompt(r); noted(r);
  });
  test('C10 日志不含正文 / 路径 / 完整 id', async () => {
    const r = cmdBridge(); await r.send('/new');
    for (const l of r.errors) for (const bad of ['/Users', 'secret', 'om_1', '回复超时']) assert.ok(!l.includes(bad), l);
  });
});

// ---- LOW-3：启动通知不因取机器人 id 挂住而不发 ----
describe('L3 启动通知最多等机器人 id 5 秒', () => {
  test('取 id 的请求永不返回 → 5 秒到点照常发启动通知，机器人 id 一项标成取不到；4.999 秒时还没发', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const src = cutSrc('const BOT_ID_STARTUP_WAIT_MS = 5000;', '\n\n', { inclusive: false });
    assert.match(src, /scopeSelfCheck\(\)\.finally\(\(\) => botCheck\.finally\(\(\) => announceStartup\(\)\)\);/);
    const calls = []; const errors = [];
    const scope = {
      waitAtMost, client: {}, console: { error: (...a) => errors.push(a.join(' ')), log() {} },
      lookupBotOpenId: () => new Promise(() => {}), // 永不返回
      botIdFailureCount: () => 0, botIdStartupMissing: false,
      scopeSelfCheck: async () => {},
      announceStartup: () => { calls.push(scope.botIdStartupMissing); },
    };
    // eslint-disable-next-line no-new-func
    new Function('scope', `with (scope) {\n${src}\n}`)(scope);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    t.mock.timers.tick(4999);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.deepEqual(calls, [], '没到 5 秒不发');
    t.mock.timers.tick(1);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    assert.deepEqual(calls, [true], '到点就发，且标成取不到机器人 id');
    assert.ok(errors.some((e) => e.includes('超过 5 秒')), errors.join('|'));
  });

  test('waitAtMost：先落定的赢；被拒不抛；p 不被取消', async () => {
    assert.equal(await waitAtMost(Promise.resolve(1), 50), 'done');
    assert.equal(await waitAtMost(Promise.reject(new Error('x')), 50), 'rejected');
    assert.equal(await waitAtMost(new Promise(() => {}), 10), 'timeout');
  });
});
