// BRIDGE-INBOUND-1（V03）：群里 @ 机器人取不到机器人自身 id——入口与 buildPrompt 共用一份查询；入口无视 60 秒闸、网络类失败有界重试。
// 假 client；Date.now 用假时钟，重试等待把 ≥1000 ms 的 setTimeout 改成 0。不联网。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDE_FALLBACK_BIN = '';
const { buildPrompt, lookupBotOpenId, botIdFailureCount } = await import('../src/messages.js');
const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

const BOT = 'ou_bot_abcdef123456';
let ws; let realNow; let clock; let realErr; let realLog; let realSetTimeout; let errs; let logs;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound1-bot-'));
  realNow = Date.now; clock = 9_000_000; Date.now = () => clock;
  realErr = console.error; realLog = console.log; errs = []; logs = [];
  console.error = (...a) => errs.push(a.map(String).join(' '));
  console.log = (...a) => logs.push(a.map(String).join(' '));
  realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 1000 ? 0 : ms, ...rest);
});
afterEach(() => {
  Date.now = realNow; console.error = realErr; console.log = realLog; globalThis.setTimeout = realSetTimeout;
  fs.rmSync(ws, { recursive: true, force: true });
});
const mentions = [
  { key: '@_user_1', id: { open_id: BOT }, name: '机器人' },
  { key: '@_user_2', id: { open_id: 'ou_a' }, name: '张三' },
];
const textMsg = () => ({ message_id: 'om_t', message_type: 'text', content: JSON.stringify({ text: '@_user_1 请通知 @_user_2' }), mentions });
const netErr = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
const ok = () => Promise.resolve({ bot: { open_id: BOT } });

