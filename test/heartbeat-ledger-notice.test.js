// BRIDGE-LEDGER-1：台账坏条目通知 owner（H-4）；心跳状态写不进去时不重发（H-3 心跳部分）；
// 台账一拍读不出来不清桥接侧记录（M-7 第一半）。全部用临时目录 + 假时钟 + 注入桩，不起子进程、不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  mkEnv, harness, CFG, writeTask, readTask, taskFile, at, plus, T0, click, btn, TOAST_STALE, OWNER,
} from './vr-harness.js';

const base = (o = {}) => ({ title: '跟进报价单', status: 'open', next_check_at: '2026-11-16T09:00', created_at: '2026-11-15T09:00', ...o });
const LONG = '长'.repeat(301);
const isRoot = () => process.getuid?.() === 0;
const titles = (h) => h.sent.map((s) => s.text);
const count = (h, re) => titles(h).filter((t) => re.test(t)).length;
const NOTICE = /台账文件读不了/;
const FAULT = /心跳状态写不进去/;
const withDirLocked = async (dir, fn) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o555);
  try { return await fn(); } finally { fs.chmodSync(dir, 0o755); }
};
const next = (h, min = 30) => h.setNow(plus(h.now(), min));

// ------------------------------------------------------------------ H-4：坏台账通知

test('T1 坏台账（H1）：notes 301 字 → 私聊一条、不带内容；不重复；内容变了 / 修好后再坏才再发', async () => {
  const env = mkEnv();
  writeTask(env, 'bad', base({ title: '坏的', notes: LONG }));
  writeTask(env, 'quote', base());
  const h = harness(env, {
    runImpl: async () => { writeTask(env, 'quote', { ...readTask(env, 'quote'), next_check_at: '2026-12-01T09:00' }); return '合法那条的提醒'; },
  });
  const r1 = await h.hb.beat();
  assert.equal(r1.action, 'sent'); // 动作语义照原分支（调了模型并发出）
  assert.equal(h.calls.length, 1, '合法那条照常到期调模型');
  assert.equal(h.sent.length, 2);
  const notice = h.sent[0].text;
  assert.match(notice, NOTICE);
  assert.match(notice, /tasks\/bad\.json：notes 超过 300 字/);
  assert.match(notice, /修好之前不会到期提醒/);
  assert.ok(!notice.includes('长长长') && !notice.includes('坏的'), '正文不带文件内容');
  assert.match(h.sent[1].text, /合法那条的提醒/);
  for (let i = 0; i < 3; i++) { next(h); await h.hb.beat(); }
  assert.equal(count(h, NOTICE), 1, '之后 3 拍不再发');
  assert.equal(h.calls.length, 1);
  assert.ok(h.readState().invalid_notified?.['bad.json']);

  next(h); writeTask(env, 'bad', base({ title: '坏的', notes: `${LONG}二` })); // 仍然坏、内容变了
  await h.hb.beat();
  assert.equal(count(h, NOTICE), 2, '内容变了（仍然坏）再发一次');

  next(h); writeTask(env, 'bad', base({ title: '坏的', notes: '好了' }));
  await h.hb.beat();
  assert.equal(count(h, NOTICE), 2, '修好不发');
  assert.equal(h.readState().invalid_notified, undefined, '变合法后记录删掉');

  next(h); writeTask(env, 'bad', base({ title: '坏的', notes: `${LONG}二` })); // 与上一次逐字相同
  await h.hb.beat();
  assert.equal(count(h, NOTICE), 3, '修好后再弄坏（哪怕与之前逐字相同）算新的一次');
  const all = titles(h).join('\n');
  assert.ok(!all.includes('长长长'));
});

test('T1b 原因变了（同一个文件、同样的内容指纹以外）也算新的一次；全是坏台账时仍返回 no-due', async () => {
  const env = mkEnv();
  writeTask(env, 'bad', base({ notes: LONG }));
  const h = harness(env);
  assert.equal((await h.hb.beat()).action, 'no-due');
  assert.equal(h.calls.length, 0);
  assert.equal(count(h, NOTICE), 1);
  next(h);
  writeTask(env, 'bad', base({ status: '???' }));
  assert.equal((await h.hb.beat()).action, 'no-due');
  assert.equal(count(h, NOTICE), 2);
  assert.match(titles(h)[1], /tasks\/bad\.json：status/);
});

