// BRIDGE-PRIV-3：调度器的 button 模式（S1–S6、D1、D2）。走真实的 startScheduler，假时钟，密钥与记录放临时目录。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startScheduler } = await import('../src/scheduler.js');

const CHAT = 'oc_0123456789abcdef0123';
const NOW = new Date(2026, 10, 20, 9, 30, 0);
const MIN = 60_000;
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
function mkEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priv3-sb-'));
  const env = {
    dir, jobs: path.join(dir, 'jobs'), data: path.join(dir, 'data'), state: path.join(dir, 'data', 'schedule-state.json'), key: path.join(dir, 'key'),
    write(name, job) { fs.mkdirSync(env.jobs, { recursive: true }); fs.writeFileSync(path.join(env.jobs, name), JSON.stringify(job)); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
  fs.mkdirSync(env.data, { recursive: true });
  return env;
}
const quiet = (t) => { const logs = []; t.mock.method(console, 'log', (...a) => logs.push(a.join(' '))); t.mock.method(console, 'error', () => {}); return logs; };
const mockClock = (t) => t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW.getTime() });
const jobOf = (extra = {}) => ({ name: '晨报', when: '0 10 * * *', prompt: 'P', chat_id: CHAT, enabled: true, ...extra });
const adv = async (t, ms) => { t.mock.timers.tick(ms); await settle(); };

function start(env, o = {}) {
  const fired = [];
  const notes = [];
  const cards = [];
  const h = startScheduler({
    schedulesDir: env.jobs, stateFile: env.state, requireApproval: true, approvalKeyFile: env.key,
    turnFor: () => ({ private: false }), notifyOwner: async (x) => { notes.push(x); }, onFire: async (j) => { fired.push(j._file); },
    approvalMode: 'button',
    sendApprovalCard: async (info) => { cards.push(info); return o.cardResult === undefined ? true : (typeof o.cardResult === 'function' ? o.cardResult(info) : o.cardResult); },
    ...o.opts,
  });
  return { h, fired, notes, cards };
}
const cand = (h, file = 'a.json') => h.approvalCandidates().find((c) => c.file === file);

