// BRIDGE-RUN-2：src/child-registry.js 单元测试。
// 注入 probe / kill / exec / sleepSync，不起任何真进程（真进程的端到端见 child-reaper.test.js）。
// ps 这一层是假的 exec：每个用例结束都核一遍「只出现过 -p <单个 pid> 的查询」，证明从不枚举进程表。
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHILD_REGISTRY_FILE, probeProcess, createChildRegistry, childRegistryFor, orphanNoticeText, deferUntilAwake,
} from '../src/child-registry.js';
import { makeWorld, tmpRegistryDir, logSink, rec, LSTART, CLAUDE_CMD } from './fixtures/reap-helpers.mjs';

const T = { timeout: 15_000 };
const PS_ARGS_HEAD = ['-ww', '-o', 'ppid=,pgid=,lstart=,command=', '-p'];
const SESSION_ID = 'c0ffee00-1111-4222-8333-444455556666';

const dirs = [];
afterEach(() => { while (dirs.length) dirs.pop().cleanup(); });

/** 一套：临时记录文件 + 假世界 + 登记簿（探测走真 probeProcess 套假 exec） */
function setup({ world: worldOpts, reg: regOpts } = {}) {
  const t = tmpRegistryDir('unit');
  dirs.push(t);
  const world = makeWorld(worldOpts);
  const regLog = logSink();
  const reg = createChildRegistry({
    file: t.file, log: regLog, probe: world.probe, psBin: '/bin/ps', platform: 'linux', selfPid: 99_999, ...regOpts,
  });
  return { t, world, reg, regLog, allowed: new Set([4242]) };
}

/** 跑一次启动清理（kill / sleepSync 都是假的），随后核对：ps 只被问过 `-p <允许的单个 pid>` */
function reap(ctx, extra = {}) {
  const out = logSink();
  const r = ctx.reg.reapPrevious({
    log: out, kill: ctx.world.kill, sleepSync: ctx.world.sleepSync, escalateMs: 1000, pollMs: 100, ...extra,
  });
  assertOnlyPidQueries(ctx.world, ctx.allowed);
  return { r, out: out.lines };
}

function assertOnlyPidQueries(world, allowed) {
  for (const c of world.execCalls) {
    assert.equal(c.bin, '/bin/ps');
    assert.equal(c.args.length, PS_ARGS_HEAD.length + 1, `ps 参数个数不对：${JSON.stringify(c.args)}`);
    assert.deepEqual(c.args.slice(0, PS_ARGS_HEAD.length), PS_ARGS_HEAD);
    const last = c.args[c.args.length - 1];
    assert.match(last, /^\d+$/, `ps 只许查单个 pid，收到 ${JSON.stringify(c.args)}`);
    const ok = typeof allowed === 'function' ? allowed(Number(last)) : allowed.has(Number(last));
    assert.ok(ok, `查了没登记过的 pid ${last}`);
    assert.deepEqual(c.opts.env, { LC_ALL: 'C', TZ: 'UTC' });
  }
}

const sigs = (world) => world.signals().map(([t, s]) => `${t}:${s}`);

