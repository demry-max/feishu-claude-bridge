// BRIDGE-SCHED-1：定时任务调度可靠性的行为断言（S1–S10）。
// 全部走真实的 startScheduler / fireJob，只把 onFire、notifyOwner、turnFor、sleep 换成测试替身；
// 30 秒周期用 mock timers 手动推进（接管 setInterval 与 Date），不靠真实 sleep。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startScheduler, fireJob, parseWhen, nextFireAt } = await import('../src/scheduler.js');

const CHAT = 'oc_0123456789abcdef0123';
const NOW = new Date(2026, 10, 20, 9, 30, 0); // 本地 2026-11-20 09:30
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const gate = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
const pad = (n) => String(n).padStart(2, '0');
// 一次性任务的 when 按本地时区解析
const localWhen = (msFromNow) => {
  const d = new Date(Date.now() + msFromNow);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function mkEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-rel-'));
  const env = {
    dir,
    jobs: path.join(dir, 'jobs'),
    data: path.join(dir, 'data'),
    state: path.join(dir, 'data', 'schedule-state.json'),
    write(name, job) {
      fs.mkdirSync(env.jobs, { recursive: true });
      fs.writeFileSync(path.join(env.jobs, name), typeof job === 'string' ? job : JSON.stringify(job));
    },
    readState: () => JSON.parse(fs.readFileSync(env.state, 'utf8')),
    seed(obj) {
      fs.mkdirSync(env.data, { recursive: true });
      fs.writeFileSync(env.state, JSON.stringify(obj));
    },
    cleanup() {
      try { fs.chmodSync(env.data, 0o755); } catch { /* 目录可能不存在 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  fs.mkdirSync(env.data, { recursive: true });
  return env;
}
const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {}); };
const mockClock = (t, now = NOW) => t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: now.getTime() });
const job = (extra = {}) => ({ name: 'j', when: localWhen(-60_000), prompt: 'P', chat_id: CHAT, enabled: true, ...extra });

describe('S1 并发：tick 不等任务，上限跨拍有效，等位超时跳过并通知', () => {
  test('慢任务不挡 tick：首拍立即返回，同拍后到点的任务照常派发', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    const g = gate();
    const started = [];
    env.write('slow.json', job({ name: 'slow' }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, maxConcurrent: 2,
      onFire: async (j) => { started.push(j.name); if (j.name === 'slow') await g.p; } });
    try {
      assert.deepEqual(started, ['slow'], 'startScheduler 同步返回，慢任务还没完成');
      assert.equal(h.inflightCount(), 1);
      env.write('quick.json', job({ name: 'quick' }));
      t.mock.timers.tick(30_000);
      await settle();
      assert.deepEqual(started, ['slow', 'quick'], '下一拍照常扫描并派发，没有被慢任务卡住');
      g.release();
      await h.idle();
      assert.equal(h.inflightCount(), 0);
    } finally { h.stop(); env.cleanup(); }
  });

  test('并发上限对所有在跑的任务跨拍有效，释放名额后下一拍补上', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    const gates = { a: gate(), b: gate(), c: gate() };
    const started = [];
    for (const n of ['a', 'b', 'c']) env.write(`${n}.json`, job({ name: n }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, maxConcurrent: 2,
      onFire: async (j) => { started.push(j.name); await gates[j.name].p; } });
    try {
      assert.equal(started.length, 2, '首拍只派发上限个');
      t.mock.timers.tick(30_000); await settle();
      t.mock.timers.tick(30_000); await settle();
      assert.equal(started.length, 2, '后续几拍仍被在跑的两个占满，不会因为换了一拍就多开');
      assert.equal(h.inflightCount(), 2);
      const waiting = ['a', 'b', 'c'].find((n) => !started.includes(n));
      gates[started[0]].release(); await settle();
      t.mock.timers.tick(30_000); await settle();
      assert.ok(started.includes(waiting), '名额释放后，被挡的任务下一拍触发');
      for (const g of Object.values(gates)) g.release();
      await h.idle();
    } finally { h.stop(); env.cleanup(); }
  });

  test('whenIdle 等首拍派发的任务；idle 等所有在跑的任务', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    const g1 = gate(); const g2 = gate();
    env.write('first.json', job({ name: 'first' }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, maxConcurrent: 3,
      onFire: async (j) => { await (j.name === 'first' ? g1.p : g2.p); } });
    try {
      let whenDone = false; let idleDone = false;
      void h.whenIdle().then(() => { whenDone = true; });
      env.write('later.json', job({ name: 'later' }));
      t.mock.timers.tick(30_000); await settle();
      assert.equal(h.inflightCount(), 2);
      void h.idle().then(() => { idleDone = true; });
      await settle();
      assert.equal(whenDone, false);
      g1.release(); await settle();
      assert.equal(whenDone, true, 'whenIdle 只等首拍派发的那个');
      assert.equal(idleDone, false, '后一拍派发的还在跑，idle 不能返回');
      g2.release(); await h.idle();
      assert.equal(idleDone, true);
    } finally { h.stop(); env.cleanup(); }
  });

  test('并发满、等位超过迟到窗口：记 skipped-busy 并通知 owner（不含 prompt / chat_id）', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    const g = gate();
    const notes = [];
    env.write('hog.json', job({ name: 'hog' }));
    env.write('wait.json', job({ name: 'wait', prompt: 'SECRET-PROMPT-BODY' }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, maxConcurrent: 1, maxLateMs: 60_000,
      notifyOwner: async (x) => { notes.push(x); },
      onFire: async (j) => { if (j.name === 'hog') await g.p; } });
    try {
      // 按文件名顺序：hog 先占位，wait 被挡
      t.mock.timers.tick(30_000); await settle();
      assert.equal(notes.length, 0, '还没等够窗口，不通知');
      assert.notEqual(env.readState()['wait.json']?.status, 'skipped-busy');
      t.mock.timers.tick(30_000); await settle();
      t.mock.timers.tick(30_000); await settle();
      assert.equal(env.readState()['wait.json'].status, 'skipped-busy');
      assert.equal(notes.length, 1);
      assert.match(notes[0], /wait/);
      assert.ok(!notes[0].includes('SECRET-PROMPT-BODY'));
      assert.ok(!notes[0].includes(CHAT));
      assert.ok(!/ou_/.test(notes[0]));
      t.mock.timers.tick(30_000); await settle();
      assert.equal(notes.length, 1, '同一任务同一原因同一天只通知一次');
      g.release(); await h.idle();
    } finally { h.stop(); env.cleanup(); }
  });
});

describe('S2 重启打断：running 记录按条件补跑一次或记 interrupted', () => {
  const AT = new Date(2026, 10, 20, 9, 0, 0).toISOString();
  const cronJob = (extra = {}) => ({ name: 'daily', when: '0 9 * * *', prompt: 'P', chat_id: CHAT, enabled: true, ...extra });
  const running = (extra = {}) => ({ at: AT, when: '0 9 * * *', status: 'running', ...extra });
  const priv = () => ({ private: true });

  async function boot(t, { jobs = { 'daily.json': cronJob() }, state = { 'daily.json': running() }, turnFor = priv, ...opts } = {}) {
    quiet(t); mockClock(t);
    const env = mkEnv();
    for (const [f, j] of Object.entries(jobs)) env.write(f, j);
    env.seed(state);
    const fired = []; const notes = []; const turnCalls = [];
    const g = gate();
    const h = startScheduler({
      schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); },
      onFire: async (j) => { fired.push(j); await g.p; },
      ...(turnFor === null ? {} : { turnFor: (...a) => { turnCalls.push(a); return turnFor(...a); } }),
      ...opts,
    });
    return { env, h, fired, notes, g, turnCalls };
  }

  test('owner 私聊的 prompt 型任务、窗口内：补跑一次，running 带 resumed，done 不带', async (t) => {
    const { env, h, fired, g, turnCalls } = await boot(t);
    try {
      assert.equal(fired.length, 1);
      assert.equal(fired[0]._resumed, true);
      assert.deepEqual(turnCalls[0][0], 'sched');
      assert.deepEqual(env.readState()['daily.json'], { at: AT, when: '0 9 * * *', status: 'running', resumed: true });
      let idle = false; void h.whenIdle().then(() => { idle = true; });
      await settle(); assert.equal(idle, false, 'whenIdle 等启动补跑的任务');
      g.release(); await h.whenIdle();
      assert.deepEqual(env.readState()['daily.json'], { at: AT, when: '0 9 * * *', status: 'done' });
      t.mock.timers.tick(30_000); await settle();
      assert.equal(fired.length, 1, '补跑完不会再来一次');
    } finally { h.stop(); env.cleanup(); }
  });

  test('补跑途中又被打断（running 已带 resumed）：不再补，记 interrupted 并通知', async (t) => {
    const { env, h, fired, notes } = await boot(t, { state: { 'daily.json': running({ resumed: true }) } });
    try {
      assert.equal(fired.length, 0);
      assert.equal(env.readState()['daily.json'].status, 'interrupted');
      assert.equal(notes.length, 1);
      assert.match(notes[0], /daily/);
    } finally { h.stop(); env.cleanup(); }
  });

  for (const [label, turnFor] of [
    ['结果不发往 owner 私聊', () => ({ private: false })],
    ['turnFor 抛错按「不是」', () => { throw new Error('boom'); }],
    ['turnFor 没传', null],
    ['turnFor 返回空', () => undefined],
  ]) {
    test(`不补跑：${label}`, async (t) => {
      const { env, h, fired, notes } = await boot(t, { turnFor });
      try {
        assert.equal(fired.length, 0);
        assert.equal(env.readState()['daily.json'].status, 'interrupted');
        assert.equal(notes.length, 1);
        assert.ok(!notes[0].includes(CHAT));
      } finally { h.stop(); env.cleanup(); }
    });
  }

  test('不补跑：触发时间已改 / 文件已删 / 已停用 / action 型 / 超过窗口', async (t) => {
    const cases = [
      ['when 已改', { jobs: { 'daily.json': cronJob({ when: '0 8 * * *' }) } }, 'baseline'],
      ['文件已删', { jobs: {} }, 'interrupted'],
      ['已停用', { jobs: { 'daily.json': cronJob({ enabled: false }) } }, 'interrupted'],
      ['action 型', { jobs: { 'daily.json': { name: 'daily', when: '0 9 * * *', action: 'set-model', model: 'fable', enabled: true } } }, 'interrupted'],
      ['超过窗口', { maxLateMs: 60_000 }, 'interrupted'],
    ];
    for (const [label, extra, expectStatus] of cases) {
      const { env, h, fired, notes } = await boot(t, extra);
      try {
        assert.equal(fired.length, 0, label);
        const st = env.readState()['daily.json'];
        if (label === 'when 已改') {
          // 先记 interrupted，随后扫描按新 when 重新登记基线，不补跑
          assert.ok(['interrupted', 'baseline'].includes(st.status), label);
        } else {
          assert.equal(st.status, expectStatus, label);
        }
        assert.equal(notes.length, 1, `${label}：通知 owner`);
      } finally { h.stop(); env.cleanup(); t.mock.timers.reset(); }
    }
  });

  test('补跑也受并发上限：排队的下一拍再补；stop 之后不再补', async (t) => {
    const second = { at: AT, when: '0 9 * * *', status: 'running' };
    const { env, h, fired, g } = await boot(t, {
      jobs: { 'a.json': cronJob({ name: 'a' }), 'b.json': cronJob({ name: 'b' }) },
      state: { 'a.json': running(), 'b.json': second }, maxConcurrent: 1,
    });
    try {
      assert.deepEqual(fired.map((j) => j.name), ['a']);
      g.release(); await settle();
      t.mock.timers.tick(30_000); await settle();
      assert.deepEqual(fired.map((j) => j.name), ['a', 'b'], '名额空出后，排队的补跑在下一拍派发');
      assert.equal(fired[1]._resumed, true);
      await h.idle();
    } finally { h.stop(); env.cleanup(); }
  });
});

describe('S3 优雅退出：stop 与 inflightCount', () => {
  test('stop 之后不再派发新任务；在跑的不被打断，inflightCount 到收尾才归零', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    const g = gate(); const fired = [];
    env.write('a.json', job({ name: 'a' }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state,
      onFire: async (j) => { fired.push(j.name); await g.p; } });
    try {
      assert.equal(h.inflightCount(), 1);
      h.stop();
      env.write('b.json', job({ name: 'b' }));
      t.mock.timers.tick(30_000); await settle();
      assert.deepEqual(fired, ['a'], 'stop 后 tick 不再派发');
      assert.equal(h.inflightCount(), 1, '在跑的任务继续算进行中');
      g.release(); await h.idle();
      assert.equal(h.inflightCount(), 0);
      assert.equal(env.readState()['a.json'].status, 'done', '已在跑的任务跑完照常落盘');
    } finally { h.stop(); env.cleanup(); }
  });

  test('inflightCount 到发送完成才减：onFire 内的发送阶段仍算进行中', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    const sendGate = gate(); let phase = 'run';
    env.write('a.json', job({ name: 'a' }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state,
      onFire: async () => { phase = 'send'; await sendGate.p; phase = 'sent'; } });
    try {
      await settle();
      assert.equal(phase, 'send');
      assert.equal(h.inflightCount(), 1, '正在发送时不能算空闲，否则退出会把结果丢在半路');
      sendGate.release(); await h.idle();
      assert.equal(h.inflightCount(), 0);
    } finally { h.stop(); env.cleanup(); }
  });

  test('stop 置的停止标志：已排上的扫描回调（定时器清不掉的那一拍）也不再派发，启动补跑的等位项不再补', async (t) => {
    quiet(t);
    // 模拟「stop 时已经有一拍排在队列里」：接管 setInterval 抓住回调，clearInterval 不生效
    const cbs = [];
    t.mock.method(globalThis, 'setInterval', (fn) => { cbs.push(fn); return 1; });
    t.mock.method(globalThis, 'clearInterval', () => {});
    const AT = new Date().toISOString();
    const env = mkEnv();
    const g = gate(); const fired = [];
    env.write('a.json', { name: 'a', when: '0 9 * * *', prompt: 'P', chat_id: CHAT, enabled: true });
    env.write('b.json', { name: 'b', when: '0 9 * * *', prompt: 'P', chat_id: CHAT, enabled: true });
    env.seed({
      'a.json': { at: AT, when: '0 9 * * *', status: 'running' },
      'b.json': { at: AT, when: '0 9 * * *', status: 'running' },
    });
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, maxConcurrent: 1, turnFor: () => ({ private: true }),
      onFire: async (j) => { fired.push(j.name); await g.p; } });
    try {
      assert.deepEqual(fired, ['a'], 'b 在补跑队列里等名额');
      h.stop();
      env.write('c.json', job({ name: 'c' }));
      g.release(); await h.idle();
      cbs[0](); await settle();
      assert.deepEqual(fired, ['a'], 'stop 之后：队列里的补跑与新到点的任务都不再派发');
    } finally { h.stop(); env.cleanup(); }
  });

  test('stop 对空调度器也安全，可重复调用', (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, onFire: async () => {} });
    try {
      assert.equal(h.inflightCount(), 0);
      h.stop(); h.stop();
    } finally { env.cleanup(); }
  });
});

describe('S4 状态写不进去：本进程内不重跑，恢复后补写，每次故障通知一次', () => {
  const skipRoot = process.getuid?.() === 0 ? { skip: 'root 不受目录权限限制' } : {};
  test('只读状态目录：一次性任务只跑一次；通知含错误码与目录；恢复后写回盘', skipRoot, async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    const notes = []; let fired = 0;
    env.write('once.json', job({ name: 'once' }));
    fs.chmodSync(env.data, 0o555);
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); },
      onFire: async () => { fired += 1; } });
    try {
      await h.whenIdle();
      for (let i = 0; i < 4; i++) { t.mock.timers.tick(30_000); await settle(); }
      assert.equal(fired, 1, '状态写不进去时，同一次触发不能每拍重跑');
      assert.equal(notes.length, 1, '一次故障只通知一次');
      assert.match(notes[0], /EACCES/);
      assert.ok(notes[0].includes(env.data), '通知里带数据目录');
      fs.chmodSync(env.data, 0o755);
      t.mock.timers.tick(30_000); await settle();
      assert.equal(env.readState()['once.json'].status, 'done', '盘恢复后内存里的记录写回去');
      assert.equal(fired, 1);
      // 再坏一次：算新一次故障，再通知一次
      env.write('two.json', job({ name: 'two' }));
      fs.chmodSync(env.data, 0o555);
      t.mock.timers.tick(30_000); await settle(); await h.idle();
      assert.equal(notes.length, 2);
      assert.equal(fired, 2);
    } finally { h.stop(); env.cleanup(); }
  });

  test('cron 任务的基线写不进去也不会每拍重新登记', skipRoot, async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    const notes = [];
    env.write('c.json', job({ name: 'c', when: '*/5 * * * *' }));
    fs.chmodSync(env.data, 0o555);
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); }, onFire: async () => {} });
    try {
      for (let i = 0; i < 3; i++) { t.mock.timers.tick(30_000); await settle(); }
      assert.equal(notes.length, 1);
      assert.equal(fs.existsSync(env.state), false);
    } finally { h.stop(); env.cleanup(); }
  });
});

