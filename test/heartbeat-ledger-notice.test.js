// BRIDGE-LEDGER-1：台账坏条目通知 owner（H-4）；心跳状态写不进去时不重发（H-3 心跳部分）；
// 台账一拍读不出来不清桥接侧记录（M-7 第一半）。全部用临时目录 + 假时钟 + 注入桩，不起子进程、不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  mkEnv, harness, CFG, writeTask, readTask, taskFile, at, plus, T0, click, btn, quoted, TOAST_STALE, OWNER,
} from './vr-harness.js';
import { heartbeatReplyShortcut } from '../src/events.js';

const base = (o = {}) => ({ title: '跟进报价单', status: 'open', next_check_at: '2026-11-16T09:00', created_at: '2026-11-15T09:00', ...o });
const LONG = '长'.repeat(301);
// 「坏」台账：时间写法不对（notes 超 300 字现在只截断、不再失效）；换个写法＝内容变了但原因不变
const BADT = (t = '明天上午') => base({ title: '坏的', next_check_at: t });
const isRoot = () => process.getuid?.() === 0;
const titles = (h) => h.sent.map((s) => s.text);
const count = (h, re) => titles(h).filter((t) => re.test(t)).length;
const NOTICE = /台账文件读不了/;
const FAULT = /心跳状态写不进去/;
const TRUNC = /notes 已截断/;
const withDirDenied = async (dir, fn) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o000);
  try { return await fn(); } finally { fs.chmodSync(dir, 0o755); }
};
const withDirLocked = async (dir, fn) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o555);
  try { return await fn(); } finally { fs.chmodSync(dir, 0o755); }
};
const next = (h, min = 30) => h.setNow(plus(h.now(), min));

// ------------------------------------------------------------------ H-4：坏台账通知

test('T1 坏台账（H1）：next_check_at 写法不对 → 私聊一条、不带内容；不重复；内容变了 / 修好后再坏才再发', async () => {
  const env = mkEnv();
  writeTask(env, 'bad', BADT());
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
  assert.match(notice, /tasks\/bad\.json：next_check_at 不是合法时间/);
  assert.match(notice, /修好之前不会到期提醒/);
  assert.ok(!notice.includes('明天上午') && !notice.includes('坏的'), '正文不带文件内容');
  assert.match(h.sent[1].text, /合法那条的提醒/);
  for (let i = 0; i < 3; i++) { next(h); await h.hb.beat(); }
  assert.equal(count(h, NOTICE), 1, '之后 3 拍不再发');
  assert.equal(h.calls.length, 1);
  assert.ok(h.readState().invalid_notified?.['bad.json']);

  next(h); writeTask(env, 'bad', BADT('后天上午')); // 仍然坏、内容变了
  await h.hb.beat();
  assert.equal(count(h, NOTICE), 2, '内容变了（仍然坏）再发一次');

  next(h); writeTask(env, 'bad', base({ title: '坏的', notes: '好了' }));
  await h.hb.beat();
  assert.equal(count(h, NOTICE), 2, '修好不发');
  assert.equal(h.readState().invalid_notified, undefined, '变合法后记录删掉');

  next(h); writeTask(env, 'bad', BADT('后天上午')); // 与上一次逐字相同
  await h.hb.beat();
  assert.equal(count(h, NOTICE), 3, '修好后再弄坏（哪怕与之前逐字相同）算新的一次');
  const all = titles(h).join('\n');
  assert.ok(!all.includes('天上午'));
});

