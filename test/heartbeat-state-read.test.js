// BRIDGE-HBSTATE-1：心跳读状态失败时不得用空壳覆盖盘上状态。
// 读状态文件失败（非 ENOENT、非损坏）→ 那一拍整拍跳过、不落盘、私聊 owner 一次；台账目录读不了的那一拍不清任何桥接侧记录；
// 日结同样处理。全部用临时目录 + 假时钟 + 注入桩（chmod 造故障，root 下跳过），不起子进程、不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  mkEnv, harness, CFG, writeTask, readTask, taskFile, at, plus, T0, spyTimers, OWNER,
} from './vr-harness.js';

const base = (o = {}) => ({ title: '跟进报价单', status: 'open', next_check_at: '2026-11-16T09:00', created_at: '2026-11-15T09:00', ...o });
const FAR = (o = {}) => base({ next_check_at: '2026-12-31T09:00', ...o });
const BADT = () => base({ title: '坏的', next_check_at: '明天上午' });
const VERDONE = { title: '待验收的事', status: 'verify', created_at: '2026-11-15T09:00', done_evidence: { kind: 'other', ref: '', summary: 'x' } };
const ESC = { title: '跟进报价单', status: 'open', next_check_at: '2026-11-20T09:00', escalate_after: '2026-11-16T09:00' };
const isRoot = () => process.getuid?.() === 0;
const SKIP = 'root 无视文件权限，chmod 造不出读失败';
const count = (h, re) => h.sent.filter((s) => re.test(s.text)).length;
const READ = /心跳状态文件读不出来/;
const WRITE = /心跳状态写不进去/;
const NOTICE = /台账文件读不了/;
const DIGEST = /台账日结/;
const fence = (t) => t.replace(/UNTRUSTED(_END)?_[0-9a-f]{16}/g, 'UNTRUSTED$1_X');
const noNonce = (s) => ({ ...s, msg_index: Object.fromEntries(Object.entries(s.msg_index).map(([k, v]) => [k, { ...v, nonce: '' }])) });
const next = (h, min = 30) => h.setNow(plus(h.now(), min));
const mids = (h) => h.sent.map((s) => s.text.split('\n')[0]);

// 状态文件 chmod 000 期间跑 fn；结束一定改回
const withFileDenied = async (file, fn) => {
  fs.chmodSync(file, 0o000);
  try { return await fn(); } finally { fs.chmodSync(file, 0o600); }
};
const withDirMode = async (dir, mode, fn) => {
  fs.chmodSync(dir, mode);
  try { return await fn(); } finally { fs.chmodSync(dir, 0o755); }
};
// 「读不出来」那条拿固定 mid，其余按序号：这样对照组与故障组的消息索引逐项可比
const midImpl = () => {
  let k = 0;
  return (rec) => (READ.test(rec.text) ? 'om_readfault' : `om_${++k}`);
};
const injectPending = (env, body, hash = 'externalhash0000000000000000000000') => {
  const st = JSON.parse(fs.readFileSync(env.stateFile, 'utf8'));
  st.pending.push({ at: '2026-11-16T10:00', hash, body, slugs: [] });
  fs.writeFileSync(env.stateFile, JSON.stringify(st));
};

// ------------------------------------------------------------------ S1：免打扰，恢复后与「故障拍没发生」逐项一致

async function s1Scenario(withFault) {
  const env = mkEnv();
  writeTask(env, 'quote', base());
  writeTask(env, 'v1', VERDONE);
  const h = harness(env, {
    config: CFG({ HEARTBEAT_QUIET_HOURS: '22-08', HEARTBEAT_VERIFY: 'rule' }),
    now: at(2026, 11, 16, 20, 0),
    runImpl: async (n) => `第 ${n} 条提醒`,
    sendImpl: midImpl(),
  });
  await h.hb.beat(); // 20:00 正常：调模型发出 + 一张验收卡片
  writeTask(env, 'quote', base({ next_check_at: '2026-11-16T23:00' }));
  h.setNow(at(2026, 11, 16, 23, 0)); await h.hb.beat(); // 免打扰：排队 1 条
  const out = {};
  if (withFault) {
    const before = fs.readFileSync(env.stateFile);
    await withFileDenied(env.stateFile, async () => {
      h.setNow(at(2026, 11, 17, 1, 0));
      out.action = (await h.hb.beat()).action;
    });
    out.bytesSame = Buffer.compare(before, fs.readFileSync(env.stateFile)) === 0;
  }
  h.setNow(at(2026, 11, 17, 8, 0)); await h.hb.beat();
  const s = h.readState();
  return { ...out, h, s: noNonce(s), raw: s, sent: h.sent.map((x) => fence(x.text)), calls: h.calls.length };
}