// =============================================================================================
describe('U1 判定表（指纹全对才整组结束）', () => {
  it('全对 → 恰好一次 kill(-4242, SIGTERM)，killed:1', T, () => {
    const ctx = setup();
    ctx.t.write([rec(4242)]);
    ctx.world.addProc(4242);
    const { r } = reap(ctx);
    assert.deepEqual(r, { killed: 1, dropped: 0, unreadable: false });
    assert.deepEqual(ctx.world.signals(), [[-4242, 'SIGTERM']]);
  });

  const BREAKS = [
    ['探测为 null（进程不在）', null],
    ['pgid 是 4243', { pgid: 4243 }],
    ['lstart 差 1 秒', { lstart: 'Fri Nov 20 03:55:29 2026' }],
    ['命令是 claude -p --model x', { command: '/x/claude -p --model x' }],
    ['命令是 node fake-claude-run.mjs --gc 30', { command: 'node /t/fake-claude-run.mjs --gc 30' }],
    ['ppid 是 777（别的桥接还活着）', { ppid: 777 }],
    ['ppid 是 0', { ppid: 0 }],
    ['ppid 是 本进程自己（本代刚起的）', { ppid: 99_999 }],
    ['形态词顺序不对', { command: '/x/claude --verbose stream-json --output-format -p' }],
    ['形态词只在第 0 个词', { command: '-p --output-format stream-json --verbose' }],
    ['四个形态词中间夹了别的参数（第一个词后插 --model x）', { command: '/x/claude -p --model x --output-format stream-json --verbose' }],
    ['四个形态词中间夹了别的参数（stream-json 与 --verbose 之间）', { command: '/x/claude -p --output-format stream-json --resume abc --verbose' }],
    ['形态词大小写不同（全大写）', { command: '/x/claude -P --OUTPUT-FORMAT STREAM-JSON --VERBOSE' }],
    ['形态词大小写不同（只有一个词）', { command: '/x/claude -p --output-format STREAM-JSON --verbose' }],
  ];
  for (const [name, override] of BREAKS) {
    it(`逐项改坏：${name} → 不调用 kill，计入 dropped`, T, () => {
      const ctx = setup();
      ctx.t.write([rec(4242)]);
      if (override) ctx.world.addProc(4242, override);
      const { r } = reap(ctx);
      assert.deepEqual(r, { killed: 0, dropped: 1, unreadable: false });
      assert.deepEqual(ctx.world.killCalls, [], '一次 kill 都不该有');
    });
  }

  it('lstart 只差空白（日 < 10 时 ps 多补一个空格）→ 归一化后仍 kill，两个方向都行', T, () => {
    for (const [recorded, shown] of [['Mon Nov 3 03:55:28 2026', 'Mon Nov  3 03:55:28 2026'], ['Mon Nov  3 03:55:28 2026', 'Mon Nov 3 03:55:28 2026']]) {
      const ctx = setup();
      ctx.t.write([{ pid: 4242, pgid: 4242, lstart: recorded }]);
      ctx.world.addProc(4242, { lstart: shown });
      const { r } = reap(ctx);
      assert.equal(r.killed, 1, `${JSON.stringify(recorded)} vs ${JSON.stringify(shown)}`);
      assert.deepEqual(ctx.world.signals(), [[-4242, 'SIGTERM']]);
    }
  });

  const BAD_SHAPES = [
    ['pid 为 1', { pid: 1, pgid: 1, lstart: LSTART }],
    ['pid 为 0', { pid: 0, pgid: 0, lstart: LSTART }],
    ['pid 为 -5', { pid: -5, pgid: -5, lstart: LSTART }],
    ['pid 为 1.5', { pid: 1.5, pgid: 1.5, lstart: LSTART }],
    ['pid 是字符串 "4242"', { pid: '4242', pgid: '4242', lstart: LSTART }],
    ['pid 等于 selfPid', { pid: 99_999, pgid: 99_999, lstart: LSTART }],
    ['pgid ≠ pid', { pid: 4242, pgid: 4243, lstart: LSTART }],
    ['pgid 缺失', { pid: 4242, lstart: LSTART }],
    ['lstart 缺失', { pid: 4242, pgid: 4242 }],
    ['lstart 为空串', { pid: 4242, pgid: 4242, lstart: '' }],
    ['lstart 只有空白', { pid: 4242, pgid: 4242, lstart: '   ' }],
    ['lstart 100 字', { pid: 4242, pgid: 4242, lstart: 'x'.repeat(100) }],
    ['lstart 不是字符串', { pid: 4242, pgid: 4242, lstart: 1763600000 }],
    ['条目是 null', null],
    ['条目是数字', 7],
    ['条目是字符串', 'x'],
  ];
  for (const [name, entry] of BAD_SHAPES) {
    it(`形状不对：${name} → 连 probe 都不调，不 kill，计入 dropped`, T, () => {
      const ctx = setup();
      ctx.t.write([entry]);
      ctx.world.addProc(4242).addProc(99_999).addProc(1);
      const { r } = reap(ctx);
      assert.deepEqual(r, { killed: 0, dropped: 1, unreadable: false });
      assert.equal(ctx.world.execCalls.length, 0, 'ps 一次都不该问');
      assert.deepEqual(ctx.world.killCalls, []);
    });
  }

  it('pid 在本进程内存表里 → 不探测、不 kill，写回后仍在文件里', T, () => {
    const ctx = setup();
    ctx.world.addProc(4242);
    assert.equal(ctx.reg.add(4242), true);
    assert.equal(ctx.reg.has(4242), true);
    const queried = ctx.world.execCalls.length; // add 自己查过一次
    const { r } = reap(ctx);
    assert.deepEqual(r, { killed: 0, dropped: 0, unreadable: false });
    assert.equal(ctx.world.execCalls.length, queried, '清理时不该再探测自己的子进程');
    assert.deepEqual(ctx.world.killCalls, []);
    assert.deepEqual(ctx.t.read().entries.map((e) => e.pid), [4242], '写回后自己的记录仍在');
  });

  it('文件里既有自己的、也有上一代残留的 → 只清残留，自己的保留', T, () => {
    const ctx = setup();
    ctx.allowed = new Set([4242, 5151]);
    ctx.world.addProc(4242);
    ctx.reg.add(4242);
    ctx.world.addProc(5151); // 上一代留下的
    const stale = { pid: 5151, pgid: 5151, lstart: LSTART };
    ctx.t.write([...ctx.t.read().entries, stale]);
    const { r } = reap(ctx);
    assert.equal(r.killed, 1);
    assert.deepEqual(ctx.world.signals(), [[-5151, 'SIGTERM']]);
    assert.deepEqual(ctx.t.read().entries.map((e) => e.pid), [4242]);
  });

  it('两条都对 → 各自一次 SIGTERM，killed:2', T, () => {
    const ctx = setup();
    ctx.allowed = new Set([4242, 5151]);
    ctx.t.write([rec(4242), rec(5151)]);
    ctx.world.addProc(4242).addProc(5151);
    const { r } = reap(ctx);
    assert.equal(r.killed, 2);
    assert.deepEqual(sigs(ctx.world), ['-4242:SIGTERM', '-5151:SIGTERM']);
  });

  it('SIGTERM 抛 ESRCH（已经不在了）→ killed:0, dropped:1', T, () => {
    const ctx = setup({ world: { killThrows: ['SIGTERM'] } });
    ctx.t.write([rec(4242)]);
    ctx.world.addProc(4242);
    const { r } = reap(ctx);
    assert.deepEqual(r, { killed: 0, dropped: 1, unreadable: false });
  });

  it('只看前 200 条：多出的计入 dropped，也不探测', T, () => {
    const ctx = setup();
    ctx.allowed = (pid) => pid >= 5000 && pid < 5200;
    ctx.t.write(Array.from({ length: 250 }, (_, i) => rec(5000 + i)));
    const { r } = reap(ctx);
    assert.deepEqual(r, { killed: 0, dropped: 250, unreadable: false });
    assert.equal(ctx.world.execCalls.length, 200);
  });

  it('写回：处理完的记录从文件里清掉（version 1、entries 为空数组）', T, () => {
    const ctx = setup();
    ctx.t.write([rec(4242), rec(4243, { pgid: 1 })]);
    ctx.allowed = new Set([4242]);
    ctx.world.addProc(4242);
    reap(ctx);
    assert.deepEqual(ctx.t.read(), { version: 1, entries: [] });
    assert.deepEqual(ctx.t.leftovers(), []);
  });
});