describe('S1–S6 button 模式', () => {
  test('S1 受闸任务：发一张确认卡（带 file / hash / job / destUnknown），不发文字通知；同内容后续拍与重启不再发', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env);
    try {
      await settle();
      assert.equal(a.h.approvalMode, 'button');
      assert.equal(a.cards.length, 1);
      assert.deepEqual(Object.keys(a.cards[0]).sort(), ['destUnknown', 'file', 'hash', 'job']);
      assert.equal(a.cards[0].file, 'a.json');
      assert.equal(a.cards[0].hash, cand(a.h).hash);
      assert.equal(a.cards[0].job.name, '晨报');
      assert.deepEqual(a.notes, [], '卡发成功就不再发文字通知');
      assert.deepEqual(a.fired, []);
      await adv(t, 5 * MIN);
      assert.equal(a.cards.length, 1, '同内容不重复发卡');
    } finally { a.h.stop(); }
    const b = start(env);
    try {
      await settle();
      assert.equal(b.cards.length, 0, '重启后同内容仍不重复发');
      assert.deepEqual(b.notes, []);
    } finally { b.h.stop(); env.cleanup(); }
  });
  test('S2 发卡返回 false / 抛错：退回文字通知（带兜底那一句和确认码），不抛', async (t) => {
    quiet(t); mockClock(t);
    for (const cardResult of [false, () => { throw new Error('boom'); }, () => Promise.reject(new Error('x')), 'yes']) {
      const env = mkEnv();
      env.write('a.json', jobOf());
      const a = start(env, { cardResult });
      try {
        await settle();
        assert.equal(a.cards.length, 1);
        assert.equal(a.notes.length, 1);
        const code = cand(a.h).code;
        assert.ok(a.notes[0].includes('确认卡发不出去，先用文字通知'));
        assert.ok(a.notes[0].includes(`/tasks approve ${code}`) && a.notes[0].includes(`/tasks reject ${code}`));
        assert.ok(!a.notes[0].includes(CHAT));
      } finally { a.h.stop(); env.cleanup(); }
    }
  });
  test('S3 同一拍最多发 5 张，其余留到下一拍（不记、不丢）', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    for (let i = 0; i < 7; i++) env.write(`j${i}.json`, jobOf({ name: `任务${i}` }));
    const a = start(env);
    try {
      await settle();
      assert.equal(a.cards.length, 5);
      await adv(t, 30_000);
      assert.equal(a.cards.length, 7, '下一拍补齐剩下的');
      assert.equal(new Set(a.cards.map((c) => c.file)).size, 7, '每个任务一张');
      await adv(t, 30_000);
      assert.equal(a.cards.length, 7);
    } finally { a.h.stop(); env.cleanup(); }
  });
  test('S4 任务内容改了：新哈希再发一张卡；用 resendApprovalCard 补发有 2 分钟限频，已确认 / 不存在 → gone', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env);
    try {
      await settle();
      assert.equal(a.cards.length, 1);
      assert.equal(a.h.resendApprovalCard('a.json'), 'sent');
      await settle();
      assert.equal(a.cards.length, 2);
      assert.equal(a.h.resendApprovalCard({ file: 'a.json' }), 'recent');
      await adv(t, 119_000);
      assert.equal(a.h.resendApprovalCard('a.json'), 'recent');
      await adv(t, 2_000);
      assert.equal(a.h.resendApprovalCard('a.json'), 'sent');
      await settle();
      assert.equal(a.cards.length, 3);
      assert.equal(a.cards.length, 3, '补发之后下一拍也不再重复发同一内容');
      await adv(t, 30_000);
      assert.equal(a.cards.length, 3);
      for (const bad of ['nope.json', '', undefined, null, 7, {}]) assert.equal(a.h.resendApprovalCard(bad), 'gone');
      // 内容改了 → 下一拍对新内容发一张新卡
      env.write('a.json', jobOf({ prompt: 'P2' }));
      await adv(t, 30_000);
      assert.equal(a.cards.length, 4);
      assert.notEqual(a.cards[3].hash, a.cards[0].hash);
      // 确认后补发 → gone
      assert.equal(a.h.approvalStore.decide('a.json', cand(a.h).hash, 'approved').ok, true);
      assert.equal(a.h.resendApprovalCard('a.json'), 'gone');
    } finally { a.h.stop(); env.cleanup(); }
  });
  test('S5 确认记录作废（签名密钥重建）时：button 模式只提示一次，说明会各发一张卡，不含「带 ⏸」那句', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env);
    try { await settle(); a.h.approvalStore.decide('a.json', cand(a.h).hash, 'approved'); } finally { a.h.stop(); }
    fs.writeFileSync(env.key, 'not a key'); // 密钥坏了 → 重建 → 旧记录验不过
    const b = start(env, { opts: {} });
    try {
      await settle();
      assert.equal(b.cards.length, 1);
      assert.equal(b.notes.length, 1);
      assert.match(b.notes[0], /之前的确认 \/ 拒绝已作废。需要你重新确认的任务会各发一张确认卡。$/);
      assert.ok(!b.notes[0].includes('带 ⏸'));
    } finally { b.h.stop(); env.cleanup(); }
  });
  test('S5b 作废提示按实际条数写、同一拍多个任务也只说一次（button 与 command 各一遍）', async (t) => {
    quiet(t); mockClock(t);
    for (const mode of ['button', 'command']) {
      const env = mkEnv();
      for (const n of ['a', 'b', 'c']) env.write(`${n}.json`, jobOf({ name: `任务${n}`, prompt: `P${n}` }));
      const a = start(env, { opts: { approvalMode: mode } });
      try { await settle(); for (const n of ['a', 'b', 'c']) a.h.approvalStore.decide(`${n}.json`, cand(a.h, `${n}.json`).hash, 'approved'); } finally { a.h.stop(); }
      fs.writeFileSync(env.key, 'not a key');
      const b = start(env, { opts: { approvalMode: mode } });
      try {
        await settle();
        assert.equal(b.notes.length, 1, mode);
        const said = b.notes[0].split('定时任务的确认记录有 3 条校验不通过').length - 1;
        assert.equal(said, 1, `${mode}：提示只能出现一次且写的是 3 条 :: ${b.notes[0]}`);
        assert.equal(b.notes[0].includes('有 1 条'), false);
        if (mode === 'button') assert.equal(b.cards.length, 3);
        else assert.equal(b.notes[0].split('/tasks approve').length - 1, 3);
      } finally { b.h.stop(); env.cleanup(); }
    }
  });
  test('S6 没有 sendApprovalCard / 没有 notifyOwner / requireApproval 为假：不发卡，与 command 一致', async (t) => {
    quiet(t); mockClock(t);
    {
      const env = mkEnv(); env.write('a.json', jobOf());
      const notes = [];
      const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, requireApproval: true, approvalKeyFile: env.key, turnFor: () => ({ private: false }), notifyOwner: async (x) => { notes.push(x); }, onFire: async () => {}, approvalMode: 'button' });
      try { await settle(); assert.equal(notes.length, 1); assert.ok(notes[0].includes('/tasks approve')); assert.ok(!notes[0].includes('确认卡发不出去')); assert.equal(h.resendApprovalCard('a.json'), 'gone'); } finally { h.stop(); env.cleanup(); }
    }
    {
      const env = mkEnv(); env.write('a.json', jobOf());
      const cards = [];
      const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, requireApproval: true, approvalKeyFile: env.key, turnFor: () => ({ private: false }), onFire: async () => {}, approvalMode: 'button', sendApprovalCard: async (i) => { cards.push(i); return true; } });
      try { await settle(); assert.deepEqual(cards, [], '没有 notifyOwner 就没有通知渠道，不发'); } finally { h.stop(); env.cleanup(); }
    }
    {
      const env = mkEnv(); env.write('a.json', jobOf());
      const cards = []; const fired = [];
      const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, turnFor: () => ({ private: false }), notifyOwner: async () => {}, onFire: async (j) => { fired.push(j._file); }, approvalMode: 'button', sendApprovalCard: async (i) => { cards.push(i); return true; } });
      try { await settle(); assert.equal(h.approvalMode, 'command'); assert.deepEqual(cards, []); await adv(t, 29 * MIN); await adv(t, 2 * MIN); assert.deepEqual(fired, ['a.json'], '不受闸，照常执行'); } finally { h.stop(); env.cleanup(); }
    }
  });
  test('点了确认之后到点才执行（卡片路径不改调度语义）', async (t) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    const a = start(env);
    try {
      await settle();
      assert.deepEqual(a.fired, []);
      assert.equal(a.h.approvalStore.decide(a.cards[0].file, a.cards[0].hash, 'approved').ok, true);
      await adv(t, 29 * MIN);
      assert.deepEqual(a.fired, [], '还没到 10:00');
      await adv(t, 2 * MIN);
      assert.deepEqual(a.fired, ['a.json']);
    } finally { a.h.stop(); env.cleanup(); }
  });
});

