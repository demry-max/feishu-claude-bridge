// BRIDGE-INBOUND-1（L1 + 残留）：固化提醒按轮绑定——只有带 opts.memoryNudge === true 的那次 runClaude 才能把提醒转成已固化 / 重新排上。
// 隔离目录 + 假 claude CLI，不联网。N12 切 index.js 里真实的提醒块验证接线。
import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeSandbox, sandboxEnv, applyEnv, loadClaude, captureConsole, within, settle, sleep, reapAll } from './fixtures/run-helpers.mjs';

const SB = makeSandbox('inbound1-nudge');
applyEnv(sandboxEnv(SB));
after(() => SB.cleanup());
afterEach(() => reapAll(SB));

const init = (sid = 'sid-x') => ({ type: 'system', subtype: 'init', session_id: sid });
const bigText = (t, tokens = 5000) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }], usage: { input_tokens: tokens } } });
const result = (r, sid = 'sid-x') => ({ type: 'result', subtype: 'success', is_error: false, result: r, session_id: sid });
const errResult = (r, sid = 'sid-x') => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result: r, session_id: sid });
const okPlan = (tokens = 5000, extra = {}) => ({ events: [init(), bigText('答案', tokens), result('答案')], ...extra });
const NOTICE = '带固化提醒的那一轮没跑成，下一轮再提醒';
const MARK = { memoryNudge: true };

async function load() {
  const m = await loadClaude(SB, { CONTEXT_NUDGE_TOKENS: '100', CLAUDE_MAX_RETRIES: '1', CLAUDE_IDLE_TIMEOUT_MS: undefined });
  m._setRetryDelaysForTest?.([20, 20]);
  return m;
}
/** 第 1 轮成功（上下文过阈值）→ 排上提醒（先不取） */
async function primed(m, chat) {
  SB.plan(okPlan());
  await within(m.runClaude(chat, 'turn1', true, [], null), 15_000);
}
/** 一轮不带标记的调用已起跑、还在跑；这时下一条消息到达并取走提醒；然后那一轮才结束 */
async function earlierRoundFinishesAfterTake(m, chat, tokens) {
  SB.plan(okPlan(tokens, { delayMs: 400 }));
  const r1 = m.runClaude(chat, 'R1 不带标记', true, [], null);
  await sleep(100);
  assert.equal(m.consumeMemoryNudge(chat), true, 'R2 到达取走提醒');
  await within(r1, 15_000);
}

