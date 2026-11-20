// BRIDGE-RUN-2：桥接被强杀 / 崩溃后，下次启动时清理上一代留下的 claude 进程组。
//
// 背景：RUN-1 起 claude 子进程自成进程组（detached，pgid == pid）。桥接正常退出时有 exit 监听给它们补 SIGTERM；
// 桥接被 SIGKILL 或崩溃时监听不跑，claude 被 1 号进程收养，把手上的工具调用跑完，继续占着会话与额度。
//
// 做法：每起一个 claude 子进程，把「pid + 进程组 + 启动时间」写进 DATA_DIR/claude-children.json（权限 0600，
// 不含命令行、会话键、chat id、会话 id）；回合收尾时删掉。启动时对着上一代留下的记录逐条核对「指纹」，
// 全部对得上才整组结束：
//   pid、pgid == pid、启动时间 lstart 一致（pid 被复用时这里对不上）、命令行带桥接起的那种 claude 调用的形态、
//   父进程是 1（上一代已经死了才会被收养；别的桥接还活着时它的子进程父进程是那个桥接）。
// 任何一项对不上：只删记录，不碰进程。
//
// 安全边界（本文件的硬约束）：
//   - 只用「按单个 pid 查询」的 ps，不枚举进程表，不按进程名 / 命令行去找、去杀；只处理自己登记过的 pid。
//   - 不读环境变量（防漂移测试会扫 src/）；不打印命令行、pid、启动时间、会话 / chat id。
//   - add / remove / 写盘 / 清理都不抛：它们在 spawn 的 Promise 执行器和 settle() 里被调用。
//   - 不新增任何 process.on 监听（claude-run 的测试按个数数 exit 监听器）。
//   - Windows 与找不到 ps 的机器：登记与清理一律是空操作。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const CHILD_REGISTRY_FILE = 'claude-children.json';

const MAX_ENTRIES = 200; // 启动时最多看这么多条，多出的只算「记录对不上」
const LSTART_MAX_LEN = 64;
const SHAPE_WORDS = ['-p', '--output-format', 'stream-json', '--verbose']; // 桥接起 claude 的参数一律以这四个词开头

// ---- ps ----
// 首次用到时才判断（模块加载不做任何 IO）。undefined = 还没判断；'' = 没有可用的 ps。
let psBinResolved;
function resolvePsBin(exists = fs.existsSync) {
  if (psBinResolved !== undefined) return psBinResolved;
  let found = '';
  for (const p of ['/bin/ps', '/usr/bin/ps']) {
    try { if (exists(p)) { found = p; break; } } catch { /* 当作没有 */ }
  }
  psBinResolved = found;
  return found;
}

/** lstart 归一：按空白切词、单个空格连接（日 < 10 时 ps 会多补一个空格）。 */
function normLstart(s) {
  return typeof s === 'string' ? s.trim().split(/\s+/).filter(Boolean).join(' ') : '';
}

/**
 * 查一个 pid 的指纹：{ ppid, pgid, lstart, command }；进程不在 / 输出认不出来 → null。永不抛。
 * 只做 `ps -p <一个 pid>`；环境只给 LC_ALL / TZ，让 lstart 的写法与时区固定。
 * 输出一行：ppid pgid lstart(5 个词) command…（命令里的换行 ps 会显示成 \012，所以恒为一行）。
 */
