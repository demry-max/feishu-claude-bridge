// BRIDGE-MISC-2：心跳——读状态失败三处补测（S05）、日结读失败只记一行（S06）、台账目录读不了私聊 owner 一次（S31）、错误码只用安全码（S02）。
// 临时目录 + 假时钟 + 注入桩（chmod 造故障，root 下跳过），不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  mkEnv, harness, CFG, writeTask, at, plus, T0, spyTimers,
} from './vr-harness.js';

const base = (o = {}) => ({ title: '跟进报价单', status: 'open', next_check_at: '2026-11-16T09:00', created_at: '2026-11-15T09:00', ...o });
const FAR = (o = {}) => base({ next_check_at: '2026-12-31T09:00', ...o });
const isRoot = () => process.getuid?.() === 0;
const SKIP = 'root 无视文件权限，chmod 造不出读失败';
const LEDGER = /台账目录读不了/;
const READ = /心跳状态文件读不出来/;
const count = (h, re) => h.sent.filter((s) => re.test(s.text)).length;
const next = (h, min = 30) => h.setNow(plus(h.now(), min));
const dirDenied = async (env, fn) => {
  fs.chmodSync(env.tasksDir, 0o000);
  try { return await fn(); } finally { fs.chmodSync(env.tasksDir, 0o755); }
};
const fileDenied = async (file, fn) => {
  fs.chmodSync(file, 0o000);
  try { return await fn(); } finally { fs.chmodSync(file, 0o600); }
};

// ------------------------------------------------------------------ S05

test('H1 读状态失败那拍在取信号之前返回：状态文件字节不变、信号还在；恢复后一拍 read_at 写上', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'quote', base());
  const h = harness(env, { config: CFG({}) });
  await h.hb.beat();
  const mid = h.sent[0]?.mid;
  assert.ok(mid, '先正常发出一条心跳消息');
  h.hb.recordSignal({ type: 'read', message_id: mid, at: '2026-11-16T10:05' });
  const before = fs.readFileSync(env.stateFile);
  let r;
  await fileDenied(env.stateFile, async () => { next(h); r = await h.hb.beat(); });
  assert.equal(r.action, 'state-unreadable');
  assert.equal(Buffer.compare(before, fs.readFileSync(env.stateFile)), 0, '状态文件字节不变');
  assert.ok(fs.existsSync(env.signalsFile) && fs.readFileSync(env.signalsFile, 'utf8').includes(mid), '信号文件里那条还在');
  assert.equal(h.readState().msg_index[mid]?.read_at ?? null, null, '故障拍没把信号并进状态');
  next(h); await h.hb.beat();
  assert.ok(h.readState().msg_index[mid]?.read_at, '恢复后 read_at 写上');
});

test('H2 repair:false 的读（statusText）遇到 EISDIR 不登记故障：之后真读不出来的通知错误码是权限类，不是 EISDIR', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'later', FAR());
  const h = harness(env, { config: CFG({}) });
  await h.hb.beat();
  const body = fs.readFileSync(env.stateFile);
  fs.rmSync(env.stateFile); fs.mkdirSync(env.stateFile); // EISDIR
  h.hb.statusText();
  fs.rmSync(env.stateFile, { recursive: true }); fs.writeFileSync(env.stateFile, body);
  await fileDenied(env.stateFile, async () => { next(h); await h.hb.beat(); });
  const notes = h.sent.filter((s) => READ.test(s.text));
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /错误码 (EACCES|EPERM)/);
  assert.doesNotMatch(notes[0].text, /EISDIR/);
});

test('H3 台账目录读不了那一拍仍落盘：盘上 last_beat_at 等于这一拍的时间', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'later', FAR());
  const h = harness(env, { config: CFG({}) });
  await h.hb.beat();
  next(h);
  await dirDenied(env, async () => { await h.hb.beat(); });
  assert.equal(new Date(h.readState().last_beat_at).getTime(), h.now().getTime());
});

// ------------------------------------------------------------------ S06