test('T1b 原因变了（同一个文件、同样的内容指纹以外）也算新的一次；全是坏台账时仍返回 no-due', async () => {
  const env = mkEnv();
  writeTask(env, 'bad', BADT());
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
  for (let i = 1; i <= 7; i++) writeTask(env, `bad${i}`, BADT());
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
  writeTask(env, 'bad', BADT());
  const h = harness(env, { config: CFG({ HEARTBEAT_QUIET_HOURS: '22-08' }), now: at(2026, 11, 16, 23, 0) });
  await h.hb.beat();
  assert.equal(h.sent.length, 0);
  assert.equal(h.readState().pending.length, 1);
  h.setNow(at(2026, 11, 17, 2, 0)); await h.hb.beat();
  assert.equal(h.readState().pending.length, 1, '夜里不重复排队');
  h.setNow(at(2026, 11, 17, 8, 0)); await h.hb.beat();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /待发汇总/);
  assert.match(h.sent[0].text, /tasks\/bad\.json：next_check_at 不是合法时间/);
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
  writeTask(env, 'bad', BADT());
  let hook = null;
  const h = harness(env, { extra: { log: (...a) => { const m = a.join(' '); h.logs.push(m); if (hook && m.includes('跳过台账 bad.json')) { const f = hook; hook = null; f(); } } } });
  hook = () => writeTask(env, 'bad', base({ notes: '主会话刚写好' }));
  await h.hb.beat();
  assert.equal(h.sent.length, 0, '重读时已合法：不报');
  assert.equal(h.readState().invalid_notified, undefined);

  writeTask(env, 'bad', BADT());
  next(h);
  hook = () => writeTask(env, 'bad', BADT('后天上午'));
  await h.hb.beat();
  assert.equal(h.sent.length, 0, '重读时内容又变了：这拍不报');
  next(h); await h.hb.beat();
  assert.equal(count(h, NOTICE), 1, '下一拍按新内容报一次');
});

