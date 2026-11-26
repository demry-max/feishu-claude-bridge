// BRIDGE-STD-1 §3.2 / §3.3（C5 / W7）：过期只消费、启动与重连补拉、低频补漏
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  messageTime, backfillConfig, createIngest, createChatBook, mergeKnownChats,
  toEventShape, planBackfill, backfillWindow, createBackfill,
} from '../src/backfill.js';
import { createDedupeStore } from '../src/inbound-dedupe.js';
import { createInboundGuard } from '../src/inbound-guard.js';
import { BRIDGE_OWN_KEYS, childEnv } from '../src/child-env.js';

const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const MIN = 60_000;
const T0 = 1_700_000_000_000;
const P2P = 'oc_test0001';
const GROUP = 'oc_test0002';
const OWNER = 'ou_test0001';
const BOT = 'ou_bot0001';
const longId = (n) => ['om', `abcdef${n}`].join('_'); // 长的消息 id 运行时拼（源码里不放像真 id 的串）

const tmpDirs = []; // 随本测试进程退出清掉
process.once('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'std1-backfill-')); tmpDirs.push(d); return d; };
const mkClock = (t0 = T0) => { const k = { t: t0 }; k.now = () => k.t; return k; };
const sink = () => { const logs = []; return { logs, log: (s) => logs.push(String(s)) }; };
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

/** 消息列表接口的一项（字段照 SDK 类型定义 im.v1.message.list 的 items） */
const item = (id, atMs, over = {}) => ({
  message_id: id, msg_type: 'text', create_time: String(atMs), update_time: String(atMs), deleted: false, updated: false,
  chat_id: P2P, sender: { id: OWNER, id_type: 'open_id', sender_type: 'user', tenant_key: 'tk' },
  body: { content: JSON.stringify({ text: '正文' }) }, ...over,
});
const atBot = { key: '@_user_1', id: BOT, id_type: 'open_id', name: '机器人', tenant_key: 'tk' };
const groupItem = (id, atMs, over = {}) => item(id, atMs, { chat_id: GROUP, mentions: [atBot], ...over });
const page = (items, extra = {}) => ({ code: 0, msg: 'success', data: { items, has_more: false, ...extra } });
const eventOf = (it, chatType = 'p2p') => toEventShape(it, chatType);

// ---- 开关 ----------------------------------------------------------------------------------
test('开关缺省：补拉开、补漏 10 分钟、过期 10 分钟；空串按缺省、不记日志', () => {
  const { logs, log } = sink();
  assert.deepEqual(backfillConfig({}, log), { enabled: true, sweepMin: 10, staleMs: 600_000 });
  assert.deepEqual(backfillConfig({ BRIDGE_BACKFILL: ' ', BRIDGE_SWEEP_MIN: '', BRIDGE_STALE_MS: '' }, log), { enabled: true, sweepMin: 10, staleMs: 600_000 });
  assert.deepEqual(logs, []);
});

test('开关合法值：off 关总闸；补漏 0 或 5–60；过期 60000–86400000', () => {
  const { logs, log } = sink();
  assert.equal(backfillConfig({ BRIDGE_BACKFILL: 'off' }, log).enabled, false);
  assert.equal(backfillConfig({ BRIDGE_BACKFILL: 'on' }, log).enabled, true);
  for (const v of ['0', '5', '60']) assert.equal(backfillConfig({ BRIDGE_SWEEP_MIN: v }, log).sweepMin, Number(v), v);
  for (const v of ['60000', '86400000']) assert.equal(backfillConfig({ BRIDGE_STALE_MS: v }, log).staleMs, Number(v), v);
  assert.deepEqual(logs, []);
});

test('开关非法值：回落到缺省，每个记一行', () => {
  const cases = [
    ['BRIDGE_BACKFILL', ['yes', '1', 'constructor'], 'enabled', true],
    ['BRIDGE_SWEEP_MIN', ['4', '61', '-1', '7.5', 'abc'], 'sweepMin', 10],
    ['BRIDGE_STALE_MS', ['59999', '86400001', '6e5', '-60000', '十分钟'], 'staleMs', 600_000],
  ];
  for (const [key, values, field, dflt] of cases) {
    for (const v of values) {
      const { logs, log } = sink();
      assert.equal(backfillConfig({ [key]: v }, log)[field], dflt, `${key}=${v}`);
      assert.equal(logs.length, 1, `${key}=${v}`);
      assert.match(logs[0], new RegExp(`^\\[config\\] ${key} `));
    }
  }
});

test('开关键名归到桥接自己的键：不交给 claude 子进程；.env.example 加上这三行后防漂移测试也认得', () => {
  const names = [];
  backfillConfig(new Proxy({}, { get: (_, key) => { names.push(key); return undefined; } }), () => {});
  assert.deepEqual(names, ['BRIDGE_BACKFILL', 'BRIDGE_SWEEP_MIN', 'BRIDGE_STALE_MS']);
  for (const k of names) assert.ok(BRIDGE_OWN_KEYS.includes(k), `${k} 没归类（加进 src/child-env.js 的 BRIDGE_OWN_KEYS）`);
  assert.deepEqual(childEnv({ ...Object.fromEntries(names.map((k) => [k, '1'])), HOME: '/h' }), { HOME: '/h' });
});

// ---- 过期只消费 ----------------------------------------------------------------------------
function ingestRig({ staleMs = 600_000 } = {}) {
  const k = mkClock();
  const dir = tmp();
  const dedupe = createDedupeStore({ file: path.join(dir, 'seen.json'), now: k.now, log: () => {} });
  const handled = [];
  const seen = [];
  const { logs, log } = sink();
  const ingest = createIngest({
    dedupe, staleMs, now: k.now, log,
    handle: async (d) => { handled.push(d.message.message_id); return 'handled'; },
    onSeen: (m, at) => seen.push([m.message_id, at]),
  });
  return { k, dedupe, handled, seen, logs, ingest };
}

test('create_time：数字串 → 毫秒；缺失 / 空串 / 空白 / 非数字 → null（不当成 0）', () => {
  assert.equal(messageTime(String(T0)), T0);
  assert.equal(messageTime(T0), T0);
  for (const bad of [undefined, null, '', '  ', 'abc', NaN, Infinity, {}, true]) assert.equal(messageTime(bad), null, String(bad));
});

test('过期边界：now - create_time 刚好等于 staleMs 不算过期，多 1 毫秒就算', async () => {
  const r = ingestRig();
  await r.ingest(eventOf(item('om_a1', T0 - 600_000)), 'event');
  await r.ingest(eventOf(item('om_a2', T0 - 600_001)), 'event');
  assert.deepEqual(r.handled, ['om_a1']);
});

test('过期只消费：登记成已消费、不进处理链；日志带末 6 位、分钟数、来源，不带正文', async () => {
  const r = ingestRig();
  const id = longId('000123');
  assert.equal(await r.ingest(eventOf(item(id, T0 - 25 * MIN)), 'backfill'), undefined);
  assert.deepEqual(r.handled, []);
  assert.equal(r.dedupe.has(id), true);
  assert.deepEqual(r.logs, [`[stale] id=…000123 age=25m src=backfill`]);
  // 同一条再来（事件重推 / 下一轮补拉）：不再记第二行，仍不处理
  await r.ingest(eventOf(item(id, T0 - 25 * MIN)), 'event');
  assert.deepEqual(r.handled, []);
  assert.equal(r.logs.length, 1);
});

test('create_time 缺失或非数字：按不过期处理（交给处理链），记一行', async () => {
  for (const bad of [undefined, '', 'abc']) {
    const r = ingestRig();
    const data = eventOf(item('om_b1', T0));
    data.message.create_time = bad;
    assert.equal(await r.ingest(data, 'event'), 'handled');
    assert.deepEqual(r.handled, ['om_b1'], String(bad));
    assert.equal(r.logs.length, 1);
    assert.match(r.logs[0], /^\[stale\] id=…om_b1 create_time 缺失或无法识别，按不过期处理 src=event$/);
  }
});

test('onSeen：答了、过期、重复都回调（游标据此前移）；处理链的同步前段先于 onSeen', async () => {
  const k = mkClock();
  const order = [];
  const dedupe = createDedupeStore({ file: path.join(tmp(), 'seen.json'), now: k.now, log: () => {} });
  const ingest = createIngest({
    dedupe, now: k.now, log: () => {},
    handle: async (d) => { order.push(`handle:${d.message.message_id}`); dedupe.checkAndMark(d.message.message_id); },
    onSeen: (m, at) => order.push(`seen:${m.message_id}:${at}`),
  });
  await ingest(eventOf(item('om_c1', T0 - 1)), 'event');
  await ingest(eventOf(item('om_c2', T0 - 3_600_000)), 'event');
  await ingest(eventOf(item('om_c1', T0 - 1)), 'backfill');
  assert.deepEqual(order, [
    'handle:om_c1', `seen:om_c1:${T0 - 1}`,
    `seen:om_c2:${T0 - 3_600_000}`,
    'handle:om_c1', `seen:om_c1:${T0 - 1}`,
  ]);
});

test('没有 message 的数据：照样交给处理链（由它自己忽略），不回调 onSeen、不记日志', async () => {
  const r = ingestRig();
  const calls = [];
  const ingest = createIngest({ dedupe: r.dedupe, now: r.k.now, log: (s) => r.logs.push(s), handle: async (d) => calls.push(d), onSeen: () => r.seen.push('x') });
  await ingest({}, 'event');
  assert.equal(calls.length, 1);
  assert.deepEqual(r.seen, []);
  assert.deepEqual(r.logs, []);
});

// ---- 列表项 → 事件形状 ----------------------------------------------------------------------
test('toEventShape：文本消息——msg_type / body.content / sender.id 对到事件字段，chat_type 由调用方给', () => {
  assert.deepEqual(toEventShape(item('om_d1', T0, { root_id: 'om_r1', parent_id: 'om_p1', thread_id: 'th1' }), 'p2p'), {
    sender: { sender_id: { open_id: OWNER }, sender_type: 'user' },
    message: {
      message_id: 'om_d1', chat_id: P2P, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '正文' }),
      create_time: String(T0), mentions: undefined, parent_id: 'om_p1', root_id: 'om_r1', thread_id: 'th1',
    },
  });
});

