// BRIDGE-SEND-1：定时任务结果发送重试不重复——飞书发送的幂等键（请求体 data.uuid）。
// 全部用桩：不连飞书、不读 .env、不用真实 HOME。K1 键的形状、K2 schedSendKey、K3 sendCardWithFallback、
// K4 index.js 真接线 + 真 fireJob + 假客户端（W1–W8）、K5 flushOutbox、K6 调度器给 ctx.sendKey、K7 同键不同内容不吞、日志不含键。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { feishuUuid, withUuid, outboxPart, contentPart, FEISHU_UUID_MAX_LEN } from '../src/send-key.js';
import { sendCardWithFallback } from '../src/events.js';
import { flushOutbox, redact } from '../src/outbound.js';
import { fireJob, startScheduler, schedSendKey } from '../src/scheduler.js';
import { resolveTurn } from '../src/turn-context.js';
import { schedDestOf } from '../src/biz-wiring.js';
import { schedDiagPrompt } from '../src/claude.js';

const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
function cut(start, end) {
  const a = SRC.indexOf(start);
  assert.ok(a >= 0, `index.js 里找不到：${start}`);
  const b = SRC.indexOf(end, a + start.length);
  assert.ok(b > a, `index.js 里找不到 ${start} 之后的：${JSON.stringify(end)}`);
  return SRC.slice(a, b + end.length);
}
const DM = 'oc_ownerdm0000000001';
const netErr = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const httpErr = () => Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { code: 230099 } } });
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const withFastTimers = async (fn) => {
  const o = globalThis.setTimeout;
  globalThis.setTimeout = (f, ms, ...r) => o(f, ms >= 1000 ? 0 : ms, ...r);
  try { return await fn(); } finally { globalThis.setTimeout = o; }
};
// 收集日志，断言没有任何一行包含键
function collectLogs(t) {
  const lines = [];
  const grab = (...a) => { lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')); };
  t.mock.method(console, 'error', grab);
  t.mock.method(console, 'log', grab);
  t.mock.method(console, 'warn', grab);
  return lines;
}

describe('K1 键的形状（send-key.js）', () => {
  test('同输入同输出；40 位十六进制；不超过 50；超长逻辑键仍是 40 位；part 不同键不同', () => {
    const a = feishuUuid('K', 'card');
    assert.equal(a, feishuUuid('K', 'card'));
    assert.match(a, /^[0-9a-f]{40}$/);
    assert.ok(a.length <= FEISHU_UUID_MAX_LEN);
    assert.match(feishuUuid('x'.repeat(10000), 'card'), /^[0-9a-f]{40}$/);
    assert.notEqual(a, feishuUuid('K', 'text'));
    assert.notEqual(a, feishuUuid('K2', 'card'));
  });
  test('没有逻辑键（undefined / 空串 / 非字符串）→ undefined', () => {
    for (const k of [undefined, null, '', 0, 123, {}, []]) assert.equal(feishuUuid(k, 'card'), undefined);
  });
  test('withUuid：无键返回同一个对象且没有 uuid；有键返回新对象、入参不变', () => {
    const d = { msg_type: 'text', content: '{}' };
    const same = withUuid(d, undefined, 'card');
    assert.equal(same, d);
    assert.ok(!('uuid' in same));
    assert.equal(withUuid(d, '', 'card'), d);
    const w = withUuid(d, 'K', 'card');
    assert.notEqual(w, d);
    assert.ok(!('uuid' in d));
    assert.deepEqual(Object.keys(d), ['msg_type', 'content']);
    assert.equal(w.uuid, feishuUuid('K', 'card'));
    assert.equal(w.msg_type, 'text');
  });
  test('outboxPart：文件名 + 内容的哈希，不含原文', () => {
    const p = outboxPart('secret-name.txt', Buffer.from('BODY'));
    assert.match(p, /^file:[0-9a-f]{64}$/);
    assert.ok(!p.includes('secret'));
    assert.equal(p, outboxPart('secret-name.txt', Buffer.from('BODY')));
    assert.equal(p, outboxPart('secret-name.txt', new Uint8Array(Buffer.from('BODY'))));
  });
});

describe('K2 schedSendKey', () => {
  const D = '2026-11-20T01:00:00.000Z';
  test('同 (file, dueIso, resumed) 同键；任一变化键都变', () => {
    const k = schedSendKey('daily.json', D);
    assert.equal(k, schedSendKey('daily.json', D));
    assert.equal(k, schedSendKey('daily.json', D, false));
    assert.notEqual(k, schedSendKey('other.json', D));
    assert.notEqual(k, schedSendKey('daily.json', '2026-11-21T01:00:00.000Z'));
    assert.notEqual(k, schedSendKey('daily.json', D, true));
  });
  test('scope（目的会话 + when 原文）不同键不同；scope 缺省与 \'\' 同键', () => {
    const k = schedSendKey('daily.json', D, false);
    assert.equal(k, schedSendKey('daily.json', D, false, ''));
    assert.equal(k, schedSendKey('daily.json', D, false, undefined));
    const a = schedSendKey('daily.json', D, false, 'oc_aaa\n2026-11-20 09:29');
    assert.notEqual(a, k);
    assert.notEqual(a, schedSendKey('daily.json', D, false, 'oc_bbb\n2026-11-20 09:29'));
    assert.notEqual(a, schedSendKey('daily.json', D, false, 'oc_aaa\n2026-11-20T09:29'));
    assert.match(a, /^sched:[0-9a-f]{32}$/);
  });
  test('返回串不含文件名与时间原文；含 oc_ / ou_ 的文件名也不会漏进 uuid', () => {
    const k = schedSendKey('daily.json', D);
    assert.ok(!k.includes('daily') && !k.includes('2026'));
    const k2 = schedSendKey('oc_abc_ou_def.json', D);
    assert.ok(!k2.includes('oc_abc') && !k2.includes('ou_def'));
    const u = feishuUuid(k2, contentPart('card', 'x'));
    assert.ok(!u.includes('oc_') && !u.includes('ou_'));
    assert.ok(feishuUuid(k, contentPart('card', 'x')).length <= FEISHU_UUID_MAX_LEN);
  });
});

describe('K3 sendCardWithFallback 带键', () => {
  const K = schedSendKey('daily.json', 'D');
  const fake = (impl) => { const reqs = []; return { reqs, create: async (d) => { reqs.push(d); return impl(d, reqs.length); } }; };
  const ok = { data: { message_id: 'om_1' } };

  test('卡片成功 → 1 次请求，uuid 是 card 段', async (t) => {
    const logs = collectLogs(t);
    const { reqs, create } = fake(() => ok);
    assert.equal(await sendCardWithFallback(create, 'hi', { idempotencyKey: K }), 'om_1');
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].uuid, feishuUuid(K, contentPart('card', 'hi')));
    assert.ok(logs.every((l) => !l.includes(reqs[0].uuid)));
  });
  test('卡片网络错 → 文本沿用卡片的 uuid', async () => {
    const { reqs, create } = fake((d, n) => { if (n === 1) throw netErr(); return ok; });
    await sendCardWithFallback(create, 'hi', { idempotencyKey: K });
    assert.deepEqual(reqs.map((r) => r.msg_type), ['interactive', 'text']);
    assert.equal(reqs[1].uuid, reqs[0].uuid);
  });
  test('卡片 HTTP 400 → 文本用 text 段，与卡片不同', async () => {
    const { reqs, create } = fake((d, n) => { if (n === 1) throw httpErr(); return ok; });
    await sendCardWithFallback(create, 'hi', { idempotencyKey: K });
    assert.equal(reqs[1].uuid, feishuUuid(K, contentPart('text', 'hi')));
    assert.notEqual(reqs[1].uuid, reqs[0].uuid);
  });
  test('带 actions + 键：仍是 2.0 卡片并带 uuid', async () => {
    const { reqs, create } = fake(() => ok);
    await sendCardWithFallback(create, 'hi', { idempotencyKey: K, actions: [{ text: '好', value: { a: 1 } }] });
    const card = JSON.parse(reqs[0].content);
    assert.equal(card.schema, '2.0');
    assert.equal(reqs[0].uuid, feishuUuid(K, contentPart('card', 'hi')));
  });
  test('不带键 → 每次请求的字段恰为 msg_type、content', async () => {
    const a = fake(() => ok);
    await sendCardWithFallback(a.create, 'hi');
    assert.deepEqual(Object.keys(a.reqs[0]), ['msg_type', 'content']);
    const b = fake((d, n) => { if (n === 1) throw netErr(); return ok; });
    await sendCardWithFallback(b.create, 'hi', {});
    assert.deepEqual(b.reqs.map((r) => Object.keys(r)), [['msg_type', 'content'], ['msg_type', 'content']]);
  });
});

