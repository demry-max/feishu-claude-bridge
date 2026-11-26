// BRIDGE-STD-1 §3.4（W9）：启动自证——App ID 形状、onReady 看门狗、连续失败阶梯（从 index.js 原样搬出）、60 秒巡检
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertAppIdShape, createExitLadder, failFast, createReadyWatchdog, inspectConnection, BACKOFF_LADDER } from '../src/ws-watchdog.js';

/** 假定时器 + 虚拟时钟：advance(ms) 按时间顺序触发到点的回调 */
function fakeTimers() {
  const k = { t: 1_000_000, list: [], seq: 0 };
  k.now = () => k.t;
  k.setTimeout = (fn, ms) => {
    const h = { id: ++k.seq, fn, at: k.t + ms, ms, unrefCalled: false, cleared: false, unref() { h.unrefCalled = true; return h; } };
    k.list.push(h);
    return h;
  };
  k.clearTimeout = (h) => { if (h) h.cleared = true; };
  k.advance = (ms) => {
    const end = k.t + ms;
    for (;;) {
      const due = k.list.filter((h) => !h.cleared && !h.fired && h.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      k.t = due.at; due.fired = true; due.fn();
    }
    k.t = end;
  };
  k.active = () => k.list.filter((h) => !h.cleared && !h.fired);
  return k;
}
// 阶梯构造时先排一个 5 分钟清零定时器（list[0]）；之后每次 bailOut 排的退出定时器都在它后面
const exitTimersOf = (tm) => tm.list.slice(1);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'std1-ladder-')), 'bail-count.json');

test('assertAppIdShape：以 cli_ 开头且不含空白才过；错误文本不含 App ID 本身', () => {
  assert.equal(assertAppIdShape('cli_t01'), null); // 假 ID 写短，脱敏门不把它当真的
  for (const bad of ['', undefined, null, 'ou_test0001', ' cli_t01', 'cli_t 01', 'cli_', 'CLI_t01', 12345]) {
    const msg = assertAppIdShape(bad);
    assert.equal(typeof msg, 'string', JSON.stringify(bad));
    assert.match(msg, /形状不对：应以 cli_ 开头/);
  }
  const leaky = 'ou_SecretLooking123';
  assert.ok(!assertAppIdShape(leaky).includes(leaky));
  assert.ok(!assertAppIdShape(leaky).includes('SecretLooking'));
});

test('阶梯：与 index.js 原来的行为一致——15s → 60s → 5m → 15m，跨重启累积，count 文件 { n, at }', () => {
  assert.deepEqual(BACKOFF_LADDER, [15_000, 60_000, 300_000, 900_000]);
  const file = tmpFile();
  const waits = [];
  for (let i = 0; i < 6; i += 1) { // 每次相当于一次新进程：新的 ladder、新的定时器
    const tm = fakeTimers();
    const logs = [];
    const ladder = createExitLadder({ file, now: tm.now, timers: tm, exit: () => {}, log: (s) => logs.push(s) });
    ladder.bailOut(`原因${i}`);
    const t = exitTimersOf(tm)[0];
    waits.push(t.ms);
    assert.match(logs[0], new RegExp(`^\\[exit\\] 原因${i}（第 ${Math.min(i + 1, 99)} 次连续失败，${t.ms / 1000}s 后退出）$`));
  }
  assert.deepEqual(waits, [15_000, 60_000, 300_000, 900_000, 900_000, 900_000]);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.n, 6);
  assert.equal(typeof doc.at, 'number');
});

test('阶梯：调用方给的延迟比阶梯长就用调用方的；exiting 守卫——只排一个退出定时器、只记一行；到点 exit(1)', () => {
  const tm = fakeTimers();
  const exits = [];
  const logs = [];
  const ladder = createExitLadder({ file: tmpFile(), now: tm.now, timers: tm, exit: (c) => exits.push(c), log: (s) => logs.push(s) });
  ladder.bailOut('第一次', 20_000);
  ladder.bailOut('第二次', 0);
  const exitTimers = exitTimersOf(tm);
  assert.equal(exitTimers.length, 1);
  assert.equal(exitTimers[0].ms, 20_000);
  assert.equal(logs.length, 1);
  tm.advance(19_999);
  assert.deepEqual(exits, []);
  tm.advance(1);
  assert.deepEqual(exits, [1]);
});

