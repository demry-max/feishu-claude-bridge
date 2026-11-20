// BRIDGE-RUN-2：claude.js 的两处行为（真实 runClaude + 假 CLI；隔离目录，不碰线上 data/ 与 workspace/，不联网）。
//   H1–H7  owner 私聊「原会话已失效、这一轮换了新会话」时，答案后面追加一句提示；其他场合、其他结果一律不加。
//   G1     同一个会话键上「取消后立刻开下一轮」：被取消的那一轮落定时，不能把下一轮的运行登记一并删掉
//          （settle 里 running 表的「是自己才删」守卫；RUN-1 复审点名缺测试）。
// 阈值类配置、会话表都在 claude.js import 时读取：每个用例重新 import 一份（loadClaude），
// 所以 seedSessions 必须写在 load 之前。每个用例都有 timeout，等待走 within()，afterEach 收掉假 CLI 与备用账号配置。
import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  makeSandbox, sandboxEnv, applyEnv, loadClaude, captureConsole, within, settle, waitFor, waitGone, reapAll, FAKE_SRC,
} from './fixtures/run-helpers.mjs';
import { configureAccountFallback } from '../src/account-fallback.js';
import { resolveTurn } from '../src/turn-context.js';
import { SCHED_DEST_OWNER_P2P } from '../src/biz-wiring.js';

const SB = makeSandbox('run2-claude');
applyEnv(sandboxEnv(SB));
// account-fallback.js 在静态 import 时读过一次外部环境（CLAUDE_FALLBACK_BIN）；先收回「未配置」，免得本机的设置混进来
configureAccountFallback({ fallbackBin: '' });
after(() => SB.cleanup());
afterEach(() => {
  configureAccountFallback({ fallbackBin: '' });
  return reapAll(SB);
});

// ---- 假 CLI 的事件 ----
const init = (sid = 'sid-x') => ({ type: 'system', subtype: 'init', session_id: sid });
const text = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const result = (r, sid = 'sid-x') => ({ type: 'result', subtype: 'success', is_error: false, result: r, session_id: sid });
const errResult = (r, sid = 'sid-x') => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result: r, session_id: sid });
const okPlan = (sid, answer) => ({ events: [init(sid), text(answer), result(answer, sid)] });
/** 原会话不存在：没出 result 就退出，stderr 里是那句固定话 */
const gone = (sid = 'stale') => ({ events: [], stderr: `No conversation found with session ID: ${sid}`, exit: 1 });
const LIMIT = (sid = 'sid-lim') => ({ events: [init(sid), errResult('Claude AI usage limit reached|1763600000', sid)], exit: 1 });

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** 备用账号的假 CLI：同一个假程序，只多带一个 FAKE_ROLE=fallback（假 CLI 把环境变量的键名写进启动日志） */
function makeFallbackBin(name = 'claude-fallback') {
  const p = path.join(SB.root, name);
  fs.writeFileSync(p, `#!/bin/sh\nFAKE_ROLE=fallback exec ${shq(process.execPath)} ${shq(FAKE_SRC)} "$@"\n`, { mode: 0o755 });
  return p;
}

/** 重新 import 一份 claude.js；退避缩短到 20ms（测试专用钩子，没有对外的环境变量） */
async function load(env = {}) {
  const m = await loadClaude(SB, env);
  m._setRetryDelaysForTest?.([20, 20]);
  return m;
}

const ownerDm = (chatId) => resolveTurn({ source: 'chat', isOwner: true, chatType: 'p2p', chatId });
const sessionLine = (key) => `[session] ${key} 原会话已不存在，已开新会话`;

