// BRIDGE-MISC-3（V05）：带固化提醒的那一轮没跑成，不能被当成「已固化」。
// 隔离目录 + 假 claude CLI（test/fixtures/fake-claude-run.mjs，按 FAKE_PLAN 演），不联网、不碰线上数据。
import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, sandboxEnv, applyEnv, loadClaude, captureConsole, within, settle, sleep, reapAll } from './fixtures/run-helpers.mjs';

const SB = makeSandbox('misc3-nudge');
applyEnv(sandboxEnv(SB));
after(() => SB.cleanup());
afterEach(() => reapAll(SB));

const init = (sid = 'sid-x') => ({ type: 'system', subtype: 'init', session_id: sid });
const bigText = (t, tokens = 5000) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }], usage: { input_tokens: tokens } } });
const result = (r, sid = 'sid-x') => ({ type: 'result', subtype: 'success', is_error: false, result: r, session_id: sid });
const errResult = (r, sid = 'sid-x') => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result: r, session_id: sid });
const okPlan = (answer = '答案', sid = 'sid-x') => ({ events: [init(sid), bigText(answer), result(answer, sid)] });
const NOTICE = '带固化提醒的那一轮没跑成，下一轮再提醒';

async function load(env = {}) {
  const m = await loadClaude(SB, { CONTEXT_NUDGE_TOKENS: '100', CLAUDE_MAX_RETRIES: '1', CLAUDE_IDLE_TIMEOUT_MS: undefined, ...env });
  m._setRetryDelaysForTest?.([20, 20]);
  return m;
}
const count = (lines, needle) => lines.filter((l) => l.includes(needle)).length;

/** 第 1 轮成功（上下文过阈值）→ 取提醒；返回 chatId 备用 */
async function primed(m, chat) {
  SB.plan(okPlan());
  await within(m.runClaude(chat, 'turn1', true, [], null), 15_000);
  assert.equal(m.consumeMemoryNudge(chat), true, '上下文过阈值后应排上提醒');
}

/** 失败那一轮之后的共同断言：不带提醒的成功轮不回收；提醒已重新排上；再带提醒成功则正常回收 */
async function assertRequeued(m, chat, cap) {
  // 第 3 轮用量低于阈值：noteContext 不会自己排上提醒，所以下面的 consumeMemoryNudge 为 true 只可能来自「重新排上」
  SB.plan({ events: [init(), bigText('答案', 10), result('答案')] });
  await within(m.runClaude(chat, 'turn3 普通', true, [], null), 15_000);
  assert.equal(m.shouldRecycleSession(chat), false, '提醒那轮没跑成，不能算已固化');
  assert.equal(m.consumeMemoryNudge(chat), true, '提醒应重新排上');
  SB.plan(okPlan());
  await within(m.runClaude(chat, 'turn4 带提醒', true, [], null), 15_000);
  assert.equal(m.shouldRecycleSession(chat), true, '正常路径不变：带提醒的轮成功后回收');
  assert.equal(count(cap.lines, NOTICE), 1, '「再提醒」日志恰好 1 行');
}