test('S1 免打扰里读失败一拍后恢复：与「故障拍没发生」逐项一致（待发、消息索引、验收卡片、次数、发送序列）', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const A = await s1Scenario(true);
  const B = await s1Scenario(false);
  assert.equal(A.action, 'state-unreadable');
  assert.equal(A.bytesSame, true, '故障拍前后状态文件字节完全相同');
  assert.deepEqual(A.s, B.s, '恢复后的状态与对照组一致');
  assert.deepEqual(A.sent, B.sent, '发送序列与对照组一致');
  assert.equal(A.calls, B.calls);
  assert.equal(A.calls, 3, '20:00、23:00、08:00 各调一次；01:00 的故障拍没调');
  assert.ok(A.raw.runs < CFG().maxRunsPerDay, '当天次数不是上限');
  assert.equal(count(A.h, /待发汇总/), 1);
  assert.equal(count(A.h, /待你验收/), 1, '验收卡片全程 1 张');
  assert.equal(count(A.h, READ), 0, '01:00 在免打扰、08:00 前已恢复：不发读不出来通知');
  assert.equal(A.raw.pending.length, 0);
});

// ------------------------------------------------------------------ S2：非免打扰、连续 2 拍读失败

async function s2Scenario(withFault) {
  const env = mkEnv();
  writeTask(env, 'quote', base());
  writeTask(env, 'v1', VERDONE);
  const h = harness(env, {
    config: CFG({ HEARTBEAT_VERIFY: 'rule', HEARTBEAT_ESCALATE_LADDER: 'true' }),
    now: at(2026, 11, 16, 20, 0),
    runImpl: async (n) => `第 ${n} 条提醒`,
    sendImpl: midImpl(),
  });
  await h.hb.beat();
  writeTask(env, 'quote', base({ next_check_at: '2026-11-17T08:00', escalate_after: '2026-11-16T09:00' }));
  if (withFault) {
    await withFileDenied(env.stateFile, async () => {
      for (const d of [at(2026, 11, 17, 1, 0), at(2026, 11, 17, 1, 30)]) { h.setNow(d); await h.hb.beat(); }
    });
  }
  h.setNow(at(2026, 11, 17, 8, 0)); await h.hb.beat();
  const s = h.readState();
  return { h, raw: s, s: noNonce(s), sent: h.sent.filter((x) => !READ.test(x.text)).map((x) => fence(x.text)), calls: h.calls.length };
}

test('S2 非免打扰连续 2 拍读失败（开验收与升级阶梯）：读不出来恰好 1 条，其余与对照组逐项一致', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const A = await s2Scenario(true);
  const B = await s2Scenario(false);
  assert.equal(count(A.h, READ), 1);
  assert.equal(count(B.h, READ), 0);
  assert.deepEqual(A.s, B.s);
  assert.deepEqual(A.sent, B.sent);
  assert.equal(A.calls, B.calls);
  assert.ok(Object.keys(A.raw.verify ?? {}).length >= 1, 'verify 记录在');
  assert.deepEqual(A.raw.verify, B.raw.verify);
  for (const slug of Object.keys(B.raw.tasks)) assert.deepEqual(A.raw.tasks[slug]?.esc, B.raw.tasks[slug]?.esc, `${slug} 的 esc 一致`);
});

// ------------------------------------------------------------------ S3：通知节奏、正文、日志