test('阶梯：起来超过 5 分钟才失败 → 算第 1 次、不累加 count；5 分钟的清零定时器存在且 unref，到点删 count 文件', () => {
  const tm = fakeTimers();
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ n: 3, at: 1 }));
  const ladder = createExitLadder({ file, now: tm.now, timers: tm, exit: () => {}, log: () => {} });
  const reset = tm.list[0];
  assert.equal(reset.ms, 5 * 60 * 1000, '清零定时器');
  assert.equal(reset.unrefCalled, true);
  tm.t += 5 * 60 * 1000 + 1; // 稳定跑了 5 分钟多
  ladder.bailOut('稳定后才断');
  assert.equal(exitTimersOf(tm)[0].ms, 15_000, '第 1 次：15s');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 3, '没动 count（5 分钟那个定时器会清它）');
  reset.fn();
  assert.equal(fs.existsSync(file), false);
});

test('阶梯：退出定时器默认 unref；{ ref: true } 不 unref（启动早期没有别的东西撑着事件循环）', () => {
  const t1 = fakeTimers();
  createExitLadder({ file: tmpFile(), now: t1.now, timers: t1, exit: () => {}, log: () => {} }).bailOut('x');
  assert.equal(exitTimersOf(t1)[0].unrefCalled, true);
  const t2 = fakeTimers();
  createExitLadder({ file: tmpFile(), now: t2.now, timers: t2, exit: () => {}, log: () => {} }).bailOut('x', 0, { ref: true });
  assert.equal(exitTimersOf(t2)[0].unrefCalled, false);
});

test('failFast（凭据缺失 / App ID 形状不对的早退路径）：走阶梯、不 unref、不是裸 exit(1)', () => {
  const tm = fakeTimers();
  const exits = [];
  const logs = [];
  const ladder = createExitLadder({ file: tmpFile(), now: tm.now, timers: tm, exit: (c) => exits.push(c), log: (s) => logs.push(s) });
  failFast(ladder, '缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，请检查 .env', { log: (s) => logs.push(s) });
  assert.deepEqual(exits, [], '不是立刻退出');
  const t = exitTimersOf(tm)[0];
  assert.ok(t, '排了退出定时器');
  assert.equal(t.unrefCalled, false, '不能 unref：顶层 await 一直不返回，unref 了 Node 会以 13 退出而不是 1');
  assert.ok(logs.some((l) => l.includes('缺少 FEISHU_APP_ID')));
  tm.advance(15_000);
  assert.deepEqual(exits, [1]);
});