test('A4 通知正文与日志不出现文件内容、chat_id、open_id', async () => {
  const env = mkEnv();
  writeTask(env, 'bad', base({ title: 'SECRET-TITLE-xyz', next_check_at: 'SECRET-TIME-xyz', notes: 'SECRET-NOTES-xyz', watch: { type: 'chat_reply', chat_id: 'oc_SECRETCHAT' } }));
  const h = harness(env);
  await h.hb.beat();
  const blob = `${titles(h).join('\n')}\n${h.logs.join('\n')}`;
  for (const s of ['SECRET', 'oc_', OWNER]) assert.ok(!blob.includes(s), `不应出现 ${s}`);
  assert.match(blob, /next_check_at 不是合法时间/);
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

// ------------------------------------------------------------------ R1 返工：fail-closed 状态不记成「未落盘状态」

test('T9 状态目录读、写都失败一拍（EACCES 模拟 EMFILE / EIO）后恢复：待发队列 / 消息索引 / 验收记录 / 每日次数都不被空壳覆盖', async (t) => {
  if (isRoot()) { t.skip('root 无视目录权限，chmod 造不出读写失败'); return; }
  const env = mkEnv();
  writeTask(env, 'quote', base());
  writeTask(env, 'v1', { title: '待验收的事', status: 'verify', created_at: '2026-11-15T09:00', done_evidence: { kind: 'other', ref: '', summary: 'x' } });
  const h = harness(env, {
    config: CFG({ HEARTBEAT_QUIET_HOURS: '22-08', HEARTBEAT_VERIFY: 'rule' }),
    now: at(2026, 11, 16, 20, 0),
    runImpl: async (n) => `第 ${n} 条提醒`,
  });
  await h.hb.beat(); // 20:00 正常：调模型发出 + 一张验收卡片
  assert.equal(h.calls.length, 1);
  assert.equal(count(h, /待你验收/), 1);
  writeTask(env, 'quote', base({ next_check_at: '2026-11-16T23:00' }));
  h.setNow(at(2026, 11, 16, 23, 0)); await h.hb.beat(); // 免打扰：排进 1 条待发
  const before = h.readState();
  assert.equal(before.pending.length, 1);
  const idxBefore = Object.keys(before.msg_index).length;
  assert.ok(idxBefore >= 2);
  await withDirDenied(path.dirname(env.stateFile), async () => {
    h.setNow(at(2026, 11, 17, 1, 0)); await h.hb.beat(); // 读写都失败
  });
  h.setNow(at(2026, 11, 17, 8, 0)); await h.hb.beat();
  const after = h.readState();
  assert.equal(count(h, /待发汇总/), 1, '08:00 这拍发出待发汇总');
  assert.equal(after.pending.length, 0);
  assert.ok(Object.keys(after.msg_index).length >= idxBefore, '消息索引不少于故障前');
  assert.equal(count(h, /待你验收/), 1, '验收卡片全程只 1 张');
  assert.ok(after.runs < CFG().maxRunsPerDay, '每日次数不是上限');
  assert.equal(h.calls.length, 3, '20:00、23:00（免打扰里调模型、结果排队）、08:00 各一次；01:00 的故障拍没调');
});

test('T10 状态目录读写都坏期间连跑 3 拍、另有一条坏台账：坏台账通知 0 条（整拍跳过），写不进去通知恰好 1 条；恢复后下一拍坏台账通知 1 条', async (t) => {
  if (isRoot()) { t.skip('root 无视目录权限，chmod 造不出读写失败'); return; }
  const env = mkEnv();
  writeTask(env, 'later', base({ next_check_at: '2026-12-31T09:00' }));
  writeTask(env, 'bad', BADT());
  const h = harness(env);
  await h.hb.beat(); // 先正常一拍：坏台账已通知 1 条
  assert.equal(count(h, NOTICE), 1);
  fs.rmSync(env.stateFile); // 让「读不了」这一路是纯故障，不依赖盘上已有的记录
  await withDirDenied(path.dirname(env.stateFile), async () => {
    for (let i = 0; i < 3; i++) { next(h); await h.hb.beat(); }
  });
  assert.equal(count(h, NOTICE), 1, 'fail-closed 的拍不再发坏台账通知（整拍跳过）');
  assert.equal(count(h, FAULT), 1, '写不进去通知恰好 1 条');
  next(h); await h.hb.beat(); // 恢复：盘上没有状态文件 → 新状态、记录是空的 → 坏台账通知再发 1 条
  assert.equal(count(h, NOTICE), 2, '恢复后下一拍发 1 条');
  assert.equal(count(h, FAULT), 1);
});

test('T10b 状态文件在、目录读写都坏：连跑 3 拍期间坏台账通知一条都不发，恢复后不重发（记录还在盘上）', async (t) => {
  if (isRoot()) { t.skip('root 无视目录权限，chmod 造不出读写失败'); return; }
  const env = mkEnv();
  writeTask(env, 'later', base({ next_check_at: '2026-12-31T09:00' }));
  writeTask(env, 'bad', BADT());
  const h = harness(env);
  await h.hb.beat();
  assert.equal(count(h, NOTICE), 1);
  await withDirDenied(path.dirname(env.stateFile), async () => {
    for (let i = 0; i < 3; i++) { next(h); await h.hb.beat(); }
  });
  assert.equal(count(h, NOTICE), 1);
  assert.equal(count(h, FAULT), 1);
  next(h); await h.hb.beat();
  assert.equal(count(h, NOTICE), 1, '盘上记录还在，恢复后不重发');
});

// ------------------------------------------------------------------ R1 返工：补测试缺口

test('R2 写不进去若干拍、恢复后落盘成功：之后进程外改盘上状态，下一拍读到新值（已回到读盘）', async (t) => {
  if (isRoot()) { t.skip('root 无视目录写权限，chmod 造不出写失败'); return; }
  const env = mkEnv();
  writeTask(env, 'quote', base());
  const h = harness(env);
  await withDirLocked(path.dirname(env.stateFile), async () => {
    for (let i = 0; i < 3; i++) { await h.hb.beat(); next(h); }
  });
  await h.hb.beat(); // 恢复可写：这一拍落盘成功
  next(h);
  const st = h.readState(); // 能读到＝已经落盘
  const body = '进程外塞进来的待发项 EXTERNAL';
  st.pending.push({ at: '2026-11-16T10:00', hash: 'externalhash0000000000000000000000', body, slugs: [] });
  fs.writeFileSync(env.stateFile, JSON.stringify(st));
  await h.hb.beat();
  assert.equal(count(h, /EXTERNAL/), 1, '下一拍读的是盘上的新值，不是内存里的旧快照');
});

test('R3 写不进去期间连跑多拍（超过退避阈值）：attempts 不虚增，恢复后第一拍照常调模型、不是 backoff', async (t) => {
  if (isRoot()) { t.skip('root 无视目录写权限，chmod 造不出写失败'); return; }
  const env = mkEnv();
  writeTask(env, 'quote', base());
  const h = harness(env);
  await withDirLocked(path.dirname(env.stateFile), async () => {
    for (let i = 0; i < 8; i++) { assert.equal((await h.hb.beat()).action, 'state-error'); next(h); }
  });
  assert.equal(h.calls.length, 0);
  const r = await h.hb.beat();
  assert.notEqual(r.action, 'backoff');
  assert.equal(h.calls.length, 1, '恢复后第一拍照常调模型');
  assert.equal(h.readState().tasks.quote.attempts, 1, 'attempts 没有被写不进去的那些拍虚增');
});

test('R9 日结那一刻台账无效：history.seen 保留旧值（digestNow 的 diffSeen 传 invalid）', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', base({ status: 'verify', done_evidence: { kind: 'other', ref: '', summary: '已办' } }));
  const h = harness(env, { config: CFG({ HEARTBEAT_VERIFY: 'rule', HEARTBEAT_DIGEST_AT: '21:30' }) });
  await h.hb.beat();
  assert.equal(h.readState().history.seen.quote, 'verify');
  const good = fs.readFileSync(taskFile(env, 'quote'), 'utf8');
  fs.writeFileSync(taskFile(env, 'quote'), good.slice(0, 40));
  next(h);
  const r = await h.hb.digestNow();
  assert.ok(['sent', 'queued', 'empty'].includes(r.action), `digestNow → ${r.action}`);
  assert.equal(h.readState().history.seen.quote, 'verify', '日结时台账无效，seen 不被抹掉');
});

test('R10 调模型前那一刻台账无效：快照的 diffSeen 保留 seen 旧值', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', base());
  writeTask(env, 'other', base({ title: '另一件', status: 'waiting', next_check_at: '2026-12-31T09:00' }));
  const h = harness(env, {
    config: CFG({ HEARTBEAT_VERIFY: 'rule' }),
    // 本拍开头读台账时 other 还合法；拉外部增量（在调模型前的快照之前）时它被写坏
    collectDeltas: async () => { fs.writeFileSync(taskFile(env, 'other'), '{半截'); return []; },
    runImpl: async () => 'HEARTBEAT_OK',
  });
  await h.hb.beat();
  assert.equal(h.calls.length, 1);
  assert.equal(h.readState().history.seen.other, 'waiting', '调模型前快照时 other 无效，seen 不被抹掉');
});