export function probeProcess(pid, { exec = execFileSync, psBin } = {}) {
  try {
    const bin = psBin ?? resolvePsBin();
    if (!bin) return null;
    const out = exec(bin, ['-ww', '-o', 'ppid=,pgid=,lstart=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { LC_ALL: 'C', TZ: 'UTC' },
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = String(out ?? '').split('\n').filter((l) => l.trim() !== '');
    if (lines.length !== 1) return null;
    const w = lines[0].trim().split(/\s+/);
    if (w.length < 8) return null; // 2 个整数 + 5 个词的启动时间 + 至少 1 个词的命令
    if (!/^\d+$/.test(w[0]) || !/^\d+$/.test(w[1])) return null;
    const ppid = Number(w[0]);
    const pgid = Number(w[1]);
    if (!Number.isSafeInteger(ppid) || ppid <= 0 || !Number.isSafeInteger(pgid) || pgid <= 0) return null;
    if (!/^\d{1,2}$/.test(w[4]) || !/^\d\d:\d\d:\d\d$/.test(w[5]) || !/^\d{4}$/.test(w[6])) return null;
    const lstart = normLstart(w.slice(2, 7).join(' '));
    const command = w.slice(7).join(' ');
    if (!command) return null;
    return { ppid, pgid, lstart, command };
  } catch {
    return null; // 进程不在（退出码 1）、ps 超时、ps 起不来
  }
}

/** 命令按空白切词后，在下标 ≥1 处依次出现 -p / --output-format / stream-json / --verbose。 */
function hasClaudeShape(command) {
  if (typeof command !== 'string') return false;
  const words = command.split(/\s+/).filter(Boolean);
  let at = 0;
  for (let i = 1; i < words.length && at < SHAPE_WORDS.length; i += 1) {
    if (words[i] === SHAPE_WORDS[at]) at += 1;
  }
  return at === SHAPE_WORDS.length;
}

/** 指纹是否全部对上（第 3d 条）：进程组、启动时间、调用形态、父进程是 1。 */
function fingerprintMatches(pid, lstart, p) {
  return !!p
    && p.pgid === pid
    && normLstart(p.lstart) === normLstart(lstart)
    && hasClaudeShape(p.command)
    && p.ppid === 1;
}

function groupAlive(pid, kill) {
  try { kill(-pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } // EPERM：组在、只是没权限
}

function defaultSleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms; // 取不到 Atomics.wait 时忙等兜底（至多整个 escalateMs）
    while (Date.now() < end) { /* 等 */ }
  }
}

function safeLog(log, msg) {
  try { log(msg); } catch { /* 日志出错不影响主流程 */ }
}

// ---- 登记 / 清理 ----

/**
 * 登记簿：add(pid) / remove(pid) / has(pid) / reapPrevious(opts)。
 * psBin 只给测试用：'' 表示没有 ps（整个登记 / 清理停用）；不传则首次用到时按 /bin/ps、/usr/bin/ps 判断。
 */
export function createChildRegistry({
  file, log = console.error, probe = probeProcess, platform = process.platform, selfPid = process.pid, psBin,
} = {}) {
  const table = new Map(); // pid → { pid, pgid, lstart, spawnedAt }：本进程自己登记、还没收尾的
  let seq = 0;
  let warnedAdd = false;
  let warnedWrite = false;
  let warnedNoPs = false;

  /** 平台与 ps 都支持才启用；没有 ps 时只记一次日志。 */
  function enabled() {
    if (platform === 'win32') return false;
    const bin = psBin ?? resolvePsBin();
    if (bin) return true;
    if (!warnedNoPs) {
      warnedNoPs = true;
      safeLog(log, '[reaper] 找不到 ps 命令，不登记、也不清理上一代残留的 claude 进程');
    }
    return false;
  }

  /** 整份原子写（同目录临时文件 0600 + rename）；失败只记一次日志，返回是否成功。永不抛。 */
  function persist() {
    const tmp = `${file}.${process.pid}.${++seq}.tmp`;
    try {
      const body = JSON.stringify({ version: 1, entries: [...table.values()] });
      fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(tmp, 0o600); // umask 再松也收紧到 0600
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 尽力 */ }
      if (!warnedWrite) {
        warnedWrite = true;
        safeLog(log, `[reaper] 子进程记录写不进去（${e?.code ?? 'unknown'}），只影响桥接异常退出后的残留清理`);
      }
      return false;
    }
  }

  function add(pid) {
    try {
      if (!enabled()) return false;
      if (!Number.isSafeInteger(pid) || pid <= 1) return false;
      const p = probe(pid);
      if (!p || p.pgid !== pid || !normLstart(p.lstart)) {
        if (!warnedAdd) {
          warnedAdd = true;
          safeLog(log, '[reaper] 取不到子进程的进程组或启动时间，本轮不登记（只影响桥接异常退出后的残留清理）');
        }
        return false;
      }
      table.set(pid, { pid, pgid: pid, lstart: p.lstart, spawnedAt: new Date().toISOString() });
      persist();
      return true;
    } catch {
      return false;
    }
  }

  function remove(pid) {
    try {
      if (!enabled()) return false;
      if (!table.has(pid)) return false;
      table.delete(pid);
      persist();
      return true;
    } catch {
      return false;
    }
  }

  function has(pid) {
    return table.has(pid);
  }

  /**
   * 启动清理：同步完成（含 SIGKILL 补刀），整个函数不抛。返回 { killed, dropped, unreadable }。
   * killed = 指纹全对、SIGTERM 发成功的组数；dropped = 只删记录、没碰进程的条数。
   */
  function reapPrevious({
    log: out = console.log, escalateMs = 2000, pollMs = 100, sleepSync = defaultSleepSync, kill = process.kill.bind(process),
  } = {}) {
    let killed = 0;
    let dropped = 0;
    try {
      if (!enabled()) return { killed: 0, dropped: 0, unreadable: false };

      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        if (e?.code === 'ENOENT') return { killed: 0, dropped: 0, unreadable: false };
        safeLog(out, `[reaper] 子进程记录读不出来（${e?.code ?? 'unknown'}），本次不清理`);
        return { killed: 0, dropped: 0, unreadable: true };
      }
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 || !Array.isArray(data.entries)) {
        safeLog(out, '[reaper] 子进程记录损坏，本次不清理');
        return { killed: 0, dropped: 0, unreadable: true };
      }

      const had = data.entries.length;
      dropped += Math.max(0, had - MAX_ENTRIES);
      const pending = []; // { pid, lstart }：SIGTERM 已发出、等着确认这一组没了的
      for (const e of data.entries.slice(0, MAX_ENTRIES)) {
        // a. 形状
        const pid = e?.pid;
        const shapeOk = !!e && typeof e === 'object'
          && Number.isSafeInteger(pid) && pid > 1 && pid !== selfPid
          && e.pgid === pid
          && typeof e.lstart === 'string' && normLstart(e.lstart) !== '' && e.lstart.length <= LSTART_MAX_LEN;
        if (!shapeOk) { dropped += 1; continue; }
        // b. 本进程自己刚起的：不动，写回时保留
        if (table.has(pid)) continue;
        // c. 进程还在吗
        const p = probe(pid);
        if (!p) { dropped += 1; continue; }
        // d. 指纹
        if (!fingerprintMatches(pid, e.lstart, p)) { dropped += 1; continue; }
        // e. 整组 SIGTERM
        try {
          kill(-pid, 'SIGTERM');
          killed += 1;
          pending.push({ pid, lstart: e.lstart });
        } catch {
          dropped += 1; // ESRCH 等：已经不在了
        }
      }

      // 4. 等这些组消失；到点还在的补 SIGKILL
      const step = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 100; // 防止 0 / NaN 让循环不收敛
      const limit = Number.isFinite(escalateMs) && escalateMs >= 0 ? escalateMs : 2000;
      let alive = pending;
      let waited = 0;
      while (alive.length) {
        alive = alive.filter(({ pid }) => groupAlive(pid, kill));
        if (!alive.length || waited >= limit) break;
        sleepSync(step);
        waited += step;
      }
      for (const { pid, lstart } of alive) {
        try {
          const leader = probe(pid);
          // 领头进程还在：指纹仍全对才补刀（防止这两秒里 pid 换了主人）；已不在、组还在：就是我们刚确认过的那一组
          if (!leader || fingerprintMatches(pid, lstart, leader)) kill(-pid, 'SIGKILL');
        } catch { /* 已经没了 */ }
      }

      // 5. 写回：只留本进程自己的
      // 6. 只记一行个数
      if (had >= 1) {
        persist();
        safeLog(out, `[reaper] 上次运行留下的 claude 进程：已结束 ${killed} 组；记录对不上、只删记录 ${dropped} 条`);
      }
      return { killed, dropped, unreadable: false };
    } catch {
      safeLog(out, '[reaper] 清理出错，本次跳过');
      return { killed, dropped, unreadable: false };
    }
  }

  return { add, remove, has, reapPrevious };
}