// ---------------------------------------------------------------------------------------------
describe('H1–H7 owner 私聊换了新会话：答案后追加一句提示', () => {
  test('H1 owner 私聊、原会话不存在 → 第二个子进程不带 --resume，返回「新答案 + 空一行 + 提示」；[session] 日志原文不变', { timeout: 30_000 }, async () => {
    SB.seedSessions({ oc_h1: 'stale' });
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    // 常量本身要有实际内容：否则「期望值也用同一个常量」的断言挡不住把提示改成空串
    assert.equal(typeof m.SESSION_RENEWED_NOTE, 'string');
    assert.match(m.SESSION_RENEWED_NOTE, /会话已失效/);
    assert.match(m.SESSION_RENEWED_NOTE, /新会话/);
    assert.ok(m.SESSION_RENEWED_NOTE.length > 20 && m.SESSION_RENEWED_NOTE.length < 200, `提示长度 ${m.SESSION_RENEWED_NOTE.length}`);
    SB.plan(gone('stale'), okPlan('sid-h1-new', '新答案'));
    const cap = captureConsole();
    let r;
    try {
      r = await within(settle(m.runClaude('oc_h1', 'hi', true, [], null, { turn: ownerDm('oc_h1') })), 15_000, 'H1');
    } finally { cap.restore(); }
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, `新答案\n\n${m.SESSION_RENEWED_NOTE}`);
    const sp = SB.spawns();
    assert.equal(sp.length, 2);
    assert.equal(sp[0].resume, 'stale');
    assert.equal(sp[1].resume, null, '换新会话那一轮不带 --resume');
    assert.equal(SB.sessions().oc_h1, 'sid-h1-new');
    assert.ok(cap.lines.includes(sessionLine('oc_h1')), `[session] 日志文案不能变：\n${cap.lines.join('\n')}`);
  });

  test('H2 同样换了新会话，但不是 owner 私聊（群里的 owner / 访客 / 两种定时 / 心跳 / 没传 turn）→ 一律不加提示', { timeout: 60_000 }, async () => {
    const cases = [
      { name: 'owner-group', key: 'guest:oc_h2grp:ou_owner_h', isOwner: true, turn: resolveTurn({ source: 'chat', isOwner: true, chatType: 'group', chatId: 'oc_h2grp', senderOpenId: 'ou_owner_h' }) },
      { name: 'guest', key: 'guest:oc_h2gst:ou_guest_h', isOwner: false, turn: resolveTurn({ source: 'chat', isOwner: false, chatType: 'p2p', chatId: 'oc_h2gst', senderOpenId: 'ou_guest_h' }) },
      { name: 'sched-owner-dm', key: 'sched:h2-dm.json', isOwner: true, turn: resolveTurn({ source: 'sched', isOwner: true, schedDest: SCHED_DEST_OWNER_P2P, chatId: 'sched:h2-dm.json' }) },
      { name: 'sched-other', key: 'sched:h2-other.json', isOwner: true, turn: resolveTurn({ source: 'sched', isOwner: true, schedDest: 'other', chatId: 'sched:h2-other.json', ownerDmKnown: true }) },
      { name: 'heartbeat', key: 'heartbeat:h2', isOwner: true, turn: resolveTurn({ source: 'heartbeat', isOwner: true, chatId: 'heartbeat:h2' }) },
      { name: '没传 turn', key: 'oc_h2noturn', isOwner: true, turn: undefined },
    ];
    for (const c of cases) {
      if (c.turn) assert.equal(c.turn.kind, c.name, `造出来的 turn 要正是要测的那一种：${c.name}`);
    }
    SB.seedSessions(Object.fromEntries(cases.filter((c) => !c.key.startsWith('sched')).map((c) => [c.key, 'stale'])));
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    for (const c of cases) {
      SB.plan(gone('stale'), okPlan(`sid-h2-${c.name}`, '新答案'));
      const cap = captureConsole();
      let r;
      try {
        r = await within(settle(m.runClaude(c.key, 'hi', c.isOwner, [], null, c.turn ? { turn: c.turn } : {})), 15_000, `H2 ${c.name}`);
      } finally { cap.restore(); }
      assert.equal(r.ok, true, `${c.name}：${r.e?.message}`);
      assert.equal(SB.spawns().length, 2, `${c.name}：这一轮确实走了「原会话不存在 → 换新会话」（否则下面的「没提示」没有意义）`);
      assert.ok(cap.lines.includes(sessionLine(c.key)), `${c.name}：应有 [session] 日志\n${cap.lines.join('\n')}`);
      assert.equal(r.v, '新答案', `${c.name}：不该有提示`);
    }
  });

  test('H3 owner 私聊、会话正常续上（没换新会话）→ 不加提示', { timeout: 30_000 }, async () => {
    SB.seedSessions({ oc_h3: 'sid-h3-old' });
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    SB.plan(okPlan('sid-h3-old', '答案3'));
    const r = await within(settle(m.runClaude('oc_h3', 'hi', true, [], null, { turn: ownerDm('oc_h3') })), 15_000, 'H3');
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(r.v, '答案3');
    const sp = SB.spawns();
    assert.equal(sp.length, 1);
    assert.equal(sp[0].resume, 'sid-h3-old', '这一轮是续的旧会话');
  });

  test('H4 换了新会话、新会话也失败 → 抛错，错误信息里没有提示（失败照旧，不带这句话）', { timeout: 30_000 }, async () => {
    SB.seedSessions({ oc_h4: 'stale' });
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    SB.plan(gone('whatever')); // 只剩一条计划：两个子进程都用它
    const r = await within(settle(m.runClaude('oc_h4', 'hi', true, [], null, { turn: ownerDm('oc_h4') })), 15_000, 'H4');
    assert.equal(r.ok, false);
    assert.equal(SB.spawns().length, 2, '原会话 1 次 + 不带 --resume 的 1 次，就这两次');
    assert.match(String(r.e.message) + String(r.e.cliStderr ?? ''), /No conversation found/, '拿到的是真实的失败，不是别的错');
    assert.ok(!String(r.e.message).includes('会话已失效'), r.e.message);
    assert.ok(!String(r.e.message).includes(m.SESSION_RENEWED_NOTE), r.e.message);
  });

  test('H5 换了新会话、新会话遇到 529，网络类自动重试后成功 → 提示还在（本轮的「换过新会话」不随重试清零），共 3 个子进程', { timeout: 40_000 }, async () => {
    SB.seedSessions({ oc_h5: 'stale' });
    const m = await load({ CLAUDE_MAX_RETRIES: '2' });
    SB.plan(
      gone('stale'),
      { events: [init('sid-h5-b'), errResult('API Error: 529 Overloaded', 'sid-h5-b')], exit: 1 },
      okPlan('sid-h5-c', '第三次的答案'),
    );
    const cap = captureConsole();
    let r;
    try {
      r = await within(settle(m.runClaude('oc_h5', 'hi', true, [], null, { turn: ownerDm('oc_h5') })), 25_000, 'H5');
    } finally { cap.restore(); }
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(SB.spawns().length, 3, '原会话不存在 → 新会话遇 529 → 网络重试成功');
    assert.ok(cap.lines.some((l) => l.startsWith('[retry] oc_h5 网络类失败')), `应走过一次网络重试\n${cap.lines.join('\n')}`);
    assert.equal(r.v, `第三次的答案\n\n${m.SESSION_RENEWED_NOTE}`);
  });

  test('H6 配了备用账号：(a) 原会话不存在 → 换新会话成功；(c) 主用额度用完切到备用、备用上也没有这个会话 → 在备用上换新会话；两种都带提示', { timeout: 60_000 }, async () => {
    SB.seedSessions({ oc_h6a: 'stale', oc_h6c: 'stale' });
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    const bin = makeFallbackBin();
    configureAccountFallback({ fallbackBin: bin, log: () => {} });

    // (a) 主用上原会话不存在，不带 --resume 重开后成功；备用不参与
    SB.plan(gone('stale'), okPlan('sid-h6a', '答案6a'));
    const ra = await within(settle(m.runClaude('oc_h6a', 'hi', true, [], null, { turn: ownerDm('oc_h6a') })), 20_000, 'H6a');
    assert.equal(ra.ok, true, ra.e?.message);
    assert.equal(ra.v, `答案6a\n\n${m.SESSION_RENEWED_NOTE}`);
    const spa = SB.spawns();
    assert.equal(spa.length, 2);
    assert.ok(spa.every((s) => !s.envKeys.includes('FAKE_ROLE')), '两个子进程都是主用的 CLI');

    // (c) 主用额度用完 → 备用（带着旧会话 id，备用的配置目录里没有它）→ 不带 --resume 在备用上重开
    configureAccountFallback({ fallbackBin: bin, log: () => {} }); // 回到全新状态（上面没进过备用期，保险起见重置）
    SB.plan(LIMIT('sid-lim-6c'), gone('stale'), okPlan('sid-h6c', '答案6c'));
    const rc = await within(settle(m.runClaude('oc_h6c', 'hi', true, [], null, { turn: ownerDm('oc_h6c') })), 20_000, 'H6c');
    assert.equal(rc.ok, true, rc.e?.message);
    assert.equal(rc.v, `答案6c\n\n${m.SESSION_RENEWED_NOTE}`);
    const spc = SB.spawns();
    assert.equal(spc.length, 3, '主用（额度）→ 备用（会话不存在）→ 备用（新会话）');
    assert.deepEqual(spc.map((s) => s.envKeys.includes('FAKE_ROLE')), [false, true, true], '后两个子进程是备用的 CLI');
    assert.equal(spc[2].resume, null);
  });

  test('H7 换了新会话、但这一轮答出来是空串 → 原样返回空串，不追加提示', { timeout: 30_000 }, async () => {
    SB.seedSessions({ oc_h7: 'stale' });
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    SB.plan(gone('stale'), { events: [init('sid-h7'), result('', 'sid-h7')] });
    const cap = captureConsole();
    let r;
    try {
      r = await within(settle(m.runClaude('oc_h7', 'hi', true, [], null, { turn: ownerDm('oc_h7') })), 15_000, 'H7');
    } finally { cap.restore(); }
    assert.equal(r.ok, true, r.e?.message);
    assert.equal(SB.spawns().length, 2, '确实换过新会话');
    assert.ok(cap.lines.includes(sessionLine('oc_h7')));
    assert.equal(r.v, '');
  });
});

