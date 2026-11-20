// BRIDGE-RUN-1：调 Claude 子进程的收尾、重试与环境（行为测试）。
//
// 全部用隔离目录 + 假 claude CLI（test/fixtures/fake-claude-run.mjs，按 FAKE_PLAN 演），
// 不碰线上 data/ 与 workspace/，不调真实 claude CLI，不联网。
// 阈值类配置（CLAUDE_IDLE_TIMEOUT_MS / CLAUDE_RESULT_GRACE_MS / CLAUDE_MAX_RETRIES / CLAUDE_BIN）在 claude.js import 时读取，
// 所以每个变体都重新 import 一份（?run=N）。
// 本文件的测试自带保护：每个用例有 timeout，等待都走 within()，afterEach 把假 CLI 及其孙进程收干净，
// 不依赖外部超时。
import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeSandbox, sandboxEnv, applyEnv, loadClaude, captureConsole, within, settle, sleep, waitGone, waitFor,
  readPid, reapAll, pgidOf, childProcessEnv, runDriver, CLAUDE_URL,
} from './fixtures/run-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_DRIVER = path.join(HERE, 'fixtures', 'run-driver.mjs');
const IS_WIN = process.platform === 'win32';

const SB = makeSandbox('claude-run');
applyEnv(sandboxEnv(SB));
after(() => SB.cleanup());
afterEach(() => reapAll(SB));

// ---- 假 CLI 的事件 ----
const init = (sid = 'sid-x') => ({ type: 'system', subtype: 'init', session_id: sid });
const asst = (content) => ({ type: 'assistant', message: { content } });
const text = (t) => asst([{ type: 'text', text: t }]);
const tool = (name, t = '') => asst([...(t ? [{ type: 'text', text: t }] : []), { type: 'tool_use', id: `tu_${name}`, name, input: {} }]);
const toolResult = () => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'ok' }] } });
const result = (r, sid = 'sid-x') => ({ type: 'result', subtype: 'success', is_error: false, result: r, session_id: sid });
const errResult = (r, sid = 'sid-x') => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result: r, session_id: sid });
const okPlan = (sid, answer) => ({ events: [init(sid), text(answer), result(answer, sid)] });

/** 重新 import 一份 claude.js；退避缩短到 20ms（测试专用钩子，没有对外的环境变量） */
async function load(env = {}) {
  const m = await loadClaude(SB, env);
  m._setRetryDelaysForTest?.([20, 20]);
  return m;
}