describe('K4 index.js 真接线 + 真 fireJob + 假飞书客户端', () => {
  function build(createImpl, { runClaudeImpl, flushImpl } = {}) {
    const reqs = [];
    const flushCalls = [];
    const scope = {
      resolveTurn, schedDestOf, ownerDmChatId: DM, OWNER_TOOL_PROFILE: 'legacy', BIZ_ON: false,
      startScheduler: (opts) => { scope.captured = opts; return { stop() {}, inflightCount: () => 0 }; },
      SCHEDULES_DIR: '/tmp/x', SCHED_STATE_FILE: '/tmp/x.json',
      sendToOwner: async () => {}, setRuntimeConfig: () => ({ model: 'm', effort: 'e', execModel: '' }),
      client: { im: { v1: { message: { create: async (x) => { reqs.push(x); return createImpl(x, reqs.length); } } } } },
      fireJob, redact, sendCardWithFallback,
      runClaude: async (...a) => (runClaudeImpl ? runClaudeImpl(a) : 'ANSWER'),
      flushOutbox: async (...a) => { flushCalls.push(a); return flushImpl ? flushImpl(...a) : 0; },
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
    return { reqs, flushCalls, opts: scope.captured };
  }
  const job = (extra = {}) => ({ _file: 'daily.json', name: '晨报', prompt: 'P', chat_id: DM, ...extra });
  const KEY = schedSendKey('daily.json', '2026-11-20T01:00:00.000Z');
  const okRes = { data: { message_id: 'om_1' } };
  // sendMarkdown 的写法：redact(text).slice(0, 20000)；text 是 fireJob 拼的「⏰ **名字**\n\n正文」
  const CHUNK = redact('⏰ **晨报**\n\nANSWER').slice(0, 20000);

  test('W1 卡片、文本都网络错，第二轮卡片成功：3 次请求，uuid 全等且是 card 段', async (t) => {
    const logs = collectLogs(t);
    const { reqs, opts } = build((x, n) => { if (n <= 2) throw netErr(); return okRes; });
    const notes = [];
    await withFastTimers(() => opts.onFire(job(), { sendKey: KEY, notifyOnce: async (r, x) => { notes.push([r, x]); } }));
    assert.equal(reqs.length, 3);
    assert.deepEqual(reqs.map((r) => r.data.msg_type), ['interactive', 'text', 'interactive']);
    assert.equal(new Set(reqs.map((r) => r.data.uuid)).size, 1);
    assert.equal(reqs[0].data.uuid, feishuUuid(KEY, contentPart('card', CHUNK)));
    assert.ok(reqs.every((r) => r.data.receive_id === DM && r.params.receive_id_type === 'chat_id'));
    assert.equal(notes.length, 0);
    assert.ok(logs.every((l) => !l.includes(reqs[0].data.uuid) && !l.includes(KEY)));
  });

  test('W2 所有请求都网络错：6 次请求 uuid 全等；notifyOnce 恰 1 次、原因 send', async (t) => {
    const logs = collectLogs(t);
    const { reqs, opts } = build(() => { throw netErr(); });
    const notes = [];
    await withFastTimers(() => assert.rejects(opts.onFire(job(), { sendKey: KEY, notifyOnce: async (r, x) => { notes.push([r, x]); } }), /发送失败/));
    assert.equal(reqs.length, 6);
    assert.equal(new Set(reqs.map((r) => r.data.uuid)).size, 1);
    assert.equal(notes.length, 1);
    assert.equal(notes[0][0], 'send');
    assert.ok(logs.every((l) => !l.includes(reqs[0].data.uuid) && !l.includes(KEY)));
  });

  test('W3 卡片一律 HTTP 400、文本成功：文本 uuid 是 text 段', async () => {
    const { reqs, opts } = build((x) => { if (x.data.msg_type === 'interactive') throw httpErr(); return okRes; });
    await opts.onFire(job(), { sendKey: KEY, notifyOnce: async () => {} });
    assert.equal(reqs.length, 2);
    assert.equal(reqs[1].data.uuid, feishuUuid(KEY, contentPart('text', CHUNK)));
    assert.notEqual(reqs[1].data.uuid, reqs[0].data.uuid);
  });

  test('W4 ctx = {} 或 undefined：请求体逐字不变（没有 uuid）', async () => {
    for (const ctx of [{}, undefined]) {
      const { reqs, opts } = build(() => okRes);
      await opts.onFire(job(), ctx);
      assert.ok(reqs.length >= 1);
      for (const r of reqs) assert.deepEqual(Object.keys(r.data), ['receive_id', 'msg_type', 'content']);
    }
  });

  test('W5 flushOutbox 第 4 参：有键时 { idempotencyKey }，没键时 undefined', async () => {
    const a = build(() => okRes);
    await a.opts.onFire(job(), { sendKey: KEY });
    assert.ok(a.flushCalls.length >= 1);
    assert.deepEqual(a.flushCalls[0][3], { idempotencyKey: KEY });
    const b = build(() => okRes);
    await b.opts.onFire(job(), {});
    assert.equal(b.flushCalls[0][3], undefined);
    const c = build(() => okRes);
    await c.opts.onFire(job(), undefined);
    assert.equal(c.flushCalls[0][3], undefined);
  });

  test('W6 模型调用失败走自诊断：自诊断发送没有 uuid；onRunFailure 里的 flushOutbox 第 4 参只有 mode: \'hold\'、不带幂等键', async () => {
    const { reqs, flushCalls, opts } = build(() => okRes, {
      runClaudeImpl: (a) => { if (String(a[0]).startsWith('sched:')) throw new Error('model down'); return 'DIAG'; },
    });
    await opts.onFire(job(), { sendKey: KEY, notifyOnce: async () => {} });
    assert.ok(reqs.length >= 1);
    for (const r of reqs) assert.deepEqual(Object.keys(r.data), ['receive_id', 'msg_type', 'content']);
    assert.ok(flushCalls.length >= 1);
    assert.deepEqual(flushCalls.map((c) => c[3]), [{ mode: 'hold' }]);
  });

  test('W7 set-model 动作任务：发出的请求没有 uuid', async () => {
    const { reqs, opts } = build(() => okRes);
    await opts.onFire({ _file: 'sw.json', name: '切模型', action: 'set-model', model: 'sonnet', chat_id: DM }, { sendKey: KEY, notifyOnce: async () => {} });
    assert.ok(reqs.length >= 1, '切模型会发通知');
    for (const r of reqs) assert.deepEqual(Object.keys(r.data), ['receive_id', 'msg_type', 'content']);
  });

  test('W8 去重模拟：卡片先「投递」再网络错，同 uuid 的重复请求按成功处理（不看 code）', async (t) => {
    collectLogs(t);
    for (const dupRes of [{ code: 0, data: { message_id: 'om_first' } }, { code: 230020, msg: 'dup', data: {} }]) {
      const delivered = new Set();
      let throwFirst = true;
      const { reqs, opts } = build((x) => {
        const u = x.data.uuid;
        if (delivered.has(u)) return dupRes;
        delivered.add(u);
        if (throwFirst) { throwFirst = false; throw netErr(); } // 已送达但连接被断
        return { data: { message_id: 'om_x' } };
      });
      const notes = [];
      await withFastTimers(() => opts.onFire(job(), { sendKey: KEY, notifyOnce: async (r, x) => { notes.push([r, x]); } }));
      assert.equal(delivered.size, 1, '只有 1 次「投递」');
      assert.equal(reqs.length, 2, '卡片（网络错）+ 文本降级（被去重）后结束，不再重试');
      assert.equal(notes.length, 0);
    }
  });
});

describe('K5 flushOutbox', () => {
  const mkClient = () => ({
    im: { v1: {
      image: { create: async ({ data }) => { await data.image.toArray(); return { image_key: 'img_1' }; } },
      file: { create: async ({ data }) => { await data.file.toArray(); return { file_key: 'file_1' }; } },
    } },
  });
  const run = async (dir, files, opts) => {
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
    const sent = [];
    await flushOutbox(mkClient(), dir, async (d) => { sent.push(d); }, opts);
    return sent;
  };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'send1-'));

  test('带键：每个文件一个键（文件名 + 内容），互不相同', async (t) => {
    const logs = collectLogs(t);
    const dir = tmp();
    try {
      const sent = await run(dir, { 'a.png': 'PNG', 'b.txt': 'TXT' }, { idempotencyKey: 'K' });
      assert.equal(sent.length, 2);
      const by = Object.fromEntries(sent.map((d) => [d.msg_type, d.uuid]));
      assert.equal(by.image, feishuUuid('K', outboxPart('a.png', Buffer.from('PNG'))));
      assert.equal(by.file, feishuUuid('K', outboxPart('b.txt', Buffer.from('TXT'))));
      assert.notEqual(by.image, by.file);
      assert.ok(logs.every((l) => !l.includes(by.image) && !l.includes(by.file)));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('同名同内容再来一次 → 同 uuid；同名不同内容 → 不同；不同名同内容 → 不同', async () => {
    const dir = tmp();
    try {
      const u = async (files) => (await run(dir, files, { idempotencyKey: 'K' }))[0].uuid;
      const first = await u({ 'b.txt': 'TXT' });
      assert.equal(await u({ 'b.txt': 'TXT' }), first);
      assert.notEqual(await u({ 'b.txt': 'OTHER' }), first);
      assert.notEqual(await u({ 'c.txt': 'TXT' }), first);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('不带第 4 参 / 带 {} → 请求字段恰为 msg_type、content', async () => {
    const dir = tmp();
    try {
      for (const opts of [undefined, {}]) {
        const sent = await run(dir, { 'a.png': 'PNG', 'b.txt': 'TXT' }, opts);
        assert.equal(sent.length, 2);
        for (const d of sent) assert.deepEqual(Object.keys(d), ['msg_type', 'content']);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('K6 调度器给 ctx.sendKey', () => {
  const CHAT = 'oc_0123456789abcdef0123';
  const NOW = new Date(2026, 10, 20, 9, 30, 0);
  const pad = (n) => String(n).padStart(2, '0');
  const localWhen = (ms) => { const d = new Date(NOW.getTime() + ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function env(t) {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW.getTime() });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send1s-'));
    const e = { dir, jobs: path.join(dir, 'jobs'), state: path.join(dir, 'data', 's.json') };
    fs.mkdirSync(e.jobs); fs.mkdirSync(path.join(dir, 'data'));
    e.write = (n, j) => fs.writeFileSync(path.join(e.jobs, n), JSON.stringify(j));
    return e;
  }

  test('一次性任务首拍触发：sendKey 对应状态文件里的 at、resumed=false', async (t) => {
    const e = env(t);
    e.write('once.json', { name: 'o', when: localWhen(-60_000), prompt: 'P', chat_id: CHAT, enabled: true });
    const got = [];
    const h = startScheduler({ schedulesDir: e.jobs, stateFile: e.state, onFire: async (j, ctx) => { got.push([j._file, ctx.sendKey]); } });
    try {
      await h.whenIdle();
      const at = JSON.parse(fs.readFileSync(e.state, 'utf8'))['once.json'].at;
      assert.equal(got.length, 1);
      assert.equal(got[0][1], schedSendKey('once.json', at, false, `${CHAT}\n${localWhen(-60_000)}`));
    } finally { h.stop(); fs.rmSync(e.dir, { recursive: true, force: true }); }
  });

  test('重启补跑：sendKey 是 resumed=true 的键，与首次不同', async (t) => {
    const e = env(t);
    const AT = new Date(2026, 10, 20, 9, 0, 0).toISOString();
    e.write('daily.json', { name: 'd', when: '0 9 * * *', prompt: 'P', chat_id: CHAT, enabled: true });
    fs.writeFileSync(e.state, JSON.stringify({ 'daily.json': { at: AT, when: '0 9 * * *', status: 'running' } }));
    const got = [];
    const h = startScheduler({ schedulesDir: e.jobs, stateFile: e.state, turnFor: () => ({ private: true }), notifyOwner: async () => {}, onFire: async (j, ctx) => { got.push([j._resumed === true, ctx.sendKey]); } });
    try {
      await h.whenIdle();
      assert.deepEqual(got, [[true, schedSendKey('daily.json', AT, true, `${CHAT}\n0 9 * * *`)]]);
      assert.notEqual(got[0][1], schedSendKey('daily.json', AT, false, `${CHAT}\n0 9 * * *`));
    } finally { h.stop(); fs.rmSync(e.dir, { recursive: true, force: true }); }
  });

  test('两个任务同一应触发时间：键不同', async (t) => {
    const e = env(t);
    const when = localWhen(-60_000);
    e.write('a.json', { name: 'a', when, prompt: 'P', chat_id: CHAT, enabled: true });
    e.write('b.json', { name: 'b', when, prompt: 'P', chat_id: CHAT, enabled: true });
    const got = {};
    const h = startScheduler({ schedulesDir: e.jobs, stateFile: e.state, maxConcurrent: 2, onFire: async (j, ctx) => { got[j._file] = ctx.sendKey; } });
    try {
      await h.whenIdle(); await settle();
      assert.equal(Object.keys(got).length, 2);
      assert.notEqual(got['a.json'], got['b.json']);
    } finally { h.stop(); fs.rmSync(e.dir, { recursive: true, force: true }); }
  });
});

describe('K7 同一逻辑键下内容不同 → uuid 不同（不被飞书当重复吞掉）', () => {
  const K = schedSendKey('daily.json', 'D');
  const ok = { data: { message_id: 'om_1' } };
  const fake = (impl) => { const reqs = []; return { reqs, create: async (d) => { reqs.push(d); return impl(d, reqs.length); } }; };

  test('K7-a 同键两段不同正文 → 不同 uuid；同一段正文两次 → 相同；网络错降级文本 = 卡片 uuid；HTTP 400 降级文本 ≠ 卡片 uuid', async () => {
    const a = fake(() => ok);
    await sendCardWithFallback(a.create, '第一版', { idempotencyKey: K });
    await sendCardWithFallback(a.create, '第二版', { idempotencyKey: K });
    await sendCardWithFallback(a.create, '第一版', { idempotencyKey: K });
    assert.notEqual(a.reqs[0].uuid, a.reqs[1].uuid);
    assert.equal(a.reqs[0].uuid, a.reqs[2].uuid);
    assert.equal(a.reqs[0].uuid, feishuUuid(K, contentPart('card', '第一版')));

    const n = fake((d, i) => { if (i === 1) throw netErr(); return ok; });
    await sendCardWithFallback(n.create, '正文', { idempotencyKey: K });
    assert.deepEqual(n.reqs.map((r) => r.msg_type), ['interactive', 'text']);
    assert.equal(n.reqs[1].uuid, n.reqs[0].uuid);

    const h = fake((d, i) => { if (i === 1) throw httpErr(); return ok; });
    await sendCardWithFallback(h.create, '正文', { idempotencyKey: K });
    assert.notEqual(h.reqs[1].uuid, h.reqs[0].uuid);
    assert.equal(h.reqs[1].uuid, feishuUuid(K, contentPart('text', '正文')));

    // 降级文本也随正文变
    const h2 = fake((d, i) => { if (i === 1) throw httpErr(); return ok; });
    await sendCardWithFallback(h2.create, '另一段', { idempotencyKey: K });
    assert.notEqual(h2.reqs[1].uuid, h.reqs[1].uuid);
  });

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d, sep = ' ') => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}${sep}${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const CHAT = 'oc_0123456789abcdef0123';
  const NOW = new Date(2026, 10, 20, 9, 30, 10);
  function env(t) {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW.getTime() });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send1k7-'));
    const e = { dir, jobs: path.join(dir, 'jobs'), state: path.join(dir, 's.json') };
    fs.mkdirSync(e.jobs);
    e.write = (n, j) => fs.writeFileSync(path.join(e.jobs, n), JSON.stringify(j));
    return e;
  }

  test('K7-b 一次性任务改期后又改回同一时刻（换写法、重新启用）→ 第三次与第一次的 sendKey 不同', async (t) => {
    const e = env(t);
    const at = new Date(NOW.getTime() - 60_000);
    e.write('o.json', { name: 'o', when: fmt(at), prompt: '第一版', chat_id: CHAT });
    const got = [];
    const h = startScheduler({ schedulesDir: e.jobs, stateFile: e.state, onFire: async (j, c) => { got.push([j.prompt, c.sendKey]); } });
    try {
      await h.whenIdle(); await settle();
      e.write('o.json', { name: 'o', when: fmt(new Date(NOW.getTime() + 60_000)), prompt: '改期', chat_id: CHAT, enabled: true });
      t.mock.timers.tick(90_000); await settle();
      e.write('o.json', { name: 'o', when: fmt(at, 'T'), prompt: '第三版', chat_id: CHAT, enabled: true });
      t.mock.timers.tick(30_000); await settle();
      assert.equal(got.length, 3, JSON.stringify(got.map((g) => g[0])));
      assert.notEqual(got[0][1], got[1][1]);
      assert.notEqual(got[2][1], got[0][1], '同一时刻、when 换了写法 → 不同键');
      assert.notEqual(got[2][1], got[1][1]);
    } finally { h.stop(); fs.rmSync(e.dir, { recursive: true, force: true }); }
  });

  test('K7-c 两个调度器实例、不同目录、同名 daily.json、同一时刻、chat_id 不同 → sendKey 不同', async (t) => {
    const e1 = env(t);
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'send1k7b-'));
    const when = fmt(new Date(NOW.getTime() - 60_000));
    e1.write('daily.json', { name: 'a', when, prompt: 'A', chat_id: CHAT });
    fs.writeFileSync(path.join(dir2, 'daily.json'), JSON.stringify({ name: 'a', when, prompt: 'A', chat_id: 'oc_ffffffffffffffffffff' }));
    const got = [];
    const h1 = startScheduler({ schedulesDir: e1.jobs, stateFile: e1.state, onFire: async (j, c) => { got.push([j.chat_id, c.sendKey]); } });
    const h2 = startScheduler({ schedulesDir: dir2, stateFile: path.join(dir2, 's.json'), onFire: async (j, c) => { got.push([j.chat_id, c.sendKey]); } });
    try {
      await h1.whenIdle(); await h2.whenIdle();
      assert.equal(got.length, 2);
      assert.notEqual(got[0][0], got[1][0]);
      assert.notEqual(got[0][1], got[1][1], '不同目的会话 → 不同键');
    } finally { h1.stop(); h2.stop(); fs.rmSync(e1.dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true }); }
  });
});