test('toEventShape：@ 提及——列表接口的 id 是字符串加 id_type，事件里是 id.open_id；非 open_id 的提及不给 open_id', () => {
  const shaped = toEventShape(groupItem('om_d2', T0, { mentions: [atBot, { key: '@_user_2', id: 'uid-x', id_type: 'user_id', name: '同事' }] }), 'group');
  assert.equal(shaped.message.chat_type, 'group');
  assert.deepEqual(shaped.message.mentions, [
    { key: '@_user_1', id: { open_id: BOT }, name: '机器人' },
    { key: '@_user_2', id: { open_id: undefined }, name: '同事' },
  ]);
});

test('toEventShape：撤回、应用发送者、匿名、发送者 id 类型不是 open_id、缺 message_id、系统消息 → null', () => {
  const nulls = {
    deleted: item('om_e1', T0, { deleted: true }),
    app: item('om_e2', T0, { sender: { id: 'cli_x', id_type: 'app_id', sender_type: 'app' } }),
    anonymous: item('om_e3', T0, { sender: { id: '', id_type: '', sender_type: 'anonymous' } }),
    userId: item('om_e4', T0, { sender: { id: 'u1', id_type: 'user_id', sender_type: 'user' } }),
    noSender: item('om_e5', T0, { sender: undefined }),
    noId: item(undefined, T0),
    system: item('om_e6', T0, { msg_type: 'system' }),
  };
  for (const [name, it] of Object.entries(nulls)) assert.equal(toEventShape(it, 'p2p'), null, name);
  assert.equal(toEventShape(undefined, 'p2p'), null);
});