describe('第 3 项 固化提醒按轮绑定', () => {
  test('N8（L1）取提醒前已起跑、不带标记的前一轮成功：不回收；随后带标记的那一轮成功：回收', async () => {
    const m = await load();
    await primed(m, 'oc_n8');
    await earlierRoundFinishesAfterTake(m, 'oc_n8', 5000);
    assert.equal(m.shouldRecycleSession('oc_n8'), false, '前一轮不带提醒，不能算已固化');
    SB.plan(okPlan());
    await within(m.runClaude('oc_n8', 'R2 带提醒', true, [], null, MARK), 15_000);
    assert.equal(m.shouldRecycleSession('oc_n8'), true, '带标记的那一轮成功才算已固化');
  });

  test('N9 带标记的那一轮失败、而之前已起跑的不带标记的一轮成功：提醒重新排上，不回收', async () => {
    const m = await load();
    const cap = captureConsole();
    try {
      await primed(m, 'oc_n9');
      await earlierRoundFinishesAfterTake(m, 'oc_n9', 10); // 低于阈值：noteContext 不会自己重新排上提醒
      SB.plan({ events: [init(), errResult('boom')], exit: 1 });
      const r = await settle(within(m.runClaude('oc_n9', 'R2 带提醒', true, [], null, MARK), 15_000));
      assert.equal(r.ok, false);
      assert.equal(cap.lines.filter((l) => l.includes(NOTICE)).length, 1, '「再提醒」日志恰好 1 行');
      assert.equal(m.consumeMemoryNudge('oc_n9'), true, '提醒重新排上');
      SB.plan(okPlan());
      await within(m.runClaude('oc_n9', 'R3 普通', true, [], null), 15_000);
      assert.equal(m.shouldRecycleSession('oc_n9'), false, '没有带提醒成功的轮，不回收');
    } finally { cap.restore(); }
  });

  test('N10（残留）取了提醒、没有任何调用 → 再取仍为 true；中间插一次不带标记的成功调用 → 不回收、再取仍为 true', async () => {
    const m = await load();
    await primed(m, 'oc_n10');
    assert.equal(m.consumeMemoryNudge('oc_n10'), true);
    assert.equal(m.consumeMemoryNudge('oc_n10'), true, '取走后带标记的那次还没起跑：提醒仍待注入');
    // 不带标记、用量低于阈值的成功轮：noteContext 不会自己排上提醒，下面的 true 只可能来自「未起跑视同待提醒」
    SB.plan(okPlan(10));
    await within(m.runClaude('oc_n10', '普通轮', true, [], null), 15_000);
    assert.equal(m.consumeMemoryNudge('oc_n10'), true);
    // 再来一次用量高于阈值的不带标记成功轮：上下文大，回收与否只取决于有没有「带标记的成功轮」
    SB.plan(okPlan(5000));
    await within(m.runClaude('oc_n10', '普通大轮', true, [], null), 15_000);
    assert.equal(m.shouldRecycleSession('oc_n10'), false, '不带标记的成功轮不算固化');
  });

  test('N11 带标记的那一轮起跑后再取 → false（同一轮不重复给提醒）', async () => {
    const m = await load();
    await primed(m, 'oc_n11');
    assert.equal(m.consumeMemoryNudge('oc_n11'), true);
    SB.plan(okPlan(10, { delayMs: 400 })); // 用量低于阈值：结束后也不会被 noteContext 重新排上
    const r = m.runClaude('oc_n11', 'R2 带提醒', true, [], null, MARK);
    await sleep(100);
    assert.equal(m.consumeMemoryNudge('oc_n11'), false, '已起跑，不再提醒');
    await within(r, 15_000);
  });

  test('N11b 带标记但这个会话没有取走过提醒：不碰提醒状态（成功不算固化）', async () => {
    const m = await load();
    await primed(m, 'oc_n11b');
    SB.plan(okPlan());
    await within(m.runClaude('oc_n11b', '带标记但没取提醒', true, [], null, MARK), 15_000);
    assert.equal(m.shouldRecycleSession('oc_n11b'), false);
  });

  test('N12 接线：取到提醒的轮把 runClaude 包一层加 memoryNudge: true（lane、turn 原样）；不取提醒的轮不带这个键', async () => {
    const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const start = 'if (isOwner && consumeMemoryNudge(sessionKey)) {';
    const a = SRC.indexOf(start);
    assert.ok(a >= 0);
    const b = SRC.indexOf('\n  enqueue(sessionKey', a);
    assert.ok(b > a);
    const block = SRC.slice(a, b);
    // eslint-disable-next-line no-new-func
    const run = new Function('scope', `with (scope) {\nlet prompt = 'P';\n${block}\nreturn prompt;\n}`);
    const go = (nudge) => {
      const seen = [];
      const toolTurn = { runClaude: (...args) => { seen.push(args); return 'ok'; } };
      const logs = [];
      const prompt = run({ isOwner: true, sessionKey: 'k', message: { chat_id: 'oc_x' }, toolTurn, consumeMemoryNudge: () => nudge, console: { log: (s) => logs.push(s) } });
      return { seen, toolTurn, prompt, logs };
    };
    const turn = { kind: 'owner-dm' };
    const withNudge = go(true);
    assert.match(withNudge.prompt, /系统提示/);
    withNudge.toolTurn.runClaude('k', 'p', true, ['t'], null, { lane: 'chat', turn });
    assert.deepEqual(withNudge.seen[0].slice(0, 5), ['k', 'p', true, ['t'], null]);
    assert.deepEqual(withNudge.seen[0][5], { lane: 'chat', turn, memoryNudge: true });
    assert.equal(withNudge.seen[0][5].turn, turn, 'turn 原样（同一个引用）');
    const without = go(false);
    without.toolTurn.runClaude('k', 'p', true, [], null, { lane: 'chat', turn });
    assert.equal('memoryNudge' in without.seen[0][5], false, '没取提醒的轮不带标记');
  });
});
