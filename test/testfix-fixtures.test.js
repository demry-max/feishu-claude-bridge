// BRIDGE-TESTFIX-1：测试夹具的「锚点」与 EPIPE / pid 文件顺序（真进程、临时目录、不联网）。
//
// 锚点 = 测试文件进程（FAKE_ANCHOR_PID，由 run-helpers 的 sandboxEnv 设）：夹具进程（假 CLI 领头、--gc 孙进程、reap-driver）
// 每 500 毫秒探一次它，只在锚点不存在（ESRCH）时自己退出——测试被中断 / 被杀后不留进程。
// 收尸只收本用例起的 pid，且命令行带 fake-claude-run.mjs 才发信号（见 run-helpers 的 reapAll）。
// Windows 没有这套进程语义：整个文件跳过。
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import {
  makeSandbox, sandboxEnv, applyEnv, sleep, waitGone, waitFor, readPid, alive, FAKE_SRC,
} from './fixtures/run-helpers.mjs';
import { IS_WIN, MARKED_ARGS, spawnOrphan, waitPpid1 } from './fixtures/reap-helpers.mjs';

const SB = makeSandbox('testfix');
applyEnv(sandboxEnv(SB)); // 本进程环境里有 FAKE_ANCHOR_PID = 本进程 pid（spawnOrphan 的孤儿继承它）
after(() => SB.cleanup());

const isFake = (cmd) => cmd.includes('fake-claude-run.mjs');

/** 直接起假 CLI（不经 claude.js）。env 在本进程环境上叠加，undefined 表示删掉。 */
function startFake(sb, plan, { env = {}, stdio = ['ignore', 'ignore', 'ignore'], detached = false } = {}) {
  sb.plan(plan);
  const e = { ...process.env, FAKE_PLAN: sb.planFile, FAKE_LOG: sb.logFile };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete e[k];
    else e[k] = String(v);
  }
  return spawn(process.execPath, [FAKE_SRC], { env: e, stdio, detached });
}

const killIfFake = async (pid) => {
  if (!(pid > 1) || !alive(pid)) return;
  try {
    if (isFake(execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }))) process.kill(pid, 'SIGKILL');
  } catch { /* 已经没了 */ }
};

describe('TESTFIX-1 夹具', { skip: IS_WIN ? 'Windows 没有进程组 / ps 语义' : false }, () => {
  test('X1 锚点没了：假 CLI 领头与它的孙进程都自己退出', { timeout: 30_000 }, async () => {
    const sb = makeSandbox('testfix-x1');
    const anchor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    const pidfile = sb.pidfile('x1-gc');
    let leader = null;
    try {
      leader = startFake(sb, { events: [], hang: true, hangMs: 20_000, grandchild: { sec: 20, stdio: 'ignore', pidfile } },
        { env: { FAKE_ANCHOR_PID: anchor.pid }, detached: true });
      const gcPid = await waitFor(() => readPid(pidfile), 8000, '孙进程 pid');
      assert.ok(alive(leader.pid) && alive(gcPid), '锚点还在时它们都活着');
      await sleep(1200); // 两个检查周期以上，锚点活着就不该退
      assert.ok(alive(leader.pid) && alive(gcPid), '锚点活着：1.2 秒后仍活着');
      anchor.kill('SIGKILL');
      assert.deepEqual(await waitGone([leader.pid, gcPid], 3000), [], '锚点没了之后领头与孙进程都退出');
    } finally {
      try { anchor.kill('SIGKILL'); } catch { /* 已经没了 */ }
      if (leader) await killIfFake(leader.pid);
      sb.cleanup();
    }
  });

  test('X2 锚点活着：被遗弃的 --gc 孤儿照样活着（B3/B4/B6 的前提不变）', { timeout: 30_000 }, async (t) => {
    assert.equal(process.env.FAKE_ANCHOR_PID, String(process.pid), '本文件环境里的锚点就是本进程');
    const orphan = await spawnOrphan(SB, MARKED_ARGS, 'x2');
    if (!(await waitPpid1(orphan, 3000))) { t.skip('孤儿 3 秒内没有被 1 号进程收养（环境可能有 subreaper）'); return; }
    await sleep(1500); // 三个检查周期
    assert.ok(alive(orphan), '父进程没了、锚点还在：孤儿不该退');
  });

  test('X3 没有 FAKE_ANCHOR_PID：行为与改前一致（--gc 孤儿按自己的秒数退出）', { timeout: 30_000 }, async () => {
    const saved = process.env.FAKE_ANCHOR_PID;
    delete process.env.FAKE_ANCHOR_PID;
    let orphan;
    try {
      orphan = await spawnOrphan(SB, ['--gc', '2'], 'x3');
    } finally {
      process.env.FAKE_ANCHOR_PID = saved;
    }
    await sleep(1500);
    assert.ok(alive(orphan), '1.5 秒时仍活着');
    assert.deepEqual(await waitGone([orphan], 4000), [], '约 2 秒后按自己的秒数退出');
  });

  test('X4 忽略 SIGTERM 的假 CLI 不会因为读端没了（EPIPE）而退出', { timeout: 30_000 }, async () => {
    const sb = makeSandbox('testfix-x4');
    let child = null;
    try {
      child = startFake(sb, { ignoreTerm: true, hang: true, hangMs: 20_000, lateMs: 300, lateEvents: [{ raw: 'x' }] },
        { stdio: ['ignore', 'pipe', 'ignore'] });
      await waitFor(() => sb.spawns().length, 8000, '假 CLI 启动');
      child.stdout.destroy(); // 读端没了：之后它写 stdout 会 EPIPE
      await sleep(1500);
      assert.ok(alive(child.pid), '晚到的事件行写不出去，也不该让它退出');
    } finally {
      if (child) await killIfFake(child.pid);
      sb.cleanup();
    }
  });

  test('X5 孙进程 pid 文件出现时，事件行已经写出（先写事件、后写 pid 文件）', { timeout: 30_000 }, async () => {
    const sb = makeSandbox('testfix-x5');
    const out = path.join(sb.root, 'stdout.txt');
    const fd = fs.openSync(out, 'w');
    const pidfile = sb.pidfile('x5-gc');
    const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-x5' });
    let child = null;
    try {
      child = startFake(sb, {
        events: [{ type: 'system', subtype: 'init', session_id: 'sess-x5' }], hang: true, hangMs: 20_000,
        grandchild: { sec: 20, stdio: 'ignore', pidfile },
      }, { stdio: ['ignore', fd, 'ignore'] });
      const end = Date.now() + 8000;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!readPid(pidfile) && Date.now() < end) Atomics.wait(wait, 0, 0, 1); // 同步轮询：不给事件循环让出时间
      assert.ok(readPid(pidfile), 'pid 文件出现了');
      assert.ok(fs.readFileSync(out, 'utf8').split('\n').includes(initLine), 'pid 文件出现的那一刻，init 行已在 stdout 里');
    } finally {
      fs.closeSync(fd);
      if (child) await killIfFake(child.pid);
      sb.cleanup();
    }
  });
});