// =============================================================================================
describe('U2 记录文件的各种状态', () => {
  it('文件不存在 → 全 0、无日志、不建文件、不查 ps', T, () => {
    const ctx = setup();
    const { r, out } = reap(ctx);
    assert.deepEqual(r, { killed: 0, dropped: 0, unreadable: false });
    assert.deepEqual(out, []);
    assert.deepEqual(ctx.regLog.lines, []);
    assert.equal(fs.existsSync(ctx.t.file), false);
    assert.equal(ctx.world.execCalls.length, 0);
  });

  const CORRUPT = [
    ['不是 JSON', '{not json'],
    ['空文件', ''],
    ['JSON null', 'null'],
    ['顶层是数组', '[]'],
    ['空对象', '{}'],
    ['version 是 2', '{"version":2,"entries":[]}'],
    ['version 缺失', '{"entries":[]}'],
    ['entries 是对象', '{"version":1,"entries":{}}'],
    ['entries 缺失', '{"version":1}'],
  ];
  for (const [name, text] of CORRUPT) {
    it(`损坏：${name} → unreadable:true、恰好一行损坏日志、文件字节不变、probe 零调用`, T, () => {
      const ctx = setup();
      ctx.t.writeRaw(text);
      ctx.world.addProc(4242);
      const before = ctx.t.readRaw();
      const { r, out } = reap(ctx);
      assert.deepEqual(r, { killed: 0, dropped: 0, unreadable: true });
      assert.deepEqual(out, ['[reaper] 子进程记录损坏，本次不清理']);
      assert.ok(ctx.t.readRaw().equals(before), '文件字节被改了');
      assert.equal(ctx.world.execCalls.length, 0);
      assert.deepEqual(ctx.world.killCalls, []);
    });
  }

  it('损坏的文件会在下一次 add 写盘时被整份覆盖', T, () => {
    const ctx = setup();
    ctx.t.writeRaw('{not json');
    reap(ctx);
    ctx.world.addProc(4242);
    assert.equal(ctx.reg.add(4242), true);
    assert.equal(ctx.t.read().version, 1);
    assert.deepEqual(ctx.t.read().entries.map((e) => e.pid), [4242]);
  });

  it('路径是目录 → 读错误那行（含错误码）、unreadable:true、不抛', T, () => {
    const ctx = setup();
    fs.mkdirSync(ctx.t.file);
    const { r, out } = reap(ctx);
    assert.deepEqual(r, { killed: 0, dropped: 0, unreadable: true });
    assert.equal(out.length, 1);
    assert.match(out[0], /^\[reaper\] 子进程记录读不出来（EISDIR），本次不清理$/);
    assert.equal(ctx.world.execCalls.length, 0);
    assert.equal(fs.statSync(ctx.t.file).isDirectory(), true, '目录不该被动');
  });

  it('权限 000 → 读错误那行、unreadable:true、不改文件（root 下跳过）', T, (tc) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) { tc.skip('root / Windows 下 chmod 000 不拦读'); return; }
    const ctx = setup();
    ctx.t.write([rec(4242)]);
    ctx.world.addProc(4242);
    fs.chmodSync(ctx.t.file, 0o000);
    const { r, out } = reap(ctx);
    fs.chmodSync(ctx.t.file, 0o600);
    assert.deepEqual(r, { killed: 0, dropped: 0, unreadable: true });
    assert.equal(out.length, 1);
    assert.match(out[0], /^\[reaper\] 子进程记录读不出来（EACCES），本次不清理$/);
    assert.equal(ctx.world.execCalls.length, 0);
    assert.deepEqual(ctx.t.read().entries.length, 1, '文件原样还在');
  });

  it('只有空数组 → 全 0、无日志、不改文件', T, () => {
    const ctx = setup();
    ctx.t.write([]);
    const before = ctx.t.readRaw();
    const { r, out } = reap(ctx);
    assert.deepEqual(r, { killed: 0, dropped: 0, unreadable: false });
    assert.deepEqual(out, []);
    assert.ok(ctx.t.readRaw().equals(before));
  });

  it('清理本身出意外异常（probe 抛错）→ 记「清理出错」一行、返回已有计数、不抛', T, () => {
    const ctx = setup({ reg: { probe: () => { throw new Error('boom'); } } });
    ctx.t.write([rec(4242)]);
    const out = logSink();
    const r = ctx.reg.reapPrevious({ log: out, kill: ctx.world.kill, sleepSync: ctx.world.sleepSync });
    assert.deepEqual(r, { killed: 0, dropped: 0, unreadable: false });
    assert.deepEqual(out.lines, ['[reaper] 清理出错，本次跳过']);
  });
});

