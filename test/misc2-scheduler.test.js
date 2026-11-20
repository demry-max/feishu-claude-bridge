// BRIDGE-MISC-2：一次性任务恰好迟到 24 小时补发（S07）、任务文件里下划线开头的键不进调度（S11）、并发已满只在开始等位时记一行（S12）。
// 真实 startScheduler / fireJob，mock timers 接管 setInterval 与 Date，不靠真实 sleep。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startScheduler, fireJob } = await import('../src/scheduler.js');

const CHAT = 'oc_0123456789abcdef0123';
const NOW = new Date(2026, 10, 20, 9, 30, 0);
const pad = (n) => String(n).padStart(2, '0');
const localWhen = (ms) => {
  const d = new Date(Date.now() + ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };

function mkEnv(t) {
  const logs = [];
  t.mock.method(console, 'log', (...a) => { logs.push(a.join(' ')); });
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW.getTime() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misc2-sched-'));
  const env = {
    dir, logs, jobs: path.join(dir, 'jobs'), state: path.join(dir, 's.json'),
    write: (n, j) => fs.writeFileSync(path.join(env.jobs, n), typeof j === 'string' ? j : JSON.stringify(j)),
    readState: () => JSON.parse(fs.readFileSync(env.state, 'utf8')),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  fs.mkdirSync(env.jobs);
  return env;
}
const job = (extra = {}) => ({ name: 'j', when: localWhen(-60_000), prompt: 'P', chat_id: CHAT, enabled: true, ...extra });

describe('S07 一次性 prompt 任务迟到上限', () => {
  for (const [label, lateMs, expect] of [['恰好 24 小时仍补发', 24 * 3_600_000, 1], ['24 小时 + 1 分钟放弃', 24 * 3_600_000 + 60_000, 0]]) {
    test(`C1 ${label}`, async (t) => {
      const env = mkEnv(t);
      const fired = [];
      env.write('once.json', job({ name: 'once', when: localWhen(-lateMs) }));
      const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, maxLateMs: 60_000, notifyOwner: async () => {}, onFire: async (j) => { fired.push(j); } });
      try {
        await h.whenIdle(); await settle();
        assert.equal(fired.length, expect);
        if (expect) {
          assert.equal(fired[0]._lateOver, true);
          assert.equal(fired[0]._late, lateMs);
        } else {
          assert.equal(env.readState()['once.json'].status, 'skipped-late');
        }
      } finally { h.stop(); env.cleanup(); }
    });
  }
});

describe('S11 任务文件里下划线开头的键', () => {
  test('C2 文件里的 _resumed / _lateOver / _late / _file / _x 都不进 payload；_late 为 0，_file 是真实文件名；标题不带补跑 / 补发前缀', async (t) => {
    const env = mkEnv(t);
    env.write('once.json', job({ name: 'once', _resumed: true, _lateOver: true, _late: 999_999_999, _file: 'other.json', _x: 1 }));
    const fired = [];
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, onFire: async (j) => { fired.push(j); } });
    try {
      await h.whenIdle(); await settle();
      assert.equal(fired.length, 1);
      const p = fired[0];
      for (const k of ['_resumed', '_lateOver', '_x']) assert.ok(!(k in p), `${k} 不应进入`);
      assert.ok(!p._resumed);
      assert.equal(p._late, 0);
      assert.equal(p._file, 'once.json');
      const sent = [];
      await fireJob({ job: p, run: async () => '结果', send: async (x) => { sent.push(x); }, flush: async () => {}, notifyOwner: async () => {}, onRunFailure: async () => {}, isQuiet: () => false, sleep: async () => {}, log: () => {} });
      assert.ok(sent.length >= 1);
      assert.doesNotMatch(sent[0].split('\n')[0], /因重启补跑|补发/);
    } finally { h.stop(); env.cleanup(); }
  });

  test('C4 任务文件内容为 null / "str" / [] → 与今天一致：前两者按「不是合法的 JSON」通知，数组静默跳过', async (t) => {
    const env = mkEnv(t);
    const notes = [];
    env.write('n.json', 'null');
    env.write('s.json', '"str"');
    env.write('a.json', '[]');
    env.write('ok.json', job({ name: 'ok' }));
    const fired = [];
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); }, onFire: async (j) => { fired.push(j.name); } });
    try {
      await h.whenIdle(); await settle();
      assert.deepEqual(fired, ['ok']);
      const bad = notes.join('\n');
      assert.match(bad, /n\.json/);
      assert.match(bad, /s\.json/);
      assert.doesNotMatch(bad, /a\.json/);
    } finally { h.stop(); env.cleanup(); }
  });
});