// ---- planBackfill / 窗口 ------------------------------------------------------------------
test('planBackfill：按 create_time 升序；去重表里的跳过；过期的也交给入口（打标）；游标取看过的最大值', () => {
  const items = [item('om_f3', T0 - 1), item('om_f1', T0 - 20 * MIN), item('om_f2', T0 - 2 * MIN), item('om_f4', T0 - 3 * MIN)];
  const plan = planBackfill({ items, cursorMs: T0 - 30 * MIN, now: T0, staleMs: 600_000, has: (id) => id === 'om_f4', chatKind: 'p2p' });
  assert.deepEqual(plan.deliver.map((d) => [d.data.message.message_id, d.stale]), [['om_f1', true], ['om_f2', false], ['om_f3', false]]);
  assert.equal(plan.skipped.dup, 1);
  assert.equal(plan.newCursorMs, T0 - 1);
});

test('planBackfill：群里没 @ 机器人的跳过（不交付，也就不进去重表），@ 了别人也算没 @；游标照样越过它们', () => {
  const asked = [];
  const items = [
    groupItem('om_g1', T0 - 5000, { mentions: undefined }),
    groupItem('om_g2', T0 - 4000, { mentions: [{ key: '@_user_1', id: 'ou_other001', id_type: 'open_id', name: '别人' }] }),
    groupItem('om_g3', T0 - 3000),
    groupItem('om_g4', T0 - 2000, { mentions: undefined }),
  ];
  const plan = planBackfill({ items, cursorMs: 0, now: T0, staleMs: 600_000, has: (id) => { asked.push(id); return false; }, botOpenId: BOT, chatKind: 'group' });
  assert.deepEqual(plan.deliver.map((d) => d.data.message.message_id), ['om_g3']);
  assert.equal(plan.skipped.noAt, 3);
  assert.equal(plan.newCursorMs, T0 - 2000);
  // 没拿到机器人 id 时群消息一条都不算 @ 机器人
  assert.equal(planBackfill({ items, cursorMs: 0, now: T0, staleMs: 600_000, has: () => false, botOpenId: undefined, chatKind: 'group' }).deliver.length, 0);
});

test('planBackfill：撤回 / 应用消息不交付但算看过；游标不倒退；create_time 缺失的排在最后、不算过期', () => {
  const items = [item('om_h1', T0, { create_time: undefined }), item('om_h2', T0 - 1000, { deleted: true }), item('om_h3', T0 - 30 * MIN)];
  const plan = planBackfill({ items, cursorMs: T0, now: T0, staleMs: 600_000, has: () => false, chatKind: 'p2p' });
  assert.deepEqual(plan.deliver.map((d) => [d.data.message.message_id, d.stale]), [['om_h3', true], ['om_h1', false]]);
  assert.equal(plan.skipped.unsupported, 1);
  assert.equal(plan.newCursorMs, T0, '游标不倒退');
});

test('窗口：start_time = floor(max(游标, now - stale) / 1000) - 1；游标落后超过 stale 才算截断', () => {
  const now = T0 + 999;
  assert.deepEqual(backfillWindow({ cursorMs: now - 60_000, now, staleMs: 600_000 }), { startSec: Math.floor((now - 60_000) / 1000) - 1, truncatedMs: 0 });
  assert.deepEqual(backfillWindow({ cursorMs: now - 900_000, now, staleMs: 600_000 }), { startSec: Math.floor((now - 600_000) / 1000) - 1, truncatedMs: 300_000 });
  assert.deepEqual(backfillWindow({ cursorMs: 0, now, staleMs: 600_000 }), { startSec: Math.floor((now - 600_000) / 1000) - 1, truncatedMs: 0 });
});