test('S3 连续 3 拍读失败 → 1 条通知（固定模板、不含状态内容与完整路径、不带按钮）；恢复后再坏 → 第 2 条；同一次故障不再加；每拍日志恰好 1 行', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'later', FAR());
  const h = harness(env, { config: CFG({ HEARTBEAT_VERIFY: 'rule' }) });
  await h.hb.beat(); // 先正常一拍，状态文件落盘
  const SECRET = 'SECRET_PENDING_XYZ';
  injectPending(env, SECRET);
  const logsFrom = (n) => h.logs.slice(n);
  const failBeat = async () => {
    const n0 = h.logs.length;
    next(h);
    const r = await h.hb.beat();
    assert.equal(r.action, 'state-unreadable');
    return logsFrom(n0);
  };
  await withFileDenied(env.stateFile, async () => {
    const l1 = await failBeat();
    assert.equal(l1.filter((l) => /读不了状态文件/.test(l)).length, 1);
    assert.equal(l1.filter((l) => /已私聊 owner：状态文件读不出来/.test(l)).length, 1);
    assert.equal(l1.length, 2, '发通知那拍：读不了 1 行 + 已私聊 1 行');
    for (const i of [2, 3]) {
      const l = await failBeat();
      assert.equal(l.length, 1, `第 ${i} 拍只有 1 行日志`);
      assert.match(l[0], /读不了状态文件/);
    }
  });
  assert.equal(count(h, READ), 1);
  const note = h.sent.find((s) => READ.test(s.text));
  assert.match(note.text, /data\/heartbeat-state\.json/);
  assert.match(note.text, /错误码 (EACCES|EPERM)/);
  assert.match(note.text, /不调模型/);
  assert.equal(note.argc, 1, '直接 send(text)：一个参数、不带按钮');
  assert.equal(note.opts, undefined);
  for (const bad of [SECRET, env.dir, OWNER]) {
    assert.ok(!note.text.includes(bad), `通知不含 ${bad}`);
    assert.ok(!h.logs.join('\n').includes(bad), `日志不含 ${bad}`);
  }
  assert.ok(!h.logs.some((l) => l.includes('今日按额度用完处理')));
  assert.equal(h.calls.length, 0);
  // 恢复一拍：待发项发出（盘上状态没被覆盖）
  next(h); await h.hb.beat();
  assert.equal(count(h, new RegExp(SECRET)), 1, '待发项在恢复后发出一次');
  // 再坏：第 2 条
  await withFileDenied(env.stateFile, async () => {
    next(h); await h.hb.beat();
    next(h); await h.hb.beat();
  });
  assert.equal(count(h, READ), 2, '再坏算新的一次故障：第 2 条');
});

test('S3b /heartbeat status（repair:false 的读）读成功不算恢复、读失败不记故障：同一次故障里通知节奏不受影响', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'later', FAR());
  const h = harness(env, { config: CFG({ HEARTBEAT_VERIFY: 'rule' }) });
  await h.hb.beat();
  await withFileDenied(env.stateFile, async () => { next(h); await h.hb.beat(); });
  assert.equal(count(h, READ), 1);
  h.hb.statusText(); // 文件暂时读得出：repair:false 的读成功，不能当作恢复
  await withFileDenied(env.stateFile, async () => { next(h); assert.equal((await h.hb.beat()).action, 'state-unreadable'); });
  assert.equal(count(h, READ), 1, '没有 repair 读成功过：还是同一次故障，不再发');
  // repair:false 的读失败不记故障：故障从没被 beat 看到过，就不会有通知
  const env2 = mkEnv();
  writeTask(env2, 'later', FAR());
  const h2 = harness(env2, { config: CFG({ HEARTBEAT_VERIFY: 'rule' }) });
  await h2.hb.beat();
  await withFileDenied(env2.stateFile, async () => { h2.hb.statusText(); next(h2); });
  await h2.hb.beat();
  assert.equal(count(h2, READ), 0);
  assert.ok(!h2.logs.some((l) => /读不了状态文件/.test(l)), 'repair:false 的读失败不记「读不了状态文件」日志');
});

