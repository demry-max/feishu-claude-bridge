// BRIDGE-PRIV-3 R1：button 模式走点击路径（真调度器 + 真确认卡 + 真 events.cardAction + 真确认记录），临时目录、假时钟。
// 每条用例断言「没有放行」：到 10:00 没有任何不该执行的任务被执行，候选状态没被改。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startScheduler } = await import('../src/scheduler.js');
const { createApprovalCards } = await import('../src/sched-approval-card.js');
const { createEventHandlers } = await import('../src/events.js');

const CHAT = 'oc_0123456789abcdef0123';
const NOW = new Date(2026, 10, 20, 9, 30, 0);
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const tick = async (t, ms) => { t.mock.timers.tick(ms); await settle(); };
const toTen = async (t) => { for (let i = 0; i < 61; i++) await tick(t, 30_000); };

function mkEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priv3-click-'));
  const env = { dir, jobs: path.join(dir, 'jobs'), state: path.join(dir, 'data', 'schedule-state.json'), key: path.join(dir, 'key') };
  fs.mkdirSync(env.jobs, { recursive: true }); fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  env.w = (n, j) => fs.writeFileSync(path.join(env.jobs, n), JSON.stringify(j));
  env.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return env;
}
const jobOf = (name, prompt) => ({ name, when: '0 10 * * *', prompt, chat_id: CHAT, enabled: true });

function rig(env, { owner = 'ou_owner' } = {}) {
  const sent = []; const fired = []; let seq = 0; let scheduler;
  const cards = createApprovalCards({
    send: async (card) => { sent.push(card); return { data: { message_id: `om_real${String(++seq).padStart(4, '0')}` } }; },
    notify: async () => {}, getOwner: () => owner, scheduler: () => scheduler, log: () => {},
  });
  scheduler = startScheduler({
    schedulesDir: env.jobs, stateFile: env.state, requireApproval: true, approvalKeyFile: env.key,
    turnFor: () => ({ private: false }), notifyOwner: async () => {}, onFire: async (j) => { fired.push([j._file, j.prompt]); },
    approvalMode: 'button', sendApprovalCard: (i) => cards.issue(i),
  });
  const ev = createEventHandlers({ getOwner: () => owner, heartbeat: () => null, schedApproval: () => cards, log: () => {} });
  // 回调 value 以 JSON 串传入；a = 0 确认、1 拒绝；patch 可覆盖按钮值里的字段
  const click = (card, id, { a = 0, op = owner, patch = {} } = {}) => ev.cardAction({
    operator: { open_id: op }, context: { open_message_id: id },
    action: { value: JSON.stringify({ ...card.body.elements.at(-1).columns[a].elements[0].behaviors[0].value, ...patch }) },
  });
  const states = () => Object.fromEntries(scheduler.approvalCandidates().map((c) => [c.file, c.state]));
  const idOf = (i) => `om_real${String(i + 1).padStart(4, '0')}`;
  return { sent, fired, scheduler, click, states, idOf };
}
const setup = async (t, jobs = { 'a.json': jobOf('A', 'PA'), 'b.json': jobOf('B', 'PB') }) => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW.getTime() });
  const env = mkEnv();
  for (const [n, j] of Object.entries(jobs)) env.w(n, j);
  const r = rig(env);
  await settle();
  return { env, r };
};
const PENDING = { 'a.json': 'pending', 'b.json': 'pending' };

describe('S5 点击确认后到点恰好执行 1 次', () => {
  test('真卡点确认 → 10:00 onFire 恰好 1 次，payload 是被确认的那份；没点的任务不执行', async (t) => {
    const { env, r } = await setup(t);
    try {
      assert.equal(r.sent.length, 2, '每个受闸任务一张卡');
      const out = await r.click(r.sent[0], r.idOf(0));
      assert.equal(out.toast.content, '已确认');
      assert.deepEqual(r.states(), { 'a.json': 'approved', 'b.json': 'pending' });
      await toTen(t);
      assert.deepEqual(r.fired, [['a.json', 'PA']]);
    } finally { r.scheduler.stop(); env.cleanup(); }
  });
  test('点拒绝 → 到点不执行', async (t) => {
    const { env, r } = await setup(t);
    try {
      const out = await r.click(r.sent[0], r.idOf(0), { a: 1 });
      assert.equal(out.toast.content, '已拒绝');
      await toTen(t);
      assert.deepEqual(r.fired, []);
    } finally { r.scheduler.stop(); env.cleanup(); }
  });
});