// ---------------------------------------------------------------------------------------------
describe('H1 重试只看 acted，不看 producedOutput', () => {
  test('钩子在：_setRetryDelaysForTest（退避缩短，测试不必真等 3 秒 / 15 秒）', async () => {
    const m = await load();
    assert.equal(typeof m._setRetryDelaysForTest, 'function');
  });

  test('错误 result（API Error: 529 Overloaded）+ 没动过手 → 自动重试到上限，最终报错里没有「执行到一半」', { timeout: 30_000 }, async () => {
    const m = await load();
    SB.plan({ events: [init(), errResult('API Error: 529 Overloaded')], exit: 1 });
    const r = await within(settle(m.runClaude('oc_h1a', 'hi', true, [], null)), 20_000, 'H1a');
    assert.equal(r.ok, false);
    assert.equal(SB.spawns().length, 3, '默认最多重试 2 次 → 共 3 个子进程');
    assert.match(r.e.message, /529/);
    assert.ok(!/执行到一半/.test(r.e.message), r.e.message);
  });

  test('529 之后第二次成功 → 返回第二次的答案，共 2 个子进程', { timeout: 30_000 }, async () => {
    const m = await load();
    SB.plan({ events: [init('s-b1'), errResult('API Error: 529 Overloaded', 's-b1')], exit: 1 }, okPlan('s-b2', '第二次的答案'));
    const r = await within(settle(m.runClaude('oc_h1b', 'hi', true, [], null)), 20_000, 'H1b');
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '第二次的答案');
    assert.equal(SB.spawns().length, 2);
  });

  test('先调过工具再 529 → 不重放（只 1 个子进程），报错带「任务已执行到一半」，e.acted=true', { timeout: 30_000 }, async () => {
    const m = await load();
    SB.plan({ events: [init('s-c'), tool('Edit', '开始改'), toolResult(), errResult('API Error: 529 Overloaded', 's-c')], exit: 1 });
    const r = await within(settle(m.runClaude('oc_h1c', 'hi', true, [], null)), 20_000, 'H1c');
    assert.equal(r.ok, false);
    assert.equal(SB.spawns().length, 1, '动过手就不能重放');
    assert.match(r.e.message, /任务已执行到一半/);
    assert.equal(r.e.acted, true);
  });

  test('推送过进度（onProgress 被调用）也算动过手：不重放，带提示', { timeout: 30_000 }, async () => {
    const m = await load();
    const progress = [];
    SB.plan({ events: [init('s-d'), text('第一段'), text('第二段'), errResult('API Error: 529 Overloaded', 's-d')], exit: 1 });
    const r = await within(settle(m.runClaude('oc_h1d', 'hi', true, [], async (t) => { progress.push(t); })), 20_000, 'H1d');
    assert.equal(r.ok, false);
    assert.equal(SB.spawns().length, 1);
    assert.ok(progress.includes('第一段'), `进度应推过第一段：${JSON.stringify(progress)}`);
    assert.ok(progress.every((p) => !/连接中断/.test(p)), '没重试就不该发重试提示');
    assert.match(r.e.message, /任务已执行到一半/);
    assert.equal(r.e.acted, true);
  });

  test('回归：没有任何输出的断连（stderr Connection error.）照旧自动重试', { timeout: 30_000 }, async () => {
    const m = await load();
    SB.plan({ events: [], stderr: 'Connection error.', exit: 1 }, okPlan('s-e', '重试后成功'));
    const r = await within(settle(m.runClaude('oc_h1e', 'hi', true, [], null)), 20_000, 'H1e');
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '重试后成功');
    assert.equal(SB.spawns().length, 2);
  });

  test('producedOutput 语义不变（错误 result 也算产出），acted 另算', { timeout: 20_000 }, async () => {
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    SB.plan({ events: [init('s-f1'), errResult('API Error: 529 Overloaded', 's-f1')], exit: 1 });
    const r = await within(settle(m.runClaude('oc_h1f1', 'hi', true, [], null)), 10_000, 'H1f1');
    assert.equal(r.e.producedOutput, true, 'daily-session 靠它判断「本轮是否有产出」');
    assert.equal(r.e.acted, false);
  });

  test('超时：调过工具 → acted=true；一个事件都没有 → acted=false 且 producedOutput=false', { timeout: 30_000 }, async () => {
    const m = await load({ CLAUDE_MAX_RETRIES: '0', CLAUDE_IDLE_TIMEOUT_MS: '600' });
    SB.plan({ events: [init('s-t1'), tool('Edit', 'x')], hang: true });
    const r1 = await within(settle(m.runClaude('oc_h1t1', 'hi', true, [], null)), 8000, '调过工具后静默');
    assert.equal(r1.ok, false);
    assert.match(r1.e.message, /超时/);
    assert.equal(r1.e.acted, true);
    assert.equal(r1.e.producedOutput, true);

    SB.plan({ events: [], hang: true });
    const r2 = await within(settle(m.runClaude('oc_h1t2', 'hi', true, [], null)), 8000, '一个事件都没有');
    assert.equal(r2.ok, false);
    assert.match(r2.e.message, /超时/);
    assert.equal(r2.e.acted, false);
    assert.equal(r2.e.producedOutput, false);
  });

  test('取消：调过工具后 cancelRun → 错误带 cancelled 与 acted=true', { timeout: 20_000 }, async () => {
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    SB.plan({ events: [init('s-x'), tool('Edit', 'x')], hang: true });
    const p = settle(m.runClaude('oc_h1x', 'hi', true, [], null));
    await waitFor(() => SB.spawns().length === 1 && m.isRunning('oc_h1x'), 8000, '子进程起来');
    await sleep(500); // 让 tool_use 那一行被桥接读到
    assert.equal(m.cancelRun('oc_h1x'), true);
    const r = await within(p, 8000, 'H1x');
    assert.equal(r.ok, false);
    assert.equal(r.e.cancelled, true);
    assert.equal(r.e.acted, true);
    assert.equal(m.isRunning('oc_h1x'), false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('R2 结果已到、进程不退：宽限一到就用已收到的结果收尾', () => {
  test('result 之后进程挂住 → 约宽限时间后返回原答案；isRunning=false；会话 id 已写；子进程被清掉；日志一行', { timeout: 20_000 }, async () => {
    const m = await load({ CLAUDE_RESULT_GRACE_MS: '400', CLAUDE_IDLE_TIMEOUT_MS: '60000' });
    SB.plan({ events: [init('sg1'), text('临时'), result('完整答案', 'sg1')], hang: true });
    const cap = captureConsole();
    let r;
    const t0 = Date.now();
    try { r = await within(settle(m.runClaude('oc_g1', 'hi', true, [], null)), 6000, '宽限到期后应收尾'); } finally { cap.restore(); }
    const dt = Date.now() - t0;
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '完整答案');
    assert.ok(dt >= 350 && dt < 5000, `耗时 ${dt}ms，应约等于宽限 400ms`);
    assert.equal(m.isRunning('oc_g1'), false);
    assert.equal(SB.sessions().oc_g1, 'sg1', 'result 到达时就已写会话 id');
    assert.deepEqual(await waitGone(SB.spawns().map((s) => s.pid), 4000), [], '挂住的子进程要被清掉');
    assert.ok(cap.lines.includes('[claude] oc_g1 结果已到但进程 0.4 秒未退出，已结束'), cap.lines.join('\n'));
  });

  test('result 之后进程挂住、还忽略 SIGTERM → 宽限一到就返回答案（不等 2 秒后的 SIGKILL）；子进程最终仍被清掉', { timeout: 20_000 }, async () => {
    const m = await load({ CLAUDE_RESULT_GRACE_MS: '400', CLAUDE_IDLE_TIMEOUT_MS: '60000' });
    SB.plan({ events: [init('sg5'), result('先到的答案', 'sg5')], ignoreTerm: true, hang: true });
    const t0 = Date.now();
    const r = await within(settle(m.runClaude('oc_g5', 'hi', true, [], null)), 6000, '宽限到期后应收尾');
    const dt = Date.now() - t0;
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '先到的答案');
    // 宽限 400ms 到期时发 SIGTERM，但进程忽略它，要等约 2 秒后的 SIGKILL 才会退。
    // 落定时刻不能依赖进程退出（否则本轮要多挂 2 秒，进程若杀不掉还会一直挂着）：到期那一刻就用已收到的结果收尾
    assert.ok(dt >= 350 && dt < 1800, `耗时 ${dt}ms：应在宽限到期（约 400ms）时落定，不该等 SIGKILL 升级的 2 秒`);
    assert.equal(m.isRunning('oc_g5'), false);
    assert.deepEqual(await waitGone(SB.spawns().map((s) => s.pid), 4000), [], '补发 SIGKILL 之后子进程要被清掉');
  });

  test('is_error 的 result 之后进程挂住 → 抛原错误（不是超时）', { timeout: 20_000 }, async () => {
    const m = await load({ CLAUDE_RESULT_GRACE_MS: '400', CLAUDE_IDLE_TIMEOUT_MS: '60000', CLAUDE_MAX_RETRIES: '0' });
    SB.plan({ events: [init('sg2'), errResult('boom', 'sg2')], hang: true });
    const r = await within(settle(m.runClaude('oc_g2', 'hi', true, [], null)), 6000, '宽限到期后应收尾');
    assert.equal(r.ok, false);
    assert.equal(r.e.message, 'boom');
    assert.equal(r.e.acted, false);
    assert.equal(m.isRunning('oc_g2'), false);
    assert.deepEqual(await waitGone(SB.spawns().map((s) => s.pid), 4000), []);
  });

  test('result 到了就不再按静默超时算：静默阈值比宽限短时仍返回答案，不报超时', { timeout: 20_000 }, async () => {
    const m = await load({ CLAUDE_RESULT_GRACE_MS: '1500', CLAUDE_IDLE_TIMEOUT_MS: '500' });
    SB.plan({ events: [init('sg3'), result('答案在先', 'sg3')], hang: true });
    const r = await within(settle(m.runClaude('oc_g3', 'hi', true, [], null)), 8000, 'R2c');
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '答案在先');
  });

  test('已发终止信号、结果却在之后才到 → 以结果为准（close 先看 finalText 再看 timedOut）', { timeout: 20_000 }, async () => {
    const m = await load({ CLAUDE_IDLE_TIMEOUT_MS: '400', CLAUDE_MAX_RETRIES: '0' });
    // 假 CLI 忽略 SIGTERM，静默 ~1.2 秒后才补出 result 然后正常退出；静默阈值 400ms，终止信号早已发出
    SB.plan({ events: [init('sg4')], ignoreTerm: true, lateMs: 1200, lateEvents: [result('迟到的答案', 'sg4')] });
    const r = await within(settle(m.runClaude('oc_g4', 'hi', true, [], null)), 8000, 'R2d');
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '迟到的答案');
  });

  test('正常的一轮不受影响：快速返回、没有宽限日志、isRunning=false、会话 id 照写', { timeout: 20_000 }, async () => {
    const m = await load();
    SB.plan(okPlan('sn1', '你好呀'));
    const cap = captureConsole();
    let r;
    const t0 = Date.now();
    try { r = await within(settle(m.runClaude('oc_n1', 'hi', true, [], null)), 8000, '正常轮次'); } finally { cap.restore(); }
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '你好呀');
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(m.isRunning('oc_n1'), false);
    assert.equal(SB.sessions().oc_n1, 'sn1');
    assert.ok(!cap.lines.some((l) => /结果已到但进程/.test(l)), '进程正常退出时不该有宽限日志');
    assert.equal(SB.spawns().length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('R3 进程组：孙进程握着管道、父进程不吭声也要收得了尾', { skip: IS_WIN && 'POSIX 进程组语义；Windows 走原来的单进程 kill' }, () => {
  test('超时：孙进程继承 stdout/stderr 管道 → 超时后本轮落定，子孙都没了，同一会话键能立刻跑下一轮', { timeout: 40_000 }, async () => {
    const m = await load({ CLAUDE_IDLE_TIMEOUT_MS: '1200', CLAUDE_MAX_RETRIES: '0' });
    const gcFile = SB.pidfile('gc-a');
    SB.plan(
      { events: [init('sg-a')], grandchild: { sec: 60, stdio: 'inherit', pidfile: gcFile }, hang: true },
      okPlan('sg-a2', '第二轮'),
    );
    const t0 = Date.now();
    const r = await within(settle(m.runClaude('oc_r3a', 'hi', true, [], null)), 15_000, 'R3a');
    const dt = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.match(r.e.message, /超时/);
    assert.ok(dt < 1200 + 5000, `耗时 ${dt}ms：应在静默阈值 + 几秒内落定`);
    const gc = readPid(gcFile);
    assert.ok(gc, '孙进程应已起来');
    assert.deepEqual(await waitGone([SB.spawns()[0].pid, gc], 4000), [], '子进程和孙进程都要没了');
    assert.equal(m.isRunning('oc_r3a'), false);
    const r2 = await within(settle(m.runClaude('oc_r3a', 'hi', true, [], null)), 10_000, 'R3a 下一轮');
    assert.equal(r2.ok, true, r2.e?.message);
    assert.equal(r2.v, '第二轮');
  });

  test('cancelRun 也杀孙进程：本轮以 CANCELLED 落定，子孙都没了，isRunning=false', { timeout: 30_000 }, async () => {
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    const gcFile = SB.pidfile('gc-b');
    SB.plan({ events: [init('sg-b'), tool('Edit', 'x')], grandchild: { sec: 60, stdio: 'inherit', pidfile: gcFile }, hang: true });
    const p = settle(m.runClaude('oc_r3b', 'hi', true, [], null));
    const gc = await waitFor(() => readPid(gcFile), 8000, '孙进程起来');
    await waitFor(() => m.isRunning('oc_r3b'), 3000, 'isRunning');
    await sleep(400); // 让 tool_use 那一行被桥接读到
    const child = SB.spawns()[0].pid;
    assert.doesNotThrow(() => process.kill(-child, 0), '子进程应是自己进程组的组长（detached）');
    assert.equal(pgidOf(gc), child, '孙进程在子进程的进程组里');
    assert.equal(m.cancelRun('oc_r3b'), true);
    const r = await within(p, 8000, 'R3b');
    assert.equal(r.ok, false);
    assert.equal(r.e.cancelled, true);
    assert.match(r.e.message, /CANCELLED/);
    assert.equal(r.e.acted, true);
    assert.deepEqual(await waitGone([child, gc], 4000), []);
    assert.equal(m.isRunning('oc_r3b'), false);
  });

  test('子进程忽略 SIGTERM：约 2 秒后升级到 SIGKILL，仍以超时落定', { timeout: 30_000 }, async () => {
    const m = await load({ CLAUDE_IDLE_TIMEOUT_MS: '800', CLAUDE_MAX_RETRIES: '0' });
    SB.plan({ events: [init('sg-c')], ignoreTerm: true, hang: true });
    const t0 = Date.now();
    const r = await within(settle(m.runClaude('oc_r3c', 'hi', true, [], null)), 12_000, 'R3c');
    const dt = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.match(r.e.message, /超时/);
    assert.ok(dt >= 2500, `耗时 ${dt}ms：应先 SIGTERM、等约 2 秒再 SIGKILL`);
    assert.ok(dt < 9000, `耗时 ${dt}ms`);
    assert.deepEqual(await waitGone([SB.spawns()[0].pid], 3000), []);
    assert.equal(m.isRunning('oc_r3c'), false);
  });

  test('孙进程自立门户（另一个进程组）却握着管道：杀不到它，但本轮仍在「退出后宽限」内落定，下一轮可跑', { timeout: 40_000 }, async () => {
    const m = await load({ CLAUDE_IDLE_TIMEOUT_MS: '800', CLAUDE_MAX_RETRIES: '0' });
    const gcFile = SB.pidfile('gc-e');
    SB.plan(
      { events: [init('sg-e')], grandchild: { sec: 60, stdio: 'inherit', detached: true, pidfile: gcFile }, hang: true },
      okPlan('sg-e2', '下一轮照常'),
    );
    const t0 = Date.now();
    const r = await within(settle(m.runClaude('oc_r3e', 'hi', true, [], null)), 12_000, 'R3e');
    const dt = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.match(r.e.message, /超时/);
    assert.ok(dt < 800 + 7000, `耗时 ${dt}ms：close 永远等不到，要靠 exit 之后的限时等待收尾`);
    assert.equal(m.isRunning('oc_r3e'), false);
    const r2 = await within(settle(m.runClaude('oc_r3e', 'hi', true, [], null)), 10_000, 'R3e 下一轮');
    assert.equal(r2.ok, true, r2.e?.message);
    assert.equal(r2.v, '下一轮照常');
    // 自立门户的孙进程由 afterEach 的收尸函数处理（它在本轮的进程组之外，桥接不该、也够不着去杀）
  });

  test('进程已退出（code 0）但孙进程还握着管道、宽限设得很长：靠 exit 之后的限时等待，几秒内返回答案，残留进程组被清掉', { timeout: 40_000 }, async () => {
    const m = await load({ CLAUDE_RESULT_GRACE_MS: '60000', CLAUDE_IDLE_TIMEOUT_MS: '60000', CLAUDE_MAX_RETRIES: '0' });
    const gcFile = SB.pidfile('gc-f');
    SB.plan({ events: [init('sg-f'), result('答案', 'sg-f')], grandchild: { sec: 60, stdio: 'inherit', pidfile: gcFile } });
    const t0 = Date.now();
    const r = await within(settle(m.runClaude('oc_r3f', 'hi', true, [], null)), 12_000, 'R3f');
    const dt = Date.now() - t0;
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '答案');
    assert.ok(dt < 6000, `耗时 ${dt}ms`);
    assert.equal(m.isRunning('oc_r3f'), false);
    const gc = readPid(gcFile);
    assert.ok(gc);
    assert.deepEqual(await waitGone([gc], 4000), [], '本轮进程组里的残留进程要一并清掉');
  });
});

// ---------------------------------------------------------------------------------------------
describe('R4 桥接退出时清掉子进程组', { skip: IS_WIN && 'POSIX 进程组语义' }, () => {
  test('多次 import 只挂一个 exit 监听器；process.exit(0) 时子进程与孙进程一起被终止', { timeout: 60_000 }, async () => {
    const gcFile = SB.pidfile('gc-x');
    SB.plan({ events: [init('sg-x')], grandchild: { sec: 60, stdio: 'ignore', pidfile: gcFile }, hang: true });
    const env = childProcessEnv(SB, { DRIVER_PIDFILE: gcFile, DRIVER_IMPORTS: '3' });
    const d = await runDriver(RUN_DRIVER, env, 40_000);
    assert.equal(d.code, 0, `驱动脚本应正常退出：${d.err.slice(0, 500)}`);
    assert.ok(d.result, `驱动脚本没有给出结果：${d.out.slice(0, 300)}`);
    const { before, after: after_, named, childPid, gcPid } = d.result;
    assert.equal(after_ - before, 1, `3 次 import 后 exit 监听器应只多 1 个（实际多 ${after_ - before} 个）`);
    assert.equal(named, 1, '名为 bridgeClaudeGroupCleanup 的监听器应恰有 1 个');
    assert.ok(childPid > 1 && gcPid > 1);
    assert.deepEqual(await waitGone([childPid, gcPid], 5000), [], '桥接进程退出后，子进程与孙进程都应已被终止');
  });
});

// ---------------------------------------------------------------------------------------------
describe('R5 result 事件的文本取值（M3）', () => {
  test('result 为空串、前面有 assistant 文本 → 返回那段文本', { timeout: 20_000 }, async () => {
    const m = await load();
    SB.plan({
      events: [
        init('s5a'),
        asst([{ type: 'text', text: '真正的答案：报告已写好' }, { type: 'tool_use', id: 'tu1', name: 'Write', input: {} }]),
        toolResult(),
        asst([{ type: 'thinking', thinking: '…' }]),
        result('', 's5a'),
      ],
    });
    const r = await within(settle(m.runClaude('oc_r5a', 'hi', true, [], null)), 8000, 'R5a');
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '真正的答案：报告已写好');
  });

  test('result 只有空白 → 同样回落到 assistant 文本', { timeout: 20_000 }, async () => {
    const m = await load();
    SB.plan({ events: [init('s5b'), text('有内容的那段'), result('  \n ', 's5b')] });
    const r = await within(settle(m.runClaude('oc_r5b', 'hi', true, [], null)), 8000, 'R5b');
    assert.equal(r.v, '有内容的那段');
  });

  test('result 为空串、前面也没有任何文本 → 空串', { timeout: 20_000 }, async () => {
    const m = await load();
    SB.plan({ events: [init('s5c'), result('', 's5c')] });
    const r = await within(settle(m.runClaude('oc_r5c', 'hi', true, [], null)), 8000, 'R5c');
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '');
  });

  test('result 非空 → 以 result 为准（不被前面的 assistant 文本盖掉）', { timeout: 20_000 }, async () => {
    const m = await load();
    SB.plan({ events: [init('s5d'), text('过程中的话'), result('最终结论', 's5d')] });
    const r = await within(settle(m.runClaude('oc_r5d', 'hi', true, [], null)), 8000, 'R5d');
    assert.equal(r.v, '最终结论');
  });

  test('result 为 null → 回落到 assistant 文本（回归）', { timeout: 20_000 }, async () => {
    const m = await load();
    SB.plan({ events: [init('s5e'), text('后备文本'), { type: 'result', subtype: 'success', is_error: false, result: null, session_id: 's5e' }] });
    const r = await within(settle(m.runClaude('oc_r5e', 'hi', true, [], null)), 8000, 'R5e');
    assert.equal(r.v, '后备文本');
  });
});