describe('D1–D2 command 模式不变', () => {
  const run = async (t, mode) => {
    quiet(t); mockClock(t);
    const env = mkEnv();
    env.write('a.json', jobOf());
    env.write('b.json', jobOf({ name: '晚报' }));
    const cards = [];
    const notes = [];
    const opts = { schedulesDir: env.jobs, stateFile: env.state, requireApproval: true, approvalKeyFile: env.key, turnFor: () => ({ private: false }), notifyOwner: async (x) => { notes.push(x); }, onFire: async () => {}, sendApprovalCard: async (i) => { cards.push(i); return true; } };
    if (mode !== '<unset>') opts.approvalMode = mode;
    const h = startScheduler(opts);
    try {
      await settle();
      await adv(t, 30_000);
      return { notes: notes.map((n) => n.replace(/[0-9a-f]{6}/g, 'CODE')), cards: cards.length, mode: h.approvalMode, resend: h.resendApprovalCard('a.json') };
    } finally { h.stop(); env.cleanup(); }
  };
  test('D1 不传 / command / 不认识的值：通知逐字相同，sendApprovalCard 一次都不调，resend 恒为 gone', async (t) => {
    const base = await (async () => { let r; await t.test('unset', async (tt) => { r = await run(tt, '<unset>'); }); return r; })();
    assert.equal(base.cards, 0);
    assert.equal(base.mode, 'command');
    assert.equal(base.resend, 'gone');
    assert.equal(base.notes.length, 1);
    assert.ok(base.notes[0].includes('/tasks approve CODE') && base.notes[0].includes('2 项'));
    for (const mode of ['command', '', ' COMMAND ', 'bogus', 'buttons', 7]) {
      await t.test(`approvalMode=${JSON.stringify(mode)}`, async (tt) => {
        const r = await run(tt, mode);
        assert.deepEqual(r, base);
      });
    }
  });
  test('D2 不认识的值只在启动时记一行（不回显原值）', async (t) => {
    const env = mkEnv();
    const logs = quiet(t); mockClock(t);
    env.write('a.json', jobOf());
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, requireApproval: true, approvalKeyFile: env.key, turnFor: () => ({ private: false }), notifyOwner: async () => {}, onFire: async () => {}, approvalMode: 'sekret-typo' });
    try {
      await settle(); await adv(t, 90_000);
      const hits = logs.filter((l) => l.includes('SCHED_APPROVAL_MODE'));
      assert.deepEqual(hits, ['[sched] SCHED_APPROVAL_MODE 只认 command / button，按 command 处理']);
      assert.ok(!logs.join('\n').includes('sekret-typo'));
    } finally { h.stop(); env.cleanup(); }
  });
});