test('S3c 状态文件不存在（ENOENT）也算恢复：之后再坏（这里是路径被换成目录 EISDIR）算新的一次，再发 1 条', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'quote', base());
  const h = harness(env, {
    runImpl: async (n) => { writeTask(env, 'quote', base({ next_check_at: '2026-12-31T09:00' })); return `第 ${n} 条提醒`; },
  });
  await h.hb.beat(); // 调模型并落盘；台账改到很远之后，后面的拍不再落盘
  await withFileDenied(env.stateFile, async () => { next(h); await h.hb.beat(); });
  assert.equal(count(h, READ), 1);
  fs.rmSync(env.stateFile);
  next(h); assert.equal((await h.hb.beat()).action, 'no-due'); // ENOENT：按新状态跑，故障清掉
  fs.rmSync(env.stateFile); // 这一拍照常落了一份新状态；换成目录，读它得到 EISDIR（中间没有任何一次成功读）
  fs.mkdirSync(env.stateFile);
  next(h); assert.equal((await h.hb.beat()).action, 'state-unreadable');
  assert.equal(count(h, READ), 2, '新的一次故障');
  assert.match(h.sent.filter((x) => READ.test(x.text))[1].text, /错误码 EISDIR/);
});

// ------------------------------------------------------------------ S4：免打扰顺延

test('S4 免打扰顺延：23:00 起读失败，02:00、07:30 失败 → 0 条；08:00 仍失败 → 1 条；08:30 不再发。另一组：07:30 前恢复 → 全程 0 条', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const prime = async () => {
    const env = mkEnv();
    writeTask(env, 'later', FAR());
    const h = harness(env, { config: CFG({ HEARTBEAT_QUIET_HOURS: '22-08', HEARTBEAT_VERIFY: 'rule' }), now: at(2026, 11, 16, 20, 0) });
    await h.hb.beat();
    assert.ok(fs.existsSync(env.stateFile));
    return { env, h };
  };
  {
    const { env, h } = await prime();
    await withFileDenied(env.stateFile, async () => {
      for (const [d, want] of [[at(2026, 11, 16, 23, 0), 0], [at(2026, 11, 17, 2, 0), 0], [at(2026, 11, 17, 7, 30), 0], [at(2026, 11, 17, 8, 0), 1], [at(2026, 11, 17, 8, 30), 1]]) {
        h.setNow(d);
        assert.equal((await h.hb.beat()).action, 'state-unreadable');
        assert.equal(count(h, READ), want, d.toTimeString().slice(0, 5));
      }
    });
  }
  {
    const { env, h } = await prime();
    await withFileDenied(env.stateFile, async () => {
      h.setNow(at(2026, 11, 16, 23, 0)); await h.hb.beat();
      h.setNow(at(2026, 11, 17, 2, 0)); await h.hb.beat();
    });
    h.setNow(at(2026, 11, 17, 7, 30)); await h.hb.beat(); // 恢复
    h.setNow(at(2026, 11, 17, 8, 0)); await h.hb.beat();
    assert.equal(count(h, READ), 0, '时段结束前已恢复：不发');
  }
});

// ------------------------------------------------------------------ S5：不调模型、不落盘、不留内存快照；发送失败重试

test('S5 读失败期间有到期台账：不调模型；进程外往盘上状态塞待发项，恢复后下一拍发出（没有内存里的旧快照）', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'quote', FAR());
  const h = harness(env, { config: CFG({ HEARTBEAT_VERIFY: 'rule' }) });
  await h.hb.beat();
  writeTask(env, 'quote', base({ next_check_at: '2026-11-16T09:00' })); // 到期
  await withFileDenied(env.stateFile, async () => {
    for (let i = 0; i < 2; i++) { next(h); assert.equal((await h.hb.beat()).action, 'state-unreadable'); }
  });
  assert.equal(h.calls.length, 0, '读失败期间不调模型');
  assert.equal(h.sent.filter((s) => !READ.test(s.text)).length, 0);
  injectPending(env, '进程外塞进来的待发项 EXTERNAL');
  next(h); await h.hb.beat();
  assert.equal(count(h, /EXTERNAL/), 1, '下一拍读的是盘上的新值');
  assert.equal(h.calls.length, 1, '恢复后到期台账照常调模型');
});