// =============================================================================================
describe('U3 SIGTERM 之后的补刀', () => {
  it('组在 SIGTERM 后消失 → 无 SIGKILL，也不睡', T, () => {
    const ctx = setup();
    ctx.t.write([rec(4242)]);
    ctx.world.addProc(4242);
    reap(ctx);
    assert.deepEqual(sigs(ctx.world), ['-4242:SIGTERM']);
    assert.equal(ctx.world.slept, 0, '组一开始就没了，不该等');
  });

  it('组过了两个轮询才消失 → 仍无 SIGKILL', T, () => {
    const ctx = setup({ world: { ignoreTerm: true } });
    ctx.t.write([rec(4242)]);
    ctx.world.addProc(4242);
    ctx.world.onSleep = (slept, w) => { if (slept >= 200) { w.groups.delete(4242); w.procs.delete(4242); } };
    reap(ctx);
    assert.deepEqual(sigs(ctx.world), ['-4242:SIGTERM']);
    assert.deepEqual(ctx.world.sleeps, [100, 100]);
  });

  it('组一直在、领头进程复查指纹仍对 → 恰好一次 kill(-pid, SIGKILL)', T, () => {
    const ctx = setup({ world: { ignoreTerm: true } });
    ctx.t.write([rec(4242)]);
    ctx.world.addProc(4242);
    reap(ctx);
    assert.deepEqual(sigs(ctx.world), ['-4242:SIGTERM', '-4242:SIGKILL']);
    assert.equal(ctx.world.slept, 1000);
    assert.ok(ctx.world.queriedPids().length >= 2, 'SIGKILL 前要再查一次领头进程');
  });

  it('组在、但领头进程复查时 lstart 变了（pid 换了主人）→ 不 SIGKILL', T, () => {
    const ctx = setup({ world: { ignoreTerm: true } });
    ctx.t.write([rec(4242)]);
    ctx.world.addProc(4242);
    ctx.world.onKill = (target, sig, w) => { if (sig === 'SIGTERM') w.procs.get(4242).lstart = 'Sat Nov 21 03:55:28 2026'; };
    const { r } = reap(ctx);
    assert.equal(r.killed, 1, 'SIGTERM 已发出，计数不变');
    assert.deepEqual(sigs(ctx.world), ['-4242:SIGTERM']);
  });

  it('组在、但领头进程复查时形态不再对（命令变了）→ 不 SIGKILL', T, () => {
    const ctx = setup({ world: { ignoreTerm: true } });
    ctx.t.write([rec(4242)]);
    ctx.world.addProc(4242);
    ctx.world.onKill = (target, sig, w) => { if (sig === 'SIGTERM') w.procs.get(4242).command = '/usr/bin/vim notes.txt'; };
    reap(ctx);
    assert.deepEqual(sigs(ctx.world), ['-4242:SIGTERM']);
  });

  it('组在、但领头进程复查时 ppid 不是 1 → 不 SIGKILL', T, () => {
    const ctx = setup({ world: { ignoreTerm: true } });
    ctx.t.write([rec(4242)]);
    ctx.world.addProc(4242);
    ctx.world.onKill = (target, sig, w) => { if (sig === 'SIGTERM') w.procs.get(4242).ppid = 321; };
    reap(ctx);
    assert.deepEqual(sigs(ctx.world), ['-4242:SIGTERM']);
  });

  it('领头进程已不在、但组里还有成员 → SIGKILL（我们刚确认过的那一组）', T, () => {
    const ctx = setup({ world: { ignoreTerm: true } });
    ctx.t.write([rec(4242)]);
    ctx.world.addProc(4242);
    ctx.world.onKill = (target, sig, w) => { if (sig === 'SIGTERM') w.procs.delete(4242); }; // 领头先死，孙进程还在
    reap(ctx);
    assert.deepEqual(sigs(ctx.world), ['-4242:SIGTERM', '-4242:SIGKILL']);
  });

  it('sleepSync 累计不超过 escalateMs + pollMs', T, () => {
    for (const [escalateMs, pollMs] of [[1000, 100], [950, 100], [2000, 100], [0, 100], [300, 250], [100, 100]]) {
      const ctx = setup({ world: { ignoreTerm: true } });
      ctx.t.write([rec(4242)]);
      ctx.world.addProc(4242);
      reap(ctx, { escalateMs, pollMs });
      assert.ok(ctx.world.slept <= escalateMs + pollMs, `escalateMs=${escalateMs} pollMs=${pollMs} 睡了 ${ctx.world.slept}`);
      assert.deepEqual(sigs(ctx.world), ['-4242:SIGTERM', '-4242:SIGKILL'], `escalateMs=${escalateMs} pollMs=${pollMs}`);
    }
  });

  it('pollMs / escalateMs 给了 0、NaN、负数也会收敛，不会死循环', T, () => {
    for (const extra of [{ pollMs: 0 }, { pollMs: Number.NaN }, { pollMs: -5 }, { escalateMs: Number.NaN }, { escalateMs: -1 }, { escalateMs: undefined, pollMs: undefined }]) {
      const ctx = setup({ world: { ignoreTerm: true } });
      ctx.t.write([rec(4242)]);
      ctx.world.addProc(4242);
      reap(ctx, extra);
      assert.ok(ctx.world.slept <= 2100, `${JSON.stringify(extra)} 睡了 ${ctx.world.slept}`);
      assert.deepEqual(sigs(ctx.world), ['-4242:SIGTERM', '-4242:SIGKILL']);
    }
  });

  it('多个组：只对还在的补刀', T, () => {
    const ctx = setup({ world: { ignoreTerm: true } });
    ctx.allowed = new Set([4242, 5151]);
    ctx.t.write([rec(4242), rec(5151)]);
    ctx.world.addProc(4242).addProc(5151);
    ctx.world.onSleep = (slept, w) => { if (slept >= 300) { w.groups.delete(4242); w.procs.delete(4242); } }; // 4242 自己退了
    reap(ctx);
    assert.deepEqual(sigs(ctx.world), ['-4242:SIGTERM', '-5151:SIGTERM', '-5151:SIGKILL']);
  });
});