// ------------------------------------------------------------------ R1 返工：notes 超 300 字读入时截断

const LONGN = `${'长'.repeat(300)}末`; // 301 字，第 301 个字是「末」
const quoteDue = (extra = {}) => base({ title: '跟进报价单', ...extra });

test('validateTask / loadTasks：notes 超 300 字截到 300 并标记，文件不动、hash 按全文；代理对不被劈开；非字符串仍无效', async () => {
  const { loadTasks, validateTask } = await import('../src/heartbeat.js');
  const env = mkEnv();
  writeTask(env, 'a', quoteDue({ notes: LONGN }));
  writeTask(env, 'b', quoteDue({ notes: `${'长'.repeat(299)}😀尾` })); // 第 300 位落在代理对中间
  writeTask(env, 'c', quoteDue({ notes: '长'.repeat(300) })); // 恰好 300：不截
  writeTask(env, 'd', quoteDue({ notes: 5 }));
  const before = fs.readFileSync(taskFile(env, 'a'), 'utf8');
  const { tasks, invalid } = loadTasks(env.tasksDir, { log: () => {} });
  const by = Object.fromEntries(tasks.map((x) => [x.slug, x]));
  assert.equal(by.a.notes, '长'.repeat(300));
  assert.equal(by.a.notes_truncated, true);
  assert.equal(by.b.notes, '长'.repeat(299), '少截一位，不留半个字符');
  assert.equal(by.b.notes_truncated, true);
  assert.equal(by.c.notes.length, 300);
  assert.ok(!('notes_truncated' in by.c));
  assert.deepEqual(invalid.map((i) => i.file), ['d.json']);
  assert.match(invalid[0].reason, /notes 不是字符串/);
  assert.equal(fs.readFileSync(taskFile(env, 'a'), 'utf8'), before, '文件没改');
  assert.equal(by.a.hash, (await import('node:crypto')).createHash('sha256').update(before).digest('hex'), 'hash 按全文');
  assert.equal(validateTask(quoteDue({ notes: LONGN }), 'a').ok, true);
});