test('S5b 「读不出来」发送失败：只记日志、下一拍再试；前两次抛错 → 第 3 拍才发出，之后不再发', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'later', FAR());
  let fails = 0;
  const h = harness(env, {
    config: CFG({ HEARTBEAT_VERIFY: 'rule' }),
    sendImpl: (rec, n) => {
      if (READ.test(rec.text) && ++fails <= 2) throw new Error(`boom ${env.dir}`);
      return `om_${n}`;
    },
  });
  await h.hb.beat();
  await withFileDenied(env.stateFile, async () => {
    for (let i = 0; i < 5; i++) { next(h); assert.equal((await h.hb.beat()).action, 'state-unreadable'); }
  });
  const attempts = h.sent.filter((s) => READ.test(s.text));
  assert.equal(attempts.length, 3, '2 次失败 + 第 3 拍成功，之后不再发');
  assert.equal(h.logs.filter((l) => /私聊 owner 失败（状态文件读不出来的提醒）/.test(l)).length, 2);
  assert.equal(h.logs.filter((l) => /已私聊 owner：状态文件读不出来/.test(l)).length, 1);
});

// ------------------------------------------------------------------ S6：先写失败后读失败、反顺序

test('S6 先写失败、后读失败、再恢复：未落盘状态在时不读盘，读不出来通知 0 条；待发汇总 / 验收卡片 / 写不进去各 1 条，最后盘上状态完整', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'quote', base());
  const h = harness(env, {
    config: CFG({ HEARTBEAT_QUIET_HOURS: '22-08', HEARTBEAT_VERIFY: 'rule' }),
    now: at(2026, 11, 16, 23, 0),
    runImpl: async (n) => `第 ${n} 条提醒`,
  });
  await h.hb.beat(); // 免打扰里调模型，结果排队
  assert.equal(h.readState().pending.length, 1);
  writeTask(env, 'v1', VERDONE);
  const dir = path.dirname(env.stateFile);
  await withDirMode(dir, 0o555, async () => {
    h.setNow(at(2026, 11, 17, 8, 0)); await h.hb.beat(); // 补发 + 验收卡片 + 写不进去通知
    assert.equal(count(h, /待发汇总/), 1);
    assert.equal(count(h, /待你验收/), 1);
    assert.equal(count(h, WRITE), 1);
    await withFileDenied(env.stateFile, async () => {
      h.setNow(at(2026, 11, 17, 8, 30)); await h.hb.beat(); // 状态文件读不了，但有未落盘状态：不读盘
    });
  });
  h.setNow(at(2026, 11, 17, 9, 0)); await h.hb.beat(); // 全部恢复
  assert.equal(count(h, /待发汇总/), 1, '不重发');
  assert.equal(count(h, /待你验收/), 1, '不重发');
  assert.equal(count(h, WRITE), 1);
  assert.equal(count(h, READ), 0);
  const st = h.readState();
  assert.equal(st.pending.length, 0);
  assert.ok(st.verify.v1.card_at, '验收卡片记录在');
  assert.ok(Object.keys(st.msg_index).length >= 2);
});

test('S6b 反顺序：先读失败一拍（只发读不出来），再改成目录只读（读得出、写不进）一拍 → 走写不进去路径，各 1 条', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'quote', FAR());
  const h = harness(env, { config: CFG({ HEARTBEAT_VERIFY: 'rule' }) });
  await h.hb.beat();
  writeTask(env, 'quote', base()); // 到期：下一个正常拍会走「调模型前先落盘」
  await withFileDenied(env.stateFile, async () => {
    next(h); assert.equal((await h.hb.beat()).action, 'state-unreadable');
  });
  assert.equal(count(h, READ), 1);
  assert.equal(count(h, WRITE), 0);
  await withDirMode(path.dirname(env.stateFile), 0o555, async () => {
    next(h); assert.equal((await h.hb.beat()).action, 'state-error');
  });
  assert.equal(count(h, WRITE), 1);
  assert.equal(count(h, READ), 1, '读不出来通知仍是 1 条');
  assert.equal(h.calls.length, 0);
});

// ------------------------------------------------------------------ S7：已损坏不变