test('T1c 一条通知最多列 5 条，多的写「等 N 条」', async () => {
  const env = mkEnv();
  for (let i = 1; i <= 7; i++) writeTask(env, `bad${i}`, base({ notes: LONG }));
  const h = harness(env);
  await h.hb.beat();
  assert.equal(h.sent.length, 1);
  const lines = h.sent[0].text.split('\n').filter((l) => l.startsWith('tasks/'));
  assert.equal(lines.length, 5);
  assert.match(h.sent[0].text, /等 2 条，\/heartbeat status 可看/);
  next(h); await h.hb.beat();
  assert.equal(h.sent.length, 1, '7 条都已记下，下一拍不再发');
  assert.equal(Object.keys(h.readState().invalid_notified).length, 7);
});

test('T2 免打扰时段里出现的坏台账：当拍不发、进待发队列；08:00 后第一拍随补发发出；全程不调模型', async () => {
  const env = mkEnv();
  writeTask(env, 'bad', base({ notes: LONG }));
  const h = harness(env, { config: CFG({ HEARTBEAT_QUIET_HOURS: '22-08' }), now: at(2026, 11, 16, 23, 0) });
  await h.hb.beat();
  assert.equal(h.sent.length, 0);
  assert.equal(h.readState().pending.length, 1);
  h.setNow(at(2026, 11, 17, 2, 0)); await h.hb.beat();
  assert.equal(h.readState().pending.length, 1, '夜里不重复排队');
  h.setNow(at(2026, 11, 17, 8, 0)); await h.hb.beat();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /待发汇总/);
  assert.match(h.sent[0].text, /tasks\/bad\.json：notes 超过 300 字/);
  assert.equal(h.readState().pending.length, 0);
  h.setNow(at(2026, 11, 17, 8, 30)); await h.hb.beat();
  assert.equal(h.sent.length, 1);
  assert.equal(h.calls.length, 0);
});

