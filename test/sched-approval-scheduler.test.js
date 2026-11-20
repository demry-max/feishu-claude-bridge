// BRIDGE-PRIV-2：调度器里的确认闸（G1–G7、I1、I2）。
// 走真实的 startScheduler；onFire / notifyOwner / turnFor 换成替身，密钥文件放临时目录；30 秒一拍用 mock timers 推进（接管 setInterval 与 Date）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startScheduler } = await import('../src/scheduler.js');
const { SCHED_APPROVALS_FILE_NAME } = await import('../src/sched-approval.js');

const CHAT = 'oc_0123456789abcdef0123';
const NOW = new Date(2026, 10, 20, 9, 30, 0); // 本地 2026-11-20 09:30
const MIN = 60_000;
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const pad = (n) => String(n).padStart(2, '0');
const localWhen = (msFromNow) => {
  const d = new Date(Date.now() + msFromNow);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function mkEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-appr-s-'));
  const env = {
    dir, jobs: path.join(dir, 'jobs'), data: path.join(dir, 'data'), state: path.join(dir, 'data', 'schedule-state.json'),
    key: path.join(dir, 'key'),
    write(name, job) { fs.mkdirSync(env.jobs, { recursive: true }); fs.writeFileSync(path.join(env.jobs, name), JSON.stringify(job)); },
    readState: () => JSON.parse(fs.readFileSync(env.state, 'utf8')),
    seed(obj) { fs.writeFileSync(env.state, JSON.stringify(obj)); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
  fs.mkdirSync(env.data, { recursive: true });
  return env;
}
const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {}); };
const mockClock = (t, now = NOW) => t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: now.getTime() });
const CRON = '0 10 * * *';
const jobOf = (extra = {}) => ({ name: '晨报', when: CRON, prompt: 'P', chat_id: CHAT, enabled: true, ...extra });
const OTHER = () => ({ private: false });

function start(env, o = {}) {
  const fired = [];
  const notes = [];
  const h = startScheduler({
    schedulesDir: env.jobs, stateFile: env.state, requireApproval: true, approvalKeyFile: env.key,
    turnFor: OTHER, notifyOwner: async (x) => { notes.push(x); }, onFire: async (j) => { fired.push(j._file); },
    ...o,
  });
  return { h, fired, notes };
}
const cand = (h, file = 'a.json') => h.approvalCandidates().find((c) => c.file === file);
const decide = (h, decision, file = 'a.json') => { const c = cand(h, file); return h.approvalStore.decide(file, c.hash, decision); };
const adv = async (t, ms) => { t.mock.timers.tick(ms); await settle(); };

describe('G1 未确认不执行，只通知一次（持久化去重）', () => {
  test('到点不跑；通知含确认码、会话末 4 位，不含完整 chat_id / 提示词全文；同内容后续拍和重启都不再通知', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf({ when: localWhen(-MIN), prompt: 'SECRET-PROMPT-BODY' })); // 一次性且已到点
    const a = start(env);
    try {
      await settle();
      assert.deepEqual(a.fired, []);
      assert.equal(a.notes.length, 1);
      const c = cand(a.h);
      assert.equal(c.state, 'pending');
      assert.equal(c.announced, true);
      assert.ok(a.notes[0].includes(`/tasks approve ${c.code}`));
      assert.ok(a.notes[0].includes('0123') && !a.notes[0].includes(CHAT));
      await adv(t, 5 * MIN);
      assert.deepEqual(a.fired, []);
      assert.equal(a.notes.length, 1, '同内容不重复通知');
    } finally { a.h.stop(); }
    const b = start(env);
    try {
      await settle();
      assert.equal(b.notes.length, 0, '重启后同内容仍不重复通知');
      assert.deepEqual(b.fired, []);
      assert.equal(cand(b.h).state, 'pending');
      assert.equal(cand(b.h).announced, true);
    } finally { b.h.stop(); env.cleanup(); }
  });
  test('同一拍两个待确认任务合并成一条通知', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    env.write('b.json', jobOf({ name: '晚报' }));
    const a = start(env);
    try {
      await settle();
      assert.equal(a.notes.length, 1);
      assert.ok(a.notes[0].includes('2 项'));
    } finally { a.h.stop(); env.cleanup(); }
  });
});