test('S7 状态文件是坏 JSON：仍是 budget、不调模型、留 .corrupt- 备份、盘上 runs 为上限；读不出来通知 0 条', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', base());
  fs.mkdirSync(path.dirname(env.stateFile), { recursive: true });
  fs.writeFileSync(env.stateFile, '{ 坏掉的状态');
  const h = harness(env);
  assert.equal((await h.hb.beat()).action, 'budget');
  assert.equal(h.calls.length, 0);
  assert.ok(fs.readdirSync(path.dirname(env.stateFile)).some((f) => f.includes('.corrupt-')));
  assert.equal(h.readState().runs, CFG().maxRunsPerDay);
  assert.equal(count(h, READ), 0);
  assert.ok(!h.logs.some((l) => /读不了状态文件/.test(l)));
});

// ------------------------------------------------------------------ S8：台账目录读不了一拍（L2）

test('S8 台账目录读不了一拍：no-due，坏台账通知记录 / 验收 / 阶梯 / history.seen 都不清；恢复后不重发；免打扰排着的待发项照常补发', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'bad', BADT());
  writeTask(env, 'v1', VERDONE);
  writeTask(env, 'quote', ESC);
  const h = harness(env, {
    config: CFG({ HEARTBEAT_VERIFY: 'rule', HEARTBEAT_ESCALATE_LADDER: 'true', HEARTBEAT_DIGEST_AT: '21:30' }),
    now: T0,
  });
  await h.hb.beat(); // 正常一拍：坏台账通知、验收卡片、quote 登第 1 级
  const before = h.readState();
  assert.ok(Object.keys(before.invalid_notified ?? {}).length >= 1);
  assert.ok(Object.keys(before.verify ?? {}).length >= 1);
  assert.equal(before.tasks.quote.esc.level, 1);
  assert.ok(Object.keys(before.history.seen).length >= 2);
  assert.equal(count(h, NOTICE), 1);
  assert.equal(count(h, /待你验收/), 1);
  const calls0 = h.calls.length;
  injectPending(env, '台账目录读不了时的待发项 PENDING_L2'); // 本拍开头照常补发
  await (async () => {
    fs.chmodSync(env.tasksDir, 0o000);
    try { next(h); assert.equal((await h.hb.beat()).action, 'no-due'); } finally { fs.chmodSync(env.tasksDir, 0o755); }
  })();
  assert.equal(count(h, /PENDING_L2/), 1, '故障拍照常补发');
  const mid = h.readState();
  for (const k of ['invalid_notified', 'verify', 'tasks', 'history']) {
    assert.deepEqual(mid[k]?.seen ?? mid[k], before[k]?.seen ?? before[k], `${k} 不变`);
  }
  assert.ok(h.logs.some((l) => /读不了台账目录.*本拍不处理台账、保留上次的记录/.test(l)));
  next(h); await h.hb.beat();
  assert.equal(count(h, NOTICE), 1, '坏台账通知不重发');
  assert.equal(count(h, /待你验收/), 1, '验收卡片不重发');
  const after = h.readState();
  assert.equal(after.tasks.quote.esc.level, 1, '阶梯按原级数继续');
  assert.deepEqual(after.tasks.quote.esc, before.tasks.quote.esc);
  assert.equal(h.calls.length, calls0, '没有多调模型');
});

test('S8b 台账目录读不了一拍：后面的调模型快照 / afterModel 也不清 history.seen（模型期间目录变得读不了）', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'quote', base());
  writeTask(env, 'other', FAR());
  const h = harness(env, {
    config: CFG({ HEARTBEAT_VERIFY: 'rule', HEARTBEAT_DIGEST_AT: '21:30' }),
    runImpl: async (n) => {
      fs.chmodSync(env.tasksDir, 0o000); // 模型运行期间台账目录读不了：afterModel 那一次读失败
      return `第 ${n} 条提醒`;
    },
  });
  try {
    await h.hb.beat();
  } finally {
    fs.chmodSync(env.tasksDir, 0o755);
  }
  const seen = h.readState().history.seen;
  assert.ok(seen.other, 'afterModel 读不了目录时不清 history.seen');
  assert.ok(seen.quote);
});