describe('S5 通知：内容约束与去重', () => {
  test('when 写错（含 6 段 cron）：不触发，通知一次；跨本地日再通知；重启同日不重复', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    const notes = []; let fired = 0;
    const longName = `${'名'.repeat(80)}\n第二行`;
    env.write('six.json', job({ name: longName, when: '0 0 9 * * *', prompt: 'SECRET-PROMPT-BODY' }));
    const start = () => startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); }, onFire: async () => { fired += 1; } });
    let h = start();
    try {
      for (let i = 0; i < 4; i++) { t.mock.timers.tick(30_000); await settle(); }
      assert.equal(fired, 0);
      assert.equal(notes.length, 1, '同一任务同一原因每天一次，不是每拍一次');
      assert.ok(!notes[0].includes('SECRET-PROMPT-BODY'));
      assert.ok(!notes[0].includes(CHAT));
      assert.ok(!notes[0].includes('名'.repeat(61)), '任务名用 plain(name, 60) 截断');
      assert.ok(!notes[0].includes('\n第二行'), '任务名压成一行');
      h.stop(); h = start(); await settle();
      assert.equal(notes.length, 1, '去重记录持久化：重启同一天不重复通知');
      t.mock.timers.setTime(NOW.getTime() + 24 * 3600_000);
      t.mock.timers.tick(30_000); await settle();
      assert.equal(notes.length, 2, '换了本地日可以再通知一次');
    } finally { h.stop(); env.cleanup(); }
  });

  test('任务文件不是合法 JSON：通知一次，不含文件内容', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); const notes = [];
    env.write('broken.json', '{"name": "x", "prompt": "SECRET-PROMPT-BODY", ');
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); }, onFire: async () => {} });
    try {
      for (let i = 0; i < 3; i++) { t.mock.timers.tick(30_000); await settle(); }
      assert.equal(notes.length, 1);
      assert.match(notes[0], /broken\.json/);
      assert.ok(!notes[0].includes('SECRET-PROMPT-BODY'));
    } finally { h.stop(); env.cleanup(); }
  });

  test('cron 迟到超过窗口：skipped-late 并通知；一次性 action 任务同样', async (t) => {
    quiet(t); mockClock(t, new Date(2026, 10, 20, 15, 0, 0));
    const env = mkEnv(); const notes = []; let fired = 0;
    env.write('daily.json', job({ name: 'daily', when: '0 9 * * *' }));
    env.seed({ 'daily.json': { at: new Date(2026, 10, 19, 9, 0, 0).toISOString(), when: '0 9 * * *', status: 'done' } });
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); }, onFire: async () => { fired += 1; } });
    try {
      await h.whenIdle();
      assert.equal(fired, 0);
      assert.equal(env.readState()['daily.json'].status, 'skipped-late');
      assert.equal(notes.length, 1);
      assert.match(notes[0], /daily/);
      assert.ok(!notes[0].includes(CHAT));
    } finally { h.stop(); env.cleanup(); }
  });

  test('notifyOwner 没传 / 抛错都不影响调度', async (t) => {
    quiet(t); mockClock(t);
    for (const notifyOwner of [undefined, async () => { throw new Error('send failed'); }]) {
      const env = mkEnv(); let fired = 0;
      env.write('bad.json', job({ name: 'bad', when: '0 0 9 * * *' }));
      env.write('ok.json', job({ name: 'ok' }));
      const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner, onFire: async () => { fired += 1; } });
      try { await h.whenIdle(); assert.equal(fired, 1); } finally { h.stop(); env.cleanup(); }
    }
  });

  test('onFire 的 ctx.notifyOnce：同一原因当天只发一次', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); const notes = [];
    env.write('a.json', job({ name: 'a' }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); },
      onFire: async (_j, ctx) => { await ctx.notifyOnce('send', 'x1'); await ctx.notifyOnce('send', 'x2'); await ctx.notifyOnce('other', 'y'); } });
    try { await h.whenIdle(); assert.deepEqual(notes, ['x1', 'y']); } finally { h.stop(); env.cleanup(); }
  });
});