// ---- 会话游标表 / 已知会话 ------------------------------------------------------------------
test('会话游标表：note 记活跃时间并前移游标；落盘 { v:1, chats }，0600，重启读回', () => {
  const k = mkClock();
  const file = path.join(tmp(), 'data', 'inbound-cursor.json');
  const book = createChatBook({ file, now: k.now, log: () => {} });
  book.note(P2P, 'p2p', T0 - 10);
  k.t += 100;
  book.note(P2P, 'p2p', T0 - 50); // 更早的消息：活跃时间更新，游标不倒退
  book.note(GROUP, 'topic_group', null); // 缺时间：只记活跃
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    v: 1,
    chats: {
      [P2P]: { kind: 'p2p', cursorMs: T0 - 10, lastSeenMs: T0 + 100 },
      [GROUP]: { kind: 'group', cursorMs: 0, lastSeenMs: T0 + 100 },
    },
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = createChatBook({ file, now: k.now, log: () => {} });
  assert.equal(again.cursor(P2P), T0 - 10);
  assert.equal(again.cursor('oc_test0009'), 0);
});

test('会话游标表：advance 只前移游标，不算「发过消息」；7 天外的不在 recent 里', () => {
  const k = mkClock();
  const book = createChatBook({ file: path.join(tmp(), 'c.json'), now: k.now, log: () => {} });
  book.advance(GROUP, 'group', T0);
  assert.equal(book.cursor(GROUP), T0);
  assert.deepEqual(book.recent(), []);
  book.advance(GROUP, 'group', T0 - 5);
  assert.equal(book.cursor(GROUP), T0);
  book.note(P2P, 'p2p', T0);
  assert.deepEqual(book.recent(), [{ chatId: P2P, kind: 'p2p' }]);
  k.t += 7 * 24 * 3600 * 1000;
  assert.deepEqual(book.recent(), [{ chatId: P2P, kind: 'p2p' }]);
  k.t += 1;
  assert.deepEqual(book.recent(), []);
});

test('会话游标表：上限 50 个，按最近活跃淘汰', () => {
  const k = mkClock();
  const book = createChatBook({ file: path.join(tmp(), 'c.json'), now: k.now, log: () => {} });
  const id = (i) => `oc_test${String(i).padStart(4, '0')}x`;
  for (let i = 0; i < 50; i += 1) { k.t += 1; book.note(id(i), 'group', k.t); }
  k.t += 1; book.note(id(0), 'group', k.t); // 最早进来的又活跃了
  k.t += 1; book.note(id(50), 'group', k.t);
  const ids = book.recent().map((c) => c.chatId);
  assert.equal(ids.length, 50);
  assert.ok(ids.includes(id(0)) && ids.includes(id(50)));
  assert.ok(!ids.includes(id(1)), '最久没活跃的被淘汰');
});

test('会话游标表：损坏按空表起步记一行；写失败不抛、内存照记、日志每小时最多一行且不带 id', () => {
  const dir = tmp();
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(file, '{oops');
  const a = sink();
  assert.equal(createChatBook({ file, log: a.log }).cursor(P2P), 0);
  assert.equal(a.logs.length, 1);
  const k = mkClock();
  const b = sink();
  const brokenFs = {
    readFileSync: () => { throw Object.assign(new Error('nf'), { code: 'ENOENT' }); },
    mkdirSync() {}, chmodSync() {}, rmSync() {}, renameSync() {},
    writeFileSync: () => { throw Object.assign(new Error(`disk ${P2P}`), { code: 'ENOSPC' }); },
  };
  const book = createChatBook({ file, fs: brokenFs, now: k.now, log: b.log });
  book.note(P2P, 'p2p', T0);
  book.note(P2P, 'p2p', T0 + 1);
  assert.equal(book.cursor(P2P), T0 + 1);
  assert.equal(b.logs.length, 1);
  assert.match(b.logs[0], /ENOSPC/);
  assert.ok(!b.logs[0].includes(P2P));
  k.t += 3600 * 1000;
  book.note(P2P, 'p2p', T0 + 2);
  assert.equal(b.logs.length, 2);
});

test('已知会话：owner 私聊 ＋ 7 天内发过消息的 ＋ ALLOW_CHATS 群；同一个只列一次，owner 私聊在最前', () => {
  assert.deepEqual(mergeKnownChats({
    ownerDmChatId: P2P,
    recent: [{ chatId: 'oc_test0003', kind: 'p2p' }, { chatId: P2P, kind: 'p2p' }, { chatId: GROUP, kind: 'group' }],
    allowChats: [GROUP, 'oc_test0004', P2P],
  }), [
    { chatId: P2P, kind: 'p2p' }, { chatId: 'oc_test0003', kind: 'p2p' },
    { chatId: GROUP, kind: 'group' }, { chatId: 'oc_test0004', kind: 'group' },
  ]);
  assert.deepEqual(mergeKnownChats({ ownerDmChatId: null }), []);
});

