// BRIDGE-RUN-1 测试公共件：隔离目录、假 claude CLI（FAKE_PLAN 计划文件）、进程探测、日志截取。
// 全部用临时目录，不碰线上 data/ 与 workspace/，不调真实 claude CLI，不联网。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_SRC = path.join(HERE, 'fake-claude-run.mjs');
export const CLAUDE_URL = new URL('../../src/claude.js', import.meta.url).href;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 一套隔离目录 + sh 包装的假 CLI（不依赖仓库里文件的可执行位） */
export function makeSandbox(prefix = 'run') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bridge-${prefix}-`));
  const dir = (n) => {
    const p = path.join(root, n);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  const sb = {
    root, ws: dir('ws'), guest: dir('guest'), data: dir('data'), home: dir('home'), tmp: dir('tmp'), pidDir: dir('pids'),
    bin: path.join(root, 'claude'), planFile: path.join(root, 'plan.json'), logFile: path.join(root, 'spawns.log'),
  };
  fs.writeFileSync(sb.bin, `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(FAKE_SRC)} "$@"\n`, { mode: 0o755 });
  /** 设计划（每次启动取走一条，只剩一条时一直用）并清空启动日志 */
  sb.plan = (...plans) => {
    fs.writeFileSync(sb.planFile, JSON.stringify(plans));
    fs.writeFileSync(sb.logFile, '');
  };
  /** 假 CLI 每次启动写一行：{ pid, resume, envKeys } */
  sb.spawns = () => {
    try { return fs.readFileSync(sb.logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  sb.sessions = () => {
    try { return JSON.parse(fs.readFileSync(path.join(sb.data, 'sessions.json'), 'utf8')); } catch { return {}; }
  };
  sb.seedSessions = (obj) => fs.writeFileSync(path.join(sb.data, 'sessions.json'), JSON.stringify(obj));
  sb.pidfile = (name) => path.join(sb.pidDir, name);
  sb.cleanup = () => {
    reapAll(sb);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  };
  return sb;
}

/** 隔离环境。值为 undefined 表示删掉该变量。claude.js 的阈值类配置在 import 时读取，每个变体都要重新 import。 */
export function sandboxEnv(sb, extra = {}) {
  return {
    HOME: sb.home, TMPDIR: sb.tmp, WORKSPACE_DIR: sb.ws, GUEST_WORKSPACE_DIR: sb.guest, DATA_DIR: sb.data,
    CLAUDE_BIN: sb.bin, FAKE_PLAN: sb.planFile, FAKE_LOG: sb.logFile,
    FAKE_ANCHOR_PID: String(process.pid), // 夹具进程盯着测试文件进程：它没了（被中断 / 被杀）夹具进程就自己退出
    FEISHU_TOOLS: 'false', BMS_TOOL_ENABLED: '', CLAUDE_FALLBACK_BIN: '', OWNER_NAME: '', OWNER_STRICT_DENY_WRITE_DIRS: '',
    DAILY_SESSION: '', OWNER_TOOL_PROFILE: '', ALLOWED_TOOLS: undefined, NON_OWNER_TOOLS: undefined, LARK_CLI: undefined,
    CLAUDE_MAX_RETRIES: '2', CLAUDE_IDLE_TIMEOUT_MS: undefined, CLAUDE_TIMEOUT_MS: undefined, CLAUDE_RESULT_GRACE_MS: undefined,
    ...extra,
  };
}

export function applyEnv(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
}

let seq = 0;
/** 设好隔离环境后重新 import 一份 claude.js（同一进程里可有多份实例，各读各的阈值） */
export async function loadClaude(sb, env = {}) {
  applyEnv(sandboxEnv(sb, env));
  const orig = console.error;
  console.error = () => {};
  try { return await import(`${CLAUDE_URL}?run=${++seq}`); } finally { console.error = orig; }
}

/** 截取 console.log / error / warn；restore() 还原 */
export function captureConsole() {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const push = (...a) => { lines.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')); };
  console.log = push;
  console.error = push;
  console.warn = push;
  return { lines, restore() { Object.assign(console, orig); } };
}

/** 限时等待：到点还没落定就抛错，测试不会无限挂住 */
export function within(p, ms, label = '') {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`超过 ${ms}ms 仍未落定${label ? `：${label}` : ''}`)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

export const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 进程还活着吗（僵尸＝已死，只差收尸，不算活） */
export function alive(pid) {
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  try { return !/^Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { return false; }
}

/** 进程所在的进程组 id（ps 查；查不到返回 null） */
export function pgidOf(pid) {
  try {
    const n = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    return n > 0 ? n : null;
  } catch { return null; }
}

/** 给驱动脚本（独立 node 进程）用的完整环境：当前进程环境叠加沙箱环境（undefined 表示删掉） */
export function childProcessEnv(sb, extra = {}) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(sandboxEnv(sb, extra))) {
    if (v === undefined) delete env[k];
    else env[k] = String(v);
  }
  delete env.NODE_TEST_CONTEXT; // 别让驱动脚本以为自己是 node --test 的子进程
  return env;
}

/**
 * 跑一个驱动脚本，最多 ms 毫秒；超时只杀自己起的这一个 pid。
 * 返回 { code, signal, out, err, result }，result 是最后一行 `DRIVER_RESULT {json}` 解析出来的对象。
 */
export function runDriver(file, env, ms = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      reject(new Error(`驱动脚本超过 ${ms}ms 未结束`));
    }, ms);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const line = out.split('\n').reverse().find((l) => l.startsWith('DRIVER_RESULT '));
      resolve({ code, signal, out, err, result: line ? JSON.parse(line.slice('DRIVER_RESULT '.length)) : null });
    });
  });
}

/** 轮询到所有 pid 都没了；返回仍活着的 pid 列表（空＝都没了） */
export async function waitGone(pids, ms = 4000) {
  const end = Date.now() + ms;
  let left = pids.filter(alive);
  while (left.length && Date.now() < end) {
    await sleep(50);
    left = left.filter(alive);
  }
  return left;
}

export async function waitFor(fn, ms = 5000, label = '') {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`等待超时${label ? `：${label}` : ''}`);
    await sleep(25);
  }
}

export const readPid = (file) => {
  try { const n = Number(fs.readFileSync(file, 'utf8').trim()); return n > 1 ? n : null; } catch { return null; }
};

const isFixtureProc = (pid) => {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes('fake-claude-run.mjs'); } catch { return false; }
};

/** 收尸：只杀命令行里带 fake-claude-run.mjs 的、本沙箱记录过的进程（防止 pid 复用后误杀别人） */
export function reapAll(sb) {
  const pids = new Set(sb.spawns().map((s) => s.pid));
  try {
    for (const f of fs.readdirSync(sb.pidDir)) {
      const n = readPid(path.join(sb.pidDir, f));
      if (n) pids.add(n);
    }
  } catch { /* 没有也行 */ }
  for (const pid of pids) {
    if (pid > 1 && alive(pid) && isFixtureProc(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ }
    }
  }
}