// ---------------------------------------------------------------------------------------------
describe('R6 输出行容错（L1）', () => {
  test('null / 42 / "x" / [] / true / 乱码 / 结构不对的行都不影响本轮；日志里没有行内容', { timeout: 20_000 }, async () => {
    const m = await load();
    SB.plan({
      events: [
        init('s6'),
        { raw: 'null' }, { raw: '42' }, { raw: '"x"' }, { raw: '[]' }, { raw: 'true' },
        { raw: '{ not json RAW-LINE-MARKER' },
        { raw: JSON.stringify({ type: 'assistant', message: { content: 'not-an-array RAW-LINE-MARKER2' } }) },
        text('正常内容'),
        result('正常内容', 's6'),
      ],
    });
    const uncaught = [];
    const onUncaught = (e) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    const cap = captureConsole();
    let r;
    try {
      r = await within(settle(m.runClaude('oc_r6', 'hi', true, [], null)), 8000, 'R6');
    } finally {
      cap.restore();
      process.off('uncaughtException', onUncaught);
    }
    assert.deepEqual(uncaught.map((e) => String(e?.message ?? e)), [], '不该有未捕获异常');
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '正常内容');
    assert.ok(!cap.lines.some((l) => l.includes('RAW-LINE-MARKER')), '日志里不能带原始行内容');
    assert.equal(cap.lines.filter((l) => l === '[claude] 跳过一行无法处理的输出').length, 1, '结构不对而抛错的那一行记一条固定文案的日志');
    assert.equal(m.isRunning('oc_r6'), false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('R8 未配置备用时，原会话不存在 → 不带 --resume 重试一次（M5）', () => {
  test('stderr 报 No conversation found → 第二个子进程不带 --resume，成功，会话表换成新 id，日志一行', { timeout: 30_000 }, async () => {
    SB.seedSessions({ oc_r8a: 'sid-old' });
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    SB.plan({ events: [], stderr: 'No conversation found with session ID: sid-old', exit: 1 }, okPlan('sid-new', '新会话的答案'));
    const cap = captureConsole();
    let r;
    try { r = await within(settle(m.runClaude('oc_r8a', 'hi', true, [], null)), 15_000, 'R8a'); } finally { cap.restore(); }
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '新会话的答案');
    const sp = SB.spawns();
    assert.equal(sp.length, 2);
    assert.equal(sp[0].resume, 'sid-old');
    assert.equal(sp[1].resume, null, '重试不带 --resume');
    assert.equal(SB.sessions().oc_r8a, 'sid-new');
    assert.ok(cap.lines.includes('[session] oc_r8a 原会话已不存在，已开新会话'), cap.lines.join('\n'));
  });

  test('错误 result 的 errors 数组里报 No conversation found（CLI 新版写法）同样重试一次', { timeout: 30_000 }, async () => {
    SB.seedSessions({ oc_r8b: 'sid-old-b' });
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    SB.plan(
      { events: [init('sid-old-b'), { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: sid-old-b'], session_id: 'sid-old-b' }], exit: 1 },
      okPlan('sid-new-b', '换了新会话'),
    );
    const r = await within(settle(m.runClaude('oc_r8b', 'hi', true, [], null)), 15_000, 'R8b');
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '换了新会话');
    const sp = SB.spawns();
    assert.equal(sp.length, 2);
    assert.equal(sp[1].resume, null);
    assert.equal(SB.sessions().oc_r8b, 'sid-new-b');
  });

  test('调用方显式给了 resumeId（每日新会话的交接）→ 不做这次重试，原样抛错交给调用方处理', { timeout: 30_000 }, async () => {
    SB.seedSessions({ oc_r8c: 'sid-keep' });
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    SB.plan({ events: [], stderr: 'No conversation found with session ID: sid-handoff', exit: 1 }, okPlan('sid-never', '不该跑到这里'));
    const r = await within(settle(m.runClaude('oc_r8c', 'hi', true, [], null, { resumeId: 'sid-handoff' })), 15_000, 'R8c');
    assert.equal(r.ok, false);
    assert.match(r.e.message + (r.e.cliStderr ?? ''), /No conversation found/);
    const sp = SB.spawns();
    assert.equal(sp.length, 1, '显式 resumeId 失败后不能自作主张开新会话');
    assert.equal(sp[0].resume, 'sid-handoff');
  });

  test('本轮已动过手（acted）→ 不重试', { timeout: 30_000 }, async () => {
    SB.seedSessions({ oc_r8d: 'sid-old-d' });
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    SB.plan({ events: [init('sid-old-d'), tool('Edit', 'x'), toolResult(), errResult('No conversation found with session ID: sid-old-d', 'sid-old-d')], exit: 1 });
    const r = await within(settle(m.runClaude('oc_r8d', 'hi', true, [], null)), 15_000, 'R8d');
    assert.equal(r.ok, false);
    assert.equal(SB.spawns().length, 1);
  });

  test('新会话也失败 → 只重试这一次，不无限循环', { timeout: 30_000 }, async () => {
    SB.seedSessions({ oc_r8e: 'sid-old-e' });
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    SB.plan({ events: [], stderr: 'No conversation found with session ID: whatever', exit: 1 });
    const r = await within(settle(m.runClaude('oc_r8e', 'hi', true, [], null)), 15_000, 'R8e');
    assert.equal(r.ok, false);
    assert.equal(SB.spawns().length, 2, '原会话 1 次 + 不带 --resume 的 1 次');
  });
});

// ---------------------------------------------------------------------------------------------
describe('CLAUDE_RESULT_GRACE_MS 的读法（M1）', () => {
  test('parseResultGraceMs：默认 10000；100–120000 的整数毫秒；写错按默认并只记一条日志，不回显取值', async () => {
    const m = await load();
    assert.equal(typeof m.parseResultGraceMs, 'function');
    const lines = [];
    const log = (s) => lines.push(String(s));
    assert.equal(m.parseResultGraceMs({}, log), 10_000);
    assert.equal(m.parseResultGraceMs({ CLAUDE_RESULT_GRACE_MS: '' }, log), 10_000);
    assert.equal(m.parseResultGraceMs({ CLAUDE_RESULT_GRACE_MS: '   ' }, log), 10_000);
    assert.equal(m.parseResultGraceMs({ CLAUDE_RESULT_GRACE_MS: '400' }, log), 400);
    assert.equal(m.parseResultGraceMs({ CLAUDE_RESULT_GRACE_MS: ' 2500 ' }, log), 2500);
    assert.equal(m.parseResultGraceMs({ CLAUDE_RESULT_GRACE_MS: '100' }, log), 100);
    assert.equal(m.parseResultGraceMs({ CLAUDE_RESULT_GRACE_MS: '120000' }, log), 120_000);
    assert.deepEqual(lines, [], '合法取值不该有日志');
    for (const bad of ['99', '120001', '-5', '1e3', '400.5', 'abc', '0', '4 00']) {
      lines.length = 0;
      assert.equal(m.parseResultGraceMs({ CLAUDE_RESULT_GRACE_MS: bad }, log), 10_000, bad);
      assert.equal(lines.length, 1, `「${bad}」应记一条日志`);
      assert.ok(lines[0].startsWith('[config]') && lines[0].includes('CLAUDE_RESULT_GRACE_MS'), lines[0]);
    }
    lines.length = 0;
    m.parseResultGraceMs({ CLAUDE_RESULT_GRACE_MS: 'secret-looking-value-xyz' }, log);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes('secret-looking-value-xyz'), '日志不回显配置的取值');
  });

  test('import 时按环境变量读取：写错 → 按默认、日志只一条且不含取值', async () => {
    const cap = captureConsole();
    applyEnv(sandboxEnv(SB, { CLAUDE_RESULT_GRACE_MS: 'garbage-value-xyz' }));
    try { await import(`${CLAUDE_URL}?graceBad=${Math.random()}`); } finally { cap.restore(); }
    const mine = cap.lines.filter((l) => l.includes('CLAUDE_RESULT_GRACE_MS'));
    assert.equal(mine.length, 1, cap.lines.join('\n'));
    assert.ok(mine[0].startsWith('[config]'));
    assert.ok(!mine[0].includes('garbage-value-xyz'));
  });
});
