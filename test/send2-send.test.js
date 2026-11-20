// BRIDGE-SEND-2：sendCardWithFallback 多段发送、reply / sendMarkdown 接线。
// 全部用桩：不连飞书、不读 .env、不用真实 HOME。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { feishuUuid, withUuid, contentPart } from '../src/send-key.js';
import { buildMarkdownCard, sendCardWithFallback } from '../src/events.js';
import { redact } from '../src/outbound.js';
import { fireJob, schedSendKey } from '../src/scheduler.js';
import { resolveTurn } from '../src/turn-context.js';
import { schedDestOf } from '../src/biz-wiring.js';
import { schedDiagPrompt } from '../src/claude.js';
import { splitMessage } from '../src/split-message.js';

const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
function cut(start, end) {
  const a = SRC.indexOf(start);
  assert.ok(a >= 0, `index.js 里找不到：${start}`);
  const b = SRC.indexOf(end, a + start.length);
  assert.ok(b > a, `index.js 里找不到 ${start} 之后的：${JSON.stringify(end)}`);
  return SRC.slice(a, b + end.length);
}
const DM = 'oc_ownerdm0000000001';
const KEY = schedSendKey('daily.json', '2026-11-20T01:00:00.000Z');
const netErr = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const httpErr = () => Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { code: 230099 } } });
const cps = (s) => { let n = 0; for (const _ of s) n += 1; return n; };
const withFastTimers = async (fn) => {
  const o = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms, ...r) => o(f, ms >= 1000 ? 0 : ms, ...r);
  try { return await fn(); } finally { globalThis.setTimeout = o; }
};
function collectLogs(t) {
  const lines = [];
  const grab = (...a) => { lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')); };
  t.mock.method(console, 'error', grab);
  t.mock.method(console, 'log', grab);
  t.mock.method(console, 'warn', grab);
  return lines;
}
// failIf(data, n) 返回 Error 就抛；n 从 1 起
function fakeCreate(failIf = () => null) {
  const reqs = [];
  const create = async (data) => {
    reqs.push(data);
    const e = failIf(data, reqs.length);
    if (e) throw e;
    return { data: { message_id: `om_${reqs.length}` } };
  };
  return { reqs, create };
}
const cardText = (req) => JSON.parse(req.content).elements?.[0]?.content ?? JSON.parse(req.content).body?.elements?.[0]?.content;
const BUTTONS = [{ label: '好', type: 'primary', value: { a: 1 } }, { label: '否', type: 'default', value: { a: 2 } }, { label: '稍后', type: 'default', value: { a: 3 } }];
const LONG = `机密正文${'汉'.repeat(80_000)}`; // 约 240 KB，按 64 000 字节预算 ≥ 4 段

// 夹具：f49b44b 的 sendCardWithFallback（src/events.js:58-71）原文
async function oldSend(create, chunk, opts = {}, onFallback = () => {}) {
  const actions = Array.isArray(opts?.actions) && opts.actions.length ? opts.actions : null;
  const key = opts?.idempotencyKey;
  let res;
  try {
    res = await create(withUuid({ msg_type: 'interactive', content: JSON.stringify(buildMarkdownCard(chunk, actions)) }, key, contentPart('card', chunk)));
  } catch (e) {
    onFallback(e);
    res = await create(withUuid({ msg_type: 'text', content: JSON.stringify({ text: chunk }) }, key, e?.response ? contentPart('text', chunk) : contentPart('card', chunk)));
  }
  const id = res?.data?.message_id;
  return typeof id === 'string' && id ? id : undefined;
}

describe('C 多段发送', () => {
  test('C1 差分：单段语料 × {无键, 有键} × {无按钮, 三按钮} × {成功, 卡片 400, 卡片网络错} 与旧实现逐字相同', async (t) => {
    collectLogs(t);
    const corpus = ['', '短消息', '含"引号"与\\反斜杠\n换行', '汉'.repeat(7_999), '汉'.repeat(20_000), '```js\nlet a = 1;\n```\n| a | b |\n|---|---|\n| 1 | 2 |'];
    const behaviors = { ok: () => null, card400: (d) => (d.msg_type === 'interactive' ? httpErr() : null), cardNet: (d) => (d.msg_type === 'interactive' ? netErr() : null) };
    let n = 0;
    for (const text of corpus) for (const key of [undefined, KEY]) for (const actions of [undefined, BUTTONS]) for (const [bn, fail] of Object.entries(behaviors)) {
      const a = fakeCreate(fail); const b = fakeCreate(fail);
      let fa = 0; let fb = 0;
      const ra = await oldSend(a.create, text, { actions, idempotencyKey: key }, () => { fa += 1; });
      const rb = await sendCardWithFallback(b.create, text, { actions, idempotencyKey: key }, () => { fb += 1; });
      assert.deepEqual(b.reqs, a.reqs, `${bn} key=${!!key} actions=${!!actions}`);
      assert.equal(rb, ra);
      assert.equal(fb, fa);
      n += 1;
    }
    assert.equal(n, 6 * 2 * 2 * 3);
  });

  test('C2 多段无键：每段一张卡片、无 uuid、按钮只在最后一段、返回最后一段 id、日志一行不含正文', async (t) => {
    const logs = collectLogs(t);
    const { segments } = splitMessage(LONG);
    const n = segments.length;
    assert.ok(n >= 4);
    const a = fakeCreate();
    const id = await sendCardWithFallback(a.create, LONG, {});
    assert.equal(a.reqs.length, n);
    a.reqs.forEach((r, i) => {
      assert.equal(r.msg_type, 'interactive');
      assert.equal(cardText(r), segments[i]);
      assert.deepEqual(Object.keys(r), ['msg_type', 'content']);
    });
    assert.equal(id, `om_${n}`);

    const b = fakeCreate();
    const id2 = await sendCardWithFallback(b.create, LONG, { actions: BUTTONS });
    b.reqs.forEach((r, i) => {
      const card = JSON.parse(r.content);
      if (i === n - 1) { assert.equal(card.schema, '2.0'); assert.ok(card.body.elements.some((e) => e.tag === 'column_set')); } else assert.equal(card.schema, undefined);
    });
    assert.equal(id2, `om_${n}`);

    const sendLogs = logs.filter((l) => l.includes('[send] 长消息分'));
    assert.equal(sendLogs.length, 2);
    assert.match(sendLogs[0], new RegExp(`^\\[send\\] 长消息分 ${n} 段发送（各段约 [\\d. /]+ KB）$`));
    assert.ok(logs.every((l) => !l.includes('机密正文')));
  });

  test('C3 多段带键：uuid = feishuUuid(K, 段名#i/n)；卡片网络错 → 文本沿用卡片 uuid；卡片 400 → 文本用 text 段名', async (t) => {
    const logs = collectLogs(t);
    const { segments } = splitMessage(LONG);
    const n = segments.length;
    const cardUuid = (i) => feishuUuid(KEY, `${contentPart('card', segments[i])}#${i + 1}/${n}`);
    const a = fakeCreate();
    await sendCardWithFallback(a.create, LONG, { idempotencyKey: KEY });
    a.reqs.forEach((r, i) => assert.equal(r.uuid, cardUuid(i)));
    assert.equal(new Set(a.reqs.map((r) => r.uuid)).size, n);

    const net = fakeCreate((d, k) => (k === 2 ? netErr() : null)); // 第 2 次请求 = 第 2 段卡片
    await sendCardWithFallback(net.create, LONG, { idempotencyKey: KEY });
    assert.equal(net.reqs.length, n + 1);
    assert.equal(net.reqs[1].msg_type, 'interactive');
    assert.equal(net.reqs[2].msg_type, 'text');
    assert.equal(net.reqs[2].uuid, cardUuid(1));

    const h400 = fakeCreate((d, k) => (k === 2 ? httpErr() : null));
    await sendCardWithFallback(h400.create, LONG, { idempotencyKey: KEY });
    assert.equal(h400.reqs[2].msg_type, 'text');
    assert.equal(h400.reqs[2].uuid, feishuUuid(KEY, `${contentPart('text', segments[1])}#2/${n}`));
    assert.notEqual(h400.reqs[2].uuid, cardUuid(1));
    assert.ok(logs.every((l) => !l.includes(a.reqs[0].uuid) && !l.includes(KEY) && !l.includes('机密正文')));
  });

  test('C4 内容完全相同的两段：uuid 不同（段名带段号）', async (t) => {
    collectLogs(t);
    const text = `${'汉'.repeat(1_500)}\n\n`.repeat(60);
    const { segments } = splitMessage(text);
    assert.ok(new Set(segments).size < segments.length, '语料里应有完全相同的段');
    const a = fakeCreate();
    await sendCardWithFallback(a.create, text, { idempotencyKey: KEY });
    assert.equal(new Set(a.reqs.map((r) => r.uuid)).size, segments.length);
  });

  test('C5 带键中途失败：抛原错误、第 3 段起没有请求', async (t) => {
    const logs = collectLogs(t);
    const a = fakeCreate((d, k) => (k === 2 || k === 3 ? netErr() : null)); // 第 2 段卡片与文本都网络错
    await assert.rejects(sendCardWithFallback(a.create, LONG, { idempotencyKey: KEY }), /socket hang up/);
    assert.equal(a.reqs.length, 3);
    const failLine = logs.find((l) => l.includes('段发送失败'));
    assert.match(failLine, /^\[send\] 长消息第 2\/\d+ 段发送失败，后面约 \d+ 字没有发出（交给调用方重试）$/);
    assert.ok(logs.every((l) => !l.includes('机密正文') && !l.includes(KEY)));
  });

  // —— 与 send-idempotency K4 同一写法：切 index.js 的 sendToChat / sendMarkdown / 调度块，真 fireJob，假客户端 ——
  function buildSched({ createImpl, answer }) {
    const reqs = [];
    const scope = {
      resolveTurn, schedDestOf, ownerDmChatId: DM, OWNER_TOOL_PROFILE: 'legacy', BIZ_ON: false,
      startScheduler: (opts) => { scope.captured = opts; return { stop() {}, inflightCount: () => 0 }; },
      SCHEDULES_DIR: '/tmp/x', SCHED_STATE_FILE: '/tmp/x.json',
      sendToOwner: async () => {}, setRuntimeConfig: () => ({ model: 'm', effort: 'e', execModel: '' }),
      client: { im: { v1: { message: { create: async (x) => { reqs.push(x); return createImpl(x, reqs.length); } } } } },
      fireJob, redact, sendCardWithFallback,
      runClaude: async () => answer,
      flushOutbox: async () => ({}),
      outboxDirFor: (id, p) => `/out/${id}/${p}`,
      isQuietAnswer: () => false, schedDiagPrompt,
      handleScheduledFailure: async (o) => { await o.send('DIAG-TEXT'); },
      OWNER_OPEN_ID: 'ou_x', loadOwner: () => 'ou_x',
    };
    const proxy = new Proxy(scope, { has: (t, k) => typeof k === 'string' && Object.hasOwn(t, k), get: (t, k) => (k === Symbol.unscopables ? undefined : t[k]) });
    const src = [
      cut('function schedTurnFor(source, job) {', '\n}\n'),
      cut('async function sendToChat(', '\n}\n'),
      cut('async function sendMarkdown(', '\n}\n'),
      cut('const scheduler = startScheduler({', '\n});'),
    ].join('\n');
    // eslint-disable-next-line no-new-func
    new Function('scope', `with (scope) {\n${src}\nreturn { scheduler };\n}`)(proxy);
    return { reqs, opts: scope.captured };
  }
  const job = (extra = {}) => ({ _file: 'daily.json', name: '晨报', prompt: 'P', chat_id: DM, ...extra });

  test('C5b 真 fireJob：第 2 段先「投递」再两次网络错 → 整条重发，各段恰投递 1 次、顺序正确、不通知 owner', async (t) => {
    const logs = collectLogs(t);
    const delivered = new Map(); const order = [];
    let armed = true; let burst = 0;
    const { reqs, opts } = buildSched({
      answer: LONG,
      createImpl: (x) => {
        const u = x.data.uuid;
        if (delivered.has(u)) { if (armed && burst > 0) { burst -= 1; throw netErr(); } return { code: 0, data: { message_id: delivered.get(u) } }; }
        const id = `om_${delivered.size + 1}`;
        delivered.set(u, id); order.push(u);
        if (armed && delivered.size === 2) { burst = 1; armed = false; throw netErr(); } // 投递后应答丢失；紧接着的文本降级也丢
        return { code: 0, data: { message_id: id } };
      },
    });
    const notes = [];
    await withFastTimers(() => opts.onFire(job(), { sendKey: KEY, notifyOnce: async (r, x) => { notes.push([r, x]); } }));
    const text = `⏰ **晨报**\n\n${LONG}`;
    const { segments } = splitMessage(redact(text));
    assert.equal(order.length, segments.length);
    segments.forEach((seg, i) => assert.equal(order[i], feishuUuid(KEY, `${contentPart('card', seg)}#${i + 1}/${segments.length}`)));
    assert.ok(reqs.length > segments.length);
    assert.equal(notes.length, 0);
    assert.ok(logs.every((l) => !l.includes('机密正文') && !l.includes(KEY)));
  });

  test('C5c 真 fireJob：第 2 段卡片与文本都网络错（未投递）→ 重发后各段恰投递 1 次', async (t) => {
    collectLogs(t);
    const delivered = new Map(); const order = [];
    let fails = 2;
    const { opts } = buildSched({
      answer: LONG,
      createImpl: (x) => {
        const u = x.data.uuid;
        if (delivered.has(u)) return { code: 0, data: { message_id: delivered.get(u) } };
        if (delivered.size === 1 && fails > 0) { fails -= 1; throw netErr(); }
        const id = `om_${delivered.size + 1}`;
        delivered.set(u, id); order.push(u);
        return { code: 0, data: { message_id: id } };
      },
    });
    const notes = [];
    await withFastTimers(() => opts.onFire(job(), { sendKey: KEY, notifyOnce: async (r, x) => { notes.push([r, x]); } }));
    const n = splitMessage(redact(`⏰ **晨报**\n\n${LONG}`)).segments.length;
    assert.equal(order.length, n);
    assert.equal(notes.length, 0);
  });

  test('C6 无键中途失败：不抛、补发 1 条无 uuid 的文字提示、返回第 1 段 id、第 3 段起不再发；提示也失败仍不抛', async (t) => {
    const logs = collectLogs(t);
    const { ranges } = splitMessage(LONG);
    const rest = cps(LONG.slice(ranges[1][0]));
    const a = fakeCreate((d, k) => (k === 2 || k === 3 ? httpErr() : null));
    const id = await sendCardWithFallback(a.create, LONG, {});
    assert.equal(id, 'om_1');
    assert.equal(a.reqs.length, 4);
    const hint = a.reqs[3];
    assert.equal(hint.msg_type, 'text');
    assert.equal('uuid' in hint, false);
    const text = JSON.parse(hint.content).text;
    assert.ok(text.includes('第 2 段'));
    assert.ok(text.includes(`约 ${rest} 字`));
    assert.ok(logs.some((l) => /^\[send\] 长消息第 2\/\d+ 段发送失败，后面约 \d+ 字没有发出（已补发提示）$/.test(l)));

    const b = fakeCreate((d, k) => (k >= 2 ? httpErr() : null));
    assert.equal(await sendCardWithFallback(b.create, LONG, {}), 'om_1');
    assert.equal(b.reqs.length, 4);
    assert.ok(logs.every((l) => !l.includes('机密正文')));
  });

  test('C7 无键第 1 段失败：抛出', async (t) => {
    collectLogs(t);
    const a = fakeCreate(() => httpErr());
    await assert.rejects(sendCardWithFallback(a.create, LONG, {}), /status code 400/);
    assert.equal(a.reqs.length, 2);
  });

  function replyFn(createImpl) {
    const reqs = []; const errs = [];
    const scope = {
      client: { im: { v1: { message: { reply: async (x) => { reqs.push(x); return createImpl(x, reqs.length); } } } } },
      redact, sendCardWithFallback,
      console: { error: (...a) => errs.push(a.map((x) => String(x?.message ?? x)).join(' ')), log: () => {} },
    };
    const proxy = new Proxy(scope, { has: (t, k) => typeof k === 'string' && Object.hasOwn(t, k), get: (t, k) => (k === Symbol.unscopables ? undefined : t[k]) });
    // eslint-disable-next-line no-new-func
    const { reply } = new Function('scope', `with (scope) {\n${cut('async function reply(messageId, text) {', '\n}\n')}\nreturn { reply };\n}`)(proxy);
    return { reply, reqs, errs };
  }

  test('C8 reply 接线：短文本请求逐字不变；卡片失败降级文本；长文分段；返回 undefined；空文本不发', async () => {
    const a = replyFn(() => ({ data: { message_id: 'om_x' } }));
    const content = '你好 **世界**';
    assert.equal(await a.reply('om_1', content), undefined);
    assert.deepEqual(a.reqs, [{ path: { message_id: 'om_1' }, data: { msg_type: 'interactive', content: JSON.stringify({ config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content }] }) } }]);
    await a.reply('om_1', '');
    assert.equal(a.reqs.length, 1);

    const b = replyFn((x) => { if (x.data.msg_type === 'interactive') throw httpErr(); return {}; });
    await b.reply('om_2', content);
    assert.deepEqual(b.reqs[1], { path: { message_id: 'om_2' }, data: { msg_type: 'text', content: JSON.stringify({ text: content }) } });
    assert.ok(b.errs.some((l) => l.startsWith('[reply] card failed, fallback to text:')));

    const long = `${'汉'.repeat(12_000)}\n\n\`\`\`js\n${'let a = 1;\n'.repeat(40)}\`\`\`\n\n| a | b |\n|---|---|\n${'| 1 | 2 |\n'.repeat(20)}\n${'汉'.repeat(12_000)}\n`;
    const c = replyFn(() => ({}));
    assert.equal(await c.reply('om_3', long), undefined);
    assert.equal(c.reqs.length, 2);
    assert.ok(c.reqs.every((r) => r.path.message_id === 'om_3'));

    // 脱敏：假令牌（沿用 bridge.test.js 的同类假值）不得出现在任何请求体里，单段与多段各一次
    const FAKE = 'sk-ant-abcdefghijklmno';
    assert.ok(!redact(`key ${FAKE}`).includes(FAKE));
    const d = replyFn(() => ({}));
    await d.reply('om_4', `密钥 ${FAKE} 请勿外传`);
    assert.equal(d.reqs.length, 1);
    assert.ok(!JSON.stringify(d.reqs).includes(FAKE), '单段请求体里有假令牌原值');
    assert.ok(JSON.stringify(d.reqs).includes('sk-ant-***'));
    const e = replyFn(() => ({}));
    await e.reply('om_5', `${'汉'.repeat(12_000)}\n\n密钥 ${FAKE}\n\n${'汉'.repeat(12_000)}`);
    assert.ok(e.reqs.length >= 2);
    assert.ok(!JSON.stringify(e.reqs).includes(FAKE), '多段请求体里有假令牌原值');
    assert.ok(JSON.stringify(e.reqs).includes('sk-ant-***'));
  });

  test('C9 sendMarkdown 接线：8 万字定时任务结果 ≥ 4 次 create、目的会话不变、每次请求体 ≤ 70 000 字节（预算 64 000 + 包装）；带四个按钮同样', async (t) => {
    const logs = collectLogs(t);
    const { reqs, opts } = buildSched({ answer: LONG, createImpl: () => ({ data: { message_id: 'om_1' } }) });
    await opts.onFire(job(), { sendKey: KEY, notifyOnce: async () => {} });
    assert.ok(reqs.length >= 4);
    for (const r of reqs) {
      assert.equal(r.data.receive_id, DM);
      assert.equal(r.params.receive_id_type, 'chat_id');
      assert.ok(Buffer.byteLength(JSON.stringify({ receive_id: r.data.receive_id, msg_type: r.data.msg_type, content: r.data.content, uuid: r.data.uuid })) <= 70_000);
    }
    // 带验收按钮的长消息
    const sent = [];
    const scope = {
      client: { im: { v1: { message: { create: async (x) => { sent.push(x); return { data: { message_id: 'om_9' } }; } } } } },
      redact, sendCardWithFallback,
    };
    const proxy = new Proxy(scope, { has: (tt, k) => typeof k === 'string' && Object.hasOwn(tt, k), get: (tt, k) => (k === Symbol.unscopables ? undefined : tt[k]) });
    // eslint-disable-next-line no-new-func
    const { sendMarkdown } = new Function('scope', `with (scope) {\n${cut('async function sendMarkdown(', '\n}\n')}\nreturn { sendMarkdown };\n}`)(proxy);
    const four = [...BUTTONS, { label: '驳回', type: 'danger', value: { a: 4 } }];
    const text = '汉"\n'.repeat(12_000);
    await sendMarkdown('open_id', 'ou_x', text, { actions: four, idempotencyKey: KEY });
    assert.ok(sent.length >= 2);
    for (const r of sent) assert.ok(Buffer.byteLength(JSON.stringify({ receive_id: r.data.receive_id, msg_type: r.data.msg_type, content: r.data.content, uuid: r.data.uuid })) <= 70_000);
    assert.equal(JSON.parse(sent.at(-1).data.content).schema, '2.0');
    assert.ok(logs.every((l) => !l.includes('机密正文') && !l.includes(KEY) && !l.includes(DM)));
  });
});