test('H4 日结窗口内状态文件一直读不了：「台账日结」读失败行恰好 1 行、不含「本拍」；心跳拍每拍仍 1 行原文；恢复后再坏再 1 行', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'ship', { title: '待验收的事', status: 'verify', created_at: '2026-11-15T09:00', done_evidence: { kind: 'other', ref: '', summary: 'x' } });
  const NIGHT = at(2026, 11, 16, 21, 30);
  const timers = spyTimers();
  const h = harness(env, { config: CFG({ HEARTBEAT_VERIFY: 'rule', HEARTBEAT_DIGEST_AT: '21:30' }), now: NIGHT, timers });
  await h.hb.beat();
  h.hb.start();
  const digestLines = () => h.logs.filter((l) => /台账日结：读不了状态文件/.test(l));
  const beatLines = () => h.logs.filter((l) => /读不了状态文件（\w+），本拍跳过：不调模型、不发送、不改状态文件/.test(l));
  await fileDenied(env.stateFile, async () => {
    let idx = 1;
    await timers.timeouts[idx].fn();
    for (let i = 1; i < 5; i++) {
      assert.equal(timers.timeouts[++idx].ms, 60_000);
      h.setNow(plus(NIGHT, i));
      await timers.timeouts[idx].fn();
    }
    assert.equal(digestLines().length, 1, '连跑 5 次只记 1 行');
    assert.doesNotMatch(digestLines()[0], /本拍/);
    assert.match(digestLines()[0], /（(EACCES|EPERM)）/);
    for (let i = 0; i < 3; i++) { next(h, 1); await h.hb.beat(); }
    assert.equal(beatLines().length, 3, '心跳拍每拍仍 1 行');
  });
  // 恢复：一次 repair 读成功
  next(h, 1); await h.hb.beat();
  assert.equal(digestLines().length, 1);
  await fileDenied(env.stateFile, async () => { next(h, 1); await h.hb.digestNow(); });
  assert.equal(digestLines().length, 2, '恢复后再坏再记 1 行');
  h.hb.stop();
});

// ------------------------------------------------------------------ S31

test('N1 台账目录读不了连续 3 拍：私聊恰好 1 条，只含安全错误码，不含目录路径 / 台账内容 / 称呼', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'secret', base({ title: '机密台账标题XYZ', notes: '机密备注QQQ' }));
  const h = harness(env, { config: CFG({}) });
  await dirDenied(env, async () => {
    for (let i = 0; i < 3; i++) { await h.hb.beat(); next(h); }
  });
  const hits = h.sent.filter((s) => LEDGER.test(s.text));
  assert.equal(hits.length, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(hits[0].argc, 1);
  assert.equal(hits[0].opts, undefined);
  assert.match(hits[0].text, /错误码 (EACCES|EPERM)/);
  assert.ok(!hits[0].text.includes(env.dir));
  assert.ok(!hits[0].text.includes(env.tasksDir));
  assert.doesNotMatch(hits[0].text, /\/(tmp|var|private|Users)\//);
  assert.doesNotMatch(hits[0].text, /机密/);
  assert.doesNotMatch(hits[0].text, /老板|主人|先生|女士/);
  assert.equal(h.logs.filter((l) => /已私聊 owner：台账目录读不了/.test(l)).length, 1);
});

test('P3 台账目录读不了：日志只有安全错误码，不含目录路径', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  const h = harness(env, { config: CFG({}) });
  await dirDenied(env, async () => { await h.hb.beat(); });
  const lines = h.logs.filter((l) => /读不了台账目录/.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /读不了台账目录（(EACCES|EPERM)）/);
  assert.ok(h.logs.every((l) => !l.includes(env.tasksDir)));
});

test('P3b loadTasks：没有安全 code 的错误按 UNKNOWN 记；ENOENT 返回不变', async () => {
  const { loadTasks } = await import('../src/heartbeat.js');
  const env = mkEnv();
  const logs = [];
  const missing = loadTasks(`${env.tasksDir}/nope`, { log: (l) => logs.push(l) });
  assert.deepEqual(missing, { tasks: [], invalid: [] });
  // 目录路径其实是个文件：ENOTDIR（带安全码）
  fs.writeFileSync(`${env.dir}/afile`, 'x');
  const r = loadTasks(`${env.dir}/afile`, { log: (l) => logs.push(l) });
  assert.equal(r.unreadable, true);
  assert.equal(r.code, 'ENOTDIR');
  const fsMod = await import('node:fs');
  const orig = fsMod.default.readdirSync;
  fsMod.default.readdirSync = () => { throw new Error(`weird /Users/x/secret dir failure`); };
  try {
    const r2 = loadTasks('/whatever', { log: (l) => logs.push(l) });
    assert.equal(r2.code, 'UNKNOWN');
  } finally { fsMod.default.readdirSync = orig; }
  assert.ok(logs.every((l) => !/secret|\/Users/.test(l)));
  assert.match(logs.at(-1), /读不了台账目录（UNKNOWN）/);
});

