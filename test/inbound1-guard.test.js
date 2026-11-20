// BRIDGE-INBOUND-1（V04）：入口兜底层。假 reply / forget / log，不联网。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createInboundGuard, INBOUND_FAILED_REPLY, errorKind, errorStage } from '../src/inbound-guard.js';

const FULL_ID = 'om_x100b5a1c2d3e4f5g6h7i8j9k0l';
const data = (extra = {}) => ({ message: { message_id: FULL_ID, chat_type: 'group', message_type: 'text', content: '{"text":"正文 ABC"}', ...extra }, sender: {} });
const secretErr = () => Object.assign(new Error('读 /Users/x/secret.txt 失败：正文 ABC'), { code: 'EACCES' });
function mk({ replyImpl, forgetImpl, logImpl } = {}) {
  const r = { replies: [], forgets: [], logs: [] };
  const guard = createInboundGuard({
    reply: replyImpl ?? (async (id, text) => { r.replies.push([id, text]); }),
    forget: forgetImpl ?? ((id) => { r.forgets.push(id); }),
    log: logImpl ?? ((line) => { r.logs.push(line); }),
  });
  return { r, guard };
}

describe('G 入口兜底', () => {
  test('G1 正常结束：不回复、不撤、不记；返回值透传', async () => {
    const { r, guard } = mk();
    assert.equal(await guard(data(), async () => 42), 42);
    assert.deepEqual([r.replies, r.forgets, r.logs], [[], [], []]);
  });

  test('G2 异步抛错：撤去重、回固定文案、日志恰好一行（无原文 / 完整 id / 正文）、guard 不被拒', async () => {
    const { r, guard } = mk();
    const out = await guard(data(), async () => { throw secretErr(); });
    assert.equal(out, undefined);
    assert.deepEqual(r.forgets, [FULL_ID]);
    assert.deepEqual(r.replies, [[FULL_ID, '这条消息处理失败了，请再发一次']]);
    assert.equal(INBOUND_FAILED_REPLY, '这条消息处理失败了，请再发一次');
    assert.equal(r.logs.length, 1);
    const line = r.logs[0];
    assert.match(line, /^\[inbound\] /);
    assert.match(line, /stage=\S+ kind=EACCES chat=group type=text replied=yes id=…/);
    assert.ok(line.endsWith(`id=…${FULL_ID.slice(-6)}`), line);
    for (const bad of [FULL_ID, '/Users', 'secret.txt', '正文', 'ABC', '读 ']) assert.ok(!line.includes(bad), `日志不应含 ${bad}：${line}`);
    for (const bad of ['/Users', 'secret', 'EACCES', '正文']) assert.ok(!r.replies[0][1].includes(bad), '回复不带错误原文');
  });

  test('G3 同步抛错（handle 不是 async）：同 G2', async () => {
    const { r, guard } = mk();
    const out = await guard(data(), () => { throw secretErr(); });
    assert.equal(out, undefined);
    assert.deepEqual(r.forgets, [FULL_ID]);
    assert.equal(r.replies.length, 1);
    assert.equal(r.logs.length, 1);
    assert.match(r.logs[0], /replied=yes/);
  });

  test('G4 回复也失败：replied=no，guard 仍不抛；forget / log 自己抛错也不抛出', async () => {
    const a = mk({ replyImpl: async () => { throw new Error('send down'); } });
    await assert.doesNotReject(a.guard(data(), async () => { throw secretErr(); }));
    assert.equal(a.r.logs.length, 1);
    assert.match(a.r.logs[0], /replied=no/);
    assert.deepEqual(a.r.forgets, [FULL_ID], '回复失败也已撤去重');
    assert.ok(!a.r.logs[0].includes('send down'));

    const b = mk({ forgetImpl: () => { throw new Error('forget boom'); } });
    await assert.doesNotReject(b.guard(data(), async () => { throw secretErr(); }));
    assert.equal(b.r.replies.length, 1, 'forget 出错不妨碍回复');

    const c = mk({ logImpl: () => { throw new Error('log boom'); } });
    await assert.doesNotReject(c.guard(data(), async () => { throw secretErr(); }));
    assert.equal(c.r.replies.length, 1);
    // reply 同步抛错也算失败
    const d = mk({ replyImpl: () => { throw new Error('sync reply'); } });
    await assert.doesNotReject(d.guard(data(), async () => { throw secretErr(); }));
    assert.match(d.r.logs[0], /replied=no/);
  });

  test('G5 没有 message_id：不回复、不撤，日志照记', async () => {
    const { r, guard } = mk();
    await guard({ message: { chat_type: 'p2p', message_type: 'text' } }, async () => { throw secretErr(); });
    await guard({}, async () => { throw secretErr(); });
    assert.deepEqual([r.replies, r.forgets], [[], []]);
    assert.equal(r.logs.length, 2);
    assert.match(r.logs[0], /chat=p2p type=text replied=no id=\?/);
    assert.match(r.logs[1], /chat=\? type=\? replied=no id=\?/);
  });

  test('G6 kind 取法：e.code → 飞书接口码（api<码>）→ e.name', async () => {
    assert.equal(errorKind(Object.assign(new Error('x'), { code: 'ECONNRESET' })), 'ECONNRESET');
    assert.equal(errorKind(Object.assign(new Error('x'), { response: { data: { code: 230001 } } })), 'api230001');
    assert.equal(errorKind(new TypeError('x')), 'TypeError');
    assert.equal(errorKind(null), '?');
    const { r, guard } = mk();
    await guard(data(), async () => { throw Object.assign(new Error('msg 里的 /Users/x'), { response: { data: { code: 99991672, msg: '原文' } } }); });
    assert.match(r.logs[0], /kind=api99991672 /);
    assert.ok(!r.logs[0].includes('原文'));
  });

  test('G6b stage：栈里有 runTurn 记 turn，否则 message，没有栈记 ?', () => {
    assert.equal(errorStage({ stack: 'Error\n    at runTurn (file:///x/src/index.js:1:1)' }), 'turn');
    assert.equal(errorStage({ stack: 'Error\n    at handleMessage (file:///x/src/index.js:1:1)' }), 'message');
    assert.equal(errorStage({}), '?');
  });

  test('G7 接线：index.js 里真实的 seen / isDuplicate / 兜底实例——撤去重后可重新处理；正常结束的仍算重复', async () => {
    const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const a = SRC.indexOf('const seen = new Set();');
    const b = SRC.indexOf('// ---- 每个会话串行处理', a);
    assert.ok(a >= 0 && b > a);
    const replies = []; const errors = [];
    // eslint-disable-next-line no-new-func
    const api = new Function('scope', `with (scope) {\n${SRC.slice(a, b)}\nreturn { isDuplicate, inboundGuard };\n}`)({
      createInboundGuard,
      reply: async (id, text) => { replies.push([id, text]); },
      console: { error: (s) => errors.push(s), log() {} },
    });
    assert.equal(api.isDuplicate('om_1'), false);
    assert.equal(api.isDuplicate('om_1'), true);
    await api.inboundGuard({ message: { message_id: 'om_1' } }, async () => { throw new Error('boom'); });
    assert.equal(api.isDuplicate('om_1'), false, '出错后撤去重：飞书重推 / 用户重发能重新处理');
    assert.deepEqual(replies, [['om_1', '这条消息处理失败了，请再发一次']]);
    assert.equal(errors.length, 1);
    assert.equal(api.isDuplicate('om_2'), false);
    await api.inboundGuard({ message: { message_id: 'om_2' } }, async () => 'done');
    assert.equal(api.isDuplicate('om_2'), true, '正常处理完的仍算重复');
    // 注册处：trackedHandleMessage 交给兜底（只这一条是源码断言）
    assert.match(SRC, /'im\.message\.receive_v1': \(data\) => inboundGuard\(data, trackedHandleMessage\)/);
  });
});