describe('S5b chat_id 写法不对（LOW-3）：不派发；通知按（文件名 + 内容哈希）一次；日志每键一次且不含值', () => {
  test('不派发；通知按（文件名 + 内容哈希）一次；日志每键每进程一次且不含值', async (t) => {
    const errs = [];
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', (...a) => { errs.push(a.join(' ')); });
    mockClock(t);
    const env = mkEnv(); const notes = []; let fired = 0;
    const BAD = 'bogus-ID-123';
    env.write('bad.json', job({ name: 'bad', chat_id: BAD }));
    const start = () => startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); }, onFire: async () => { fired += 1; } });
    const h = start();
    try {
      for (let i = 0; i < 5; i++) { t.mock.timers.tick(30_000); await settle(); }
      assert.equal(fired, 0, '照旧不派发');
      assert.equal(notes.length, 1, '每拍都读到，但只通知一次');
      const line = '[sched] 任务 bad.json 的 chat_id 格式不对，已跳过';
      assert.equal(errs.filter((l) => l === line).length, 1, '日志原文保留，每键每进程一次');
      for (const s of [...notes, ...errs]) { assert.ok(!s.includes(BAD), '通知与日志都不含 chat_id 的值'); }
      // 改了内容、仍然不对：算新的一条，再通知一次
      env.write('bad.json', job({ name: 'bad', chat_id: 'still-bad-456' }));
      t.mock.timers.tick(30_000); await settle();
      assert.equal(notes.length, 2);
      assert.equal(errs.filter((l) => l === line).length, 2);
      h.stop();
      const h2 = start(); await settle();
      assert.equal(notes.length, 2, '重启后同一内容不再通知（记录持久化）');
      h2.stop();
      // 空 chat_id / 没写：不属于这条规则
      env.write('nochat.json', { name: 'nochat', when: localWhen(-60_000), prompt: 'P', enabled: true });
      const h3 = start(); await h3.whenIdle();
      assert.equal(fired, 1, '没写 chat_id 的照旧派发（执行时再报缺）');
      h3.stop();
    } finally { h.stop(); env.cleanup(); }
  });
});

