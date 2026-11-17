// BRIDGE-VR-1 协调补充：优雅退出（SIGTERM / SIGINT）。信号、定时器、时钟、退出函数全部注入，不碰真进程。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { createShutdown, shutdownGraceSec, DRAINING_REPLY } = await import('../src/shutdown.js');

function rig({ graceSec = 120, busy = 0, onDrain } = {}) {
  const r = { busy, clock: 0, timers: [], exits: [], logs: [], drains: 0 };
  r.sd = createShutdown({
    graceSec,
    pollMs: 1000,
    inflight: () => r.busy,
    onDrain: onDrain ?? (() => { r.drains += 1; }),
    exit: (code) => { r.exits.push(code); },
    log: (m) => r.logs.push(m),
    now: () => r.clock,
    timers: {
      setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false, ran: false }; r.timers.push(t); return t; },
      clearTimeout: (t) => { if (t) t.cleared = true; },
    },
  });
  r.pending = () => r.timers.filter((t) => !t.cleared && !t.ran);
  r.step = () => {
    const t = r.pending()[0];
    if (!t) return false;
    t.ran = true;
    r.clock += t.ms;
    t.fn();
    return true;
  };
  return r;
}

describe('优雅退出：SIGTERM / SIGINT', () => {
  test('SIGTERM：先停接新消息和心跳（onDrain 一次），等进行中的对话做完再退出（143）', () => {
    const r = rig({ busy: 2 });
    assert.equal(r.sd.isDraining(), false);
    r.sd.handle('SIGTERM');
    assert.equal(r.sd.isDraining(), true);
    assert.equal(r.drains, 1);
    assert.deepEqual(r.exits, [], '还有 2 个对话在跑：不退出');
    assert.ok(r.logs.some((l) => l.includes('SIGTERM') && l.includes('2 个') && l.includes('120 秒')), r.logs.join('\n'));
    for (let i = 0; i < 5; i += 1) r.step();
    assert.deepEqual(r.exits, []);
    r.busy = 0;
    r.step();
    assert.deepEqual(r.exits, [143]);
    assert.equal(r.pending().length, 0, '退出后不再轮询');
  });

  test('没有进行中的对话：立即退出，不建定时器', () => {
    const r = rig();
    r.sd.handle('SIGTERM');
    assert.deepEqual(r.exits, [143]);
    assert.equal(r.timers.length, 0);
  });

  test('SIGINT → 130', () => {
    const r = rig();
    r.sd.handle('SIGINT');
    assert.deepEqual(r.exits, [130]);
  });

  test('等满 SHUTDOWN_GRACE_SEC 还没做完：记日志后直接退出', () => {
    const r = rig({ graceSec: 5, busy: 1 });
    r.sd.handle('SIGTERM');
    for (let i = 0; i < 4; i += 1) r.step();
    assert.deepEqual(r.exits, [], '4 秒：还在等');
    r.step();
    assert.deepEqual(r.exits, [143]);
    assert.ok(r.logs.some((l) => l.includes('5 秒') && l.includes('1 个')), r.logs.join('\n'));
    assert.equal(r.pending().length, 0);
  });

  test('第二次信号：不再等，立即退出；退出函数只调一次', () => {
    const r = rig({ busy: 1 });
    r.sd.handle('SIGTERM');
    r.sd.handle('SIGINT');
    assert.deepEqual(r.exits, [130]);
    assert.equal(r.drains, 1, 'onDrain 只调一次');
    assert.equal(r.pending().length, 0);
    r.sd.handle('SIGTERM');
    r.busy = 0;
    while (r.step());
    assert.deepEqual(r.exits, [130]);
  });

  test('onDrain 抛错：记日志，照样等完再退出', () => {
    const r = rig({ busy: 1, onDrain: () => { throw new Error('stop 失败'); } });
    r.sd.handle('SIGTERM');
    assert.ok(r.logs.some((l) => l.includes('stop 失败')), r.logs.join('\n'));
    assert.deepEqual(r.exits, []);
    r.busy = 0;
    r.step();
    assert.deepEqual(r.exits, [143]);
  });

  test('SHUTDOWN_GRACE_SEC=0：不等，立即退出', () => {
    const r = rig({ graceSec: 0, busy: 3 });
    r.sd.handle('SIGTERM');
    assert.deepEqual(r.exits, [143]);
  });

  test('install(proc)：只挂 SIGTERM / SIGINT，重复 install 不叠挂；信号走 handle', () => {
    const r = rig();
    const proc = new EventEmitter();
    r.sd.install(proc);
    r.sd.install(proc);
    assert.equal(proc.listenerCount('SIGTERM'), 1);
    assert.equal(proc.listenerCount('SIGINT'), 1);
    assert.equal(proc.listenerCount('SIGHUP'), 0);
    proc.emit('SIGTERM', 'SIGTERM');
    assert.deepEqual(r.exits, [143]);
  });

  test('shutdownGraceSec：默认 120；0–3600 的整数；写错按默认并记日志', () => {
    const logs = [];
    const log = (m) => logs.push(m);
    assert.equal(shutdownGraceSec({}, log), 120);
    assert.equal(shutdownGraceSec({ SHUTDOWN_GRACE_SEC: '' }, log), 120);
    assert.equal(shutdownGraceSec({ SHUTDOWN_GRACE_SEC: '30' }, log), 30);
    assert.equal(shutdownGraceSec({ SHUTDOWN_GRACE_SEC: '0' }, log), 0);
    assert.equal(logs.length, 0);
    for (const bad of ['abc', '-1', '3601', '1.5']) assert.equal(shutdownGraceSec({ SHUTDOWN_GRACE_SEC: bad }, log), 120, bad);
    assert.equal(logs.length, 4);
    assert.ok(logs.every((l) => l.includes('SHUTDOWN_GRACE_SEC')));
  });

  test('退出期间新消息的回复文案', () => {
    assert.equal(DRAINING_REPLY, '正在重启，请稍后重发');
  });
});