// =============================================================================================
describe('U4 日志只有个数', () => {
  it('有记录时恰好一行，格式固定，且不含 pid / lstart / 命令 / 会话 id', T, () => {
    const ctx = setup();
    ctx.allowed = new Set([4242, 5151]);
    const cmd = `/x/claude -p --output-format stream-json --verbose --resume ${SESSION_ID}`;
    ctx.t.write([rec(4242), rec(5151), { pid: 1, pgid: 1, lstart: LSTART }]);
    ctx.world.addProc(4242, { command: cmd }); // 5151 不在 → 只删记录；pid 1 形状不对
    const { r, out } = reap(ctx);
    assert.deepEqual(r, { killed: 1, dropped: 2, unreadable: false });
    assert.equal(out.length, 1);
    assert.match(out[0], /^\[reaper\] 上次运行留下的 claude 进程：已结束 \d+ 组；记录对不上、只删记录 \d+ 条$/);
    assert.equal(out[0], '[reaper] 上次运行留下的 claude 进程：已结束 1 组；记录对不上、只删记录 2 条');
    const all = [...out, ...ctx.regLog.lines].join('\n');
    for (const bad of ['4242', '5151', 'Nov 20', '03:55', 'stream-json', '--resume', SESSION_ID, 'oc_', 'ou_']) {
      assert.equal(all.includes(bad), false, `日志里不该出现 ${bad}`);
    }
  });

  it('文件里是空数组 → 无日志', T, () => {
    const ctx = setup();
    ctx.t.write([]);
    const { out } = reap(ctx);
    assert.deepEqual(out, []);
    assert.deepEqual(ctx.regLog.lines, []);
  });

  it('条目全被丢弃时也是同一格式的一行（已结束 0 组）', T, () => {
    const ctx = setup();
    ctx.t.write([rec(4242)]); // ps 里没有
    const { out } = reap(ctx);
    assert.deepEqual(out, ['[reaper] 上次运行留下的 claude 进程：已结束 0 组；记录对不上、只删记录 1 条']);
  });

  it('登记路径（add / remove）的日志同样不含 pid / lstart / 命令', T, () => {
    const ctx = setup();
    ctx.world.addProc(7777, { pgid: 1 }); // pgid ≠ pid → 不登记
    ctx.reg.add(7777);
    fs.mkdirSync(ctx.t.file); // 写盘必失败
    ctx.world.addProc(4242);
    ctx.reg.add(4242);
    ctx.reg.remove(4242);
    assert.equal(ctx.regLog.lines.length, 2);
    for (const l of ctx.regLog.lines) {
      assert.match(l, /^\[reaper\] /);
      for (const bad of ['7777', '4242', 'Nov 20', 'stream-json', '--resume']) assert.equal(l.includes(bad), false, l);
    }
  });
});

// =============================================================================================
describe('U5 登记', () => {
  const posix = process.platform !== 'win32';

  it('add 后：权限 0600、内容恰为 {version:1, entries:[{pid,pgid,lstart,spawnedAt}]}、无 .tmp 残留', T, () => {
    const ctx = setup();
    ctx.world.addProc(4242);
    assert.equal(ctx.reg.add(4242), true);
    if (posix) assert.equal(fs.statSync(ctx.t.file).mode & 0o777, 0o600);
    const data = ctx.t.read();
    assert.deepEqual(Object.keys(data).sort(), ['entries', 'version']);
    assert.equal(data.version, 1);
    assert.equal(data.entries.length, 1);
    assert.deepEqual(Object.keys(data.entries[0]).sort(), ['lstart', 'pgid', 'pid', 'spawnedAt']);
    assert.equal(data.entries[0].pid, 4242);
    assert.equal(data.entries[0].pgid, 4242);
    assert.equal(data.entries[0].lstart, LSTART);
    assert.equal(new Date(data.entries[0].spawnedAt).toISOString(), data.entries[0].spawnedAt, 'spawnedAt 应是 ISO 时间串');
    assert.deepEqual(ctx.t.leftovers(), []);
    assert.deepEqual(ctx.regLog.lines, []);
  });

  it('记录里不含命令行、会话键、chat id、会话 id', T, () => {
    const ctx = setup();
    ctx.world.addProc(4242, { command: `/x/claude -p --output-format stream-json --verbose --resume ${SESSION_ID} --chat oc_abc` });
    ctx.reg.add(4242);
    const text = ctx.t.readRaw().toString('utf8');
    for (const bad of ['stream-json', SESSION_ID, 'oc_abc', '--resume', '/x/claude']) assert.equal(text.includes(bad), false, bad);
  });

  it('remove 后 entries 为空；没登记过的 pid → false 且不写盘', T, () => {
    const ctx = setup();
    ctx.world.addProc(4242);
    ctx.reg.add(4242);
    assert.equal(ctx.reg.remove(5555), false);
    assert.equal(ctx.t.read().entries.length, 1, '删一个没登记过的 pid 不该动文件');
    assert.equal(ctx.reg.remove(4242), true);
    assert.deepEqual(ctx.t.read(), { version: 1, entries: [] });
    assert.equal(ctx.reg.has(4242), false);
    assert.deepEqual(ctx.t.leftovers(), []);
  });

  it('多个 pid：整份重写，顺序为登记顺序', T, () => {
    const ctx = setup();
    ctx.world.addProc(4242).addProc(4300).addProc(4400);
    ctx.reg.add(4242);
    ctx.reg.add(4300);
    ctx.reg.add(4400);
    ctx.reg.remove(4300);
    assert.deepEqual(ctx.t.read().entries.map((e) => e.pid), [4242, 4400]);
  });

  it('probe 返回 null → add 返回 false、文件不变、一行日志，第二次失败不再打', T, () => {
    const ctx = setup();
    ctx.t.write([]);
    const before = ctx.t.readRaw();
    assert.equal(ctx.reg.add(5555), false);
    assert.equal(ctx.reg.add(5556), false);
    assert.ok(ctx.t.readRaw().equals(before), '文件被动了');
    assert.deepEqual(ctx.regLog.lines, ['[reaper] 取不到子进程的进程组或启动时间，本轮不登记（只影响桥接异常退出后的残留清理）']);
    assert.equal(ctx.reg.has(5555), false);
  });

  it('probe 显示 pgid ≠ pid（没有自成进程组）→ 不登记', T, () => {
    const ctx = setup();
    ctx.world.addProc(4242, { pgid: 1 });
    assert.equal(ctx.reg.add(4242), false);
    assert.equal(fs.existsSync(ctx.t.file), false);
    assert.equal(ctx.regLog.lines.length, 1);
  });

  it('pid 不是 >1 的安全整数 → add 返回 false（不问 ps）', T, () => {
    const ctx = setup();
    for (const bad of [undefined, null, 0, 1, -3, 2.5, '4242', Number.NaN]) assert.equal(ctx.reg.add(bad), false);
    assert.equal(ctx.world.execCalls.length, 0);
  });

  it('文件路径是目录 → add / remove 不抛，多次写失败合计只一行日志，没有 .tmp 残留', T, () => {
    const ctx = setup();
    fs.mkdirSync(ctx.t.file);
    ctx.world.addProc(4242).addProc(4300);
    assert.doesNotThrow(() => {
      ctx.reg.add(4242);
      ctx.reg.add(4300);
      ctx.reg.remove(4242);
      ctx.reg.remove(4300);
    });
    const failures = ctx.regLog.lines.filter((l) => l.includes('写不进去'));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^\[reaper\] 子进程记录写不进去（\w+），只影响桥接异常退出后的残留清理$/);
    assert.deepEqual(ctx.t.leftovers(), []);
  });

  it('probe 抛错 / 日志函数抛错 → add 也不抛', T, () => {
    const a = setup({ reg: { probe: () => { throw new Error('boom'); } } });
    assert.doesNotThrow(() => assert.equal(a.reg.add(4242), false));
    const b = setup({ reg: { log: () => { throw new Error('log boom'); } } });
    assert.doesNotThrow(() => assert.equal(b.reg.add(5555), false));
    assert.doesNotThrow(() => b.reg.remove(5555));
  });

  it("platform:'win32' → add / remove 无操作返回 false、不建文件；reapPrevious 不读文件、返回全 0", T, () => {
    const ctx = setup({ reg: { platform: 'win32' } });
    ctx.world.addProc(4242);
    assert.equal(ctx.reg.add(4242), false);
    assert.equal(ctx.reg.remove(4242), false);
    assert.equal(fs.existsSync(ctx.t.file), false);
    ctx.t.writeRaw('{not json'); // 若读了，会打「损坏」日志
    const before = ctx.t.readRaw();
    const { r, out } = reap(ctx);
    assert.deepEqual(r, { killed: 0, dropped: 0, unreadable: false });
    assert.deepEqual(out, []);
    assert.deepEqual(ctx.regLog.lines, []);
    assert.ok(ctx.t.readRaw().equals(before));
    assert.equal(ctx.world.execCalls.length, 0);
  });

  it("没有 ps（psBin:''）→ 登记与清理停用，只记一次日志，不建文件、不读文件", T, () => {
    const ctx = setup({ reg: { psBin: '' } });
    ctx.t.writeRaw('{not json');
    assert.equal(ctx.reg.add(4242), false);
    assert.equal(ctx.reg.add(4300), false);
    assert.equal(ctx.reg.remove(4242), false);
    const { r, out } = reap(ctx);
    assert.deepEqual(r, { killed: 0, dropped: 0, unreadable: false });
    assert.deepEqual(out, []);
    assert.deepEqual(ctx.regLog.lines, ['[reaper] 找不到 ps 命令，不登记、也不清理上一代残留的 claude 进程']);
    assert.equal(ctx.world.execCalls.length, 0);
  });
});