test('T3 文件名不合规：正文里是清洗过的一行名字、不超过 64 字', async () => {
  const env = mkEnv();
  const names = ['x *bold* [链接](u) 任务.json', `${'名'.repeat(120)}.json`];
  for (const n of names) fs.writeFileSync(path.join(env.tasksDir, n), '{}');
  const h = harness(env);
  await h.hb.beat();
  assert.equal(h.sent.length, 1);
  const lines = h.sent[0].text.split('\n').filter((l) => l.startsWith('tasks/'));
  assert.equal(lines.length, 2);
  for (const l of lines) {
    const name = l.slice('tasks/'.length, l.indexOf('：'));
    assert.ok(Array.from(name).length <= 64, `名字 ${Array.from(name).length} 字`);
    assert.ok(!/[*[\]<>`~\n]/.test(name), '记号已中和');
    assert.match(l, /文件名不合规/);
  }
  assert.ok(lines.some((l) => l.startsWith('tasks/x ＊bold＊ ')));
  assert.ok(Object.keys(h.readState().invalid_notified).length === 2);
  next(h); await h.hb.beat();
  assert.equal(h.sent.length, 1, '长文件名的键也认得出，不重复发');
});

test('T4 本拍读时坏、同拍重读时已合法 → 不通知；重读时又变了 → 这拍不报、下一拍报新的', async () => {
  const env = mkEnv();
  writeTask(env, 'bad', base({ notes: LONG }));
  let hook = null;
  const h = harness(env, { extra: { log: (...a) => { const m = a.join(' '); h.logs.push(m); if (hook && m.includes('跳过台账 bad.json')) { const f = hook; hook = null; f(); } } } });
  hook = () => writeTask(env, 'bad', base({ notes: '主会话刚写好' }));
  await h.hb.beat();
  assert.equal(h.sent.length, 0, '重读时已合法：不报');
  assert.equal(h.readState().invalid_notified, undefined);

  writeTask(env, 'bad', base({ notes: LONG }));
  next(h);
  hook = () => writeTask(env, 'bad', base({ notes: `${LONG}又改` }));
  await h.hb.beat();
  assert.equal(h.sent.length, 0, '重读时内容又变了：这拍不报');
  next(h); await h.hb.beat();
  assert.equal(count(h, NOTICE), 1, '下一拍按新内容报一次');
});

test('A4 通知正文与日志不出现文件内容、chat_id、open_id', async () => {
  const env = mkEnv();
  writeTask(env, 'bad', base({ title: 'SECRET-TITLE-xyz', notes: `SECRET-NOTES-xyz${LONG}`, watch: { type: 'chat_reply', chat_id: 'oc_SECRETCHAT' } }));
  const h = harness(env);
  await h.hb.beat();
  const blob = `${titles(h).join('\n')}\n${h.logs.join('\n')}`;
  for (const s of ['SECRET', 'oc_', OWNER]) assert.ok(!blob.includes(s), `不应出现 ${s}`);
  assert.match(blob, /notes 超过 300 字/);
});

// ------------------------------------------------------------------ H-3：状态写不进去

test('T5 状态目录只读（P6）：待发汇总 / 验收卡片各只发 1 次，写不进去通知恰好 1 次；按钮认得出；恢复后落盘，再坏再通知', async (t) => {
  if (isRoot()) { t.skip('root 无视目录写权限，chmod 造不出写失败'); return; }
  const env = mkEnv();
  writeTask(env, 'quote', base());
  writeTask(env, 'v1', { title: '待验收的事', status: 'verify', created_at: '2026-11-15T09:00', done_evidence: { kind: 'other', ref: '', summary: 'x' } });
  const cfg = CFG({ HEARTBEAT_QUIET_HOURS: '22-08', HEARTBEAT_VERIFY: 'rule', HEARTBEAT_BUTTONS: 'true' });
  const h = harness(env, { config: cfg, now: at(2026, 11, 16, 23, 0), answer: '夜里的一条提醒' });
  await h.hb.beat();
  assert.equal(h.readState().pending.length, 1);
  assert.equal(h.sent.length, 0);
  const dataDir = path.dirname(env.stateFile);
  await withDirLocked(dataDir, async () => {
    for (let i = 0; i < 4; i++) { h.setNow(plus(at(2026, 11, 17, 8, 0), i * 30)); await h.hb.beat(); }
    assert.equal(count(h, /待发汇总/), 1, '待发汇总只发 1 次');
    assert.equal(count(h, /待你验收/), 1, '待你验收只发 1 次');
    assert.equal(count(h, FAULT), 1, '写不进去通知恰好 1 次');
    assert.equal(h.sent.length, 3);
    const fault = titles(h).find((x) => FAULT.test(x));
    assert.match(fault, /ENOSPC|EACCES|EPERM|EROFS/);
    assert.match(fault, /data\//);
    assert.match(fault, /重启后待发队列与计数回到上次落盘时/);
    assert.match(fault, /不调模型/);
    assert.equal(h.sent.find((s) => FAULT.test(s.text)).argc, 1, '直接 send，不带按钮');
    // 按钮点在这张验收卡片上：认得出（不回「已失效」）
    const card = h.sent.find((s) => /待你验收/.test(s.text));
    const toast = await h.handlers.cardAction(click(card.mid, btn(card, 'accept')));
    assert.notDeepEqual(toast, TOAST_STALE);
  });
  // 目录恢复可写：下一拍落盘成功；盘面上已经是补发后的样子，不再重发
  h.setNow(at(2026, 11, 17, 10, 0)); await h.hb.beat();
  assert.equal(h.sent.length, 3);
  assert.equal(h.readState().pending.length, 0);
  assert.ok(Object.keys(h.readState().msg_index).length >= 2, '消息索引已落盘');
  // 再坏一次 → 再通知一次
  await withDirLocked(dataDir, async () => {
    h.setNow(at(2026, 11, 17, 10, 30)); await h.hb.beat();
    assert.equal(count(h, FAULT), 2);
    h.setNow(at(2026, 11, 17, 11, 0)); await h.hb.beat();
    assert.equal(count(h, FAULT), 2, '同一次故障期间只发一次');
  });
});

test('T5b 写不进去时调模型前的计数保护不变：state-error、不调模型；通知照发', async (t) => {
  if (isRoot()) { t.skip('root 无视目录写权限，chmod 造不出写失败'); return; }
  const env = mkEnv();
  writeTask(env, 'quote', base());
  const dataDir = path.dirname(env.stateFile);
  await withDirLocked(dataDir, async () => {
    const h = harness(env, { config: CFG({ HEARTBEAT_MAX_RUNS_PER_DAY: '3' }) });
    for (let i = 0; i < 8; i++) { // 比每日上限（3）多几拍：未落盘的内存状态不能把没发生的调用算进 runs（否则会变 budget）
      assert.equal((await h.hb.beat()).action, 'state-error');
      next(h);
    }
    assert.equal(h.calls.length, 0);
    assert.equal(count(h, FAULT), 1);
    assert.ok(h.logs.some((l) => l.includes('无法落盘')));
  });
});

test('T6 免打扰时段里开始写不进去：通知等到时段结束后第一拍才发', async (t) => {
  if (isRoot()) { t.skip('root 无视目录写权限，chmod 造不出写失败'); return; }
  const env = mkEnv();
  writeTask(env, 'later', base({ next_check_at: '2026-12-31T09:00' })); // 不到期：每拍只走 no-due 落盘
  const h = harness(env, { config: CFG({ HEARTBEAT_QUIET_HOURS: '22-08' }), now: at(2026, 11, 16, 23, 0) });
  await withDirLocked(path.dirname(env.stateFile), async () => {
    await h.hb.beat();
    h.setNow(at(2026, 11, 17, 2, 0)); await h.hb.beat();
    h.setNow(at(2026, 11, 17, 7, 30)); await h.hb.beat();
    assert.equal(h.sent.length, 0, '免打扰时段内不发');
    h.setNow(at(2026, 11, 17, 8, 0)); await h.hb.beat();
    assert.equal(count(h, FAULT), 1);
    h.setNow(at(2026, 11, 17, 8, 30)); await h.hb.beat();
    assert.equal(count(h, FAULT), 1);
  });
});

test('T6b 通知发送失败只记日志，下一拍再试，直到发出一次', async (t) => {
  if (isRoot()) { t.skip('root 无视目录写权限，chmod 造不出写失败'); return; }
  const env = mkEnv();
  writeTask(env, 'later', base({ next_check_at: '2026-12-31T09:00' }));
  let fail = 2;
  const h = harness(env, { sendImpl: (rec, n) => { if (fail-- > 0) throw new Error('网络断了'); return `om_${n}`; } });
  await withDirLocked(path.dirname(env.stateFile), async () => {
    for (let i = 0; i < 5; i++) { await h.hb.beat(); next(h); }
  });
  assert.equal(count(h, FAULT), 3, '前两次发送失败，第三次发出，之后不再发');
});

// ------------------------------------------------------------------ M-7 第一半

test('T7a 待验收台账一拍写坏、下一拍逐字恢复（H3）：验收卡片全程只发 1 张，verify 记录保留', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', base({ status: 'verify', done_evidence: { kind: 'other', ref: '', summary: '已办' } }));
  const h = harness(env, { config: CFG({ HEARTBEAT_VERIFY: 'rule' }) });
  await h.hb.beat();
  const good = fs.readFileSync(taskFile(env, 'quote'), 'utf8');
  const rec = h.readState().verify.quote;
  assert.ok(rec.card_at);
  fs.writeFileSync(taskFile(env, 'quote'), good.slice(0, 40));
  next(h); await h.hb.beat();
  assert.deepEqual(h.readState().verify.quote, rec, '坏的这一拍不清验收记录');
  fs.writeFileSync(taskFile(env, 'quote'), good);
  next(h); await h.hb.beat();
  assert.equal(count(h, /待你验收/), 1, '恢复后不重发');
  assert.deepEqual(h.readState().verify.quote, rec);
});

test('T7b 升级阶梯第一级后台账一拍无效（H15）：esc 保留，恢复后按原级数继续', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', base({ next_check_at: '2026-12-01T09:00', escalate_after: '2026-11-16T09:00' }));
  const h = harness(env, { config: CFG({ HEARTBEAT_ESCALATE_LADDER: 'true' }), answer: '过了提醒时间' });
  await h.hb.beat();
  const good = fs.readFileSync(taskFile(env, 'quote'), 'utf8');
  const esc = h.readState().tasks.quote.esc;
  assert.equal(esc.level, 1);
  fs.writeFileSync(taskFile(env, 'quote'), good.slice(0, 30));
  next(h); await h.hb.beat();
  assert.deepEqual(h.readState().tasks.quote.esc, esc, '无效的这一拍 esc 保留');
  fs.writeFileSync(taskFile(env, 'quote'), good);
  const calls = h.calls.length;
  next(h); await h.hb.beat();
  assert.deepEqual(h.readState().tasks.quote.esc, esc, '恢复后仍是原来的一级，不重来');
  assert.equal(h.calls.length, calls, '不为第一级再调一次模型');
  // 满 48 小时没读：按原级数升到第 2 级（固定模板）
  h.setNow(plus(T0, 49 * 60)); await h.hb.beat();
  assert.equal(h.readState().tasks.quote.esc.level, 2);
});

test('T7c 无效的这一拍 history.seen 保留旧状态，恢复后不记假的状态变化', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', base({ status: 'verify', done_evidence: { kind: 'other', ref: '', summary: '已办' } }));
  const h = harness(env, { config: CFG({ HEARTBEAT_VERIFY: 'rule' }) });
  await h.hb.beat();
  assert.equal(h.readState().history.seen.quote, 'verify');
  const good = fs.readFileSync(taskFile(env, 'quote'), 'utf8');
  fs.writeFileSync(taskFile(env, 'quote'), good.slice(0, 40));
  next(h); await h.hb.beat();
  assert.equal(h.readState().history.seen.quote, 'verify');
  fs.writeFileSync(taskFile(env, 'quote'), good);
  next(h); await h.hb.beat();
  assert.equal(h.readState().history.seen.quote, 'verify');
  assert.deepEqual(h.readState().history.changes, []);
});

test('T7d 调模型前后的快照 / afterModel 也不覆盖无效 slug 的 seen', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', base());
  writeTask(env, 'other', base({ title: '另一件', status: 'waiting', next_check_at: '2026-12-31T09:00' }));
  const h = harness(env, {
    config: CFG({ HEARTBEAT_VERIFY: 'rule' }),
    runImpl: async () => { fs.writeFileSync(taskFile(env, 'other'), '{半截'); return 'HEARTBEAT_OK'; }, // 模型这一拍把另一条写坏了
  });
  await h.hb.beat(); // 第 1 拍：quote 到期调模型；模型期间 other 被写坏
  assert.equal(h.readState().history.seen.other, 'waiting', 'afterModel 不抹掉 other 的 seen');
});

// ------------------------------------------------------------------ 行为不变

test('T8 台账全合法、状态可写：发送序列与改动前一致，状态文件没有 invalid_notified 键', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', base());
  const h = harness(env, {
    config: CFG({ HEARTBEAT_QUIET_HOURS: '22-08' }),
    now: at(2026, 11, 16, 21, 0),
    runImpl: async (n) => { writeTask(env, 'quote', { ...readTask(env, 'quote'), next_check_at: `2026-11-1${6 + n}T09:00` }); return `第 ${n} 条提醒`; },
  });
  const seq = [];
  const beat = async (d) => { h.setNow(d); const r = await h.hb.beat(); seq.push(`${r.action}:${h.sent.length}`); };
  await beat(at(2026, 11, 16, 21, 0)); // 到期 → 调模型 → 发出
  await beat(at(2026, 11, 16, 21, 30)); // 不到期
  writeTask(env, 'quote', { ...readTask(env, 'quote'), next_check_at: '2026-11-16T21:00' });
  await beat(at(2026, 11, 16, 23, 0)); // 免打扰：排队
  await beat(at(2026, 11, 17, 8, 0)); // 补发
  assert.deepEqual(seq, ['sent:1', 'no-due:1', 'queued:1', 'no-due:2']);
  assert.deepEqual(h.sent.map((s) => s.text.split('\n')[0]), ['💓 **心跳**', '💓 **心跳 · 待发汇总（1 条）**']);
  assert.ok(!('invalid_notified' in h.readState()));
  assert.equal(count(h, NOTICE) + count(h, FAULT), 0);
});

test('loadTasks 的 invalid 项带内容指纹：读得出文本的是 sha256 前 16 位，读不出的是原因本身', async () => {
  const { loadTasks } = await import('../src/heartbeat.js');
  const env = mkEnv();
  fs.writeFileSync(path.join(env.tasksDir, 'a.json'), '{坏');
  fs.writeFileSync(path.join(env.tasksDir, 'b c.json'), '{}');
  const { invalid } = loadTasks(env.tasksDir, { log: () => {} });
  const a = invalid.find((i) => i.file === 'a.json');
  const b = invalid.find((i) => i.file === 'b c.json');
  assert.match(a.fp, /^[0-9a-f]{16}$/);
  assert.equal(b.fp, b.reason);
});