describe('B 机器人自身 open_id 共用查询', () => {
  test('B1 buildPrompt 一侧失败设了 60 秒闸之后：入口模式仍立即查；buildPrompt 一侧在闸内仍不查', async () => {
    let calls = 0; let bad = true;
    const c = { request() { calls++; if (bad) throw new Error('sync boom'); return ok(); } };
    assert.equal((await buildPrompt(c, textMsg(), ws)).prompt, '请通知');
    assert.equal(calls, 1);
    await buildPrompt(c, textMsg(), ws);
    assert.equal(calls, 1, 'buildPrompt 一侧在闸内不查');
    assert.equal(await lookupBotOpenId(c, { entry: true }), null);
    assert.equal(calls, 2, '入口无视闸立即查');
    bad = false;
    assert.equal(await lookupBotOpenId(c, { entry: true }), BOT);
    assert.equal(calls, 3);
    // 入口查到之后 buildPrompt 一侧直接用缓存
    assert.equal((await buildPrompt(c, textMsg(), ws)).prompt, '请通知 @张三');
    assert.equal(calls, 3);
  });

  test('B2 网络类失败（ECONNRESET）两次后成功：入口拿到 id、请求 3 次；此后两侧都走缓存', async () => {
    let calls = 0;
    const c = { request() { calls++; if (calls <= 2) return Promise.reject(netErr()); return ok(); } };
    assert.equal(await lookupBotOpenId(c, { entry: true }), BOT);
    assert.equal(calls, 3);
    assert.equal(botIdFailureCount(c), 0);
    assert.equal(await lookupBotOpenId(c, { entry: true }), BOT);
    assert.equal((await buildPrompt(c, textMsg(), ws)).prompt, '请通知 @张三');
    assert.equal(calls, 3, '缓存之后不再请求');
    assert.equal(logs.filter((l) => l.startsWith('[bot] open_id 已取到')).length, 1, '取到时只打一行');
    assert.ok(logs.every((l) => !l.includes(BOT)), '日志不含完整 id');
  });

  test('B2b 网络类失败一直失败：最多请求 3 次（首次 + 重试 2 次），最终失败计 1 次', async () => {
    let calls = 0;
    const c = { request() { calls++; return Promise.reject(netErr()); } };
    assert.equal(await lookupBotOpenId(c, { entry: true }), null);
    assert.equal(calls, 3);
    assert.equal(botIdFailureCount(c), 1);
  });

  test('B3 非网络类失败：不重试（请求 1 次），连续失败计数 1、2、3 递增；成功后清零', async () => {
    let calls = 0; let bad = true;
    const c = { request() { calls++; if (bad) return Promise.reject(Object.assign(new Error('permission denied'), { response: { data: { code: 99991672 } } })); return ok(); } };
    for (let i = 1; i <= 3; i++) {
      assert.equal(await lookupBotOpenId(c, { entry: true }), null);
      assert.equal(calls, i, '每次入口查询只请求 1 次');
      assert.equal(botIdFailureCount(c), i);
    }
    bad = false;
    assert.equal(await lookupBotOpenId(c, { entry: true }), BOT);
    assert.equal(botIdFailureCount(c), 0);
  });

  test('B3b 同一次失败只打一行：入口模式发起的不在 messages.js 里打；buildPrompt 一侧发起的打原来那句', async () => {
    const c = { request() { return Promise.reject(new Error('nope')); } };
    await lookupBotOpenId(c, { entry: true });
    assert.equal(errs.length, 0, '入口一侧的那一行由 index.js 打');
    clock += 61_000;
    await buildPrompt(c, textMsg(), ws);
    assert.equal(errs.filter((l) => l.includes('按不保留 @ 人名处理')).length, 1);
  });

  test('B4 入口与 buildPrompt 同时查、接口挂起后放行：只请求 1 次，两边都拿到 id', async () => {
    let calls = 0; let release;
    const gate = new Promise((r) => { release = r; });
    const c = { request: async () => { calls++; await gate; return { bot: { open_id: BOT } }; } };
    const ps = [buildPrompt(c, textMsg(), ws), lookupBotOpenId(c, { entry: true }), buildPrompt(c, textMsg(), ws)];
    await new Promise((r) => setImmediate(r));
    release();
    const [a, id, b] = await Promise.all(ps);
    assert.equal(calls, 1);
    assert.equal(id, BOT);
    assert.equal(a.prompt, '请通知 @张三');
    assert.equal(b.prompt, '请通知 @张三');
  });

  // ---- 接线：切 index.js 里真实的 getBotOpenId、群消息判定与启动通知 ----
  const cutBetween = (start, end) => {
    const a = SRC.indexOf(start); assert.ok(a >= 0, `找不到：${start}`);
    const b = SRC.indexOf(end, a + start.length); assert.ok(b > a, `找不到：${end}`);
    return SRC.slice(a, b + end.length);
  };

  function groupGate({ request }) {
    const client = { request };
    const getSrc = cutBetween('async function getBotOpenId() {', '\n}\n');
    const blockSrc = cutBetween("if (message.chat_type !== 'p2p') {", '    if (!mentioned) return;\n  }');
    // eslint-disable-next-line no-new-func
    const factory = new Function('scope', `with (scope) {\n${getSrc}\nreturn async function gate(message) {\n${blockSrc}\nreturn 'pass';\n};\n}`);
    return factory({ client, lookupBotOpenId, botIdFailureCount, console });
  }

  test('B5 接线：取不到 id 时群消息被丢、日志恰好 1 行（含「暂按未 @ 处理」「连续第 N 次」、不含消息内容）；没有 mentions 的群消息不触发查询', async () => {
    let calls = 0;
    const gate = groupGate({ request() { calls++; return Promise.reject(new Error('down')); } });
    const msg = { chat_type: 'group', content: '{"text":"绝密正文 XYZ"}', mentions: [{ id: { open_id: 'ou_a' }, name: '张三' }] };
    assert.equal(await gate(msg), undefined, '取不到 id：丢');
    assert.equal(calls, 1);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /群消息暂按未 @ 处理/);
    assert.match(errs[0], /连续第 1 次/);
    assert.ok(!errs[0].includes('XYZ') && !errs[0].includes('ou_a'));
    assert.equal(await gate(msg), undefined);
    assert.match(errs[1], /连续第 2 次/);
    assert.equal(calls, 2, '无视 60 秒闸：每条群消息都再查');
    // 没有 mentions（缺失或空数组）：直接丢，不查
    assert.equal(await gate({ chat_type: 'group', content: 'x' }), undefined);
    assert.equal(await gate({ chat_type: 'group', mentions: [] }), undefined);
    assert.equal(calls, 2, '没 @ 任何人不查机器人 id');
    assert.equal(errs.length, 2);
  });

  test('B5b 接线：取到 id 且 @ 了机器人 → 放行；@ 了别人 → 丢', async () => {
    const gate = groupGate({ request: ok });
    assert.equal(await gate({ chat_type: 'group', mentions: [{ id: { open_id: BOT } }] }), 'pass');
    assert.equal(await gate({ chat_type: 'group', mentions: [{ id: { open_id: 'ou_a' } }] }), undefined);
    assert.equal(errs.length, 0);
  });

  async function startupText(botIdStartupMissing) {
    const src = cutBetween('async function announceStartup() {', '\n}\n');
    const sent = [];
    class FakeDate { static now() { return 1e15; } toLocaleString() { return 'T'; } }
    const scope = {
      OWNER_OPEN_ID: 'ou_owner', loadOwner: () => null, process: { env: {} },
      fs: { readFileSync() { throw new Error('ENOENT'); }, writeFileSync() {} }, STARTUP_STAMP: '/x/stamp', Date: FakeDate,
      client: { im: { v1: { message: { create: async (a) => { sent.push(JSON.parse(a.data.content).text); } } } } },
      cliProblem: null, scopeProblem: null, botIdStartupMissing, console,
    };
    // eslint-disable-next-line no-new-func
    await new Function('scope', `with (scope) {\n${src}\nreturn announceStartup();\n}`)(scope);
    return sent[0];
  }

  test('B6 启动通知：取不到机器人 id 时多一行；取到时正文与改前逐字相同', async () => {
    const base = '🤖 桥接已启动（T）。若此前发过消息没收到回复，请重发一次。';
    assert.equal(await startupText(false), base);
    assert.equal(await startupText(true), `${base}\n\n⚠️ 取不到机器人自身的 open_id，群里 @ 机器人暂时不会有反应；收到下一条 @ 消息时会自动再试。`);
  });

  test('B6b 启动自检链：并行取机器人 id，两项自检都结束再发启动通知，且仍在 startToolAuditSummary 之前', () => {
    assert.match(SRC, /lookupBotOpenId\(client, \{ entry: true \}\)\.then\(/);
    assert.ok(SRC.includes('scopeSelfCheck().finally(() => botCheck.finally(() => announceStartup()));'));
    assert.ok(SRC.indexOf('botCheck.finally(') < SRC.indexOf('startToolAuditSummary({'));
  });
});
