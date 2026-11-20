// BRIDGE-PRIV-1 T3 / T4 / T5 / A5：index.js 的接线。
// 同 message-queue.test.js 的做法：把 src/index.js 里的真实代码段（handleMessage / runTurn / schedTurnFor）装进注入作用域执行，
// 依赖全是桩；不连飞书、不起 claude、不读 .env。旧会话不被续用那条另用真 claude.js + 假 CLI 验证。
import { test, describe, after } from 'node:test';
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

const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const OWNER = 'ou_owner';
const GUEST = 'ou_guest';
const DM = 'oc_ownerdm0000000001';
const GROUP = 'oc_group0000000000001';
const tick = () => new Promise((res) => setImmediate(res));
const settle = async (n = 12) => { for (let i = 0; i < n; i += 1) await tick(); };

function cut(start, end, { inclusive = false } = {}) {
  const a = SRC.indexOf(start);
  assert.ok(a >= 0, `index.js 里找不到：${start}`);
  const b = SRC.indexOf(end, a + start.length);
  assert.ok(b > a, `index.js 里找不到 ${start} 之后的：${JSON.stringify(end)}`);
  return SRC.slice(a, inclusive ? b + end.length : b);
}
let factory;
function indexFactory() {
  if (factory) return factory;
  const code = [
    cut('const chatQueues = new Map();', 'async function reply(messageId, text) {'),
    cut('async function react(messageId, emoji) {', '\n}\n', { inclusive: true }),
    cut('async function handleMessage(data', '\nconst eventDispatcher'),
    cut('const shutdown = createShutdown({', '\n});', { inclusive: true }),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  factory = new Function('scope', `with (scope) {\n${code}\nreturn { handleMessage, trackedHandleMessage };\n}`);
  return factory;
}

function bridge({ profile = 'legacy', bizOn = false, fail = false } = {}) {
  const r = { replies: [], calls: [], logs: [], errors: [], wsFor: [], outbox: [], builds: [], recalls: [], recycles: [], nudges: [], tasksDescribed: 0, n: 0 };
  const scope = {
    console: { log: (...a) => r.logs.push(a.map(String).join(' ')), error: (...a) => r.errors.push(a.map((x) => String(x?.message ?? x)).join(' ')) },
    process: { env: {} },
    createOwnerMessageQueue: mq.createOwnerMessageQueue, messageQueueEnabled: mq.messageQueueEnabled,
    mergeQueuedTurns: mq.mergeQueuedTurns, MERGED_NO_CONFIRM: mq.MERGED_NO_CONFIRM, withClearedNote: mq.withClearedNote,
    routeTurn, detectConfirm, createToolTurn, OWNER_TOOL_PROFILE: profile,
    resolveTurn, BIZ_ON: bizOn,
    createShutdown: (o) => createShutdown({ ...o, pollMs: 1000, exit: () => {}, now: () => 0, timers: { setTimeout: () => ({}), clearTimeout: () => {} } }),
    shutdownGraceSec: () => 120, replyIfDraining,
    heartbeat: { isInflight: () => false, stop: () => {} },
    HEARTBEAT_KEY: 'sched:heartbeat', VERIFY_KEY: 'sched:verify',
    client: { im: { v1: { messageReaction: { create: async () => ({ code: 0 }) } } } },
    reply: async (mid, text) => { r.replies.push([mid, text]); },
    isDuplicate: () => false,
    getBotOpenId: async () => 'ou_bot',
    isAllowed: () => true,
    OWNER_OPEN_ID: OWNER, loadOwner: () => OWNER, saveOwner: () => true, ALLOW_USERS: [],
    workspaceFor: (priv) => { r.wsFor.push(priv); return priv ? '/tmp/tw-ws' : '/tmp/tw-ws-guest'; },
    buildPrompt: async (_c, message, ws, sender) => { r.builds.push({ ws, sender }); return { prompt: message.__text, attachments: [] }; },
    describeError: (e) => ({ text: String(e?.message ?? e), hint: '' }),
    heartbeatReplyShortcut: async () => null,
    privateHeartbeatCommand: () => null,
    sessionInfo: (key, priv, turn) => `**会话状态**\n- 会话: ${key} private=${priv} kind=${turn?.kind}`,
    describeTasks: () => { r.tasksDescribed += 1; return '定时任务：A→群 oc_x'; },
    HELP_TEXT: '帮助',
    getRuntimeConfig: () => ({ model: 'm', effort: 'e', execModel: '' }),
    setRuntimeConfig: () => ({}), checkCliEnvironment: () => null,
    MODEL_ALIASES: {}, EFFORT_LEVELS: [], voiceChats: new Set(),
    resetSession: () => {}, isRunning: () => false, cancelRun: () => false, abortRetries: () => false,
    sessionKeysWithPrefix: () => [], runningKeysWithPrefix: () => [],
    runClaude: async (key, prompt, isOwner, extraTools, _p, opts) => { r.calls.push({ key, prompt, isOwner, extraTools, opts }); if (fail) throw new Error('boom'); return '答复'; },
    redact: (s) => s,
    resolveSenderName: async () => '张三',
    recallHint: (_ws, text) => { r.recalls.push(text); return '（相关记忆：memory/schedule.md）'; },
    WORKSPACE_DIR: '/tmp/tw-ws',
    shouldRecycleSession: (k) => { r.recycles.push(k); return false; },
    consumeMemoryNudge: (k) => { r.nudges.push(k); return false; },
    formatInboundLog: (o) => `[in] ${o.chatType}`,
    createProgressChannel: () => ({ update: () => {}, finish: async () => {} }),
    flushOutbox: async () => {},
    outboxDirFor: (key, priv) => { r.outbox.push([key, priv]); return '/tmp/tw-outbox'; },
    sendVoice: async () => {}, claudeFailureReply: async (m) => `⚠️ 出错了：${m}`,
  };
  const proxy = new Proxy(scope, { has: (t, k) => typeof k === 'string' && Object.hasOwn(t, k), get: (t, k) => (k === Symbol.unscopables ? undefined : t[k]) });
  Object.assign(r, indexFactory()(proxy));
  r.send = async (text, o = {}) => {
    r.n += 1;
    const type = o.type ?? 'p2p';
    const message = {
      message_id: `om_${r.n}`, chat_id: o.chat ?? (type === 'p2p' ? DM : GROUP), chat_type: type, message_type: 'text',
      create_time: String(Date.now()), mentions: type === 'p2p' ? [] : [{ id: { open_id: 'ou_bot' } }], __text: text,
    };
    await r.trackedHandleMessage({ message, sender: { sender_id: { open_id: o.sender ?? OWNER } } });
    await settle();
    return message;
  };
  return r;
}

for (const profile of ['legacy', 'audit', 'strict']) {
  describe(`T3 接线：仓主在群里按非私密回合（${profile}）`, () => {
    test('仓主群聊：isOwner=false、会话键 guest:<群>:<仓主>、turn.kind=owner-group、无召回提示、访客工作区、outbox 按非私密', async () => {
      const b = bridge({ profile });
      await b.send('安排下周的会', { type: 'group' });
      assert.equal(b.calls.length, 1);
      const c = b.calls[0];
      assert.equal(c.key, `guest:${GROUP}:${OWNER}`);
      assert.equal(c.isOwner, false, 'runClaude 第 3 参 = turn.private');
      assert.equal(c.opts.turn.kind, 'owner-group');
      assert.equal(c.opts.turn.private, false);
      assert.equal(c.opts.turn.speakerIsOwner, true);
      assert.ok(!c.prompt.includes('相关记忆'), '不带记忆召回提示');
      assert.deepEqual(b.recalls, [], '根本没调 recallHint');
      assert.deepEqual(b.recycles, [], '不查会话回收');
      assert.deepEqual(b.nudges, [], '不消耗记忆提醒');
      assert.ok(b.wsFor.length > 0 && b.wsFor.every((p) => p === false), '工作区 / 附件目录按非私密（workspace-guest/incoming）');
      assert.deepEqual(b.builds.map((x) => x.ws), ['/tmp/tw-ws-guest']);
      assert.ok(b.outbox.length > 0 && b.outbox.every(([k, p]) => k === c.key && p === false), 'outbox 按非私密：成功路径');
    });

    test('仓主群聊失败路径：outbox 同样按非私密', async () => {
      const b = bridge({ profile, fail: true });
      await b.send('你好', { type: 'group' });
      assert.equal(b.calls.length, 1);
      assert.ok(b.outbox.length > 0 && b.outbox.every(([k, p]) => k === `guest:${GROUP}:${OWNER}` && p === false));
      assert.ok(b.replies.some(([, t]) => t.includes('出错了')), '走了失败回复');
    });

    test('同群不同人的键互不相同；仓主私聊键不变（DM chat_id），带 isOwner=true 与 turn.kind=owner-dm', async () => {
      const b = bridge({ profile });
      await b.send('你好', { type: 'group', sender: GUEST });
      await b.send('你好', { type: 'group' });
      await b.send('安排下周的会', { type: 'p2p' });
      assert.deepEqual(b.calls.map((c) => c.key), [`guest:${GROUP}:${GUEST}`, `guest:${GROUP}:${OWNER}`, DM]);
      assert.deepEqual(b.calls.map((c) => c.isOwner), [false, false, true]);
      assert.deepEqual(b.calls.map((c) => c.opts.turn.kind), ['guest', 'owner-group', 'owner-dm']);
      assert.ok(b.calls[2].prompt.includes('相关记忆'), '私聊仍带召回提示');
      assert.deepEqual(b.recalls, ['安排下周的会']);
      assert.deepEqual(b.recycles, [DM]);
      assert.deepEqual(b.outbox.map(([k, p]) => `${k}|${p}`), [`guest:${GROUP}:${GUEST}|false`, `guest:${GROUP}:${OWNER}|false`, `${DM}|true`]);
    });

    test('每一次 runClaude 都带 opts.turn（A5：chat）', async () => {
      const b = bridge({ profile });
      await b.send('一', { type: 'p2p' });
      await b.send('二', { type: 'group' });
      await b.send('三', { type: 'group', sender: GUEST });
      assert.equal(b.calls.length, 3);
      for (const c of b.calls) assert.ok(c.opts.turn && typeof c.opts.turn.kind === 'string', c.key);
    });

    test('T4 群里 /tasks：固定一句话、不调 describeTasks；私聊不变；非仓主照旧被拦', async () => {
      const b = bridge({ profile });
      const g = await b.send('/tasks', { type: 'group' });
      const dm = await b.send('/tasks', { type: 'p2p' });
      const guest = await b.send('/tasks', { type: 'group', sender: GUEST });
      const to = (m) => b.replies.filter(([id]) => id === m.message_id).map(([, t]) => t);
      assert.deepEqual(to(g), ['定时任务只在私聊里查看']);
      assert.deepEqual(to(dm), ['定时任务：A→群 oc_x']);
      assert.deepEqual(to(guest), ['群会话里只有 owner 能使用会话控制指令（可以私聊我使用）。'], '非仓主在群里被既有的会话控制闸拦下');
      assert.equal(b.tasksDescribed, 1, '只有私聊那次调了 describeTasks');
      assert.equal(b.calls.length, 0, '命令不进 runClaude');
    });

    test('群里 /status 按非私密展示（会话键是访客式；不含 open_id 之外的新打印点）', async () => {
      const b = bridge({ profile });
      const g = await b.send('/status', { type: 'group' });
      const text = b.replies.filter(([id]) => id === g.message_id).map(([, t]) => t).join('\n');
      assert.match(text, /private=false kind=owner-group/);
      const dm = await b.send('/status', { type: 'p2p' });
      const t2 = b.replies.filter(([id]) => id === dm.message_id).map(([, t]) => t).join('\n');
      assert.match(t2, /private=true kind=owner-dm/);
    });
  });
}

describe('T3 旧会话：群 chat_id 老条目不被续用（真 claude.js + 假 CLI）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-wiring-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('预置 { "<群 chat_id>": "old-sid" }：仓主在群里的新键不带 --resume old-sid，老条目原样保留', async () => {
    const dirs = { data: path.join(tmp, 'data'), ws: path.join(tmp, 'ws'), gws: path.join(tmp, 'gws'), home: path.join(tmp, 'home') };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    const argvLog = path.join(tmp, 'argv.log');
    const stream = path.join(tmp, 'stream.jsonl');
    fs.writeFileSync(stream, [
      { type: 'system', subtype: 'init', session_id: 's-new' },
      { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's-new' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const fake = path.join(tmp, 'fake-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\necho "ARGV-START" >> "${argvLog}"\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argvLog}"; done\ncat > /dev/null\ncat "${stream}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dirs.data, 'sessions.json'), JSON.stringify({ [GROUP]: 'old-sid', [`guest:${GROUP}:${GUEST}`]: 'guest-sid' }));
    Object.assign(process.env, {
      DATA_DIR: dirs.data, WORKSPACE_DIR: dirs.ws, GUEST_WORKSPACE_DIR: dirs.gws, HOME: dirs.home, CLAUDE_BIN: fake,
      FEISHU_APP_ID: 'cli_test_app', FEISHU_APP_SECRET: 'test-app-secret', CLAUDE_MAX_RETRIES: '0',
    });
    for (const k of ['OWNER_TOOL_PROFILE', 'BMS_TOOL_ENABLED', 'CLAUDE_FALLBACK_BIN', 'DAILY_SESSION']) delete process.env[k];
    const orig = console.error;
    console.error = () => {};
    let m;
    try { m = await import('../src/claude.js?turn-wiring'); } finally { console.error = orig; }

    const ownerKey = `guest:${GROUP}:${OWNER}`;
    const turn = resolveTurn({ source: 'chat', isOwner: true, chatType: 'group', chatId: GROUP, senderOpenId: OWNER, profile: 'legacy', bizOn: false });
    assert.equal(turn.sessionKey, ownerKey);
    await m.runClaude(ownerKey, '你好', turn.private, [], null, { lane: 'chat', turn });
    const readArgv = () => fs.readFileSync(argvLog, 'utf8').split('ARGV-START\n').filter(Boolean).map((s) => s.split('\n').slice(0, -1));
    const first = readArgv();
    assert.equal(first.length, 1);
    assert.ok(!first[0].includes('--resume'), '新键没有会话，不 --resume');
    assert.ok(!first[0].includes('old-sid'), '更不会续老的群 chat_id 会话');

    // 对照：同群另一位访客的键有会话，能被续用 —— 证明上面不是「根本不会 resume」
    const guestKey = `guest:${GROUP}:${GUEST}`;
    await m.runClaude(guestKey, '你好', false, [], null, { lane: 'chat' });
    const second = readArgv()[1];
    assert.equal(second[second.indexOf('--resume') + 1], 'guest-sid');

    const saved = JSON.parse(fs.readFileSync(path.join(dirs.data, 'sessions.json'), 'utf8'));
    assert.equal(saved[GROUP], 'old-sid', '老条目原样留在文件里');
    assert.equal(saved[ownerKey], 's-new', '仓主在群里从此用新键');
  });
});

describe('T5 定时任务分档：目的地判定只有 schedDestOf 一处', () => {
  // 取 index.js 里真实的 schedTurnFor，注入 ownerDmChatId
  const fnSrc = cut('function schedTurnFor(source, job) {', '\n}\n', { inclusive: true });
  // eslint-disable-next-line no-new-func
  const make = (ownerDmChatId, profile = 'legacy', bizOn = false) => new Function('scope', `with (scope) {\n${fnSrc}\nreturn schedTurnFor;\n}`)(
    new Proxy({ resolveTurn, schedDestOf, ownerDmChatId, OWNER_TOOL_PROFILE: profile, BIZ_ON: bizOn }, {
      has: (t, k) => typeof k === 'string' && Object.hasOwn(t, k), get: (t, k) => (k === Symbol.unscopables ? undefined : t[k]),
    }));

  const cases = [
    ['发往 owner 私聊', DM, DM, 'sched-owner-dm', false, true],
    ['发往群', DM, GROUP, 'sched-other', false, false],
    ['owner 私聊未知（空）', '', GROUP, 'sched-other', true, false],
    ['owner 私聊未知（undefined）', undefined, DM, 'sched-other', true, false],
    ['格式不对的目的地', DM, 'oc_x', 'sched-other', false, false],
    ['缺目的地', DM, undefined, 'sched-other', false, false],
    ['非字符串目的地', DM, 12345, 'sched-other', false, false],
  ];
  for (const profile of ['legacy', 'audit', 'strict']) {
    for (const [name, ownerDm, dest, kind, destUnknown, priv] of cases) {
      test(`${name} → ${kind}（${profile}）`, () => {
        const f = make(ownerDm, profile);
        const t = f('sched', { _file: 'daily.json', chat_id: dest });
        assert.equal(t.kind, kind);
        assert.equal(t.private, priv);
        assert.equal(t.destUnknown, destUnknown);
        assert.equal(t.sessionKey, 'sched:daily.json');
        const d = f('sched-diag', { _file: 'daily.json', chat_id: dest });
        assert.equal(d.kind, priv ? 'sched-diag-owner-dm' : 'sched-diag-other', '自诊断与定时同一个目的地判定');
        assert.equal(d.private, priv);
        assert.equal(d.sessionKey, 'sched-diag:daily.json');
      });
    }
  }
  test('目的地已知但不是 owner 私聊 → destUnknown=false；owner 私聊 id 未知 → destUnknown=true', () => {
    assert.equal(make(DM)('sched', { _file: 'a.json', chat_id: GROUP }).destUnknown, false);
    assert.equal(make('')('sched', { _file: 'a.json', chat_id: GROUP }).destUnknown, true);
  });
  test('只有一处目的地判定：index.js 里 schedDestOf( 的调用恰好一次（另一处是 import）', () => {
    assert.equal(SRC.match(/schedDestOf\(/g).length, 1);
  });
});

test('A5：index.js 里每个 runClaude( 调用都显式带 turn', () => {
  const calls = [];
  for (let i = SRC.indexOf('runClaude('); i >= 0; i = SRC.indexOf('runClaude(', i + 1)) {
    let depth = 0; let j = i + 'runClaude'.length;
    for (; j < SRC.length; j += 1) {
      if (SRC[j] === '(') depth += 1;
      else if (SRC[j] === ')') { depth -= 1; if (depth === 0) break; }
    }
    calls.push(SRC.slice(i, j + 1));
  }
  assert.equal(calls.length, 3, '聊天 / 定时 / 定时自诊断');
  for (const c of calls) assert.match(c, /\bturn\b|turn: (schedTurn|diagTurn)/, c.slice(0, 80));
});

test('A5：outbox 目录按本轮 turn.private 选——聊天用（已收敛成 turn.private 的）isOwner，定时的成功 / 失败两条路径都用 schedTurn.private', () => {
  const args = [...SRC.matchAll(/outboxDirFor\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim()).filter((a) => !a.startsWith('chatId'));
  const calls = args.filter((a) => a !== 'chatId, isOwner');
  assert.deepEqual(calls.sort(), ['schedChatId, schedTurn.private', 'schedChatId, schedTurn.private', 'sessionKey, isOwner', 'sessionKey, isOwner'], calls.join(' | '));
  // 聊天路径的 isOwner 在 runTurn 里就是 turn.private（群里的 owner 因此是 false）
  assert.match(SRC, /const isOwner = turn\.private;/);
});
