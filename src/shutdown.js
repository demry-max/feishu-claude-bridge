// 优雅退出（BRIDGE-VR-1 协调补充）。
// 收到 SIGTERM / SIGINT：先停接新消息（调用方看 isDraining()）、停心跳（onDrain），等进行中的对话做完再退出；
// 最多等 SHUTDOWN_GRACE_SEC 秒（默认 120），等满了记一行日志直接退出。退出期间新来的消息回 DRAINING_REPLY。
// 第二次信号不再等，立即退出。信号源、定时器、时钟、退出函数都可注入（测试不碰真进程）。

export const DRAINING_REPLY = '正在重启，请稍后重发';

const DEFAULT_GRACE_SEC = 120;
const MAX_GRACE_SEC = 3600;
const EXIT_CODES = Object.freeze({ SIGTERM: 143, SIGINT: 130 });

/** 读 SHUTDOWN_GRACE_SEC：0–3600 的整数秒，空着按 120；写错按 120 并记日志。 */
export function shutdownGraceSec(env, log = () => {}) {
  const raw = env?.SHUTDOWN_GRACE_SEC;
  const s = raw === undefined || raw === null ? '' : String(raw).trim();
  if (s === '') return DEFAULT_GRACE_SEC;
  if (!/^\d{1,4}$/.test(s) || Number(s) > MAX_GRACE_SEC) {
    log(`[shutdown] SHUTDOWN_GRACE_SEC=${JSON.stringify(s.slice(0, 40))} 不合法（要 0–${MAX_GRACE_SEC} 的整数秒），按默认 ${DEFAULT_GRACE_SEC} 秒`);
    return DEFAULT_GRACE_SEC;
  }
  return Number(s);
}

/**
 * @param {object} o
 * @param {number} [o.graceSec]   最多等多少秒（0＝不等）
 * @param {() => number} o.inflight 进行中的对话数
 * @param {() => void} [o.onDrain] 进入退出流程时调一次：停心跳（新消息由调用方看 isDraining() 拒收；抛错只记日志）
 * @param {(code: number) => void} [o.exit]
 */
export function createShutdown({
  graceSec = DEFAULT_GRACE_SEC,
  inflight = () => 0,
  onDrain = () => {},
  exit = (code) => process.exit(code),
  timers = globalThis,
  log = console.log,
  pollMs = 500,
  now = Date.now,
} = {}) {
  let draining = false;
  let exited = false;
  let poll = null;
  let startedAt = 0;
  const installed = new WeakSet();

  const busy = () => {
    try {
      const n = Number(inflight());
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };

  function finish(code) {
    if (exited) return;
    exited = true;
    if (poll) {
      timers.clearTimeout(poll);
      poll = null;
    }
    exit(code);
  }

  function schedule(code) {
    poll = timers.setTimeout(() => {
      poll = null;
      if (exited) return;
      const n = busy();
      if (n === 0) {
        log('[shutdown] 进行中的对话都做完了，退出');
        finish(code);
        return;
      }
      if (now() - startedAt >= graceSec * 1000) {
        log(`[shutdown] 等了 ${graceSec} 秒还有 ${n} 个对话没做完，直接退出`);
        finish(code);
        return;
      }
      schedule(code);
    }, pollMs);
  }

  function handle(signal) {
    if (exited) return;
    const code = EXIT_CODES[signal] ?? EXIT_CODES.SIGTERM;
    if (draining) {
      log(`[shutdown] 又收到 ${signal}：不再等，立即退出`);
      finish(code);
      return;
    }
    draining = true;
    startedAt = now();
    const n = busy();
    if (n === 0) log(`[shutdown] 收到 ${signal}：没有进行中的对话，停掉心跳后退出`);
    else if (graceSec <= 0) log(`[shutdown] 收到 ${signal}：SHUTDOWN_GRACE_SEC=0，不等进行中的 ${n} 个对话，直接退出`);
    else log(`[shutdown] 收到 ${signal}：不再接新消息、停掉心跳；等进行中的 ${n} 个对话做完（最多等 ${graceSec} 秒）再退出`);
    try {
      onDrain();
    } catch (e) {
      log(`[shutdown] 停止接新消息 / 心跳时出错：${e?.message ?? e}`);
    }
    if (exited) return;
    if (busy() === 0 || graceSec <= 0) {
      finish(code);
      return;
    }
    schedule(code);
  }

  /** 挂 SIGTERM / SIGINT（同一个 proc 重复 install 不叠挂）。 */
  function install(proc = process) {
    if (installed.has(proc)) return;
    installed.add(proc);
    proc.on('SIGTERM', () => handle('SIGTERM'));
    proc.on('SIGINT', () => handle('SIGINT'));
  }

  return { handle, install, isDraining: () => draining };
}
