// BRIDGE-STD-1 §3.5 / §3.7：日志不落正文；出站回复带请求级 uuid
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { redact, sendVoice, formatInboundLog } from '../src/outbound.js';
import { sendCardWithFallback } from '../src/events.js';
import { splitMessage } from '../src/split-message.js';
import { createOwnerMessageQueue } from '../src/message-queue.js';
import { feishuUuid, contentPart, FEISHU_UUID_MAX_LEN } from '../src/send-key.js';

const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const MID = ['om', 'test0001abc'].join('_'); // 运行时拼（源码里不放像真 id 的串）
const BODY = '机密正文甲乙丙';
const httpErr = (code) => Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { code } } });

/** index.js 里的 reply 原段，注入假客户端 */
function realReply(createImpl) {
  const a = SRC.indexOf('async function reply(messageId, text) {');
  const b = SRC.indexOf('\n}\n', a);
  assert.ok(a > 0 && b > a);
  const reqs = []; const errs = [];
  const scope = {
    client: { im: { v1: { message: { reply: async (x) => { reqs.push(x); return createImpl(x, reqs.length); } } } } },
    redact, sendCardWithFallback, console: { error: (...x) => errs.push(x.join(' ')), log: () => {} },
  };
  // eslint-disable-next-line no-new-func
  const reply = new Function('scope', `with (scope) {\n${SRC.slice(a, b + 3)}\nreturn reply;\n}`)(scope);
  return { reply, reqs, errs };
}

test('reply：uuid 由 reply:<消息 id> 派生，≤50 字符、不含 id 原文；同一条的不同文案 uuid 不同', async () => {
  const r = realReply(() => ({}));
  await r.reply(MID, BODY);
  await r.reply(MID, `${BODY}2`);
  const [a, b] = r.reqs.map((x) => x.data.uuid);
  assert.equal(a, feishuUuid(`reply:${MID}`, contentPart('card', BODY)));
  assert.ok(a.length <= FEISHU_UUID_MAX_LEN && !a.includes('om_'), a);
  assert.notEqual(a, b);
});

test('reply：卡片退文本的日志带飞书错误码；文本请求也带 uuid', async () => {
  const r = realReply((x) => { if (x.data.msg_type === 'interactive') throw httpErr(230099); return {}; });
  await r.reply(MID, BODY);
  assert.equal(r.reqs[1].data.uuid, feishuUuid(`reply:${MID}`, contentPart('text', BODY)));
  assert.equal(r.errs.length, 1);
  assert.ok(r.errs[0].startsWith('[reply] card failed, fallback to text:') && r.errs[0].includes('230099'), r.errs[0]);
});

test('reply：长回复后面某段发不出去——照旧补一条「没发完」提示、不抛（这条路没有调用方重试），提示也带 uuid', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const long = `${'汉'.repeat(12_000)}\n\n${'字'.repeat(12_000)}`;
  assert.ok(splitMessage(long).segments.length > 1);
  const r = realReply((x, n) => { if (n === 2 || n === 3) throw httpErr(1); return {}; });
  await r.reply(MID, long);
  assert.equal(r.reqs.length, 4);
  const notice = r.reqs[3].data;
  assert.ok(JSON.parse(notice.content).text.includes('没有送达'));
  assert.ok(r.reqs.every((x) => typeof x.data.uuid === 'string' && x.data.uuid.length <= FEISHU_UUID_MAX_LEN));
  assert.equal(new Set(r.reqs.map((x) => x.data.uuid)).size, 4);
});

test('接线：回答轮的两处附件回传和语音回复都带同一个逻辑键', () => {
  const a = SRC.indexOf('async function handleMessage(');
  const seg = SRC.slice(a, SRC.indexOf('const eventDispatcher', a));
  assert.equal(seg.match(/flushOutbox\(client, outboxDirFor\(sessionKey, isOwner\)/g).length, 2);
  assert.equal(seg.match(/idempotencyKey: replyKey/g).length, 3);
  assert.match(seg, /const replyKey = `reply:\$\{message\.message_id\}`;/);
});

// ---- 语音 ------------------------------------------------------------------------------------
/** 假的 say / ffmpeg：转码那一步写出一个假的 opus；假客户端等读流打开后返回 file_key */
const fakeExec = async (cmd, args) => { if (args.includes('-y')) fs.writeFileSync(args.at(-1), 'x'); return { stdout: '' }; };
const voiceClient = { im: { v1: { file: { create: async ({ data }) => { await new Promise((r) => data.file.once('open', r)); data.file.destroy(); return { file_key: 'fk' }; } } } } };

test('语音回复带 uuid（≤50）；不给键时请求体不变', async () => {
  const sent = [];
  const send = async (d) => { sent.push(d); };
  assert.equal(await sendVoice(voiceClient, BODY, send, { idempotencyKey: `reply:${MID}`, exec: fakeExec, platform: 'darwin' }), true);
  assert.equal(sent[0].uuid, feishuUuid(`reply:${MID}`, contentPart('audio', BODY)));
  assert.ok(sent[0].uuid.length <= FEISHU_UUID_MAX_LEN);
  await sendVoice(voiceClient, BODY, send, { exec: fakeExec, platform: 'darwin' });
  assert.deepEqual(sent[1], { msg_type: 'audio', content: JSON.stringify({ file_key: 'fk' }) });
});

test('语音合成失败：日志只记错误码，不带正文（命令行报错里带着整段回复）', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...x) => logs.push(x.map((v) => v?.stack ?? String(v)).join(' ')));
  const exec = async (cmd, args) => { throw Object.assign(new Error(`Command failed: ${cmd} ${args.join(' ')}`), { code: 1, cmd: args.join(' ') }); };
  assert.equal(await sendVoice(voiceClient, BODY, async () => {}, { exec, platform: 'darwin' }), false);
  assert.deepEqual(logs, ['[tts] 语音回复失败（code=1）']);
});

// ---- 其它正文输出点 ---------------------------------------------------------------------------
test('[msg] 行：只有身份尾号、类型、字数和消息尾号，没有正文', () => {
  const id = ['ou', 'test0009zzz'].join('_');
  assert.equal(
    formatInboundLog({ who: id, chatType: 'group', messageType: 'text', exec: true, text: `${BODY}\n第二行😀`, messageId: MID }),
    '[msg] ou_…009zzz @ group [text] [exec] len=12 id=…001abc',
  );
  assert.equal(formatInboundLog({ who: 'owner', chatType: 'p2p', messageType: 'text', text: '' }), '[msg] owner @ p2p [text] len=0 id=?');
});

test('排队通知发不出去：日志只记长度，不带通知文字', async () => {
  const logs = [];
  const q = createOwnerMessageQueue({
    enabled: true, isDraining: () => true, reply: async () => { throw new Error('飞书 500'); }, react: async () => true,
    startTurn: () => {}, log: (s) => logs.push(s), warn: (s) => logs.push(s),
  });
  logs.length = 0; // 开关开启时构造器自己打一行
  await q.offer('k', { message: { message_id: MID } });
  assert.equal(logs.length, 1, logs.join('\n'));
  assert.match(logs[0], /^\[queue\] 回复失败（长度 \d+）：飞书 500$/);
});