// 单例：按文件路径区分；测试带 ?query 重复 import 本模块与 claude.js 时共用同一份内存表
// （靠 globalThis 上的 Symbol.for 键共享，与 claude.js 的 liveChildren 同一写法）。
export function childRegistryFor(file) {
  const registries = (globalThis[Symbol.for('feishu-claude-bridge.child-registry')] ??= new Map());
  const key = path.resolve(file);
  let reg = registries.get(key);
  if (!reg) {
    reg = createChildRegistry({ file: key });
    registries.set(key, reg);
  }
  return reg;
}

// ---- 通知 ----

/** 启动清理结束了 n 组时，发给仓主的固定文案（不含命令、会话 id、chat id）。 */
export function orphanNoticeText(n) {
  const k = Number.isSafeInteger(n) && n > 0 ? n : 0;
  return `⚠️ 上次异常退出时有 ${k} 个进行中的任务被中断（已清理）。如果当时在等回复，请把那条消息再发一次。`;
}

/**
 * 免打扰时段里不打扰：isQuiet() 为假（或抛错）就立刻 send() 一次；为真就每 recheckMs 查一次，出了免打扰再发一次并停表。
 * send 抛错 / reject 只记一行日志，不重试，也不产生未处理的 rejection。
 */
export function deferUntilAwake({
  send, isQuiet, recheckMs = 60_000, log = console.error, every = setInterval, stop = clearInterval,
} = {}) {
  const quiet = () => { try { return !!isQuiet(); } catch { return false; } };
  const fire = () => {
    const failed = () => safeLog(log, '[reaper] 中断通知发送失败');
    try {
      const r = send();
      if (r && typeof r.then === 'function') r.then(undefined, failed);
    } catch {
      failed();
    }
  };
  if (!quiet()) { fire(); return; }
  safeLog(log, '[reaper] 免打扰时段，中断通知延后到时段结束');
  let timer = null;
  let done = false;
  timer = every(() => {
    if (done || quiet()) return;
    done = true;
    try { stop(timer); } catch { /* 尽力 */ }
    fire();
  }, recheckMs);
  timer?.unref?.();
}
