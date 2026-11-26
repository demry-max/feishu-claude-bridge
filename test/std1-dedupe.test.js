// BRIDGE-STD-1 §3.1（W5 / C3 / C4）：去重落盘
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDedupeStore, writeJsonAtomic } from '../src/inbound-dedupe.js';

const DAY = 24 * 3600 * 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'std1-dedupe-'));
const mkClock = (t0 = 1_700_000_000_000) => { const k = { t: t0 }; k.now = () => k.t; return k; };
const quiet = () => { const logs = []; return { logs, log: (s) => logs.push(s) }; };
/** 内存里的 fs（大批量登记的用例不想真写盘几千次） */
function memFs() {
  const files = new Map();
  const enoent = () => Object.assign(new Error('nf'), { code: 'ENOENT' });
  return {
    files,
    mkdirSync() {}, chmodSync() {}, rmSync(f) { files.delete(f); },
    readFileSync: (f) => { if (!files.has(f)) throw enoent(); return files.get(f); },
    writeFileSync: (f, body) => { files.set(f, String(body)); },
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  };
}

test('checkAndMark：第一次登记返回 false，之后返回 true；has 不登记；size 计数', () => {
  const dir = tmp();
  const s = createDedupeStore({ file: path.join(dir, 'seen.json'), ...quiet() });
  assert.equal(s.has('a1'), false);
  assert.equal(s.size, 0);
  assert.equal(s.checkAndMark('a1'), false);
  assert.equal(s.has('a1'), true);
  assert.equal(s.checkAndMark('a1'), true);
  assert.equal(s.size, 1);
  assert.equal(s.has('zzz'), false);
  assert.equal(s.size, 1, 'has 不登记');
});

test('缺 id / 非字符串 id：不当重复、不登记（不把 undefined 当成一条）', () => {
  const s = createDedupeStore({ file: path.join(tmp(), 'seen.json'), ...quiet() });
  assert.equal(s.checkAndMark(undefined), false);
  assert.equal(s.checkAndMark(undefined), false);
  assert.equal(s.checkAndMark(''), false);
  assert.equal(s.checkAndMark(123), false);
  assert.equal(s.size, 0);
});