describe('S6 when 写法', () => {
  test('一次性：T / 空格 / 仅日期 / 带时区 / 斜杠写法都认', () => {
    const local = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();
    assert.equal(parseWhen('2026-11-21 09:00').at.getTime(), local(2026, 11, 21, 9));
    assert.equal(parseWhen('2026-11-21T09:00').at.getTime(), local(2026, 11, 21, 9));
    assert.equal(parseWhen('2026-11-21').at.getTime(), local(2026, 11, 21));
    assert.equal(parseWhen('2026/11/21').at.getTime(), local(2026, 11, 21));
    assert.equal(parseWhen('2026-11-21T09:00:00Z').at.getTime(), Date.UTC(2026, 10, 21, 9));
    assert.equal(parseWhen('2026-11-21T09:00:00+08:00').at.getTime(), Date.UTC(2026, 10, 21, 1));
    assert.equal(parseWhen('2026-11-21 09:00').kind, 'once');
  });
  test('2026-02-30T09:00 沿用 new Date 的行为（顺延到 3 月），不收紧', () => {
    assert.equal(parseWhen('2026-02-30T09:00').kind, 'once');
  });
  test('cron：5 段与 @ 宏可用；6 段 / 其它段数 / 无法识别都是 bad', () => {
    assert.equal(parseWhen('0 9 * * 1-5').kind, 'cron');
    assert.equal(parseWhen('*/5 * * * *').kind, 'cron');
    assert.equal(parseWhen('@daily').kind, 'cron');
    for (const bad of ['0 0 9 * * *', '0 9 * *', 'garbage words here', 'tomorrow', '', '   ', undefined, null]) {
      assert.equal(parseWhen(bad).kind, 'bad', JSON.stringify(bad));
    }
    assert.match(parseWhen('0 0 9 * * *').reason, /5 段/);
  });
  test('nextFireAt：与调度器同一套写法判定', () => {
    const now = new Date(2026, 10, 20, 9, 30);
    assert.equal(nextFireAt({ when: '0 10 * * *' }, now).getTime(), new Date(2026, 10, 20, 10, 0).getTime());
    assert.equal(nextFireAt({ when: '2026-11-21 09:00' }, now).getTime(), new Date(2026, 10, 21, 9, 0).getTime());
    assert.equal(nextFireAt({ when: '2026-11-19 09:00' }, now), null, '已过去的一次性任务没有下次');
    assert.equal(nextFireAt({ when: '0 0 9 * * *' }, now), null, '6 段不是合法写法');
    assert.equal(nextFireAt({ when: '0 10 * * *', enabled: false }, now), null);
  });
  test('6 段 cron 的任务不会被调度（即使被 cron-parser 当「带秒」也不触发）', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); let fired = 0;
    env.write('six.json', job({ when: '0 9 * * * *' }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, onFire: async () => { fired += 1; } });
    try {
      for (let i = 0; i < 5; i++) { t.mock.timers.tick(30_000); await settle(); }
      assert.equal(fired, 0);
      assert.equal(fs.existsSync(env.state), false, '连基线都不记');
    } finally { h.stop(); env.cleanup(); }
  });
});