describe('G2 确认后按时执行', () => {
  test('cron：到点前确认，到点执行一次', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env);
    try {
      await settle();
      assert.equal(decide(a.h, 'approved').ok, true);
      await adv(t, 29 * MIN);
      assert.deepEqual(a.fired, [], '还没到 10:00');
      await adv(t, 2 * MIN);
      assert.deepEqual(a.fired, ['a.json']);
      await adv(t, 5 * MIN);
      assert.deepEqual(a.fired, ['a.json'], '只跑一次');
      assert.equal(a.h.approvalOf({ ...jobOf(), _file: 'a.json' }).state, 'approved');
    } finally { a.h.stop(); env.cleanup(); }
  });
  test('一次性：未来的时间点，确认后到点执行', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf({ when: localWhen(5 * MIN) }));
    const a = start(env);
    try {
      await settle();
      decide(a.h, 'approved');
      await adv(t, 7 * MIN);
      assert.deepEqual(a.fired, ['a.json']);
    } finally { a.h.stop(); env.cleanup(); }
  });
});

describe('G3 确认之前的点不补跑', () => {
  test('cron 没有历史记录：确认时已过点 → 记基线、不跑，第二天照常', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env);
    try {
      await adv(t, 40 * MIN); // 10:10，期间 10:00 已过且没确认
      assert.deepEqual(a.fired, []);
      decide(a.h, 'approved');
      await adv(t, 30_000);
      assert.deepEqual(a.fired, [], '不补 10:00 那一次');
      assert.equal(env.readState()['a.json'].status, 'baseline');
      await adv(t, 24 * 60 * MIN);
      assert.deepEqual(a.fired, ['a.json'], '第二天 10:00 照常');
    } finally { a.h.stop(); env.cleanup(); }
  });
  test('cron 有历史记录（以前不受闸）：确认时间晚于点 → 记基线、不跑', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const y = new Date(2026, 10, 19, 10, 0, 0).toISOString();
    env.seed({ 'a.json': { at: y, when: CRON, status: 'done' } });
    const a = start(env);
    try {
      await adv(t, 40 * MIN);
      decide(a.h, 'approved');
      await adv(t, 30_000);
      assert.deepEqual(a.fired, []);
      assert.equal(env.readState()['a.json'].status, 'baseline');
    } finally { a.h.stop(); env.cleanup(); }
  });
  test('一次性已过点：确认后记 skipped-pending、不跑，候选标 expired', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf({ when: localWhen(-5 * MIN) }));
    const a = start(env);
    try {
      await settle();
      assert.equal(cand(a.h).expired, true);
      decide(a.h, 'approved');
      await adv(t, 30_000);
      assert.deepEqual(a.fired, []);
      assert.equal(env.readState()['a.json'].status, 'skipped-pending');
      await adv(t, 10 * MIN);
      assert.deepEqual(a.fired, [], '之后也不会再跑');
    } finally { a.h.stop(); env.cleanup(); }
  });
});

describe('G4 已拒绝；G5 内容变了重新确认', () => {
  test('rejected 不执行也不再通知；恢复为 approved 后正常', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env);
    try {
      await settle();
      decide(a.h, 'rejected');
      await adv(t, 35 * MIN);
      assert.deepEqual(a.fired, []);
      assert.equal(cand(a.h).state, 'rejected');
      assert.equal(a.notes.length, 1);
      decide(a.h, 'approved');
      await adv(t, 30_000); // 确认时 10:00 已过：这一拍只记基线（mock 的大步长不会逐拍推进时间，所以单独走一拍）
      assert.deepEqual(a.fired, []);
      await adv(t, 24 * 60 * MIN);
      assert.deepEqual(a.fired, ['a.json']);
    } finally { a.h.stop(); env.cleanup(); }
  });
  test('rejected 且任务已有历史记录：拒绝之后到点也不跑（拒绝不是靠没登记基线才不跑）', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    env.seed({ 'a.json': { at: new Date(2026, 10, 19, 10, 0, 0).toISOString(), when: CRON, status: 'done' } });
    const a = start(env);
    try {
      await settle();
      decide(a.h, 'rejected'); // 09:30，之后才到 10:00
      await adv(t, 35 * MIN);
      assert.deepEqual(a.fired, []);
      await adv(t, 24 * 60 * MIN);
      assert.deepEqual(a.fired, [], '第二天也不跑');
      assert.equal(cand(a.h).state, 'rejected');
    } finally { a.h.stop(); env.cleanup(); }
  });
  for (const [tag, ch] of [['提示词', { prompt: 'Q' }], ['时间', { when: '0 11 * * *' }], ['目的地', { chat_id: 'oc_ffffffffffffffffffff' }], ['动作', { action: 'set-model', prompt: undefined }], ['任务名', { name: '改名' }]]) {
    test(`改${tag}：回到待确认、换确认码、再通知一次；旧确认码在候选里已不存在`, async (t) => {
      quiet(t); mockClock(t);
      const env = mkEnv();
      env.write('a.json', jobOf());
      const a = start(env);
      try {
        await settle();
        const old = cand(a.h);
        decide(a.h, 'approved');
        env.write('a.json', jobOf(ch));
        await adv(t, 30_000);
        const now = cand(a.h);
        assert.equal(now.state, 'pending');
        assert.notEqual(now.code, old.code);
        assert.equal(a.notes.length, 2);
        assert.ok(a.notes[1].includes(`/tasks approve ${now.code}`));
        assert.equal(a.h.approvalCandidates().some((c) => c.code === old.code), false);
        await adv(t, 60 * MIN);
        assert.deepEqual(a.fired, []);
      } finally { a.h.stop(); env.cleanup(); }
    });
  }
  for (const [tag, ch] of [['model', { model: 'x' }], ['effort', { effort: 'high' }]]) {
    test(`prompt 型任务只改 ${tag}：重新待确认、再通知一次、到点不跑`, async (t) => {
      quiet(t); mockClock(t);
      const env = mkEnv();
      env.write('a.json', jobOf());
      const a = start(env);
      try {
        await settle();
        const old = cand(a.h);
        decide(a.h, 'approved');
        env.write('a.json', jobOf(ch));
        await adv(t, 30_000);
        const now = cand(a.h);
        assert.equal(now.state, 'pending');
        assert.notEqual(now.code, old.code);
        assert.equal(a.notes.length, 2, '再通知一次');
        assert.ok(a.notes[1].includes(`/tasks approve ${now.code}`));
        await adv(t, 60_000);
        assert.equal(a.notes.length, 2, '不重复');
        await adv(t, 60 * MIN);
        assert.deepEqual(a.fired, []);
      } finally { a.h.stop(); env.cleanup(); }
    });
  }
});