// ---- 运行部分 -----------------------------------------------------------------------------
/** 假定时器：只要 setInterval */
function fakeIntervals() {
  const list = [];
  return {
    list,
    setInterval: (fn, ms) => { const h = { fn, ms, unrefCalled: false, unref() { h.unrefCalled = true; return h; } }; list.push(h); return h; },
  };
}
/**
 * 补拉台架：真的去重表 + 真的游标表 + createIngest；处理链是「先同步判重、再记一次副作用」（与 handleMessage 开头同形）。
 * listMessages：respond(chatId, params, 第几次调用) 给回应
 */
function rig({ chats = [{ chatId: P2P, kind: 'p2p' }], respond = () => page([]), botId = BOT, isDraining, dir = tmp(), clock = mkClock(), enabled, sweepMin, staleMs = 600_000, handle } = {}) {
  const { logs, log } = sink();
  const dedupe = createDedupeStore({ file: path.join(dir, 'inbound-seen.json'), now: clock.now, log });
  const book = createChatBook({ file: path.join(dir, 'inbound-cursor.json'), now: clock.now, log });
  const effects = [];
  const ingest = createIngest({
    dedupe, staleMs, now: clock.now, log,
    handle: handle ?? (async (d) => { if (dedupe.checkAndMark(d.message.message_id)) return; await tick(); effects.push(d.message.message_id); }),
    onSeen: (m, at) => book.note(m.chat_id, m.chat_type, at),
  });
  const calls = [];
  const timers = fakeIntervals();
  const botCalls = [];
  const backfill = createBackfill({
    listMessages: async (params) => { calls.push(params); return respond(params.container_id, params, calls.length); },
    knownChats: () => chats, ingest, dedupe, book, staleMs, enabled, sweepMin, timers, now: clock.now, log,
    getBotOpenId: async () => { botCalls.push(1); return botId; },
    ...(isDraining ? { isDraining } : {}),
  });
  return { backfill, ingest, dedupe, book, effects, calls, logs, log, timers, botCalls, clock, dir };
}

test('一轮：列表参数照卡片；按顺序交付；游标前移并落盘；非定时触发记一行小结', async () => {
  const r = rig({ respond: () => page([item('om_i2', T0 - MIN), item('om_i1', T0 - 2 * MIN), item('om_i3', T0 - 30 * MIN)]) });
  r.book.advance(P2P, 'p2p', T0 - 3 * MIN);
  await r.backfill.run('ready');
  assert.deepEqual(r.calls, [{ container_id_type: 'chat', container_id: P2P, start_time: String(Math.floor((T0 - 3 * MIN) / 1000) - 1), sort_type: 'ByCreateTimeAsc', page_size: 50 }]);
  assert.deepEqual(r.effects, ['om_i1', 'om_i2']);
  assert.equal(r.book.cursor(P2P), T0 - MIN);
  assert.ok(r.logs.includes('[backfill] reason=ready 会话 1 个，交给入口 3 条（过期 1），失败 0 个'), r.logs.join('\n'));
});

test('定时补漏没东西可交付时不记小结（不刷屏）', async () => {
  const r = rig();
  await r.backfill.run('sweep');
  assert.deepEqual(r.logs, []);
});

test('单飞：重连风暴连续触发 5 次，只跑 1 + 1 轮', async () => {
  const gate = deferred();
  const r = rig({ respond: async (chatId, params, n) => { if (n === 1) await gate.promise; return page([]); } });
  const all = [1, 2, 3, 4, 5].map(() => r.backfill.run('reconnected'));
  await tick();
  assert.equal(r.calls.length, 1);
  gate.resolve();
  await Promise.all(all);
  assert.equal(r.calls.length, 2);
  assert.equal(r.logs.filter((l) => l.includes('上一轮还在跑')).length, 1);
  await r.backfill.run('reconnected'); // 跑完之后能再触发
  assert.equal(r.calls.length, 3);
});

test('游标在触发那一刻取快照：之后到达的新事件前移游标，不会让本轮跳过断线期间的消息', async () => {
  const gate = deferred();
  const chats = [{ chatId: P2P, kind: 'p2p' }, { chatId: 'oc_test0003', kind: 'p2p' }];
  const r = rig({ chats, respond: async (chatId, params, n) => { if (n === 1) await gate.promise; return page([]); } });
  r.book.advance('oc_test0003', 'p2p', T0 - 5 * MIN);
  const done = r.backfill.run('reconnected');
  r.book.note('oc_test0003', 'p2p', T0 - 1); // 重连后马上来了一条新事件
  gate.resolve();
  await done;
  assert.equal(r.calls[1].start_time, String(Math.floor((T0 - 5 * MIN) / 1000) - 1));
});