describe('S7 fireJob：发送失败重试与通知', () => {
  const mk = (over = {}) => {
    const c = { sends: [], flushes: 0, notes: [], sleeps: [], runFail: [] };
    const base = {
      job: { name: '晨报', chat_id: CHAT, prompt: 'P' },
      run: async () => 'ANSWER',
      send: async (x) => { c.sends.push(x); },
      flush: async () => { c.flushes += 1; },
      notifyOwner: async (x, reason) => { c.notes.push({ x, reason }); },
      onRunFailure: async (e) => { c.runFail.push(e); },
      isQuiet: (b) => b === 'HEARTBEAT_OK' || b === '',
      sleep: async (ms) => { c.sleeps.push(ms); },
      log: () => {},
    };
    return { c, args: { ...base, ...over } };
  };

  test('正常：发一次、flush 一次，不通知', async (t) => {
    quiet(t);
    const { c, args } = mk();
    await fireJob(args);
    assert.equal(c.sends.length, 1);
    assert.match(c.sends[0], /⏰ \*\*晨报\*\*\n\nANSWER/);
    assert.equal(c.flushes, 1);
    assert.deepEqual(c.sleeps, []);
    assert.equal(c.notes.length, 0);
  });

  test('前两次失败第三次成功：等 5 秒、30 秒；不通知、不自诊断', async (t) => {
    quiet(t);
    let n = 0;
    const { c, args } = mk({ send: async (x) => { n += 1; if (n < 3) throw new Error('net'); c.sends.push(x); } });
    await fireJob(args);
    assert.deepEqual(c.sleeps, [5000, 30000]);
    assert.equal(c.sends.length, 1);
    assert.equal(c.notes.length, 0);
    assert.equal(c.runFail.length, 0);
  });

  test('三次都失败：不自诊断；通知一次（任务名、会话末 6 位、正文截 2000 字）；抛错记 failed', async (t) => {
    quiet(t);
    const { c, args } = mk({ run: async () => 'x'.repeat(5000), send: async () => { throw new Error('boom'); } });
    await assert.rejects(fireJob(args), /发送失败/);
    assert.deepEqual(c.sleeps, [5000, 30000]);
    assert.equal(c.runFail.length, 0, '发送失败不走模型失败自诊断');
    assert.equal(c.notes.length, 1);
    const { x, reason } = c.notes[0];
    assert.equal(reason, 'send');
    assert.match(x, /晨报/);
    assert.ok(x.includes(CHAT.slice(-6)));
    assert.ok(!x.includes(CHAT), '不带完整 chat_id');
    assert.ok(x.includes('x'.repeat(2000)));
    assert.ok(!x.includes('x'.repeat(2001)), '正文最多 2000 字');
  });

  test('模型调用失败：走 onRunFailure，不发送、不通知', async (t) => {
    quiet(t);
    const err = new Error('model down');
    const { c, args } = mk({ run: async () => { throw err; } });
    await fireJob(args);
    assert.deepEqual(c.runFail, [err]);
    assert.equal(c.sends.length, 0);
    assert.equal(c.notes.length, 0);
  });

  test('结果已发出、只是回传文件发不出去：不重发结果正文', async (t) => {
    quiet(t);
    const { c, args } = mk({ flush: async () => { throw new Error('file'); } });
    await assert.rejects(fireJob(args), /发送失败/);
    assert.equal(c.sends.length, 1, '结果只发一份');
    assert.equal(c.notes.length, 1);
    assert.ok(!c.notes[0].x.includes('ANSWER'), '结果已发出，通知里不必再贴正文');
  });

  test('缺 chat_id：不调模型，通知 owner（reason nochat）并抛错', async (t) => {
    quiet(t);
    let ran = false;
    const { c, args } = mk({ job: { name: '晨报', prompt: 'P' }, run: async () => { ran = true; return 'x'; } });
    await assert.rejects(fireJob(args), /缺 chat_id/);
    assert.equal(ran, false);
    assert.equal(c.notes.length, 1);
    assert.equal(c.notes[0].reason, 'nochat');
    assert.match(c.notes[0].x, /晨报/);
  });

  test('没有 notifyOwner：失败路径不崩，仍抛发送失败', async (t) => {
    quiet(t);
    const { args } = mk({ notifyOwner: undefined, send: async () => { throw new Error('x'); } });
    await assert.rejects(fireJob(args), /发送失败/);
  });

  test('结果标题：补跑 / 迟到补发 / 迟到补跑', async (t) => {
    quiet(t);
    const title = async (extra) => { const { c, args } = mk({ job: { name: 'n', chat_id: CHAT, prompt: 'P', ...extra } }); await fireJob(args); return c.sends[0]; };
    assert.match(await title({ _resumed: true }), /（因重启补跑）/);
    assert.match(await title({ _late: 3 * 3600_000 + 5 * 60_000, _lateOver: true }), /（迟到 3 小时 5 分钟补发）/);
    assert.match(await title({ _late: 20 * 60_000 }), /（迟到补跑 20 分钟）/);
    assert.ok(!/迟到|补跑/.test(await title({})));
  });
});

