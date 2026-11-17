// BRIDGE-VR-1 测试共用的桩（不是测试文件：npm test 只跑 test/*.test.js）。
// 与 events.test.js 的 harness 同形，另加验收用的只读 lark 桩（verifyRunner）与 owner。
// 全部用注入的桩：不连飞书、不起 lark-cli、不调真实 claude。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const { heartbeatConfig, createHeartbeat } = await import('../src/heartbeat.js');
const { createEventHandlers } = await import('../src/events.js');

export const isQuiet = (a) => {
  const b = String(a ?? '').trim();
  return !b || /^HEARTBEAT_OK[.。!！]?$/i.test(b);
};
export const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi); // 本地时间
export const plus = (d, min) => new Date(d.getTime() + min * 60_000);
export const HOUR = 60;
export const quietLog = () => {};
export const OWNER = 'ou_owner';
export const T0 = at(2026, 11, 16, 10, 0);
export const TOAST_OK = { toast: { type: 'success', content: '已记下' } };
export const TOAST_STALE = { toast: { type: 'warning', content: '已失效' } };
export const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);

export function mkEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbvr-'));
  const tasksDir = path.join(dir, 'ws', 'tasks');
  const journalDir = path.join(dir, 'ws', 'memory', 'journal');
  fs.mkdirSync(tasksDir, { recursive: true });
  return {
    dir, tasksDir, journalDir,
    stateFile: path.join(dir, 'data', 'heartbeat-state.json'),
    signalsFile: path.join(dir, 'data', 'heartbeat-signals.json'),
  };
}
export const taskFile = (env, slug) => path.join(env.tasksDir, `${slug}.json`);
export const writeTask = (env, slug, obj) => fs.writeFileSync(taskFile(env, slug), JSON.stringify(obj, null, 2));
export const readTask = (env, slug) => JSON.parse(fs.readFileSync(taskFile(env, slug), 'utf8'));
export const journalOf = (env, day = '2026-11-16') => {
  const f = path.join(env.journalDir, `${day}.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
export const CFG = (env = {}) => heartbeatConfig({ HEARTBEAT_ENABLED: 'true', HEARTBEAT_QUIET_HOURS: 'none', ...env }, quietLog);

// 只读 lark 桩：按 argv 返回预置结果，记下每次 argv
export function mkRunner(reply = () => ({ ok: false, reason: '桩：没有预置结果' })) {
  const argvs = [];
  const run = async (argv) => {
    argvs.push(argv);
    return reply(argv, argvs.length);
  };
  run.argvs = argvs;
  return run;
}

// 心跳 + 事件处理函数。send 桩默认返回 om_<第几次调用>；runImpl(n, ...args) 可按 chatId 区分心跳 / 验收
export function harness(env, {
  config = CFG(), answer, runImpl, sendImpl, now = T0, collectDeltas, syncDefer = true, verifyRunner, timers, extra = {},
} = {}) {
  const calls = [];
  const sent = [];
  const logs = [];
  let clock = now;
  const log = (...a) => logs.push(a.join(' '));
  const hb = createHeartbeat({
    config, tasksDir: env.tasksDir, stateFile: env.stateFile, journalDir: env.journalDir, isQuiet,
    ...(collectDeltas ? { collectDeltas } : {}),
    ...(syncDefer ? { defer: (fn) => fn() } : {}),
    ...(verifyRunner ? { verifyRunner } : {}),
    ...(timers ? { timers } : {}),
    getOwner: () => OWNER,
    runClaude: async (...args) => {
      calls.push(args);
      if (runImpl) return runImpl(calls.length, ...args);
      if (answer !== undefined) return typeof answer === 'function' ? answer(calls.length, ...args) : answer;
      return `第 ${calls.length} 拍：报价单还没回`;
    },
    send: async function send(text, opts) {
      const rec = { text, opts, argc: arguments.length };
      sent.push(rec);
      if (sendImpl) return sendImpl(rec, sent.length);
      rec.mid = `om_${sent.length}`;
      return rec.mid;
    },
    now: () => clock,
    log,
    logError: log,
    ...extra,
  });
  const handlers = createEventHandlers({ getOwner: () => OWNER, heartbeat: hb, log });
  return {
    hb, handlers, calls, sent, logs,
    setNow: (d) => { clock = d; },
    now: () => clock,
    readState: () => JSON.parse(fs.readFileSync(env.stateFile, 'utf8')),
  };
}

export const haikuCalls = (calls) => calls.filter((c) => c[0] === 'sched:verify');
export const beatCalls = (calls) => calls.filter((c) => c[0] !== 'sched:verify');

// 卡片回调载荷（card.action.trigger 的形状）
export const click = (mid, value, operator = OWNER) => ({ operator: { open_id: operator }, context: { open_message_id: mid }, action: { value } });
export const btn = (sentRec, action, s) => sentRec.opts.actions.find((a) => a.value.a === action && (s === undefined || a.value.s === s)).value;
export const quoted = (parent, text, over = {}) => ({
  chat_type: 'p2p', parent_id: parent, message_type: 'text', content: JSON.stringify({ text }), ...over,
});
// 已读事件
export const readEvent = (h, mid, d) => h.handlers.read({
  reader: { reader_id: { open_id: OWNER }, read_time: String(d.getTime()) }, message_id_list: [mid],
});

// 文件快照：按钮 / 回复被拒时台账、状态、信号、journal 一律不动
export const snap = (env, slugs = ['quote']) => ({
  tasks: slugs.map((s) => sha(taskFile(env, s))),
  state: sha(env.stateFile),
  signals: sha(env.signalsFile),
  journal: journalOf(env),
  files: fs.readdirSync(env.tasksDir).sort(),
});

// 断言某段文字完整落在一道真围栏（16 位十六进制随机 nonce）之内，且只出现一次（同 heartbeat.test.js）
export function assertInsideFence(prompt, phrase) {
  const idx = prompt.indexOf(phrase);
  assert.ok(idx >= 0, `找不到「${phrase}」`);
  assert.equal(prompt.indexOf(phrase, idx + 1), -1, `「${phrase}」应只出现一次`);
  const opens = [...prompt.matchAll(/<<<UNTRUSTED_([0-9a-f]{16}) 来源：/g)].filter((m) => m.index < idx);
  assert.ok(opens.length > 0, `「${phrase}」前面没有围栏起始标记`);
  const open = opens[opens.length - 1];
  const endIdx = prompt.indexOf(`---UNTRUSTED_END_${open[1]}---`, open.index);
  assert.ok(endIdx > idx, `「${phrase}」不在围栏 ${open[1]} 之内`);
}
export function assertBalancedFences(prompt) {
  const opens = [...prompt.matchAll(/<<<UNTRUSTED_([0-9a-f]{16}) 来源：/g)].map((m) => m[1]);
  const ends = [...prompt.matchAll(/---UNTRUSTED_END_([0-9a-f]{16})---/g)].map((m) => m[1]);
  assert.ok(opens.length > 0, '至少有一道围栏');
  assert.deepEqual(opens, ends, '起止标记一一对应、按序闭合');
}

// 定时器桩：记下每次 setTimeout 的延迟与回调，手动触发
export function spyTimers() {
  const log = [];
  const timeouts = [];
  return {
    log, timeouts,
    setInterval: () => { log.push('setInterval'); return { unref() {} }; },
    clearInterval: () => {},
    setTimeout: (fn, ms) => { log.push('setTimeout'); const t = { fn, ms, cleared: false, unref() {} }; timeouts.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
  };
}