test('排队的补一轮：多次触发合并，每个会话取最早的游标快照', async () => {
  const gate = deferred();
  const r = rig({ respond: async (chatId, params, n) => { if (n === 1) await gate.promise; return page([]); } });
  r.book.advance(P2P, 'p2p', T0 - 9 * MIN);
  const a = r.backfill.run('ready');
  r.book.advance(P2P, 'p2p', T0 - 8 * MIN);
  r.backfill.run('reconnected');
  r.book.advance(P2P, 'p2p', T0 - 7 * MIN);
  r.backfill.run('sweep');
  gate.resolve();
  await a;
  assert.deepEqual(r.calls.map((c) => c.start_time), [9, 8].map((m) => String(Math.floor((T0 - m * MIN) / 1000) - 1)));
  assert.ok(r.logs.some((l) => l.startsWith('[backfill] reason=reconnected ')), '合并后仍按重连记小结');
});

test('进入退出流程：不再拉取、不再交付，游标不越过没交付的那条', async () => {
  let draining = false;
  const r = rig({
    chats: [{ chatId: P2P, kind: 'p2p' }, { chatId: 'oc_test0003', kind: 'p2p' }],
    isDraining: () => draining,
    respond: () => page([item('om_j1', T0 - 2 * MIN), item('om_j2', T0 - MIN)]),
    handle: async (d) => { r.effects.push(d.message.message_id); draining = true; },
  });
  await r.backfill.run('ready');
  assert.deepEqual(r.effects, ['om_j1']);
  assert.equal(r.calls.length, 1);
  assert.equal(r.book.cursor(P2P), T0 - 2 * MIN);
  await r.backfill.run('sweep');
  assert.equal(r.calls.length, 1, '退出中的触发什么也不拉');
});

test('单个会话失败：其他会话照常；日志带飞书 code、不带 chat_id；连续失败每小时最多一行，成功后重新计', async () => {
  const clock = mkClock();
  let mode = 'axios';
  const r = rig({
    clock,
    chats: [{ chatId: P2P, kind: 'p2p' }, { chatId: 'oc_test0003', kind: 'p2p' }],
    respond: (chatId) => {
      if (chatId !== P2P || mode === 'ok') return page([item(`om_k_${chatId.slice(-1)}_${clock.t}`, clock.t - 1, { chat_id: chatId })]);
      if (mode === 'axios') throw Object.assign(new Error(`Request failed ${chatId}`), { code: 'ERR_BAD_REQUEST', response: { data: { code: 99991672, msg: 'no permission' } } });
      return { code: 230027, msg: `lack of permission ${chatId}` };
    },
  });
  const fails = () => r.logs.filter((l) => l.startsWith('[backfill] 拉取失败'));
  await r.backfill.run('ready');
  assert.equal(r.effects.length, 1, '另一个会话照常交付');
  assert.deepEqual(fails(), ['[backfill] 拉取失败（p2p）code=99991672']);
  mode = 'body';
  clock.t += 30 * MIN;
  await r.backfill.run('sweep');
  assert.equal(fails().length, 1, '一小时内不重复');
  clock.t += 30 * MIN;
  await r.backfill.run('sweep');
  assert.deepEqual(fails().slice(1), ['[backfill] 拉取失败（p2p）code=230027']);
  mode = 'ok';
  await r.backfill.run('sweep');
  mode = 'body';
  await r.backfill.run('sweep');
  assert.equal(fails().length, 3, '成功一次之后重新计时');
  assert.ok(!r.logs.join('\n').includes('oc_'));
});

test('分页：每个会话每轮最多 3 页，带上一页的 page_token；还有剩余记一行就停', async () => {
  const r = rig({ respond: (chatId, params, n) => page([item(`om_l${n}`, T0 - (10 - n) * 1000)], { has_more: true, page_token: `pt${n}` }) });
  await r.backfill.run('ready');
  assert.deepEqual(r.calls.map((c) => c.page_token), [undefined, 'pt1', 'pt2']);
  assert.deepEqual(r.effects, ['om_l1', 'om_l2', 'om_l3']);
  assert.equal(r.logs.filter((l) => l.includes('超过 3 页')).length, 1);
});

test('分页：has_more 为 false 就停；第 2 页失败时第 1 页已交付、游标停在第 1 页末尾', async () => {
  const r = rig({
    respond: (chatId, params, n) => {
      if (n === 1) return page([item('om_m1', T0 - 2 * MIN)], { has_more: true, page_token: 'pt1' });
      throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    },
  });
  await r.backfill.run('ready');
  assert.deepEqual(r.effects, ['om_m1']);
  assert.equal(r.book.cursor(P2P), T0 - 2 * MIN);
  assert.ok(r.logs.includes('[backfill] 拉取失败（p2p）code=ECONNRESET'));
});

test('群：取不到机器人 open_id 就跳过本轮群补拉、记一行；私聊照常；一轮只查一次', async () => {
  const r = rig({
    botId: null,
    chats: [{ chatId: GROUP, kind: 'group' }, { chatId: P2P, kind: 'p2p' }, { chatId: 'oc_test0004', kind: 'group' }],
    respond: () => page([item('om_n1', T0 - MIN)]),
  });
  await r.backfill.run('ready');
  assert.deepEqual(r.calls.map((c) => c.container_id), [P2P]);
  assert.deepEqual(r.effects, ['om_n1']);
  assert.equal(r.botCalls.length, 1);
  assert.equal(r.logs.filter((l) => l.includes('取不到机器人 open_id')).length, 1);
});