describe('G5b 已确认的任务只改名 / 动作型改参数：回到待确认、再通知、到点不跑', () => {
  test('只改 name：待确认、通知第二次、到点不跑', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env);
    try {
      await settle();
      const old = cand(a.h);
      decide(a.h, 'approved');
      env.write('a.json', jobOf({ name: '<at user_id="all"></at>改名' }));
      await adv(t, 30_000);
      const now = cand(a.h);
      assert.equal(now.state, 'pending');
      assert.notEqual(now.code, old.code);
      assert.equal(a.notes.length, 2);
      await adv(t, 60 * MIN);
      assert.deepEqual(a.fired, []);
    } finally { a.h.stop(); env.cleanup(); }
  });
  test('动作型任务改 model：待确认、到点不跑', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf({ action: 'set-model', prompt: undefined, model: 'm1' }));
    const a = start(env);
    try {
      await settle();
      decide(a.h, 'approved');
      env.write('a.json', jobOf({ action: 'set-model', prompt: undefined, model: 'm2' }));
      await adv(t, 30_000);
      assert.equal(cand(a.h).state, 'pending');
      assert.equal(a.notes.length, 2);
      await adv(t, 60 * MIN);
      assert.deepEqual(a.fired, []);
    } finally { a.h.stop(); env.cleanup(); }
  });
});

describe('G6 失败时按受闸处理', () => {
  test('turnFor 抛错：受闸、不执行', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf({ when: localWhen(-MIN) }));
    const a = start(env, { turnFor: () => { throw new Error('boom'); } });
    try {
      await adv(t, 5 * MIN);
      assert.deepEqual(a.fired, []);
      assert.equal(cand(a.h).state, 'pending');
      assert.equal(a.notes.length, 1);
    } finally { a.h.stop(); env.cleanup(); }
  });
  test('没有 turnFor：受闸', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf({ when: localWhen(-MIN) }));
    const a = start(env, { turnFor: undefined });
    try {
      await settle();
      assert.deepEqual(a.fired, []);
      assert.equal(cand(a.h).state, 'pending');
    } finally { a.h.stop(); env.cleanup(); }
  });
  test('owner 私聊 id 未知（destUnknown）：受闸，通知里加注', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env, { turnFor: () => ({ private: false, destUnknown: true }) });
    try {
      await settle();
      assert.equal(a.h.approvalOf({ ...jobOf(), _file: 'a.json' }).destUnknown, true);
      assert.ok(a.notes[0].includes('桥接还不知道你的私聊会话'));
    } finally { a.h.stop(); env.cleanup(); }
  });
  test('任务从「发往 owner 私聊」变成「发往别处」（turnFor 结果变了）：从不受闸变成待确认', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    let priv = true;
    const a = start(env, { turnFor: () => ({ private: priv }) });
    try {
      await settle();
      assert.equal(a.h.approvalOf({ ...jobOf(), _file: 'a.json' }), null);
      priv = false;
      await adv(t, 30_000);
      assert.equal(cand(a.h).state, 'pending');
      assert.equal(a.notes.length, 1);
    } finally { a.h.stop(); env.cleanup(); }
  });
});