describe('S8 无事不报', () => {
  test('答案是 HEARTBEAT_OK：不发送结果，仍 flush，不通知', async (t) => {
    quiet(t);
    const sends = []; let flushes = 0; const notes = [];
    await fireJob({
      job: { name: 'n', chat_id: CHAT, prompt: 'P' }, run: async () => 'HEARTBEAT_OK',
      send: async (x) => { sends.push(x); }, flush: async () => { flushes += 1; },
      notifyOwner: async (x) => { notes.push(x); }, onRunFailure: async () => {}, isQuiet: (b) => b === 'HEARTBEAT_OK', sleep: async () => {}, log: () => {},
    });
    assert.equal(sends.length, 0);
    assert.equal(flushes, 1);
    assert.equal(notes.length, 0);
  });
});

describe('S9 数值环境变量', () => {
  const KEYS = ['SCHED_MAX_CONCURRENT', 'SCHED_MAX_LATE_MS'];
  async function withEnv(t, vars, fn) {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, vars);
    try { return await fn(); } finally {
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }
  // 首拍同时到点 4 个任务，数派发了几个
  async function concurrencyOf(t, value) {
    const logs = [];
    t.mock.method(console, 'log', (...a) => { logs.push(a.join(' ')); });
    t.mock.method(console, 'error', () => {});
    mockClock(t);
    const env = mkEnv(); let started = 0; const g = gate();
    for (const n of ['a', 'b', 'c', 'd']) env.write(`${n}.json`, job({ name: n }));
    const vars = value === undefined ? {} : { SCHED_MAX_CONCURRENT: value };
    return withEnv(t, vars, async () => {
      const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, onFire: async () => { started += 1; await g.p; } });
      const n = started; g.release(); await h.idle(); h.stop(); env.cleanup();
      t.mock.timers.reset();
      t.mock.restoreAll();
      return { n, logs: logs.filter((l) => l.includes('SCHED_MAX_CONCURRENT')) };
    });
  }

  test('SCHED_MAX_CONCURRENT：合法值生效；留空 / 没设按默认 2 且不记日志', async (t) => {
    assert.equal((await concurrencyOf(t, '3')).n, 3);
    assert.equal((await concurrencyOf(t, '1')).n, 1);
    assert.equal((await concurrencyOf(t, '10')).n, 4);
    const unset = await concurrencyOf(t, undefined);
    assert.equal(unset.n, 2); assert.equal(unset.logs.length, 0);
    const empty = await concurrencyOf(t, '');
    assert.equal(empty.n, 2); assert.equal(empty.logs.length, 0);
  });

  test('SCHED_MAX_CONCURRENT：写错 / 越界按默认并记一行，值最多回显 20 个字', async (t) => {
    for (const bad of ['abc', '0', '11', '2.5', '-1']) {
      const r = await concurrencyOf(t, bad);
      assert.equal(r.n, 2, bad);
      assert.equal(r.logs.length, 1, bad);
    }
    const long = await concurrencyOf(t, 'x'.repeat(50));
    assert.equal(long.logs.length, 1);
    assert.ok(long.logs[0].includes('x'.repeat(20)));
    assert.ok(!long.logs[0].includes('x'.repeat(21)));
  });

  // 迟到 1 小时的一次性 action 任务：窗口 ≥ 1h 触发，否则 skipped-late
  async function lateOutcome(t, value) {
    const logs = [];
    t.mock.method(console, 'log', (...a) => { logs.push(a.join(' ')); });
    t.mock.method(console, 'error', () => {});
    mockClock(t);
    const env = mkEnv(); let fired = 0;
    env.write('act.json', { name: 'act', when: localWhen(-3600_000), action: 'set-model', model: 'fable', enabled: true });
    const vars = value === undefined ? {} : { SCHED_MAX_LATE_MS: value };
    return withEnv(t, vars, async () => {
      const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, onFire: async () => { fired += 1; } });
      await h.whenIdle(); h.stop();
      const status = env.readState()['act.json'].status;
      env.cleanup(); t.mock.timers.reset(); t.mock.restoreAll();
      return { fired, status, logs: logs.filter((l) => l.includes('SCHED_MAX_LATE_MS')) };
    });
  }

  test('SCHED_MAX_LATE_MS：合法值生效；留空按默认 2 小时且不记日志；写错 / 越界按默认并记日志', async (t) => {
    const tight = await lateOutcome(t, '60000');
    assert.equal(tight.status, 'skipped-late'); assert.equal(tight.logs.length, 0);
    const wide = await lateOutcome(t, '86400000');
    assert.equal(wide.fired, 1);
    const def = await lateOutcome(t, undefined);
    assert.equal(def.fired, 1, '默认 2 小时：迟到 1 小时仍补'); assert.equal(def.logs.length, 0);
    const empty = await lateOutcome(t, '');
    assert.equal(empty.fired, 1); assert.equal(empty.logs.length, 0);
    for (const bad of ['abc', '59999', '86400001', '10m', '1e5']) {
      const r = await lateOutcome(t, bad);
      assert.equal(r.fired, 1, `${bad} 按默认 2 小时`);
      assert.equal(r.logs.length, 1, bad);
    }
  });
});