describe('点击路径上的几种不放行', () => {
  test('不在索引里的仿制卡（message_id 不是桥接发出的）：提示已失效、补发真卡，状态不变，不执行', async (t) => {
    const { env, r } = await setup(t);
    try {
      const out = await r.click(r.sent[0], 'om_forged001');
      assert.match(out.toast.content, /失效/);
      await settle();
      assert.deepEqual(r.states(), PENDING);
      assert.equal(r.sent.length, 3, '补发了一张真卡');
      await toTen(t);
      assert.deepEqual(r.fired, []);
    } finally { r.scheduler.stop(); env.cleanup(); }
  });
  test('同一次点击重放：第二次回已失效，不改状态；先拒绝再重放确认值也不放行', async (t) => {
    const { env, r } = await setup(t);
    try {
      assert.equal((await r.click(r.sent[0], r.idOf(0))).toast.content, '已确认');
      assert.deepEqual(await r.click(r.sent[0], r.idOf(0)), { toast: { type: 'warning', content: '已失效' } });
      assert.deepEqual(await r.click(r.sent[0], r.idOf(0), { a: 1 }), { toast: { type: 'warning', content: '已失效' } }, '用后不能再点成拒绝');
      assert.deepEqual(r.states(), { 'a.json': 'approved', 'b.json': 'pending' });
      // 另一张卡：先拒绝，再拿确认值重放
      assert.equal((await r.click(r.sent[1], r.idOf(1), { a: 1 })).toast.content, '已拒绝');
      assert.deepEqual(await r.click(r.sent[1], r.idOf(1), { a: 0 }), { toast: { type: 'warning', content: '已失效' } });
      assert.equal(r.states()['b.json'], 'rejected');
      await toTen(t);
      assert.deepEqual(r.fired, [['a.json', 'PA']]);
    } finally { r.scheduler.stop(); env.cleanup(); }
  });
  test('拿 A 任务的按钮值点 B 任务的卡：不放行 A 也不放行 B', async (t) => {
    const { env, r } = await setup(t);
    try {
      const out = await r.click(r.sent[0], r.idOf(1));
      assert.match(out.toast.content, /失效/);
      assert.deepEqual(r.states(), PENDING);
      await toTen(t);
      assert.deepEqual(r.fired, []);
    } finally { r.scheduler.stop(); env.cleanup(); }
  });
  test('换掉按钮值里的文件名：放行的只是卡片索引里绑定的那份（A），B 仍待确认，不执行 B', async (t) => {
    const { env, r } = await setup(t);
    try {
      const out = await r.click(r.sent[0], r.idOf(0), { patch: { f: 'b.json' } });
      assert.equal(out.toast.content, '已确认');
      assert.deepEqual(r.states(), { 'a.json': 'approved', 'b.json': 'pending' });
      await toTen(t);
      assert.deepEqual(r.fired, [['a.json', 'PA']]);
    } finally { r.scheduler.stop(); env.cleanup(); }
  });
  test('非 owner 点击：回已失效，不放行', async (t) => {
    const { env, r } = await setup(t);
    try {
      const out = await r.click(r.sent[1], r.idOf(1), { op: 'ou_other' });
      assert.equal(out.toast.content, '已失效');
      assert.deepEqual(r.states(), PENDING);
      await toTen(t);
      assert.deepEqual(r.fired, []);
    } finally { r.scheduler.stop(); env.cleanup(); }
  });
  test('任务内容变了以后点旧卡：提示内容已变，不放行；下一拍对新内容发新卡；到点只执行没改的', async (t) => {
    const { env, r } = await setup(t);
    try {
      assert.equal((await r.click(r.sent[0], r.idOf(0))).toast.content, '已确认');
      env.w('b.json', jobOf('B', 'PB2'));
      const out = await r.click(r.sent[1], r.idOf(1));
      assert.equal(out.toast.content, '任务内容已变，请看新的卡片');
      assert.equal(r.states()['b.json'], 'pending');
      await tick(t, 30_000);
      assert.ok(JSON.stringify(r.sent.at(-1)).includes('PB2'), '新内容发了新卡');
      await toTen(t);
      assert.deepEqual(r.fired, [['a.json', 'PA']]);
    } finally { r.scheduler.stop(); env.cleanup(); }
  });
  test('重启（新实例、空索引）后点旧卡：补发新卡，不放行；点新卡才生效', async (t) => {
    const { env, r } = await setup(t);
    let r2;
    try {
      const oldCards = [...r.sent];
      r.scheduler.stop();
      r2 = rig(env);
      await settle();
      const out = await r2.click(oldCards[1], r.idOf(1));
      assert.match(out.toast.content, /失效/);
      assert.deepEqual(r2.states(), PENDING);
      await toTen(t);
      assert.deepEqual(r2.fired, []);
      // 新实例自己发出的卡（同内容的旧卡已在状态里登记，需要补发的那张）点拒绝可以生效
      const fresh = r2.sent.at(-1);
      assert.ok(fresh, '补发了新卡');
      assert.equal((await r2.click(fresh, r2.idOf(r2.sent.length - 1), { a: 1 })).toast.content, '已拒绝');
    } finally { r.scheduler.stop(); r2?.scheduler.stop(); env.cleanup(); }
  });
});