test('群：拿得到机器人 id 时只交付 @ 机器人的，按群形状给事件', async () => {
  const got = [];
  const r = rig({
    chats: [{ chatId: GROUP, kind: 'group' }],
    respond: () => page([groupItem('om_o1', T0 - 2000, { mentions: undefined }), groupItem('om_o2', T0 - 1000)]),
    handle: async (d) => got.push(d),
  });
  await r.backfill.run('ready');
  assert.deepEqual(got.map((d) => [d.message.message_id, d.message.chat_type]), [['om_o2', 'group']]);
  assert.equal(r.dedupe.has('om_o1'), false);
  assert.equal(r.book.cursor(GROUP), T0 - 1000);
});

test('窗口截到 stale 记一行（不带 id），同一个游标位置只记一次', async () => {
  const r = rig({});
  r.book.advance(P2P, 'p2p', T0 - 45 * MIN);
  await r.backfill.run('ready');
  r.clock.t += 10 * MIN;
  await r.backfill.run('sweep');
  assert.deepEqual(r.logs.filter((l) => l.includes('窗口截到')), ['[backfill] 窗口截到 stale，约 35 分钟未拉']);
});

test('开关：off 时启动与重连都不拉、不挂定时器；SWEEP=0 只关补漏；缺省每 10 分钟且 unref', async () => {
  const off = rig({ enabled: false });
  off.backfill.start();
  await off.backfill.run('ready');
  await off.backfill.run('reconnected');
  assert.equal(off.calls.length, 0);
  assert.equal(off.timers.list.length, 0);
  const noSweep = rig({ sweepMin: 0 });
  noSweep.backfill.start();
  await noSweep.backfill.run('ready');
  assert.equal(noSweep.timers.list.length, 0);
  assert.equal(noSweep.calls.length, 1);
  const dflt = rig({});
  dflt.backfill.start();
  dflt.backfill.start();
  assert.equal(dflt.timers.list.length, 1);
  assert.equal(dflt.timers.list[0].ms, 10 * MIN);
  assert.equal(dflt.timers.list[0].unrefCalled, true);
  dflt.timers.list[0].fn();
  await tick();
  assert.equal(dflt.calls.length, 1);
});

// ---- 不重答：用 index.js 里真实的 isDuplicate 段 + 落盘去重表 ------------------------------
function realEntry(dedupe) {
  const a = SRC.indexOf('function isDuplicate(messageId) {');
  const b = SRC.indexOf('// ---- 每个会话串行处理', a);
  assert.ok(a > 0 && b > a, 'index.js 里找不到 isDuplicate 段');
  const scope = { dedupe, createInboundGuard, reply: async () => {}, console: { log() {}, error() {} } };
  // eslint-disable-next-line no-new-func
  return new Function('scope', `with (scope) {\n${SRC.slice(a, b)}\nreturn { isDuplicate, inboundGuard };\n}`)(scope);
}
function realRig({ dir = tmp(), respond } = {}) {
  const effects = [];
  const clock = mkClock();
  const store = createDedupeStore({ file: path.join(dir, 'inbound-seen.json'), now: clock.now, log: () => {} });
  const { isDuplicate, inboundGuard } = realEntry(store);
  // 与 handleMessage 开头同形：第一句同步判重，之后才有 await 和副作用
  const handleMessage = async (d) => { if (isDuplicate(d.message.message_id)) return; await tick(); effects.push(d.message.message_id); };
  const ingest = createIngest({ dedupe: store, now: clock.now, log: () => {}, handle: (d) => inboundGuard(d, handleMessage) });
  const book = createChatBook({ file: path.join(dir, 'inbound-cursor.json'), now: clock.now, log: () => {} });
  const backfill = createBackfill({
    listMessages: async () => respond(), knownChats: () => [{ chatId: P2P, kind: 'p2p' }], ingest, dedupe: store, book,
    getBotOpenId: async () => BOT, now: clock.now, log: () => {},
  });
  return { effects, ingest, backfill, dir };
}
const dupItem = () => item(longId('dup001'), T0 - MIN);

test('不重答：同一条先走事件、再被补拉（以及反过来），副作用都只有 1 次', async () => {
  const a = realRig({ respond: () => page([dupItem()]) });
  await a.ingest(eventOf(dupItem()), 'event');
  await a.backfill.run('reconnected');
  assert.equal(a.effects.length, 1);
  const b = realRig({ respond: () => page([dupItem()]) });
  await b.backfill.run('ready');
  await b.ingest(eventOf(dupItem()), 'event');
  assert.equal(b.effects.length, 1);
});

test('不重答：事件和补拉并发送到，副作用只有 1 次', async () => {
  for (const eventFirst of [true, false]) {
    const gate = deferred();
    const r = realRig({ respond: async () => { await gate.promise; return page([dupItem()]); } });
    const fromBackfill = r.backfill.run('reconnected');
    if (eventFirst) { const p = r.ingest(eventOf(dupItem()), 'event'); gate.resolve(); await Promise.all([p, fromBackfill]); } else {
      gate.resolve(); await tick(); const p = r.ingest(eventOf(dupItem()), 'event'); await Promise.all([p, fromBackfill]);
    }
    assert.equal(r.effects.length, 1, `eventFirst=${eventFirst}`);
  }
});