describe('S10 既有行为不变', () => {
  test('cron 首次发现只记基线不补跑；done / failed 记录只有 {at, when, status}', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); let fired = 0;
    env.write('c.json', job({ name: 'c', when: '*/5 * * * *' }));
    env.write('f.json', job({ name: 'f' }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state,
      onFire: async (j) => { if (j.name === 'f') throw new Error('x'); fired += 1; } });
    try {
      await h.whenIdle();
      assert.equal(fired, 0);
      assert.equal(env.readState()['c.json'].status, 'baseline');
      assert.deepEqual(Object.keys(env.readState()['f.json']).sort(), ['at', 'status', 'when']);
      assert.equal(env.readState()['f.json'].status, 'failed');
      t.mock.timers.tick(5 * 60_000); await settle(); await h.idle();
      assert.equal(fired, 1, '到了下一个点才触发');
      assert.deepEqual(Object.keys(env.readState()['c.json']).sort(), ['at', 'status', 'when']);
      assert.equal(env.readState()['c.json'].status, 'done');
    } finally { h.stop(); env.cleanup(); }
  });

  test('一次性任务跑完即停用并写 last_run；重复 tick 不再触发；停用 / ._ 影子文件 / 未知 action 不执行', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); const fired = [];
    env.write('once.json', job({ name: 'once' }));
    env.write('off.json', job({ name: 'off', enabled: false }));
    env.write('._shadow.json', job({ name: 'shadow' }));
    env.write('evil.json', { name: 'evil', when: localWhen(-60_000), action: 'rm-rf', enabled: true });
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, onFire: async (j) => { fired.push(j.name); } });
    try {
      await h.whenIdle();
      for (let i = 0; i < 3; i++) { t.mock.timers.tick(30_000); await settle(); }
      assert.deepEqual(fired, ['once']);
      const raw = JSON.parse(fs.readFileSync(path.join(env.jobs, 'once.json'), 'utf8'));
      assert.equal(raw.enabled, false);
      assert.ok(raw.last_run);
      assert.deepEqual(env.readState()['once.json'], { at: env.readState()['once.json'].at, when: raw.when, status: 'done' });
    } finally { h.stop(); env.cleanup(); }
  });

  test('改了 when 重新登记基线，不「改期即补跑」', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); let fired = 0;
    env.write('c.json', job({ name: 'c', when: '0 9 * * *' }));
    env.seed({ 'c.json': { at: new Date(2026, 10, 19, 9, 0).toISOString(), when: '0 8 * * *', status: 'done' } });
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, onFire: async () => { fired += 1; } });
    try {
      await h.whenIdle();
      assert.equal(fired, 0);
      assert.equal(env.readState()['c.json'].status, 'baseline');
    } finally { h.stop(); env.cleanup(); }
  });

  test('一次性 prompt 任务迟到超窗口：补发一次，带迟到时长', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); const fired = [];
    env.write('late.json', job({ name: 'late', when: localWhen(-3 * 3600_000) }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, maxLateMs: 60_000, onFire: async (j) => { fired.push(j); } });
    try {
      await h.whenIdle();
      assert.equal(fired.length, 1);
      assert.equal(fired[0]._lateOver, true);
      assert.ok(fired[0]._late >= 3 * 3600_000);
    } finally { h.stop(); env.cleanup(); }
  });
});

describe('R1-1 同一拍的调度器通知合并成一条私聊', () => {
  const OLD = new Date(2026, 7, 5, 9, 0, 0).toISOString(); // 几个月前
  const stale = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`old${i + 1}.json`, { at: OLD, when: '0 9 * * *', status: 'running' }]));
  const tickN = async (t, n) => { for (let i = 0; i < n; i++) { t.mock.timers.tick(30_000); await settle(); } };

  test('5 条陈年 running（任务文件都不在）：启动只发 1 条私聊，列出 5 个任务，状态都变 interrupted，之后不再通知', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); const notes = [];
    env.seed(stale(5));
    const start = () => startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); }, onFire: async () => {} });
    let h = start();
    try {
      await settle();
      assert.equal(notes.length, 1, '一拍只发一条');
      for (let i = 1; i <= 5; i++) assert.match(notes[0], new RegExp(`old${i}\\.json`));
      assert.ok(!notes[0].includes('另有'), '5 项没超上限');
      for (let i = 1; i <= 5; i++) assert.equal(env.readState()[`old${i}.json`].status, 'interrupted');
      await tickN(t, 40);
      assert.equal(notes.length, 1, '推进几十拍不再通知');
      h.stop(); h = start(); await tickN(t, 3);
      assert.equal(notes.length, 1, '重启同日也不再通知');
    } finally { h.stop(); env.cleanup(); }
  });

  test('12 条：1 次通知，最多列 10 项，写「另有 2 项」', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); const notes = [];
    env.seed(stale(12));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); }, onFire: async () => {} });
    try {
      await settle();
      assert.equal(notes.length, 1);
      assert.match(notes[0], /另有 2 项/);
      assert.equal(notes[0].split('\n').filter((l) => l.startsWith('·')).length, 10);
    } finally { h.stop(); env.cleanup(); }
  });

  test('首次启动（无 notices 文件）：when 写错 + 坏 JSON + chat_id 写法不对 + 陈年 running → 首拍 1 次通知含 4 项；之后同日 0 次；重启同日 0 次', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); const notes = []; let fired = 0;
    env.write('sixseg.json', job({ name: 'sixseg', when: '0 0 9 * * *', prompt: 'SECRET-PROMPT-BODY' }));
    env.write('broken.json', '{"name": "x", "prompt": "SECRET-PROMPT-BODY", ');
    env.write('badchat.json', job({ name: 'badchat', chat_id: 'oc_x' }));
    env.seed(stale(1));
    const start = () => startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); }, onFire: async () => { fired += 1; } });
    let h = start();
    try {
      await settle();
      assert.equal(fired, 0);
      assert.equal(notes.length, 1, '启动恢复 + 首拍扫描算同一拍，合并成一条');
      for (const re of [/sixseg/, /broken\.json/, /badchat\.json/, /old1\.json/]) assert.match(notes[0], re);
      assert.ok(!notes[0].includes('SECRET-PROMPT-BODY'));
      assert.ok(!notes[0].includes(CHAT));
      await tickN(t, 10);
      assert.equal(notes.length, 1, '之后同日 0 次');
      h.stop(); h = start(); await tickN(t, 3);
      assert.equal(notes.length, 1, '重启同日 0 次');
    } finally { h.stop(); env.cleanup(); }
  });

  test('只有 1 项：内容与单发一致（不加汇总头）', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); const notes = [];
    env.seed(stale(1));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); }, onFire: async () => {} });
    try {
      await settle();
      assert.equal(notes.length, 1);
      assert.match(notes[0], /^⚠️ 定时任务「old1\.json」原定 .* 的这次执行被桥接重启打断了/);
    } finally { h.stop(); env.cleanup(); }
  });

  test('不合并：ctx.notifyOnce 仍然单独发，且与同拍的合并通知互不影响', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); const notes = [];
    env.write('a.json', job({ name: 'a' }));
    env.seed(stale(2));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async (x) => { notes.push(x); },
      onFire: async (_j, ctx) => { await ctx.notifyOnce('send', 'SEPARATE'); } });
    try {
      await h.whenIdle(); await settle();
      assert.equal(notes.length, 2);
      assert.ok(notes.includes('SEPARATE'));
      assert.ok(notes.some((x) => /old1\.json/.test(x) && /old2\.json/.test(x)));
    } finally { h.stop(); env.cleanup(); }
  });

  test('发送失败也算用掉：不每拍重试；记一行日志', async (t) => {
    const errs = [];
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', (...a) => { errs.push(a.join(' ')); });
    mockClock(t);
    const env = mkEnv(); let calls = 0;
    env.seed(stale(3));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async () => { calls += 1; throw new Error('send failed'); }, onFire: async () => {} });
    try {
      await tickN(t, 5);
      assert.equal(calls, 1);
      assert.ok(errs.some((l) => l.includes('通知 owner 失败')));
    } finally { h.stop(); env.cleanup(); }
  });
});