// =============================================================================================
describe('U6 probeProcess', () => {
  const calls = [];
  const okExec = (out) => (bin, args, opts) => { calls.push({ bin, args, opts }); return out; };

  it('正常输出（行尾有空格、命令里含 \\012）解析正确', T, () => {
    const line = '    1  4242 Fri Nov 20 03:55:28 2026 /x/claude -p --output-format stream-json --verbose --append-system-prompt a\\012b  c \n';
    const p = probeProcess(4242, { exec: okExec(line), psBin: '/bin/ps' });
    assert.deepEqual(p, {
      ppid: 1, pgid: 4242, lstart: 'Fri Nov 20 03:55:28 2026',
      command: '/x/claude -p --output-format stream-json --verbose --append-system-prompt a\\012b c',
    });
  });

  it('日 < 10 时 lstart 中间两个空格 → 归一成单个空格', T, () => {
    const p = probeProcess(4242, { exec: okExec('  1 4242 Mon Nov  3 03:55:28 2026 cmd arg \n'), psBin: '/bin/ps' });
    assert.equal(p.lstart, 'Mon Nov 3 03:55:28 2026');
    assert.equal(p.command, 'cmd arg');
  });

  it('exec 抛错（含退出码 1、超时、起不来）→ null', T, () => {
    for (const err of [Object.assign(new Error('exit 1'), { status: 1 }), Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }), Object.assign(new Error('ENOENT'), { code: 'ENOENT' })]) {
      assert.equal(probeProcess(4242, { exec: () => { throw err; }, psBin: '/bin/ps' }), null);
    }
  });

  it('空输出 / 只有空白 / 两行 → null', T, () => {
    for (const out of ['', '   \n', '\n\n', undefined, null,
      '  1 4242 Fri Nov 20 03:55:28 2026 a\n  1 4243 Fri Nov 20 03:55:28 2026 b\n']) {
      assert.equal(probeProcess(4242, { exec: () => out, psBin: '/bin/ps' }), null, JSON.stringify(out));
    }
  });

  it('lstart 词形不对 / 缺命令 / 数字不对 → null', T, () => {
    const bad = [
      '1 4242 Fri Nov 20x 03:55:28 2026 cmd', // 日
      '1 4242 Fri Nov 20 3:55 2026 cmd', // 时间
      '1 4242 Fri Nov 20 03:55:28 26 cmd', // 年
      '1 4242 Fri Nov 20 03:55:28 2026', // 没有命令
      'x 4242 Fri Nov 20 03:55:28 2026 cmd', // ppid 不是数字
      '1 4242x Fri Nov 20 03:55:28 2026 cmd', // pgid 不是数字
      '1 0 Fri Nov 20 03:55:28 2026 cmd', // pgid 为 0
      '0 4242 Fri Nov 20 03:55:28 2026 cmd', // ppid 为 0
      '-1 4242 Fri Nov 20 03:55:28 2026 cmd', // 负数
      '1 4242 Fri Nov 20 2026 cmd', // 词数不够
    ];
    for (const line of bad) assert.equal(probeProcess(4242, { exec: () => `${line}\n`, psBin: '/bin/ps' }), null, line);
  });

  it('每次调用的参数恰为固定列表，env 恰为 {LC_ALL:C, TZ:UTC}', T, () => {
    calls.length = 0;
    probeProcess(4242, { exec: okExec('1 4242 Fri Nov 20 03:55:28 2026 cmd\n'), psBin: '/bin/ps' });
    probeProcess('777', { exec: okExec('1 777 Fri Nov 20 03:55:28 2026 cmd\n'), psBin: '/bin/ps' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ['-ww', '-o', 'ppid=,pgid=,lstart=,command=', '-p', '4242']);
    assert.deepEqual(calls[1].args, ['-ww', '-o', 'ppid=,pgid=,lstart=,command=', '-p', '777']);
    for (const c of calls) {
      assert.equal(c.bin, '/bin/ps');
      assert.deepEqual(c.opts.env, { LC_ALL: 'C', TZ: 'UTC' });
      assert.equal(c.opts.encoding, 'utf8');
      assert.equal(c.opts.timeout, 2000);
      assert.deepEqual(c.opts.stdio, ['ignore', 'pipe', 'ignore']);
    }
  });

  it('psBin 为空串（没有 ps）→ null，不调 exec', T, () => {
    let n = 0;
    assert.equal(probeProcess(4242, { exec: () => { n += 1; return ''; }, psBin: '' }), null);
    assert.equal(n, 0);
  });

  it('不传 psBin：用 /bin/ps 或 /usr/bin/ps（谁存在用谁），都没有就不调 exec', T, () => {
    const seen = [];
    probeProcess(4242, { exec: (bin) => { seen.push(bin); return ''; } });
    const have = ['/bin/ps', '/usr/bin/ps'].find((p) => fs.existsSync(p));
    if (have) assert.deepEqual(seen, [have]);
    else assert.deepEqual(seen, []);
  });

  it('真 ps、真进程：查自己得到自己的 pid 对应的行（ppid 是本进程的父进程）', T, (tc) => {
    if (!fs.existsSync('/bin/ps') && !fs.existsSync('/usr/bin/ps')) { tc.skip('没有 ps'); return; }
    const p = probeProcess(process.pid);
    assert.ok(p, '查自己应当有结果');
    assert.equal(p.ppid, process.ppid);
    assert.match(p.lstart, /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}$/);
    assert.ok(p.command.length > 0);
  });
});