describe('S12 并发已满只在开始等位时记一行', () => {
  const FULL = /并发已满（1）/;
  test('C5 占位期间推进 5 拍：只 1 行；占位结束后正常派发；同一文件新的一次等位再记 1 行；等位超时跳过的日志与通知不变', async (t) => {
    const env = mkEnv(t);
    const g = gate();
    const notes = [];
    const started = [];
    env.write('a-hog.json', job({ name: 'hog' }));
    env.write('b-wait.json', job({ name: 'wait' }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, maxConcurrent: 1,
      notifyOwner: async (x) => { notes.push(x); },
      onFire: async (j) => { started.push(j.name); if (j.name === 'hog' || j.name === 'hog2') await g.p; } });
    try {
      await settle();
      for (let i = 0; i < 5; i++) { t.mock.timers.tick(30_000); await settle(); }
      assert.equal(env.logs.filter((l) => FULL.test(l)).length, 1, `日志：${env.logs.filter((l) => FULL.test(l)).join('|')}`);
      assert.deepEqual(started, ['hog']);
      g.release(); await h.idle();
      t.mock.timers.tick(30_000); await settle(); await h.idle();
      assert.ok(started.includes('wait'), '慢任务结束后它照常派发');
      assert.equal(env.logs.filter((l) => FULL.test(l)).length, 1);

      // 新的一次等位：换一个应触发时间（新的 due），再被另一个占位任务挡住 → 再记 1 行
      const g2 = gate();
      const before = env.logs.filter((l) => FULL.test(l)).length;
      h.stop();
      const h2 = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, maxConcurrent: 1,
        notifyOwner: async () => {},
        onFire: async (j) => { started.push(j.name); if (j.name === 'hog2') await g2.p; } });
      env.write('a-hog.json', job({ name: 'hog2', when: localWhen(-30_000) }));
      env.write('b-wait.json', job({ name: 'wait2', when: localWhen(-90_000) }));
      try {
        for (let i = 0; i < 4; i++) { t.mock.timers.tick(30_000); await settle(); }
        assert.ok(started.includes('hog2'));
        assert.equal(env.logs.filter((l) => FULL.test(l)).length, before + 1, '新的一次等位再记 1 行');
      } finally { g2.release(); h2.stop(); }
    } finally { g.release(); h.stop(); env.cleanup(); }
  });

  test('C5b 等位超时：「跳过」日志与通知仍在，且前面只有 1 行「并发已满」', async (t) => {
    const env = mkEnv(t);
    const g = gate();
    const notes = [];
    env.write('a-hog.json', job({ name: 'hog' }));
    env.write('b-wait.json', job({ name: 'wait' }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, maxConcurrent: 1, maxLateMs: 60_000,
      notifyOwner: async (x) => { notes.push(x); },
      onFire: async (j) => { if (j.name === 'hog') await g.p; } });
    try {
      for (let i = 0; i < 4; i++) { t.mock.timers.tick(30_000); await settle(); }
      assert.equal(env.logs.filter((l) => FULL.test(l)).length, 1);
      assert.ok(env.logs.some((l) => /跳过「wait」：并发已满，等了超过 1 分钟仍没排上/.test(l)));
      assert.equal(env.readState()['b-wait.json'].status, 'skipped-busy');
      assert.equal(notes.length, 1);
      assert.match(notes[0], /等了超过 1 分钟仍没排上/);
    } finally { g.release(); h.stop(); env.cleanup(); }
  });
});