describe('R1-2 一次性 prompt 任务迟到补发有 24 小时上限', () => {
  const H = 3_600_000;
  const run = async (t, { when, state, extra = {} }) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); const fired = []; const notes = [];
    env.write('once.json', job({ name: 'once', when: typeof when === 'function' ? when() : when })); // 函数：假时钟启用后再算
    if (state) env.seed(state);
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, maxLateMs: 60_000,
      notifyOwner: async (x) => { notes.push(x); }, onFire: async (j) => { fired.push(j); }, ...extra });
    await h.whenIdle(); await settle();
    return { env, h, fired, notes };
  };

  test('迟到 3 小时：补发，标题带迟到时长', async (t) => {
    const { env, h, fired, notes } = await run(t, { when: () => localWhen(-3 * H) });
    try {
      assert.equal(fired.length, 1);
      assert.equal(fired[0]._lateOver, true);
      assert.equal(notes.length, 0);
    } finally { h.stop(); env.cleanup(); }
  });

  test('迟到 25 小时：不触发，状态 skipped-late，通知 1 次（含「超过 24 小时，不再补发」）；之后几拍不再通知', async (t) => {
    const { env, h, fired, notes } = await run(t, { when: () => localWhen(-25 * H) });
    try {
      assert.equal(fired.length, 0);
      assert.equal(env.readState()['once.json'].status, 'skipped-late');
      assert.equal(notes.length, 1);
      assert.match(notes[0], /超过 24 小时/);
      assert.match(notes[0], /不再补发/);
      assert.ok(!notes[0].includes(CHAT));
      for (let i = 0; i < 5; i++) { t.mock.timers.tick(30_000); await settle(); }
      assert.equal(fired.length, 0);
      assert.equal(notes.length, 1);
    } finally { h.stop(); env.cleanup(); }
  });

  test('when 是 19 天前的「YYYY-MM-DD HH:MM」空格写法、无状态记录：不触发', async (t) => {
    const d = new Date(NOW.getTime() - 19 * 24 * H);
    const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const { env, h, fired, notes } = await run(t, { when });
    try {
      assert.equal(fired.length, 0);
      assert.equal(env.readState()['once.json'].status, 'skipped-late');
      assert.equal(notes.length, 1);
    } finally { h.stop(); env.cleanup(); }
  });

  test('状态文件丢失 / 坏 JSON 且文件仍 enabled 的几周前一次性任务：不触发', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv(); let fired = 0;
    env.write('once.json', job({ name: 'once', when: localWhen(-21 * 24 * H) }));
    fs.writeFileSync(env.state, '{not json');
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, notifyOwner: async () => {}, onFire: async () => { fired += 1; } });
    try { await h.whenIdle(); assert.equal(fired, 0); } finally { h.stop(); env.cleanup(); }
  });

  test('上限边界：oneShotCatchupMaxMs 可注入；上限 4 小时时迟到 3 小时补发、迟到 5 小时跳过；上限 1 小时时迟到 3 小时跳过', async (t) => {
    for (const [late, cap, expectFire] of [[3, 4, 1], [5, 4, 0], [3, 1, 0]]) {
      const { env, h, fired } = await run(t, { when: () => localWhen(-late * H), extra: { oneShotCatchupMaxMs: cap * H } });
      try { assert.equal(fired.length, expectFire, `迟到 ${late}h / 上限 ${cap}h`); } finally { h.stop(); env.cleanup(); t.mock.timers.reset(); }
    }
  });
});

describe('R1-3 顺手项', () => {
  test('答案静默而回传文件发不出去：通知写「随附的文件发不出去」，不出现「结果发不出去」与 HEARTBEAT_OK', async (t) => {
    quiet(t);
    const notes = [];
    await assert.rejects(fireJob({
      job: { name: 'n', chat_id: CHAT, prompt: 'P' }, run: async () => 'HEARTBEAT_OK',
      send: async () => {}, flush: async () => { throw new Error('file'); },
      notifyOwner: async (x) => { notes.push(x); }, onRunFailure: async () => {}, isQuiet: (b) => b === 'HEARTBEAT_OK', sleep: async () => {}, log: () => {},
    }), /发送失败/);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /随附的文件发不出去/);
    assert.ok(!notes[0].includes('结果发不出去'));
    assert.ok(!notes[0].includes('HEARTBEAT_OK'));
  });

  test('任务结束落盘后记一行日志「结束（done|failed）」，不含 prompt / chat_id', async (t) => {
    const logs = [];
    t.mock.method(console, 'log', (...a) => { logs.push(a.join(' ')); });
    t.mock.method(console, 'error', () => {});
    mockClock(t);
    const env = mkEnv();
    env.write('ok.json', job({ name: 'okjob', prompt: 'SECRET-PROMPT-BODY' }));
    env.write('bad.json', job({ name: 'badjob', prompt: 'SECRET-PROMPT-BODY' }));
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, maxConcurrent: 2,
      onFire: async (j) => { if (j.name === 'badjob') throw new Error('x'); } });
    try {
      await h.idle();
      assert.ok(logs.includes('[sched] 「okjob」结束（done）'));
      assert.ok(logs.includes('[sched] 「badjob」结束（failed）'));
      assert.ok(!logs.some((l) => l.includes('SECRET-PROMPT-BODY') || l.includes(CHAT)));
    } finally { h.stop(); env.cleanup(); }
  });

  test('parseWhen：2026/11/21 09:00、2026-11-21 9:00 认作本地一次性时间；cron 不会被误判', () => {
    const local = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm).getTime();
    for (const w of ['2026/11/21 09:00', '2026-11-21 9:00']) {
      const p = parseWhen(w);
      assert.equal(p.kind, 'once', w);
      assert.equal(p.at.getTime(), local(2026, 11, 21, 9, 0), w);
    }
    assert.equal(parseWhen('0 9 * * *').kind, 'cron');
  });
});