test('不重答：「重启」后（同一目录重建去重表）补拉同一条，0 次', async () => {
  const dir = tmp();
  const before = realRig({ dir, respond: () => page([]) });
  await before.ingest(eventOf(dupItem()), 'event');
  assert.equal(before.effects.length, 1);
  const after = realRig({ dir, respond: () => page([dupItem()]) });
  await after.backfill.run('ready');
  await after.ingest(eventOf(dupItem()), 'event');
  assert.equal(after.effects.length, 0);
});

// ---- 接线：长连接回调触发补拉；断网演练 ------------------------------------------------------
/** 把 index.js 里 new lark.WSClient({…}) 那段拿出来跑，拿到真实的回调 */
function realWsCallbacks(scopeExtras) {
  const a = SRC.indexOf('const wsClient = new lark.WSClient({');
  const b = SRC.indexOf('\n});', a);
  assert.ok(a > 0 && b > a);
  let options;
  const scope = {
    lark: { WSClient: class { constructor(o) { options = o; } }, LoggerLevel: { info: 3 } },
    APP_ID: 'cli_t01', APP_SECRET: 'x', DOMAIN: 0, process: { env: {} }, bailOut: () => {}, ...scopeExtras,
  };
  // eslint-disable-next-line no-new-func
  new Function('scope', `with (scope) {\n${SRC.slice(a, b + 4)}\n}`)(scope);
  return options;
}

test('接线：onReady → 补拉 ready；onReconnected → 补拉 reconnected；onReconnecting 不拉', () => {
  const runs = [];
  const w = [];
  const cb = realWsCallbacks({
    backfill: { run: (reason) => runs.push(reason) },
    wsWatchdog: { ready: () => w.push('ready'), reconnecting: () => w.push('reconnecting'), reconnected: () => w.push('reconnected') },
    console: { log() {}, error() {} },
  });
  cb.onReady();
  cb.onReconnecting();
  assert.deepEqual(runs, ['ready']);
  cb.onReconnected();
  assert.deepEqual(runs, ['ready', 'reconnected']);
  assert.deepEqual(w, ['ready', 'reconnecting', 'reconnected']);
});

test('接线：去重表和补拉都在长连接启动之前建好；补拉用独立的静默日志客户端', () => {
  const start = SRC.indexOf('wsClient.start(');
  for (const needle of ['createDedupeStore(', 'createChatBook(', 'createBackfill(', 'createIngest(']) {
    const at = SRC.indexOf(needle);
    assert.ok(at > 0 && at < start, needle);
  }
  assert.match(SRC, /loggerLevel: lark\.LoggerLevel\.fatal/);
  const from = SRC.indexOf('createBackfill({');
  const wiring = SRC.slice(from, SRC.indexOf('\n});', from));
  assert.match(wiring, /isDraining: \(\) => shutdown\.isDraining\(\)/);
  assert.match(wiring, /listMessages: \(params\) => backfillClient\.im\.v1\.message\.list\(\{ params \}\)/);
  assert.ok(SRC.indexOf('backfill.start();') > start, '补漏定时器在长连接启动之后开');
});

test('断网演练：断网时补漏失败只记 code；重连后跑一轮——没超过 stale 的交付、超过的只消费，日志里看得到重连', async () => {
  const clock = mkClock();
  let net = 'down';
  const outage = () => [
    item('om_p1', clock.t - 12 * MIN), // 超过 10 分钟
    item('om_p2', clock.t - 2 * MIN),
  ];
  const r = rig({
    clock,
    respond: () => {
      if (net === 'down') throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      return page(outage());
    },
  });
  r.book.advance(P2P, 'p2p', clock.t);
  const wd = [];
  const cb = realWsCallbacks({
    backfill: r.backfill,
    wsWatchdog: { ready: () => wd.push('ready'), reconnecting: () => wd.push('reconnecting'), reconnected: () => wd.push('reconnected') },
    console: { log: r.log, error: r.log },
  });
  r.backfill.start();
  cb.onReconnecting();
  clock.t += 9 * MIN;
  r.timers.list[0].fn(); // 断网期间补漏到点
  await tick();
  assert.ok(r.logs.includes('[backfill] 拉取失败（p2p）code=ETIMEDOUT'));
  net = 'up';
  clock.t += 4 * MIN;
  const before = r.calls.length;
  cb.onReconnected();
  await tick();
  await tick();
  await tick();
  assert.equal(r.calls.length - before, 1, '补拉跑一轮');
  assert.deepEqual(r.effects, ['om_p2']);
  assert.equal(r.dedupe.has('om_p1'), true);
  assert.ok(r.logs.some((l) => l.startsWith('[stale] id=…om_p1 ') && l.endsWith('src=backfill')));
  assert.ok(r.logs.includes('[ws] 重连中（第 ? 次）'));
  assert.ok(r.logs.includes('[ws] 已重连'));
  assert.ok(r.logs.some((l) => l.startsWith('[backfill] reason=reconnected ')));
});
