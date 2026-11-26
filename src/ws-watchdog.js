// BRIDGE-STD-1 §3.4（W9）：启动自证。
// 长连接「悄悄没连上」比崩溃更糟：进程活着、launchd 认为正常、机器人对所有消息失聪。这里管四件事：
// ① assertAppIdShape——App ID 填成别的东西（比如 ou_ 开头的）时启动就说清楚，不去连一个注定连不上的应用；
// ② createExitLadder——连续失败的退出阶梯，从 index.js 原样搬出来（行为不变），好让最早期的凭据检查也能用；
// ③ createReadyWatchdog——以 SDK 的 onReady 回调为「就绪」（不是日志里那句 ws client ready），
//    启动 60 秒没就绪、或断线后 10 分钟没恢复，都交给阶梯退出，由 launchd 拉起重连；
// ④ inspectConnection——60 秒一次的连接状态巡检里「看一眼状态」那一小段（字符串、对象两种形态都认）。
// 依赖（fs / timers / now / exit / log）全部可注入。
import nodeFs from 'node:fs';

const MIN = 60 * 1000;
export const BACKOFF_LADDER = [15_000, 60_000, 300_000, 900_000]; // 15s → 1m → 5m → 15m

/** App ID 形状检查：通过返回 null，不通过返回一句说明。说明里不含 App ID 本身（它是配置值，不进日志） */
export function assertAppIdShape(id) {
  if (typeof id === 'string' && /^cli_\S+$/.test(id)) return null;
  return 'FEISHU_APP_ID 形状不对：应以 cli_ 开头、不含空白（出于安全不回显当前值），请到开发者后台「凭证与基础信息」重新复制';
}

/**
 * 连续失败的退出阶梯（原 index.js 的 BAIL_COUNT_FILE / readBailCount / bumpBailCount / 5 分钟清零 / exiting 守卫 / bailOut，行为不变）。
 * 连续失败次数跨重启累积（data/bail-count.json = { n, at }）：进程起来不到 5 分钟又要死 → n+1，等待按阶梯拉长；
 * 稳定跑满 5 分钟认为已恢复，清零。退出前至少等阶梯规定的时间，免得和 launchd 形成高频重启风暴。
 * 注意：{ ref: true } 的退出定时器不 unref——启动早期（凭据不对，停在永不返回的顶层 await 上）没有别的东西撑着事件循环，
 * unref 了 Node 会因「顶层 await 没落定」以退出码 13 提前退出，等待就被绕过去了。
 */
export function createExitLadder({ file, fs = nodeFs, now = Date.now, timers = globalThis, exit = (code) => process.exit(code), log = console.error } = {}) {
  const startedAt = now();

  function readBailCount() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Number(d?.n) || 0;
    } catch { return 0; }
  }
  function bumpBailCount() {
    const n = readBailCount() + 1;
    try { fs.writeFileSync(file, JSON.stringify({ n, at: now() })); } catch {}
    return n;
  }
  // 稳定运行足够久即认为已恢复，清零阶梯
  timers.setTimeout(() => {
    try { fs.rmSync(file, { force: true }); } catch {}
  }, 5 * MIN).unref();

  let exiting = false;
  function bailOut(reason, delayMs = 0, { ref = false } = {}) {
    if (exiting) return;
    exiting = true;
    // 起来没多久就又要死＝持续故障，按阶梯拉长等待
    const n = now() - startedAt < 5 * MIN ? bumpBailCount() : 1;
    const wait = Math.max(delayMs, BACKOFF_LADDER[Math.min(n - 1, BACKOFF_LADDER.length - 1)]);
    log(`[exit] ${reason}（第 ${n} 次连续失败，${Math.round(wait / 1000)}s 后退出）`);
    const t = timers.setTimeout(() => exit(1), wait);
    if (!ref) t.unref();
  }
  return { bailOut, readBailCount, bumpBailCount };
}

/** 启动早期的致命配置问题（凭据缺失 / App ID 形状不对）：记一行，走阶梯退出（不 unref）。调用方随后停在永不返回的顶层 await 上 */
export function failFast(ladder, problem, { log = console.error } = {}) {
  try { log(`[config] ${problem}`); } catch { /* 日志出错也要退出 */ }
  ladder.bailOut(problem, 0, { ref: true });
}

/**
 * 就绪看门狗。就绪的唯一判据是 SDK 的 onReady 回调（不是日志里的 ws client ready）。
 * start()：长连接启动之后调——readyTimeoutMs 内没有 ready() → onTimeout('启动 60 秒内未就绪')；
 * reconnecting()：每次进入重连状态调，第一次记起点；stallMs 内没有 reconnected()/ready() → onTimeout('断线超过 10 分钟未恢复')；
 * ready() / reconnected()：清掉对应计时。只触发一次；onTimeout 抛错不外溢。定时器全部 unref，不撑着进程。
 */
export function createReadyWatchdog({ readyTimeoutMs = 60_000, stallMs = 10 * MIN, onTimeout, timers = globalThis, now = Date.now } = {}) {
  let readyTimer = null;
  let stallTimer = null;
  let isReady = false;
  let fired = false;
  let stallSince = null;

  const arm = (fn, ms) => {
    const h = timers.setTimeout(fn, ms);
    try { h?.unref?.(); } catch { /* 假定时器没有 unref */ }
    return h;
  };
  const disarm = (h) => { if (h) timers.clearTimeout(h); };
  function stop() {
    disarm(readyTimer); readyTimer = null;
    disarm(stallTimer); stallTimer = null;
    stallSince = null;
  }
  function fire(reason) {
    if (fired) return;
    fired = true;
    stop();
    try { onTimeout?.(reason); } catch { /* 退出路径由调用方负责；这里不能再抛 */ }
  }
  function clearStall() {
    disarm(stallTimer); stallTimer = null;
    stallSince = null;
  }

  return {
    start() {
      if (isReady || readyTimer || fired) return;
      readyTimer = arm(() => { readyTimer = null; if (!isReady) fire('启动 60 秒内未就绪'); }, readyTimeoutMs);
    },
    ready() {
      isReady = true;
      disarm(readyTimer); readyTimer = null;
      clearStall();
    },
    reconnecting() {
      if (fired) return;
      if (stallSince !== null) {
        // SDK 每次重试都会再调：不重新计时；定时器被系统睡眠等拖迟时，这里按时钟补一刀
        if (now() - stallSince >= stallMs) fire('断线超过 10 分钟未恢复');
        return;
      }
      stallSince = now();
      stallTimer = arm(() => { stallTimer = null; fire('断线超过 10 分钟未恢复'); }, stallMs);
    },
    reconnected() { clearStall(); },
    stop,
  };
}

/** 巡检看一眼连接状态：SDK 返回字符串或 { state } 对象都认；只有 'failed' 才返回 'failed'，其余（含没有这个方法、抛错）返回 null */
export function inspectConnection(wsClient) {
  try {
    const st = wsClient.getConnectionStatus?.();
    const state = typeof st === 'string' ? st : st?.state; // SDK 返回的是对象，早先直接比字符串是死代码
    return state === 'failed' ? 'failed' : null;
  } catch { return null; /* 该 SDK 版本没有此方法则忽略 */ }
}