test('T11 notes 301 字且到期：照常调模型（提示词里恰好 300 字）；「已截断」通知 1 条，不含「不会到期提醒」与 notes 内容；模型改 notes 仍超长不再通知；改回 ≤300 不通知并清表；再超再通知一次', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', quoteDue({ notes: LONGN }));
  let grow = true;
  const h = harness(env, {
    runImpl: async (n) => {
      if (grow) writeTask(env, 'quote', { ...readTask(env, 'quote'), notes: `${'长'.repeat(300 + n)}末` });
      return `第 ${n} 条提醒`;
    },
  });
  await h.hb.beat();
  assert.equal(h.calls.length, 1, '照常到期调模型');
  const prompt = h.calls[0][1];
  assert.ok(prompt.includes('长'.repeat(300)));
  assert.ok(!prompt.includes('长'.repeat(300) + '末') && !prompt.includes('末'), '提示词里 notes 恰好 300 字');
  assert.equal(count(h, TRUNC), 1);
  const notice = titles(h).find((x) => TRUNC.test(x));
  assert.match(notice, /tasks\/quote\.json：notes 超过 300 字，只按前 300 字读（文件没改）/);
  assert.match(notice, /截断的那几条照常到期提醒，建议让助理把 notes 精简到 300 字内。/);
  assert.ok(!/不会到期提醒/.test(notice));
  assert.ok(!notice.includes('长长长'));
  assert.ok(h.readState().invalid_notified?.['quote.json']);
  for (let i = 0; i < 3; i++) { next(h); await h.hb.beat(); } // 模型每拍都改 notes（指纹每拍变，仍超长）
  assert.ok(h.calls.length >= 2);
  assert.equal(count(h, TRUNC), 1, '键不含指纹：之后不再通知');

  grow = false;
  writeTask(env, 'quote', { ...readTask(env, 'quote'), notes: '短了' });
  next(h); await h.hb.beat();
  assert.equal(count(h, TRUNC), 1);
  assert.equal(h.readState().invalid_notified, undefined, '改回 ≤300 字：表里删掉');
  writeTask(env, 'quote', { ...readTask(env, 'quote'), notes: LONGN });
  next(h); await h.hb.beat();
  assert.equal(count(h, TRUNC), 2, '再超再通知一次');
});