test('重启不丢：登记后新建一个 store 读同一个文件，同 id 仍是重复；文件形态 { v:1, ids:[[id, 登记时刻]] }，权限 0600', () => {
  const dir = tmp();
  const file = path.join(dir, 'data', 'seen.json');
  const k = mkClock();
  const s1 = createDedupeStore({ file, now: k.now, ...quiet() });
  s1.checkAndMark('m1');
  k.t += 5;
  s1.checkAndMark('m2');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(doc, { v: 1, ids: [['m1', 1_700_000_000_000], ['m2', 1_700_000_000_005]] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['seen.json'], '不留临时文件');
  const s2 = createDedupeStore({ file, now: k.now, ...quiet() });
  assert.equal(s2.size, 2);
  assert.equal(s2.checkAndMark('m1'), true);
  assert.equal(s2.checkAndMark('m2'), true);
  assert.equal(s2.checkAndMark('m3'), false);
});

test('每次登记都同步落盘：登记返回时文件里已经有这个 id（不做延迟合并）', () => {
  const file = path.join(tmp(), 'seen.json');
  const s = createDedupeStore({ file, ...quiet() });
  for (const id of ['a', 'b', 'c']) {
    s.checkAndMark(id);
    const ids = JSON.parse(fs.readFileSync(file, 'utf8')).ids.map((e) => e[0]);
    assert.ok(ids.includes(id), `${id} 已在盘上`);
  }
  s.checkAndMark('a'); // 重复的不用再写
});

test('先写临时文件再 rename（原子）：注入 fs 记录调用顺序', () => {
  const ops = [];
  const mem = new Map();
  const fsx = {
    mkdirSync: () => ops.push('mkdir'),
    readFileSync: () => { const e = new Error('nf'); e.code = 'ENOENT'; throw e; },
    writeFileSync: (f, body, opt) => { ops.push(['write', f, opt?.mode]); mem.set(f, body); },
    chmodSync: (f, m) => ops.push(['chmod', f, m]),
    renameSync: (a, b) => { ops.push(['rename', a, b]); mem.set(b, mem.get(a)); mem.delete(a); },
    rmSync: (f) => ops.push(['rm', f]),
  };
  const s = createDedupeStore({ file: '/virtual/seen.json', fs: fsx, ...quiet() });
  s.checkAndMark('x');
  const w = ops.find((o) => o[0] === 'write');
  const r = ops.find((o) => o[0] === 'rename');
  assert.ok(w && r && ops.indexOf(w) < ops.indexOf(r));
  assert.notEqual(w[1], '/virtual/seen.json', '写的是临时文件');
  assert.equal(w[2], 0o600);
  assert.deepEqual([r[1], r[2]], [w[1], '/virtual/seen.json']);
  assert.ok(mem.has('/virtual/seen.json'));
});

test('保留规则：7 天内的或最近 keepMin 条都留——边界（恰好 7 天留；多 1ms 且不在最近 keepMin 条里的丢）', () => {
  const k = mkClock();
  const t0 = k.t;
  const s = createDedupeStore({ file: path.join(tmp(), 'seen.json'), now: k.now, keepMs: 7 * DAY, keepMin: 1, cap: 100, ...quiet() });
  s.checkAndMark('a'); // t0
  k.t = t0 + DAY;
  s.checkAndMark('b');
  k.t = t0 + 7 * DAY;
  s.checkAndMark('c');
  assert.equal(s.has('a'), true, '恰好 7 天：还在窗口内');
  k.t = t0 + 7 * DAY + 1;
  s.checkAndMark('d');
  assert.equal(s.has('a'), false, '超过 7 天 1ms 且不在最近 1 条里：清掉');
  assert.equal(s.has('b'), true, 'b 才 6 天多');
  assert.equal(s.size, 3);
});

test('保留规则：最近 keepMin 条不论多老都留（长时间没消息也不清空）', () => {
  const k = mkClock();
  const s = createDedupeStore({ file: 'mem/seen.json', fs: memFs(), now: k.now, keepMs: DAY, keepMin: 5, cap: 100, ...quiet() });
  for (let i = 0; i < 5; i += 1) { s.checkAndMark(`m${i}`); k.t += 1000; }
  k.t += 30 * DAY;
  s.checkAndMark('late');
  assert.equal(s.size, 5, '5 条 = keepMin：最老的 m0 让位，其余留');
  assert.equal(s.has('m0'), false);
  assert.equal(s.has('m1'), true);
  assert.equal(s.has('late'), true);
});

test('硬上限 cap：窗口内也只留最新的 cap 条', () => {
  const k = mkClock();
  const s = createDedupeStore({ file: 'mem/seen.json', fs: memFs(), now: k.now, keepMs: 7 * DAY, keepMin: 2, cap: 10, ...quiet() });
  for (let i = 0; i < 25; i += 1) { s.checkAndMark(`m${i}`); k.t += 1; }
  assert.equal(s.size, 10);
  assert.equal(s.has('m14'), false);
  assert.equal(s.has('m15'), true);
  assert.equal(s.has('m24'), true);
});

test('默认值：keepMs 7 天、keepMin 2000、cap 20000', () => {
  const k = mkClock();
  const s = createDedupeStore({ file: 'mem/seen.json', fs: memFs(), now: k.now, ...quiet() });
  s.checkAndMark('first');
  for (let i = 0; i < 2100; i += 1) { k.t += 1; s.checkAndMark(`bulk${i}`); }
  assert.equal(s.has('first'), true, '都在 7 天内：2100 条全留');
  assert.equal(s.size, 2101);
  k.t += 8 * DAY;
  s.checkAndMark('after8d');
  assert.equal(s.size, 2000, '过了 7 天只剩最近 2000 条');
  assert.equal(s.has('after8d'), true);
});

test('读盘时也按保留规则清理，且按登记时刻排序后接回（文件里顺序乱也不影响）', () => {
  const file = path.join(tmp(), 'seen.json');
  const k = mkClock();
  const doc = { v: 1, ids: [['new', k.t - 10], ['ancient', k.t - 40 * DAY], ['mid', k.t - 20]] };
  fs.writeFileSync(file, JSON.stringify(doc));
  const s = createDedupeStore({ file, now: k.now, keepMs: 7 * DAY, keepMin: 2, cap: 100, ...quiet() });
  assert.equal(s.has('ancient'), false, '超 7 天且不在最近 2 条里');
  assert.equal(s.has('new'), true);
  assert.equal(s.has('mid'), true);
});

test('写盘失败不抛：内存里照常记，同 id 仍判重；日志每小时最多一行，不带 id', () => {
  const k = mkClock();
  const { logs, log } = quiet();
  const fsx = {
    mkdirSync() {}, readFileSync() { const e = new Error('nf'); e.code = 'ENOENT'; throw e; },
    writeFileSync() { const e = new Error('disk full /secret/path'); e.code = 'ENOSPC'; throw e; },
    chmodSync() {}, renameSync() {}, rmSync() {},
  };
  const s = createDedupeStore({ file: '/virtual/seen.json', fs: fsx, now: k.now, log });
  assert.doesNotThrow(() => s.checkAndMark('secretmsgid01'));
  assert.equal(s.checkAndMark('secretmsgid01'), true, '内存里记着');
  s.checkAndMark('secretmsgid02');
  assert.equal(logs.length, 1, '一小时内只记一行');
  assert.ok(!logs[0].includes('secretmsgid'), '不带 id');
  assert.ok(!logs[0].includes('/secret/path'), '不带路径');
  assert.match(logs[0], /ENOSPC/);
  k.t += 3600 * 1000 - 1;
  s.checkAndMark('secretmsgid03');
  assert.equal(logs.length, 1);
  k.t += 1;
  s.checkAndMark('secretmsgid04');
  assert.equal(logs.length, 2, '满一小时再记一行');
});

test('文件损坏 / 格式不认识：按空表起步、记一行日志、不崩；之后正常登记并改写文件', () => {
  for (const bad of ['{not json', '[]', 'null', '{"v":2,"ids":[]}', '{"v":1}', '{"v":1,"ids":"x"}', '']) {
    const file = path.join(tmp(), 'seen.json');
    fs.writeFileSync(file, bad);
    const { logs, log } = quiet();
    let s;
    assert.doesNotThrow(() => { s = createDedupeStore({ file, log }); }, bad);
    assert.equal(s.size, 0, bad);
    assert.equal(logs.length, 1, `${bad} → 一行日志`);
    assert.equal(s.checkAndMark('x1'), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).ids.map((e) => e[0]), ['x1']);
  }
});

