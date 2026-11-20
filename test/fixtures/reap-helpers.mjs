// BRIDGE-RUN-2 测试公共件：
//   1) 单元测试用的「假进程世界」（makeWorld）：把 ps / kill / sleep 都做在注入点上，不起任何真进程；
//      ps 这一层是假的 exec，所以每个用例顺带证明了「只出现过 -p <登记过的 pid>」，没有枚举进程表。
//   2) 真进程测试用的辅助（spawnOrphan / waitPpid1 / startReapDriver / psRow / …），只收自己起的进程。
// 全部用临时目录，不碰线上 data/ 与 workspace/，不调真实 claude CLI，不联网。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeProcess } from '../../src/child-registry.js';
import { FAKE_SRC, alive, sleep, waitFor, readPid, childProcessEnv } from './run-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REAP_DRIVER = path.join(HERE, 'reap-driver.mjs');

// ---------------------------------------------------------------------------------------------
// 1) 假世界
// ---------------------------------------------------------------------------------------------

export const LSTART = 'Fri Nov 20 03:55:28 2026';
export const CLAUDE_CMD = '/x/claude -p --output-format stream-json --verbose --resume s';

const esrch = () => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });

/**
 * 假进程世界。procs：pid → { ppid, pgid, lstart, command }（ps 能看到的领头进程）；
 * groups：还有成员的进程组（kill(-pgid, 0) 能成功的）。
 * 默认行为：SIGTERM / SIGKILL 发给存在的组 → 整组消失；ignoreTerm 为真时 SIGTERM 不起作用。
 * 可以用 onKill(target, sig, world) 在每次发信号后改写世界（例如领头进程换了 lstart、领头先死而孙进程还在）。
 */
export function makeWorld({ ignoreTerm = false, killThrows = null } = {}) {
  const procs = new Map();
  const groups = new Set();
  const execCalls = [];
  const killCalls = [];
  const sleeps = [];
  let slept = 0;
  const world = {
    procs, groups, execCalls, killCalls, sleeps, ignoreTerm, onKill: null, onSleep: null,
    get slept() { return slept; },
    /** 加一个领头进程（默认同时有一个同名进程组） */
    addProc(pid, row = {}, { group = true } = {}) {
      procs.set(pid, { ppid: 1, pgid: pid, lstart: LSTART, command: CLAUDE_CMD, ...row });
      if (group) groups.add(row.pgid ?? pid);
      return world;
    },
    /** 假 ps：恰好是 execFileSync(bin, args, opts) 的形状；进程不在 → 抛错（退出码 1） */
    exec(bin, args, opts) {
      execCalls.push({ bin, args: [...args], opts });
      const pid = Number(args[args.length - 1]);
      const row = procs.get(pid);
      if (!row) throw Object.assign(new Error('ps: exit 1'), { status: 1 });
      return `${String(row.ppid).padStart(5)} ${String(row.pgid).padStart(5)} ${row.lstart} ${row.command} \n`;
    },
    /** 真 probeProcess 套在假 exec 上：与线上同一份解析代码 */
    probe: (pid) => probeProcess(pid, { exec: (...a) => world.exec(...a), psBin: '/bin/ps' }),
    kill(target, sig) {
      killCalls.push([target, sig]);
      if (!(typeof target === 'number' && target < 0)) throw new Error(`只应该给进程组发信号，收到 ${target}`);
      const pg = -target;
      if (killThrows && sig !== 0 && killThrows.includes(sig)) throw esrch();
      if (!groups.has(pg)) throw esrch();
      if (sig !== 0) {
        const dies = sig === 'SIGKILL' || (sig === 'SIGTERM' && !world.ignoreTerm);
        if (dies) {
          groups.delete(pg);
          for (const [pid, row] of [...procs]) if (row.pgid === pg) procs.delete(pid);
        }
      }
      world.onKill?.(target, sig, world);
      return true;
    },
    sleepSync(ms) {
      sleeps.push(ms);
      slept += ms;
      world.onSleep?.(slept, world);
    },
    /** 只看发出去的真信号（不含 kill(-pg, 0) 探活） */
    signals: () => killCalls.filter(([, s]) => s !== 0),
    /** exec 调用里每次查的 pid（只允许 `-p <pid>` 这一种形状） */
    queriedPids: () => execCalls.map((c) => Number(c.args[c.args.length - 1])),
  };
  return world;
}