describe('G7 重启与篡改', () => {
  test('确认记录跨重启有效；记录文件被改成 approved 则重启后按待确认', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env);
    await settle();
    decide(a.h, 'rejected');
    a.h.stop();
    const recFile = path.join(env.data, SCHED_APPROVALS_FILE_NAME);
    const b = start(env);
    try {
      assert.equal(cand(b.h).state, 'rejected', '重启后仍是已拒绝');
    } finally { b.h.stop(); }
    const d = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    d.entries['a.json'].decision = 'approved';
    fs.writeFileSync(recFile, JSON.stringify(d));
    const c = start(env);
    try {
      assert.equal(cand(c.h).state, 'pending', '签名对不上，按待确认');
      assert.equal(c.h.approvalStore.invalidCount, 1);
      await adv(t, 40 * MIN);
      assert.deepEqual(c.fired, []);
    } finally { c.h.stop(); env.cleanup(); }
  });
  test('确认后重启：任务按时执行', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env);
    await settle();
    decide(a.h, 'approved');
    a.h.stop();
    const b = start(env);
    try {
      await adv(t, 31 * MIN);
      assert.deepEqual(b.fired, ['a.json']);
    } finally { b.h.stop(); env.cleanup(); }
  });
});

const HEAD = (n) => `定时任务的确认记录有 ${n} 条校验不通过（或签名密钥已重建），之前的确认 / 拒绝已作废。本条里带 ⏸ 的任务需要你重新确认：`;

describe('G8 确认记录作废后重新问 owner，同一次作废只问一次', () => {
  test('密钥被删：重启首拍合并成一条（标题行 + 新通知），任务不执行；再重启不再通知，记录里没有旧条目', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env);
    await settle();
    decide(a.h, 'approved');
    a.h.stop();
    const recFile = path.join(env.data, SCHED_APPROVALS_FILE_NAME);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(recFile, 'utf8')).entries).length, 1);
    fs.rmSync(env.key);
    const b = start(env);
    try {
      await settle();
      assert.equal(b.notes.length, 1, '首拍恰好一条私聊');
      assert.ok(b.notes[0].startsWith('⚠️ 定时任务调度器有 2 项需要你知道：'));
      // 合并时每行去掉开头的 ⚠️，所以这里核对去掉前缀后的原文
      assert.ok(b.notes[0].includes(HEAD(1)), b.notes[0]);
      const c = cand(b.h);
      assert.equal(c.state, 'pending');
      assert.ok(b.notes[0].includes(`/tasks approve ${c.code}`));
      assert.ok(b.notes[0].indexOf(HEAD(1)) < b.notes[0].indexOf('/tasks approve'), '标题行在前');
      await adv(t, 40 * MIN);
      assert.deepEqual(b.fired, []);
      assert.equal(b.notes.length, 1);
    } finally { b.h.stop(); }
    const d = start(env);
    try {
      await adv(t, 30_000);
      assert.equal(d.notes.length, 0, '密钥已稳定：不再问');
      assert.equal(d.h.approvalStore.invalidCount, 0);
      assert.equal(d.h.approvalStore.invalidated, false);
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(recFile, 'utf8')).entries), [], '旧条目已清掉');
      assert.equal(cand(d.h).state, 'pending');
      assert.equal(cand(d.h).announced, true);
    } finally { d.h.stop(); env.cleanup(); }
  });
  test('密钥重建时没有受闸任务：不发标题行', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env);
    await settle();
    decide(a.h, 'approved');
    a.h.stop();
    fs.rmSync(env.key);
    fs.rmSync(path.join(env.jobs, 'a.json'));
    const b = start(env);
    try {
      await adv(t, 30_000);
      assert.equal(b.notes.length, 0);
    } finally { b.h.stop(); env.cleanup(); }
  });
  test('G8b 一条被篡改、另一条合法：只有被篡改的重新通知；合法的照常执行；重写后再重启无通知', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    env.write('b.json', jobOf({ name: '晚报' }));
    const a = start(env);
    await settle();
    decide(a.h, 'rejected', 'a.json');
    decide(a.h, 'approved', 'b.json');
    a.h.stop();
    const recFile = path.join(env.data, SCHED_APPROVALS_FILE_NAME);
    const d0 = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    d0.entries['a.json'].decision = 'approved';
    fs.writeFileSync(recFile, JSON.stringify(d0));
    const b = start(env);
    try {
      await settle();
      assert.equal(b.notes.length, 1);
      assert.ok(b.notes[0].includes(HEAD(1)));
      assert.ok(b.notes[0].includes(`/tasks approve ${cand(b.h, 'a.json').code}`));
      assert.ok(!b.notes[0].includes(`/tasks approve ${cand(b.h, 'b.json').code}`), '合法那条不重新通知');
      assert.equal(cand(b.h, 'a.json').state, 'pending');
      assert.equal(cand(b.h, 'b.json').state, 'approved');
      await adv(t, 40 * MIN);
      assert.deepEqual(b.fired, ['b.json'], '合法的照常执行，被篡改的不跑');
    } finally { b.h.stop(); }
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(recFile, 'utf8')).entries), ['b.json']);
    const c = start(env);
    try {
      await adv(t, 30_000);
      assert.equal(c.notes.length, 0);
      assert.equal(c.h.approvalStore.invalidCount, 0);
      assert.equal(cand(c.h, 'b.json').state, 'approved');
    } finally { c.h.stop(); env.cleanup(); }
  });
});