test('index.js 早退路径：凭据缺失与形状不对都走 failFast，然后永不返回的顶层 await 拦住后面的 bootOwnerDm / wsClient.start', () => {
  const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const a = SRC.indexOf('const APP_ID = process.env.FEISHU_APP_ID');
  const hold = SRC.indexOf('await new Promise(() => {})');
  assert.ok(a >= 0 && hold > a, '有永不返回的 await');
  const block = SRC.slice(a, hold);
  assert.match(block, /assertAppIdShape\(APP_ID\)/);
  assert.match(block, /failFast\(/);
  assert.ok(!/process\.exit\(/.test(block), '早退路径不再有裸 exit');
  for (const later of ['bootOwnerDm({', 'new lark.WSClient(', 'wsClient.start(', 'new lark.Client(']) {
    const i = SRC.indexOf(later);
    assert.ok(i > hold, `${later} 必须在拦截之后`);
  }
});

test('看门狗：start 后 60 秒没有 ready → onTimeout("启动 60 秒内未就绪")；ready 在 60 秒内到 → 什么都不发生', () => {
  const tm = fakeTimers();
  const hits = [];
  const w = createReadyWatchdog({ onTimeout: (r) => hits.push(r), timers: tm, now: tm.now });
  w.start();
  tm.advance(59_999);
  assert.deepEqual(hits, []);
  tm.advance(1);
  assert.deepEqual(hits, ['启动 60 秒内未就绪']);

  const t2 = fakeTimers();
  const hits2 = [];
  const w2 = createReadyWatchdog({ onTimeout: (r) => hits2.push(r), timers: t2, now: t2.now });
  w2.start();
  t2.advance(30_000);
  w2.ready();
  t2.advance(3_600_000);
  assert.deepEqual(hits2, []);
});

test('看门狗：ready 先于 start 到（回调抢在调用方之前）也算就绪，不再起 60 秒定时器', () => {
  const tm = fakeTimers();
  const hits = [];
  const w = createReadyWatchdog({ onTimeout: (r) => hits.push(r), timers: tm, now: tm.now });
  w.ready();
  w.start();
  tm.advance(120_000);
  assert.deepEqual(hits, []);
  assert.equal(tm.active().length, 0);
});

test('看门狗：就绪后断线——重连中超过 10 分钟没恢复 → onTimeout("断线超过 10 分钟未恢复")；第一次进入记时，重复的 reconnecting 不重新计时', () => {
  const tm = fakeTimers();
  const hits = [];
  const w = createReadyWatchdog({ onTimeout: (r) => hits.push(r), timers: tm, now: tm.now });
  w.start();
  w.ready();
  w.reconnecting();
  tm.advance(5 * 60_000);
  w.reconnecting(); // SDK 每次重试都会再调
  w.reconnecting();
  tm.advance(5 * 60_000 - 1);
  assert.deepEqual(hits, []);
  tm.advance(1);
  assert.deepEqual(hits, ['断线超过 10 分钟未恢复']);
  tm.advance(3_600_000);
  assert.equal(hits.length, 1, '只触发一次');
});

test('看门狗：reconnected / ready 清掉断线计时；之后再断重新计 10 分钟', () => {
  const tm = fakeTimers();
  const hits = [];
  const w = createReadyWatchdog({ onTimeout: (r) => hits.push(r), timers: tm, now: tm.now });
  w.start();
  w.ready();
  w.reconnecting();
  tm.advance(9 * 60_000);
  w.reconnected();
  tm.advance(60 * 60_000);
  assert.deepEqual(hits, []);
  w.reconnecting();
  tm.advance(9 * 60_000);
  w.ready(); // 首次连接前就在重连的情形：之后 SDK 走 onReady
  tm.advance(60 * 60_000);
  assert.deepEqual(hits, []);
});

test('看门狗：启动阶段（还没 ready）里的 reconnecting 不让 60 秒定时器失效；定时器全部 unref', () => {
  const tm = fakeTimers();
  const hits = [];
  const w = createReadyWatchdog({ onTimeout: (r) => hits.push(r), timers: tm, now: tm.now });
  w.start();
  w.reconnecting();
  assert.ok(tm.list.every((h) => h.unrefCalled), '都 unref：看门狗不撑着进程');
  tm.advance(60_000);
  assert.deepEqual(hits, ['启动 60 秒内未就绪']);
});

test('看门狗：stop 清掉全部定时器；阈值可注入（只给测试用）', () => {
  const tm = fakeTimers();
  const hits = [];
  const w = createReadyWatchdog({ readyTimeoutMs: 1000, stallMs: 2000, onTimeout: (r) => hits.push(r), timers: tm, now: tm.now });
  w.start();
  w.stop();
  tm.advance(10_000);
  assert.deepEqual(hits, []);
});

test('onTimeout 抛错不让看门狗炸（只吞掉，退出路径由 index.js 的 bailOut 负责）', () => {
  const tm = fakeTimers();
  const w = createReadyWatchdog({ onTimeout: () => { throw new Error('boom'); }, timers: tm, now: tm.now });
  w.start();
  assert.doesNotThrow(() => tm.advance(60_000));
});

test('60 秒巡检（原样搬出）：state 为 failed 才返回 failed——字符串形态、对象形态都认；其它状态、没这个方法、抛错都返回 null', () => {
  assert.equal(inspectConnection({ getConnectionStatus: () => 'failed' }), 'failed');
  assert.equal(inspectConnection({ getConnectionStatus: () => ({ state: 'failed' }) }), 'failed');
  assert.equal(inspectConnection({ getConnectionStatus: () => 'connected' }), null);
  assert.equal(inspectConnection({ getConnectionStatus: () => ({ state: 'reconnecting' }) }), null);
  assert.equal(inspectConnection({ getConnectionStatus: () => undefined }), null);
  assert.equal(inspectConnection({}), null);
  assert.equal(inspectConnection({ getConnectionStatus: () => { throw new Error('x'); } }), null);
});

test('index.js 里的巡检仍是 60 秒一次、failed → bailOut(…, 15_000)、unref', () => {
  const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const i = SRC.indexOf('inspectConnection(wsClient)');
  assert.ok(i > 0);
  const seg = SRC.slice(i - 80, i + 420);
  assert.match(seg, /bailOut\(`巡检发现连接状态=\$\{state\}，退出交由 launchd 重启`, 15_000\)/);
  assert.match(seg, /\}, 60_000\)\.unref\(\)/);
});