/** 单元测试用的临时目录 + 记录文件 */
export function tmpRegistryDir(prefix = 'reg') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bridge-run2-${prefix}-`));
  const file = path.join(dir, 'claude-children.json');
  return {
    dir, file,
    write: (entries, extra = {}) => fs.writeFileSync(file, JSON.stringify({ version: 1, entries, ...extra })),
    writeRaw: (text) => fs.writeFileSync(file, text),
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    readRaw: () => fs.readFileSync(file),
    leftovers: () => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    cleanup: () => { try { fs.chmodSync(file, 0o600); } catch { /* 没有也行 */ } fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** 收集日志行 */
export function logSink() {
  const lines = [];
  const fn = (...a) => { lines.push(a.map(String).join(' ')); };
  fn.lines = lines;
  return fn;
}

export const rec = (pid = 4242, extra = {}) => ({ pid, pgid: pid, lstart: LSTART, ...extra });

// ---------------------------------------------------------------------------------------------
// 2) 真进程辅助
// ---------------------------------------------------------------------------------------------

export const IS_WIN = process.platform === 'win32';

const MARK_ARGS = ['-p', '--output-format', 'stream-json', '--verbose'];

/** 取一个进程的 ps 信息（测试自己查；只查传进来的单个 pid）。进程不在 → null */
export function psRow(pid) {
  return probeProcess(pid, { psBin: '/bin/ps' });
}

/** 进程组还有成员吗 */
export function groupAliveReal(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * 起一个孤儿：中间 node 进程以 detached:true、stdio:'ignore' 起 `node <fake-claude-run.mjs> …args` 后立刻退出，
 * 孤儿被 1 号进程收养。返回孤儿 pid，并写进沙箱 pids/ 便于 reapAll 收尸。
 * 孤儿命令行：`--gc 30` 模式 + 尾随 `-p --output-format stream-json --verbose` = 带形态标记；只给 `--gc 30` = 不带。
 */
export async function spawnOrphan(sb, args, name = 'orphan') {
  const pidfile = path.join(sb.pidDir, `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    'const [exe, file, pidfile, ...rest] = process.argv.slice(1);',
    "const c = spawn(exe, [file, ...rest], { detached: true, stdio: 'ignore' });",
    'fs.writeFileSync(pidfile, String(c.pid));',
    'c.unref();',
  ].join('\n');
  const mid = spawn(process.execPath, ['-e', script, process.execPath, FAKE_SRC, pidfile, ...args], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { mid.on('exit', resolve); mid.on('error', reject); });
  const pid = await waitFor(() => readPid(pidfile), 5000, '孤儿 pid');
  return pid;
}

/** 带形态标记的孤儿参数 / 不带标记的孤儿参数 */
export const MARKED_ARGS = ['--gc', '30', ...MARK_ARGS];
export const UNMARKED_ARGS = ['--gc', '30'];

/** 轮询 ps 至多 ms 毫秒，等 pid 的父进程变成 1；返回是否等到 */
export async function waitPpid1(pid, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    let ppid = null;
    try { ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return false; }
    if (ppid === 1) return true;
    if (Date.now() > end) return false;
    await sleep(25);
  }
}

/**
 * 起一个 reap-driver（独立 node 进程，真实 claude.js，沙箱环境），等到它打出 READY。
 * 返回 { child, ready: {driverPid, childPid, grandchildPid}, kill9(), term(), exited }。
 * plan 里默认挂住 20 秒、带同组孙进程（孙进程 pid 经 pidfile 取得）。
 */
export async function startReapDriver(sb, { ignoreTerm = false, extraEnv = {}, timeoutMs = 15_000 } = {}) {
  const env = childProcessEnv(sb, { CLAUDE_MAX_RETRIES: '0', ...extraEnv });
  env.REAP_IGNORE_TERM = ignoreTerm ? '1' : '';
  const child = spawn(process.execPath, [REAP_DRIVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  let ready = null;
  try {
    ready = await waitFor(() => {
      const line = out.split('\n').find((l) => l.startsWith('READY '));
      return line ? JSON.parse(line.slice('READY '.length)) : null;
    }, timeoutMs, 'reap-driver READY');
  } catch (e) {
    try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
    throw new Error(`${e.message}\n--- driver stdout ---\n${out.slice(-1500)}\n--- driver stderr ---\n${err.slice(-1500)}`);
  }
  return {
    child, ready, exited,
    out: () => out,
    err: () => err,
    kill9() { try { child.kill('SIGKILL'); } catch { /* 已经没了 */ } },
    term() { try { child.kill('SIGTERM'); } catch { /* 已经没了 */ } },
  };
}

/** 本沙箱 data 目录里的记录文件 */
export const registryFileOf = (sb) => path.join(sb.data, 'claude-children.json');

export function readRegistry(sb) {
  try { return JSON.parse(fs.readFileSync(registryFileOf(sb), 'utf8')); } catch { return null; }
}

/** 收尸：只杀传进来的 pid（调用方记录的）且命令行带 fake-claude-run.mjs / 本沙箱目录名的进程 */
export function killRecorded(pids, sb) {
  const tag = path.basename(sb.root);
  for (const pid of pids) {
    if (!(pid > 1) || !alive(pid)) continue;
    let cmd = '';
    try { cmd = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { continue; }
    if (cmd.includes('fake-claude-run.mjs') || cmd.includes(tag) || cmd.includes('reap-driver.mjs')) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ }
    }
  }
}