test('N2 免打扰：23:00 起读不了，02:00、07:30 不发；08:00 仍读不了才发；07:30 前恢复则全程不发', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const run = async (recoverBefore8) => {
    const env = mkEnv();
    const h = harness(env, { config: CFG({ HEARTBEAT_QUIET_HOURS: '22-08' }), now: at(2026, 11, 16, 23, 0) });
    fs.chmodSync(env.tasksDir, 0o000);
    try {
      await h.hb.beat();
      h.setNow(at(2026, 11, 17, 2, 0)); await h.hb.beat();
      h.setNow(at(2026, 11, 17, 7, 30)); await h.hb.beat();
      assert.equal(count(h, LEDGER), 0);
      if (recoverBefore8) {
        fs.chmodSync(env.tasksDir, 0o755);
        h.setNow(at(2026, 11, 17, 7, 40)); await h.hb.beat();
        fs.chmodSync(env.tasksDir, 0o755);
      }
      h.setNow(at(2026, 11, 17, 8, 0)); await h.hb.beat();
    } finally { fs.chmodSync(env.tasksDir, 0o755); }
    return count(h, LEDGER);
  };
  assert.equal(await run(false), 1);
  assert.equal(await run(true), 0);
});

test('N3 恢复一拍后再坏 → 第 2 条；目录被删（ENOENT）也算恢复', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  const h = harness(env, { config: CFG({}) });
  await dirDenied(env, async () => { await h.hb.beat(); });
  assert.equal(count(h, LEDGER), 1);
  next(h); await h.hb.beat(); // 恢复
  await dirDenied(env, async () => { next(h); await h.hb.beat(); });
  assert.equal(count(h, LEDGER), 2);
  // 目录被删：ENOENT 视为恢复
  fs.rmSync(env.tasksDir, { recursive: true });
  next(h); await h.hb.beat();
  fs.mkdirSync(env.tasksDir);
  await dirDenied(env, async () => { next(h); await h.hb.beat(); });
  assert.equal(count(h, LEDGER), 3);
});

test('N4 send 前两次抛错：只记日志，第 3 拍发出，之后不再发', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  let n = 0;
  const h = harness(env, { config: CFG({}), sendImpl: (rec) => { if (LEDGER.test(rec.text) && ++n <= 2) throw new Error('send boom'); return 'om_ok'; } });
  await dirDenied(env, async () => {
    for (let i = 0; i < 5; i++) { await h.hb.beat(); next(h); }
  });
  assert.equal(count(h, LEDGER), 3, '前两次失败 + 第 3 次成功，共尝试 3 次');
  assert.equal(h.logs.filter((l) => /私聊 owner 失败（台账目录读不了的提醒）/.test(l)).length, 2);
  assert.equal(h.logs.filter((l) => /已私聊 owner：台账目录读不了/.test(l)).length, 1);
});

test('N5 只有静默读失败（快照 / afterModel / digestNow / statusText）：0 条；下一拍状态文件读不出（提前返回）时静默读也没有登记故障；之后目录正常也 0 条', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'quote', base());
  writeTask(env, 'other', FAR());
  const h = harness(env, {
    config: CFG({ HEARTBEAT_VERIFY: 'rule', HEARTBEAT_DIGEST_AT: '21:30' }),
    runImpl: async (n) => { fs.chmodSync(env.tasksDir, 0o000); return `第 ${n} 条提醒`; }, // afterModel 读不了
  });
  try { await h.hb.beat(); } finally { fs.chmodSync(env.tasksDir, 0o755); }
  await dirDenied(env, async () => { h.hb.statusText(); await h.hb.digestNow(); });
  assert.equal(count(h, LEDGER), 0);
  // 静默读若登记了故障，主读取没机会清掉它：状态文件读不出的那拍提前返回，beat() 末尾的通知照样会发
  await fileDenied(env.stateFile, async () => { next(h); await h.hb.beat(); });
  assert.equal(count(h, LEDGER), 0, '静默读没有登记台账目录故障');
  next(h); await h.hb.beat();
  assert.equal(count(h, LEDGER), 0);
});

test('N6 状态文件读不出来的那拍不改变台账目录故障状态：目录坏并已通知 → 状态文件也坏（目录仍坏）→ 状态恢复、目录仍坏 → 仍只通知过 1 条', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'later', FAR());
  const h = harness(env, { config: CFG({}) });
  await h.hb.beat();
  await dirDenied(env, async () => {
    next(h); await h.hb.beat();
    assert.equal(count(h, LEDGER), 1, '目录坏并已通知');
    await fileDenied(env.stateFile, async () => { next(h); await h.hb.beat(); }); // 提前返回，没读台账；目录仍坏
    assert.equal(count(h, LEDGER), 1);
    next(h); await h.hb.beat(); // 状态恢复、目录仍坏：故障状态没被清过，不重复通知
    assert.equal(count(h, LEDGER), 1, '仍只通知过 1 条');
    assert.equal(count(h, READ), 1);
  });
  next(h); await h.hb.beat(); // 目录也恢复
  assert.equal(count(h, LEDGER), 1);
});