// ---------------------------------------------------------------------------------------------
describe('G1 取消后立刻开下一轮：被取消那一轮落定时不能删掉下一轮的运行登记', () => {
  test('同一个会话键：第一轮（忽略 SIGTERM）被取消、马上开第二轮；第一轮约 2 秒后以 CANCELLED 落定时，第二轮仍在运行', { timeout: 60_000 }, async () => {
    const K = 'oc_g1';
    const m = await load({ CLAUDE_MAX_RETRIES: '0' });
    SB.plan(
      { events: [init('sid-g1-a')], hang: true, ignoreTerm: true },
      { events: [init('sid-g1-b')], hang: true },
    );
    const p1 = settle(m.runClaude(K, 'one', true, [], null));
    await waitFor(() => SB.spawns().length === 1 && m.isRunning(K), 8000, 'G1 第一轮子进程起来');
    assert.equal(m.cancelRun(K), true);
    assert.equal(m.isRunning(K), false, 'cancelRun 自己会摘掉登记');
    const p2 = settle(m.runClaude(K, 'two', true, [], null));
    await waitFor(() => SB.spawns().length === 2 && m.isRunning(K), 8000, 'G1 第二轮子进程起来');

    // 第一轮要等 SIGTERM 被忽略、约 2 秒后升级到 SIGKILL 才会落定；此刻第二轮早已登记
    const r1 = await within(p1, 15_000, 'G1 第一轮落定');
    assert.equal(r1.ok, false);
    assert.equal(r1.e.cancelled, true);
    assert.match(r1.e.message, /CANCELLED/);
    assert.equal(m.isRunning(K), true, '第一轮落定后，第二轮的登记还在（不能被第一轮的收尾误删）');
    assert.equal(m.cancelRun(K), true, '所以还取消得到第二轮');

    const r2 = await within(p2, 15_000, 'G1 第二轮落定');
    assert.equal(r2.ok, false);
    assert.equal(r2.e.cancelled, true);
    assert.match(r2.e.message, /CANCELLED/);
    assert.equal(m.isRunning(K), false);
    assert.deepEqual(await waitGone(SB.spawns().map((s) => s.pid), 4000), [], '两个假 CLI 都没了');
  });
});