test('S8c 调模型前台账目录刚好读不了：快照那一次不清 history，与目录一直可读的对照组逐项一致', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const scen = async (flaky) => {
    const env = mkEnv();
    writeTask(env, 'quote', base());
    writeTask(env, 'v1', VERDONE);
    writeTask(env, 'other', FAR());
    const h = harness(env, {
      config: CFG({ HEARTBEAT_VERIFY: 'rule', HEARTBEAT_DIGEST_AT: '21:30' }),
      // 验收卡片发出之后（beatOnce 的台账读取已经完成）、调模型前快照之前：目录变得读不了；模型运行时恢复
      sendImpl: (rec, n) => { if (flaky && /待你验收/.test(rec.text)) fs.chmodSync(env.tasksDir, 0o000); return `om_${n}`; },
      runImpl: async (n) => {
        if (flaky) fs.chmodSync(env.tasksDir, 0o755);
        writeTask(env, 'other', FAR({ status: 'waiting' })); // 模型运行期间改了一条：要记成「心跳改的」
        return `第 ${n} 条提醒`;
      },
    });
    try { await h.hb.beat(); } finally { fs.chmodSync(env.tasksDir, 0o755); }
    return h;
  };
  const A = await scen(true);
  const B = await scen(false);
  assert.equal(A.calls.length, 1);
  assert.deepEqual(A.readState().history, B.readState().history);
  assert.ok(B.readState().history.changes.some((c) => JSON.stringify(c).includes('other')), '对照组记下了模型期间的改动');
  assert.equal(A.logs.filter((l) => /读不了台账目录/.test(l)).length, 0, '快照那一次是静默读（不记日志）');
});

// ------------------------------------------------------------------ S9：日结

test('S9 日结：状态文件读不了 / 台账目录读不了 → digestNow 返回 unreadable、不发、不落盘；恢复后照常发', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'ship', VERDONE);
  const NIGHT = at(2026, 11, 16, 21, 30);
  const h = harness(env, { config: CFG({ HEARTBEAT_VERIFY: 'rule', HEARTBEAT_DIGEST_AT: '21:30' }), now: NIGHT });
  await h.hb.beat();
  const sent0 = h.sent.length;
  const bytes0 = fs.readFileSync(env.stateFile);
  await withFileDenied(env.stateFile, async () => {
    assert.deepEqual(await h.hb.digestNow(), { action: 'unreadable' });
  });
  assert.equal(h.sent.length, sent0);
  assert.equal(Buffer.compare(bytes0, fs.readFileSync(env.stateFile)), 0, '状态文件字节不变');
  fs.chmodSync(env.tasksDir, 0o000);
  try {
    assert.deepEqual(await h.hb.digestNow(), { action: 'unreadable' });
  } finally { fs.chmodSync(env.tasksDir, 0o755); }
  assert.equal(h.sent.length, sent0);
  assert.equal(Buffer.compare(bytes0, fs.readFileSync(env.stateFile)), 0, '台账目录读不了时状态文件字节也不变');
  assert.notEqual((await h.hb.digestNow()).action, 'unreadable');
  assert.equal(count(h, DIGEST), 1, '恢复后照常发一份');
});

test('S9b digestTick 拿到 unreadable：60 秒后再试；到点后 30 分钟还读不了就排到明天、不补发', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'ship', VERDONE);
  const NIGHT = at(2026, 11, 16, 21, 30);
  const timers = spyTimers();
  const h = harness(env, { config: CFG({ HEARTBEAT_VERIFY: 'rule', HEARTBEAT_DIGEST_AT: '21:30' }), now: NIGHT, timers });
  await h.hb.beat();
  h.hb.start();
  const t1 = timers.timeouts[1];
  const sent0 = h.sent.length;
  await withFileDenied(env.stateFile, async () => {
    await t1.fn();
    assert.equal(timers.timeouts[2].ms, 60_000, '读不了：60 秒后再试');
    h.setNow(plus(NIGHT, 1));
    await timers.timeouts[2].fn();
    assert.equal(timers.timeouts[3].ms, 60_000);
    h.setNow(plus(NIGHT, 31)); // 超过到点后 30 分钟
    await timers.timeouts[3].fn();
    assert.notEqual(timers.timeouts[4].ms, 60_000, '窗口外排到明天');
    assert.ok(timers.timeouts[4].ms > 20 * 3_600_000);
  });
  assert.equal(h.sent.length, sent0, '一直没发');
  h.hb.stop();
});