describe('I1/I2 不受闸的任务与不开闸的调度器：行为不变', () => {
  const scenario = async (t, opts) => {
    mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    env.write('once.json', jobOf({ name: '提醒', when: localWhen(5 * MIN) }));
    const r = start(env, opts);
    await adv(t, 35 * MIN);
    await r.h.idle();
    const out = { fired: [...r.fired], notes: [...r.notes], state: Object.fromEntries(Object.entries(env.readState()).map(([k, v]) => [k, v.status])) };
    r.h.stop();
    const files = fs.readdirSync(env.data).sort();
    env.cleanup();
    return { ...out, files };
  };
  test('I1 发往 owner 私聊的任务：开闸与不开闸结果逐项相同，且根本不查确认记录', async (t) => {
    quiet(t);
    const withGate = await scenario(t, { turnFor: () => ({ private: true }), requireApproval: true });
    t.mock.timers.reset();
    const without = await scenario(t, { turnFor: () => ({ private: true }), requireApproval: false });
    t.mock.timers.reset();
    assert.equal(withGate.fired.length, 2, '两个都跑了');
    assert.deepEqual(withGate.fired, without.fired);
    assert.deepEqual(withGate.notes, without.notes);
    assert.deepEqual(withGate.state, without.state);
    assert.deepEqual(withGate.files, without.files, '不产生确认记录文件');
    assert.ok(!withGate.files.includes(SCHED_APPROVALS_FILE_NAME));
  });
  test('I1b 私聊任务不调用 lookup', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf({ when: localWhen(-MIN) }));
    const a = start(env, { turnFor: () => ({ private: true }) });
    try {
      const spy = t.mock.method(a.h.approvalStore, 'lookup');
      await adv(t, 5 * MIN);
      assert.equal(spy.mock.callCount(), 0);
      assert.deepEqual(a.fired, ['a.json']);
      assert.deepEqual(a.h.approvalCandidates(), []);
    } finally { a.h.stop(); env.cleanup(); }
  });
  test('I2 不开闸（默认）：发往别处的任务照旧执行，没有候选、没有确认 store、没有 sched-approvals.json', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf({ when: localWhen(-MIN) }));
    const fired = [];
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, turnFor: OTHER, onFire: async (j) => { fired.push(j._file); } });
    try {
      await settle();
      assert.deepEqual(fired, ['a.json']);
      assert.equal(h.approvalStore, null);
      assert.deepEqual(h.approvalCandidates(), []);
      assert.equal(h.approvalOf({ ...jobOf(), _file: 'a.json' }), null);
      assert.equal(fs.existsSync(path.join(env.data, SCHED_APPROVALS_FILE_NAME)), false);
    } finally { h.stop(); env.cleanup(); }
  });
  test('I2b 没写 chat_id 的任务不受闸（照旧到点执行，由 onFire 报缺）', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', { name: 'n', when: localWhen(-MIN), prompt: 'P', enabled: true });
    const a = start(env);
    try {
      await settle();
      assert.deepEqual(a.fired, ['a.json']);
      assert.deepEqual(a.h.approvalCandidates(), []);
      assert.equal(a.notes.length, 0);
    } finally { a.h.stop(); env.cleanup(); }
  });
});