test('T11b 截断与无效互转算新的一次；两组同在一条通知里，两句结尾都写；合计最多列 5 条', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', quoteDue({ notes: LONGN, next_check_at: '2026-12-31T09:00' }));
  const h = harness(env);
  await h.hb.beat();
  assert.equal(count(h, TRUNC), 1);
  next(h); writeTask(env, 'quote', quoteDue({ notes: LONGN, next_check_at: '明天上午' })); // 截断 → 无效
  await h.hb.beat();
  assert.equal(count(h, NOTICE), 1, '变无效算新的一次');
  next(h); writeTask(env, 'quote', quoteDue({ notes: LONGN, next_check_at: '2026-12-31T09:00' })); // 无效 → 截断
  await h.hb.beat();
  assert.equal(count(h, TRUNC), 2);

  const env2 = mkEnv();
  for (let i = 1; i <= 3; i++) writeTask(env2, `bad${i}`, BADT());
  for (let i = 1; i <= 4; i++) writeTask(env2, `cut${i}`, quoteDue({ notes: LONGN, next_check_at: '2026-12-31T09:00' }));
  const h2 = harness(env2);
  await h2.hb.beat();
  assert.equal(h2.sent.length, 1);
  const text = h2.sent[0].text;
  assert.match(text, /有台账文件读不了（3 个）、有台账 notes 已截断（4 个）：/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('tasks/')).length, 5);
  assert.match(text, /等 2 条，\/heartbeat status 可看/);
  assert.match(text, /不会到期提醒。截断的那几条照常到期提醒/);
});

test('T11c 截断条目同拍重读：读本拍时超长、重读时已改短 → 这拍不报', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', quoteDue({ notes: LONGN, next_check_at: '2026-12-31T09:00' }));
  const { loadTasks: realLoad } = await import('../src/heartbeat.js');
  let reads = 0;
  const h = harness(env, {
    collectDeltas: async () => [],
    extra: { },
  });
  // 用文件系统钩子：第二次读台账之前改短（beatOnce 第一次 loadTasks 之后、noticeInvalid 重读之前）
  const orig = fs.readdirSync;
  fs.readdirSync = function (dir, ...a) {
    if (String(dir) === env.tasksDir && ++reads === 2) writeTask(env, 'quote', quoteDue({ notes: '主会话刚改短', next_check_at: '2026-12-31T09:00' }));
    return orig.call(this, dir, ...a);
  };
  try { await h.hb.beat(); } finally { fs.readdirSync = orig; }
  assert.ok(reads >= 2);
  assert.equal(h.sent.length, 0, '重读时已不超长：不报');
  assert.equal(h.readState().invalid_notified, undefined);
  void realLoad;
});

test('T12 按钮 / 引用回复对 notes 超长的台账正常回写（不回「已失效」），文件里的 notes 仍是原全文', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', quoteDue({ notes: LONGN }));
  const h = harness(env, { config: CFG({ HEARTBEAT_BUTTONS: 'true', HEARTBEAT_REPLY_SHORTCUTS: 'true' }) });
  await h.hb.beat();
  const card = h.sent.find((x) => x.opts?.actions);
  assert.ok(card, '心跳消息带按钮');
  h.setNow(plus(T0, 5));
  const toast = await h.handlers.cardAction(click(card.mid, btn(card, 'snooze1d')));
  assert.notDeepEqual(toast, TOAST_STALE);
  assert.equal(readTask(env, 'quote').next_check_at, '2026-11-17T09:00');
  assert.equal(readTask(env, 'quote').notes, LONGN, '按钮回写后 notes 仍是全文');

  writeTask(env, 'quote', { ...readTask(env, 'quote'), next_check_at: '2026-11-16T09:00' });
  next(h); await h.hb.beat();
  const card2 = h.sent.filter((x) => x.opts?.actions).at(-1);
  assert.notEqual(card2.mid, card.mid);
  const r = await heartbeatReplyShortcut({ message: quoted(card2.mid, '推迟一天'), isOwner: true, heartbeat: h.hb });
  assert.match(r.reply, /已记下/);
  assert.equal(readTask(env, 'quote').notes, LONGN, '引用回复回写后 notes 仍是全文');
});