// =============================================================================================
describe('U7 deferUntilAwake / orphanNoticeText', () => {
  const fakeTimers = () => {
    const st = { fn: null, ms: null, stops: [], unrefs: 0 };
    const timer = { unref() { st.unrefs += 1; } };
    st.every = (fn, ms) => { st.fn = fn; st.ms = ms; return timer; };
    st.stop = (t) => { st.stops.push(t); };
    st.timer = timer;
    return st;
  };

  it('不在免打扰 → send 一次，没有日志、没有定时器', T, () => {
    const tm = fakeTimers();
    const log = logSink();
    let sent = 0;
    deferUntilAwake({ send: () => { sent += 1; }, isQuiet: () => false, every: tm.every, stop: tm.stop, log });
    assert.equal(sent, 1);
    assert.deepEqual(log.lines, []);
    assert.equal(tm.fn, null);
  });

  it('在免打扰 → 一行延后日志、不发；定时回调仍免打扰时不发，转为非免打扰时发一次并 stop', T, () => {
    const tm = fakeTimers();
    const log = logSink();
    let sent = 0;
    let quiet = true;
    deferUntilAwake({ send: () => { sent += 1; }, isQuiet: () => quiet, every: tm.every, stop: tm.stop, log });
    assert.equal(sent, 0);
    assert.deepEqual(log.lines, ['[reaper] 免打扰时段，中断通知延后到时段结束']);
    assert.equal(tm.ms, 60_000, '默认每分钟查一次');
    assert.equal(tm.unrefs, 1, '定时器要 unref，不拖住进程退出');
    tm.fn();
    tm.fn();
    assert.equal(sent, 0);
    assert.deepEqual(tm.stops, []);
    quiet = false;
    tm.fn();
    assert.equal(sent, 1);
    assert.deepEqual(tm.stops, [tm.timer]);
    tm.fn();
    assert.equal(sent, 1, '发过一次就不再发');
    assert.deepEqual(log.lines, ['[reaper] 免打扰时段，中断通知延后到时段结束']);
  });

  it('recheckMs 可调', T, () => {
    const tm = fakeTimers();
    deferUntilAwake({ send: () => {}, isQuiet: () => true, recheckMs: 1234, every: tm.every, stop: tm.stop, log: logSink() });
    assert.equal(tm.ms, 1234);
  });

  it('isQuiet 抛错 → 当作不在免打扰，立即发', T, () => {
    const tm = fakeTimers();
    let sent = 0;
    deferUntilAwake({ send: () => { sent += 1; }, isQuiet: () => { throw new Error('boom'); }, every: tm.every, stop: tm.stop, log: logSink() });
    assert.equal(sent, 1);
    assert.equal(tm.fn, null);
  });

  it('定时回调里 isQuiet 抛错 → 也发', T, () => {
    const tm = fakeTimers();
    let sent = 0;
    let n = 0;
    deferUntilAwake({
      send: () => { sent += 1; }, isQuiet: () => { n += 1; if (n > 1) throw new Error('boom'); return true; }, every: tm.every, stop: tm.stop, log: logSink(),
    });
    assert.equal(sent, 0);
    tm.fn();
    assert.equal(sent, 1);
  });

  it('send reject → 一行失败日志、不重试、无未处理的 rejection', T, async () => {
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const log = logSink();
      let sent = 0;
      deferUntilAwake({ send: () => { sent += 1; return Promise.reject(new Error('owner 未登记')); }, isQuiet: () => false, log });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(sent, 1);
      assert.deepEqual(log.lines, ['[reaper] 中断通知发送失败']);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('send 同步抛错 → 同样一行失败日志', T, () => {
    const log = logSink();
    deferUntilAwake({ send: () => { throw new Error('没有 owner'); }, isQuiet: () => false, log });
    assert.deepEqual(log.lines, ['[reaper] 中断通知发送失败']);
    assert.equal(log.lines.join('').includes('没有 owner'), false, '失败日志不带错误详情');
  });

  it('延后后再发，发送失败也是一行失败日志', T, async () => {
    const tm = fakeTimers();
    const log = logSink();
    deferUntilAwake({ send: () => Promise.reject(new Error('x')), isQuiet: () => false, every: tm.every, stop: tm.stop, log });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(log.lines, ['[reaper] 中断通知发送失败']);
  });

  it('orphanNoticeText(3)：固定文案，不含 chat id / open id', T, () => {
    const s = orphanNoticeText(3);
    assert.ok(s.includes('上次异常退出时有 3 个进行中的任务被中断'));
    assert.equal(s, '⚠️ 上次异常退出时有 3 个进行中的任务被中断（已清理）。如果当时在等回复，请把那条消息再发一次。');
    assert.equal(s.includes('oc_'), false);
    assert.equal(s.includes('ou_'), false);
  });

  it('orphanNoticeText 只把数字写进去（非法输入当 0）', T, () => {
    assert.ok(orphanNoticeText(12).includes('有 12 个'));
    for (const bad of [-1, 1.5, '3', null, undefined, Number.NaN]) assert.ok(orphanNoticeText(bad).includes('有 0 个'), String(bad));
  });
});

// =============================================================================================
describe('登记簿的进程内约束', () => {
  it('CHILD_REGISTRY_FILE 的值', T, () => {
    assert.equal(CHILD_REGISTRY_FILE, 'claude-children.json');
  });

  it('childRegistryFor：同一路径同一个实例（路径解析后比较），不同路径不同实例', T, () => {
    const t = tmpRegistryDir('single');
    dirs.push(t);
    const a = childRegistryFor(t.file);
    assert.equal(childRegistryFor(path.join(t.dir, '.', 'claude-children.json')), a);
    assert.equal(childRegistryFor(path.join(t.dir, 'sub', '..', 'claude-children.json')), a);
    assert.notEqual(childRegistryFor(path.join(t.dir, 'other.json')), a);
    assert.equal(typeof a.add, 'function');
    assert.equal(typeof a.remove, 'function');
    assert.equal(typeof a.has, 'function');
    assert.equal(typeof a.reapPrevious, 'function');
  });

  it('带 ?query 重复 import 本模块，仍拿到同一个登记簿（挂在 globalThis 的 Symbol.for 键上）', T, async () => {
    const t = tmpRegistryDir('single2');
    dirs.push(t);
    const again = await import(`../src/child-registry.js?again=${Date.now()}`);
    assert.notEqual(again.childRegistryFor, childRegistryFor, '确实是另一份模块实例');
    assert.equal(again.childRegistryFor(t.file), childRegistryFor(t.file));
    const holder = globalThis[Symbol.for('feishu-claude-bridge.child-registry')];
    assert.ok(holder instanceof Map);
    assert.ok(holder.has(path.resolve(t.file)));
  });

  it('不新增任何 process.on 监听（claude-run 的测试按个数数 exit 监听器）', T, () => {
    const snap = () => Object.fromEntries(process.eventNames().map((n) => [String(n), process.listenerCount(n)]));
    const before = snap();
    const ctx = setup();
    ctx.world.addProc(4242);
    ctx.reg.add(4242);
    ctx.reg.remove(4242);
    ctx.t.write([rec(4242)]);
    ctx.world.addProc(4242);
    reap(ctx);
    const tm = { every: () => ({ unref() {} }), stop() {} };
    deferUntilAwake({ send: () => {}, isQuiet: () => true, ...tm, log: logSink() });
    childRegistryFor(ctx.t.file);
    assert.deepEqual(snap(), before);
  });

  it('源码约束：不读 process.env、不用 pgrep / pkill / killall、不枚举进程表、只引入 execFileSync', T, () => {
    const src = fs.readFileSync(new URL('../src/child-registry.js', import.meta.url), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.equal(/process\.env/.test(code), false, '本文件不读环境变量');
    assert.equal(/\b(pgrep|pkill|killall)\b/.test(code), false);
    assert.equal(/'-[Aaxe]'|'-ax'|'-ef'|'aux'/.test(code), false, '不枚举进程表');
    const imports = code.match(/import\s*\{[^}]*\}\s*from\s*'node:child_process'/g) ?? [];
    assert.equal(imports.length, 1);
    assert.match(imports[0], /\{\s*execFileSync\s*\}/);
    assert.equal(/\bprocess\.on\(|\bprocess\.once\(|\bprocess\.addListener\(/.test(code), false, '不新增 process 监听');
    assert.equal(/\bspawn\(|\bexecSync\(|\bexec\(/.test(code.replace(/exec\s*=\s*execFileSync/g, '').replace(/exec\(bin/g, '')), false);
  });
});
