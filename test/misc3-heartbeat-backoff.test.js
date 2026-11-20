// BRIDGE-MISC-3（V06）：心跳退避只看决定到期的字段（status / next_check_at / escalate_after）。
// 只改 updated_at、notes 等其它字段不清零；改了到期字段照旧清零。假时钟、桩模型，不联网。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkEnv, harness, writeTask, readTask, plus } from './vr-harness.js';

const base = (o = {}) => ({ title: '跟进报价单', status: 'open', next_check_at: '2026-11-16T09:00', created_at: '2026-11-15T09:00', ...o });
const pad = (n) => String(n).padStart(2, '0');

/** 16 拍、每拍 30 分钟；mutate(task, n) 在第 n 次调模型时改台账（模拟模型改了文件） */
async function run16(mutate, init = base()) {
  const env = mkEnv();
  writeTask(env, 'quote', init);
  let n = 0;
  const h = harness(env, {
    runImpl: async () => {
      n += 1;
      if (mutate) writeTask(env, 'quote', mutate(readTask(env, 'quote'), n));
      return 'HEARTBEAT_OK';
    },
  });
  const trace = [];
  for (let i = 0; i < 16; i++) {
    const before = h.calls.length;
    await h.hb.beat();
    trace.push(h.calls.length > before ? 'S' : 'K');
    h.setNow(plus(h.now(), 30));
  }
  return { calls: h.calls.length, trace: trace.join('') };
}

/** 手动逐拍：每拍之后可在拍与拍之间改台账 */
function stepper(env, h) {
  return async (n) => {
    let out = '';
    for (let i = 0; i < n; i++) {
      const before = h.calls.length;
      await h.hb.beat();
      out += h.calls.length > before ? 'S' : 'K';
      h.setNow(plus(h.now(), 30));
    }
    return out;
  };
}

describe('V06 退避只看到期字段', () => {
  test('B1 每次只改 updated_at：与文件不动的对照逐拍相同', async () => {
    const control = await run16(null);
    const r = await run16((t, n) => ({ ...t, updated_at: `2026-11-16T10:${pad(n)}` }));
    assert.deepEqual(r, control);
    assert.equal(control.calls, 6, '对照组 16 拍调模型 6 次');
  });

  test('B2 每次只改 notes：同 B1', async () => {
    const control = await run16(null);
    const r = await run16((t, n) => ({ ...t, notes: `第 ${n} 次：对方还没回` }));
    assert.deepEqual(r, control);
  });

  test('B3 next_check_at 只在两种写法间来回换（同一时刻）：同 B1', async () => {
    const control = await run16(null);
    const r = await run16((t, n) => ({ ...t, next_check_at: n % 2 ? '2026-11-16T09:00:00' : '2026-11-16T09:00' }));
    assert.deepEqual(r, control);
  });

  test('B4 退避中把 status 从 open 改成 waiting（仍到期）：下一拍照送，之后从头计', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', base());
    const h = harness(env, { answer: 'HEARTBEAT_OK' });
    const step = stepper(env, h);
    assert.equal(await step(4), 'SSSK');
    writeTask(env, 'quote', { ...readTask(env, 'quote'), status: 'waiting' });
    assert.equal(await step(6), 'SSSKSK');
  });

  test('B5a 退避中改 next_check_at（仍在过去）：清零从头计', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', base());
    const h = harness(env, { answer: 'HEARTBEAT_OK' });
    const step = stepper(env, h);
    assert.equal(await step(4), 'SSSK');
    writeTask(env, 'quote', { ...readTask(env, 'quote'), next_check_at: '2026-11-16T09:30' });
    assert.equal(await step(6), 'SSSKSK');
  });

  test('B5b 退避中改 escalate_after（新旧都已越过，不是首次越过的豁免）：清零从头计', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', base({ escalate_after: '2026-11-16T09:10' }));
    const h = harness(env, { answer: 'HEARTBEAT_OK' });
    const step = stepper(env, h);
    assert.equal(await step(4), 'SSSK');
    writeTask(env, 'quote', { ...readTask(env, 'quote'), escalate_after: '2026-11-16T09:20' });
    assert.equal(await step(6), 'SSSKSK');
  });

  test('B6 升级前的状态（记录里只有 last_hash、没有到期指纹）：第一拍判为 changed 照送，不抛错', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', base());
    const h1 = harness(env, { answer: 'HEARTBEAT_OK' });
    await h1.hb.beat();
    // 改写状态：去掉到期指纹，并摆出「正在退避」的样子
    const st = h1.readState();
    assert.ok(st.tasks.quote.due_fp, '新版会记下到期指纹');
    delete st.tasks.quote.due_fp;
    st.tasks.quote.stale_runs = 5;
    st.tasks.quote.skip_left = 5;
    fs.writeFileSync(env.stateFile, JSON.stringify(st));
    const h2 = harness(env, { answer: 'HEARTBEAT_OK', now: plus(h1.now(), 30) });
    const r = await h2.hb.beat();
    assert.equal(h2.calls.length, 1, '没有指纹＝changed，照送模型');
    assert.notEqual(r.action, 'backoff');
    const after = h2.readState().tasks.quote;
    assert.ok(after.due_fp, '照送之后补上指纹');
    assert.ok(!(after.skip_left > 0), '退避已清零');
  });

  test('B7 提示词：新句在、旧句不在', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', base());
    const h = harness(env, { answer: 'HEARTBEAT_OK' });
    await h.hb.beat();
    assert.equal(h.calls.length, 1);
    const prompt = h.calls[0].find((a) => typeof a === 'string' && a.includes('## 规则'));
    assert.ok(prompt, '应能在调用参数里找到心跳提示词');
    assert.ok(prompt.includes('推不动的就把 `next_check_at` 往后推，并在 `notes` 记一句原因。'));
    assert.ok(!prompt.includes('同时更新 `updated_at`'));
  });
});