describe('V05 固化提醒', () => {
  test('N1 错误 result：下一轮不回收，提醒重新排上', async () => {
    const m = await load();
    const cap = captureConsole();
    try {
      await primed(m, 'oc_n1');
      SB.plan({ events: [init(), errResult('boom')], exit: 1 });
      const r = await settle(within(m.runClaude('oc_n1', 'turn2', true, [], null), 15_000));
      assert.equal(r.ok, false);
      await assertRequeued(m, 'oc_n1', cap);
    } finally { cap.restore(); }
  });

  test('N2 /cancel：同 N1', async () => {
    const m = await load();
    const cap = captureConsole();
    try {
      await primed(m, 'oc_n2');
      SB.plan({ events: [init(), bigText('想一想')], hang: true });
      const p = settle(within(m.runClaude('oc_n2', 'turn2', true, [], null), 15_000));
      await sleep(400);
      m.cancelRun('oc_n2');
      const r = await p;
      assert.equal(r.ok, false);
      assert.match(String(r.e.message), /CANCELLED/);
      await assertRequeued(m, 'oc_n2', cap);
    } finally { cap.restore(); }
  });

  test('N3 静默超时：同 N1', async () => {
    const m = await load({ CLAUDE_IDLE_TIMEOUT_MS: '300', CLAUDE_TIMEOUT_MS: '2400' });
    const cap = captureConsole();
    try {
      await primed(m, 'oc_n3');
      SB.plan({ events: [init()], hang: true });
      const r = await settle(within(m.runClaude('oc_n3', 'turn2', true, [], null), 20_000));
      assert.equal(r.ok, false);
      assert.match(String(r.e.message), /超时/);
      await assertRequeued(m, 'oc_n3', cap);
    } finally { cap.restore(); }
  });

  test('N4 第一次 529、自动重试成功：照常算固化，不重复提醒', async () => {
    const m = await load();
    const cap = captureConsole();
    try {
      await primed(m, 'oc_n4');
      SB.plan({ events: [errResult('API Error: 529 Overloaded')], exit: 1 }, okPlan());
      const r = await settle(within(m.runClaude('oc_n4', 'turn2 带提醒', true, [], null), 20_000));
      assert.equal(r.ok, true);
      assert.equal(m.shouldRecycleSession('oc_n4'), true, '重试后成功＝已固化');
      // 注意：成功那一轮的上下文仍 ≥ 阈值，noteContext 会照常重新排上「下一次」提醒（与本卡无关）；
      // 所以这里不看 consumeMemoryNudge，只看「没有因为失败而再提醒」的日志与回收标记
      assert.equal(count(cap.lines, NOTICE), 0, '中途重试成功不算没跑成');
    } finally { cap.restore(); }
  });

  test('N5 重试等待中 abortRetries：抛 CANCELLED，提醒重新排上', async () => {
    const m = await load();
    m._setRetryDelaysForTest([5_000, 5_000]);
    const cap = captureConsole();
    try {
      await primed(m, 'oc_n5');
      SB.plan({ events: [errResult('API Error: 529 Overloaded')], exit: 1 });
      const p = settle(within(m.runClaude('oc_n5', 'turn2 带提醒', true, [], null), 20_000));
      await sleep(800); // 第一次失败后进入退避等待
      assert.equal(m.abortRetries('oc_n5'), true, '应处于重试等待中');
      const r = await p;
      assert.equal(r.ok, false);
      assert.match(String(r.e.message), /CANCELLED/);
      m._setRetryDelaysForTest([20, 20]);
      await assertRequeued(m, 'oc_n5', cap);
    } finally { cap.restore(); }
  });

  test('N6 取提醒后 resetSession：下一轮成功不回收', async () => {
    const m = await load();
    await primed(m, 'oc_n6');
    m.resetSession('oc_n6');
    SB.plan(okPlan());
    await within(m.runClaude('oc_n6', 'after reset', true, [], null), 15_000);
    assert.equal(m.shouldRecycleSession('oc_n6'), false);
  });

  test('N7 没取提醒的失败轮：不产生「再提醒」日志，也不凭空排上提醒', async () => {
    const m = await load({ CONTEXT_NUDGE_TOKENS: '9999999' }); // 阈值远高于用量：不会自己排上
    const cap = captureConsole();
    try {
      SB.plan(okPlan());
      await within(m.runClaude('oc_n7', 'turn1', true, [], null), 15_000);
      SB.plan({ events: [init(), errResult('boom')], exit: 1 });
      const r = await settle(within(m.runClaude('oc_n7', 'turn2', true, [], null), 15_000));
      assert.equal(r.ok, false);
      assert.equal(count(cap.lines, NOTICE), 0);
      assert.equal(m.consumeMemoryNudge('oc_n7'), false);
    } finally { cap.restore(); }
  });
});