test('S9c digestTick：读不了后 60 秒再试，恢复后发出并排到明天', async (t) => {
  if (isRoot()) { t.skip(SKIP); return; }
  const env = mkEnv();
  writeTask(env, 'ship', VERDONE);
  const NIGHT = at(2026, 11, 16, 21, 30);
  const timers = spyTimers();
  const h = harness(env, { config: CFG({ HEARTBEAT_VERIFY: 'rule', HEARTBEAT_DIGEST_AT: '21:30' }), now: NIGHT, timers });
  await h.hb.beat();
  h.hb.start();
  await withFileDenied(env.stateFile, async () => { await timers.timeouts[1].fn(); });
  assert.equal(timers.timeouts[2].ms, 60_000);
  h.setNow(plus(NIGHT, 1));
  await timers.timeouts[2].fn();
  assert.equal(count(h, DIGEST), 1);
  assert.equal(timers.timeouts[3].ms, 86_400_000 - 60_000);
  h.hb.stop();
});

// ------------------------------------------------------------------ S10：行为不变

test('S10 全部可读可写：到期 → 调模型 → 发出 / 免打扰排队 → 补发 / 验收卡片一次；动作序列、发送序列、状态键集合不变；日志没有「读不了」', async () => {
  const env = mkEnv();
  writeTask(env, 'quote', base({ next_check_at: '2026-11-16T21:00' }));
  const h = harness(env, {
    config: CFG({ HEARTBEAT_QUIET_HOURS: '22-08' }),
    now: at(2026, 11, 16, 21, 0),
    runImpl: async (n) => { writeTask(env, 'quote', { ...readTask(env, 'quote'), next_check_at: `2026-11-1${6 + n}T09:00` }); return `第 ${n} 条提醒`; },
  });
  const seq = [];
  const beat = async (d) => { h.setNow(d); const r = await h.hb.beat(); seq.push(`${r.action}:${h.sent.length}`); };
  await beat(at(2026, 11, 16, 21, 0));
  await beat(at(2026, 11, 16, 21, 30));
  writeTask(env, 'quote', { ...readTask(env, 'quote'), next_check_at: '2026-11-16T21:00' });
  await beat(at(2026, 11, 16, 23, 0));
  await beat(at(2026, 11, 17, 8, 0));
  assert.deepEqual(seq, ['sent:1', 'no-due:1', 'queued:1', 'no-due:2']);
  assert.deepEqual(mids(h), ['💓 **心跳**', '💓 **心跳 · 待发汇总（1 条）**']);
  assert.deepEqual(Object.keys(h.readState()).sort(), [
    'consecutive_failures', 'day', 'last_beat_at', 'last_error', 'last_fingerprint', 'last_notified_at', 'last_run_at', 'msg_index',
    'notices', 'pending', 'runs', 'send_fails', 'sent', 'tasks', 'unread_pause', 'version', 'watch_cursor', 'watch_locked', 'watch_stats',
  ]);
  assert.ok(!h.logs.some((l) => /读不了/.test(l)));
  assert.equal(count(h, READ) + count(h, WRITE) + count(h, NOTICE), 0);
});

test('S10b 验收开着、全部可读可写：验收卡片只发一次，动作 / 日志不变', async () => {
  const env = mkEnv();
  writeTask(env, 'v1', VERDONE);
  writeTask(env, 'later', FAR());
  const h = harness(env, { config: CFG({ HEARTBEAT_VERIFY: 'rule' }) });
  const acts = [];
  for (let i = 0; i < 3; i++) { acts.push((await h.hb.beat()).action); next(h); }
  assert.deepEqual(acts, ['no-due', 'no-due', 'no-due']);
  assert.equal(count(h, /待你验收/), 1);
  assert.ok(!h.logs.some((l) => /读不了/.test(l)));
  assert.ok(taskFile(env, 'v1'));
});