test('文件不存在是正常首次启动：不记日志；个别坏条目被丢弃并记一行', () => {
  const { logs, log } = quiet();
  const s0 = createDedupeStore({ file: path.join(tmp(), 'nope', 'seen.json'), log });
  assert.equal(s0.size, 0);
  assert.equal(logs.length, 0);
  const file = path.join(tmp(), 'seen.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, ids: [['ok1', Date.now()], ['bad'], [1, 2], 'str', ['ok2', 'x'], ['ok3', Date.now()]] }));
  const q = quiet();
  const s1 = createDedupeStore({ file, log: q.log });
  assert.equal(s1.size, 2);
  assert.equal(s1.has('ok1') && s1.has('ok3'), true);
  assert.equal(q.logs.length, 1);
});

test('writeJsonAtomic：失败时清掉临时文件并把错误抛给调用方', () => {
  const dir = tmp();
  const rms = [];
  const fsx = {
    mkdirSync() {}, writeFileSync() {}, chmodSync() {},
    renameSync() { throw Object.assign(new Error('x'), { code: 'EIO' }); },
    rmSync: (f) => rms.push(f),
  };
  assert.throws(() => writeJsonAtomic(path.join(dir, 'a.json'), { v: 1 }, { fs: fsx }), /x/);
  assert.equal(rms.length, 1);
  writeJsonAtomic(path.join(dir, 'b.json'), { v: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8')), { v: 1 });
  assert.equal(fs.statSync(path.join(dir, 'b.json')).mode & 0o777, 0o600);
});
