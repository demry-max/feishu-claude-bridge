// BRIDGE-SEND-2：回传文件（outbox）发不出去 / 这一轮失败 / 这一轮被取消时的处理。
// 保留目录一律用 mkdtemp 的临时目录（opts.keepDir），不碰仓库的 data/；不连飞书、不读 .env。
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withUuid, outboxPart, feishuUuid, contentPart } from '../src/send-key.js';
import { flushOutbox, redact } from '../src/outbound.js';
import { displayName, fsName, keepEntry, pruneKeepDir, unsentNote, KEEP_MAX_ENTRIES } from '../src/outbox-keep.js';
import { fireJob, schedSendKey } from '../src/scheduler.js';
import { resolveTurn } from '../src/turn-context.js';
import { schedDestOf } from '../src/biz-wiring.js';
import { schedDiagPrompt } from '../src/claude.js';
import { routeTurn } from '../src/lanes.js';
import { detectConfirm } from '../src/tool-policy.js';
import { createToolTurn } from '../src/tool-audit.js';
import * as mq from '../src/message-queue.js';
import { createShutdown, replyIfDraining } from '../src/shutdown.js';

const REPO_KEEP = new URL('../data/outbox-unsent', import.meta.url).pathname;
const repoKeepBefore = fs.existsSync(REPO_KEEP) ? fs.readdirSync(REPO_KEEP).sort().join('|') : null;
const roots = [];
const mk = (p = 'send2-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); roots.push(d); return d; };
after(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
  const now = fs.existsSync(REPO_KEEP) ? fs.readdirSync(REPO_KEEP).sort().join('|') : null;
  assert.equal(now, repoKeepBefore, '测试不应改动仓库的 data/outbox-unsent');
});
const cps = (s) => [...s].length;
const KEY = schedSendKey('daily.json', '2026-11-20T01:00:00.000Z');

function silence(t) {
  const lines = [];
  const grab = (...a) => { lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')); };
  t.mock.method(console, 'error', grab);
  t.mock.method(console, 'log', grab);
  return lines;
}
function fakeClient({ failUpload = () => false } = {}) {
  const uploads = [];
  const up = (kind) => async ({ data }) => {
    const stream = data.image ?? data.file;
    const name = data.file_name ?? path.basename(stream?.path ?? 'image');
    stream?.on?.('error', () => {}); // 假上传不读内容；文件随后被删，流异步 open 会报 ENOENT
    stream?.destroy?.();
    if (failUpload(name)) throw new Error(`upload ${name} failed`);
    uploads.push({ kind, name });
    return { [kind === 'image' ? 'image_key' : 'file_key']: `key_${uploads.length}` };
  };
  return { uploads, client: { im: { v1: { image: { create: up('image') }, file: { create: up('file') } } } } };
}
function fakeSend({ failIf = () => false } = {}) {
  const sent = [];
  const sendRaw = async (data) => { sent.push(data); if (failIf(data, sent.length)) throw new Error('send failed'); return { data: { message_id: `om_${sent.length}` } }; };
  return { sent, sendRaw };
}
function outboxWith(files) {
  const dir = mk('send2-ob-');
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}
const ls = (d) => fs.readdirSync(d).sort();

// 夹具：f49b44b 的 flushOutbox（src/outbound.js:173-209）原文
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
async function oldFlush(client, outboxDir, sendRaw, opts = {}) {
  const idemKey = opts?.idempotencyKey;
  if (!fs.existsSync(outboxDir)) return 0;
  const files = fs.readdirSync(outboxDir).filter((f) => !f.startsWith('.') && fs.statSync(path.join(outboxDir, f)).isFile());
  let sent = 0;
  for (const name of files) {
    const p = path.join(outboxDir, name);
    try {
      const ext = path.extname(name).toLowerCase();
      const part = idemKey ? outboxPart(name, fs.readFileSync(p)) : null;
      if (IMAGE_EXT.has(ext)) {
        const up = await client.im.v1.image.create({ data: { image_type: 'message', image: fs.createReadStream(p) } });
        const key = up?.image_key ?? up?.data?.image_key;
        if (!key) throw new Error('上传图片未返回 image_key');
        await sendRaw(withUuid({ msg_type: 'image', content: JSON.stringify({ image_key: key }) }, idemKey, part));
      } else {
        const up = await client.im.v1.file.create({ data: { file_type: 'stream', file_name: name, file: fs.createReadStream(p) } });
        const key = up?.file_key ?? up?.data?.file_key;
        if (!key) throw new Error('上传文件未返回 file_key');
        await sendRaw(withUuid({ msg_type: 'file', content: JSON.stringify({ file_key: key }) }, idemKey, part));
      }
      sent++;
    } catch (e) {
      console.error(`[outbox] 发送 ${name} 失败:`, e?.message ?? e);
    } finally {
      fs.rmSync(p, { force: true });
    }
  }
  return sent;
}

describe('O 回传文件', () => {
  test('O1 差分：全部成功 / 空目录 / 目录不存在 / 点文件 → 请求、上传、剩余文件与旧实现相同；无额外消息', async (t) => {
    silence(t);
    const layouts = [{}, { 'a.png': 'x', 'b.pdf': 'yy', 'c.txt': 'zzz' }, { '.hidden': 'h', 'd.JPG': 'q' }];
    for (const files of layouts) for (const key of [undefined, KEY]) {
      const dA = outboxWith(files); const dB = outboxWith(files);
      const A = fakeClient(); const B = fakeClient(); const sa = fakeSend(); const sb = fakeSend();
      const ra = await oldFlush(A.client, dA, sa.sendRaw, { idempotencyKey: key });
      const rb = await flushOutbox(B.client, dB, sb.sendRaw, { idempotencyKey: key, keepDir: mk('keep-') });
      assert.deepEqual(sb.sent, sa.sent);
      assert.deepEqual(B.uploads, A.uploads);
      assert.deepEqual(ls(dB), ls(dA));
      assert.equal(rb.sent, ra);
      assert.equal(rb.note, '');
    }
    const gone = path.join(os.tmpdir(), 'send2-nonexistent-dir');
    assert.equal((await flushOutbox(fakeClient().client, gone, fakeSend().sendRaw)).sent, 0);
  });

  test('O2 发送模式失败：文件挪进保留目录（不删）、补一条说明；有键时说明带 uuid、无键时不带；说明发不出去不抛', async (t) => {
    const logs = silence(t);
    for (const key of [undefined, KEY]) {
      const dir = outboxWith({ 'ok.txt': '1', 'bad.pdf': '2', 'bad.png': '3' });
      const keep = mk('keep-');
      const { client, uploads } = fakeClient({ failUpload: (n) => n.startsWith('bad') });
      const { sent, sendRaw } = fakeSend();
      const r = await flushOutbox(client, dir, sendRaw, { idempotencyKey: key, keepDir: keep });
      assert.equal(r.sent, 1);
      assert.deepEqual(r.unsent.sort(), ['bad.pdf', 'bad.png']);
      assert.deepEqual(ls(dir), []);
      const kept = ls(keep);
      assert.equal(kept.length, 2);
      assert.ok(kept.every((n) => /^\d{8}T\d{6}Z-[0-9a-f]{4}-bad\./.test(n)));
      assert.equal(fs.readFileSync(path.join(keep, kept.find((n) => n.endsWith('.pdf'))), 'utf8'), '2');
      assert.equal(uploads.length, 1);
      const noteMsg = sent.at(-1);
      assert.equal(noteMsg.msg_type, 'text');
      const text = JSON.parse(noteMsg.content).text;
      assert.ok(text.startsWith('⚠️ '));
      assert.ok(text.includes('「bad.pdf」') && text.includes('「bad.png」'));
      assert.ok(!text.includes(dir) && !text.includes(keep) && !text.includes(os.tmpdir()));
      assert.equal(r.note, text);
      if (key) assert.equal(noteMsg.uuid, feishuUuid(key, contentPart('unsent', r.note)));
      else assert.equal('uuid' in noteMsg, false);
    }
    // 说明本身发不出去：不抛、仍返回结果
    const dir = outboxWith({ 'bad.pdf': '2' });
    const { client } = fakeClient({ failUpload: () => true });
    const { sendRaw } = fakeSend({ failIf: () => true });
    const r = await flushOutbox(client, dir, sendRaw, { keepDir: mk('keep-') });
    assert.deepEqual(r.unsent, ['bad.pdf']);
    assert.ok(logs.some((l) => l.includes('补发「没发出去」说明失败')));
  });

  test('O3 子目录整个挪走不上传、计入 nested；顶层符号链接 / 目录内链接不上传、删链接不动目标、说明不带路径', async (t) => {
    silence(t);
    const outside = mk('outside-');
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'TOP-SECRET');
    const dir = outboxWith({ 'sub/a.txt': 'a', 'sub/deep/b.txt': 'b', 'ok.txt': 'ok' });
    fs.symlinkSync(secret, path.join(dir, 'link.txt'));
    fs.symlinkSync(outside, path.join(dir, 'linkdir'));
    fs.symlinkSync(secret, path.join(dir, 'sub', 'inner-link.txt'));
    fs.mkdirSync(path.join(dir, 'empty-dir')); // 空目录：悄悄清掉，不计数、不留存
    const keep = mk('keep-');
    const { client, uploads } = fakeClient();
    const { sent, sendRaw } = fakeSend();
    const r = await flushOutbox(client, dir, sendRaw, { keepDir: keep });
    assert.deepEqual(uploads.map((u) => u.name), ['ok.txt']);
    assert.equal(r.nested, 2);
    assert.equal(r.links, 2);
    assert.equal(fs.readFileSync(secret, 'utf8'), 'TOP-SECRET');
    assert.deepEqual(ls(outside), ['secret.txt']);
    assert.deepEqual(ls(dir), []);
    const kept = ls(keep);
    assert.equal(kept.length, 1); // 只有 sub
    const subKept = kept.find((n) => n.endsWith('-sub'));
    assert.ok(fs.existsSync(path.join(keep, subKept, 'a.txt')));
    assert.ok(!fs.existsSync(path.join(keep, subKept, 'inner-link.txt')), '目录里的链接被删掉');
    const text = JSON.parse(sent.at(-1).content).text;
    assert.match(text, /2 个放在子目录里的文件没有发送/);
    assert.match(text, /2 个符号链接或特殊文件没有上传/);
    assert.ok(!text.includes(outside) && !text.includes('secret') && !text.includes(dir));
    assert.equal(sent.filter((s) => s.msg_type === 'file').length, 1);
  });

  test('O4 discard：全清、不上传不发消息、不进保留目录、returns removed 数；目录不存在返回空', async (t) => {
    silence(t);
    const dir = outboxWith({ 'a.txt': '1', 'b.png': '2', 'sub/c.txt': '3' });
    fs.symlinkSync('/etc/hosts', path.join(dir, 'l'));
    const keep = mk('keep-');
    const { client, uploads } = fakeClient(); const { sent, sendRaw } = fakeSend();
    const r = await flushOutbox(client, dir, sendRaw, { mode: 'discard', keepDir: keep });
    assert.equal(r.removed, 4);
    assert.equal(r.note, '');
    assert.deepEqual([ls(dir), ls(keep), uploads, sent], [[], [], [], []]);
    assert.ok(fs.existsSync('/etc/hosts'));
    assert.equal((await flushOutbox(client, path.join(dir, 'nope'), sendRaw, { mode: 'discard' })).removed, 0);
  });

  test('O5 hold（失败轮）：不上传、不发消息、全部进保留目录；说明以「📎 」开头并含「这一轮没有完成」；无待发文件时 note 为空', async (t) => {
    const logs = silence(t);
    const dir = outboxWith({ 'r.pdf': 'R', 'chart.png': 'C', 'sub/x.txt': 'x' });
    const keep = mk('keep-');
    const { client, uploads } = fakeClient(); const { sent, sendRaw } = fakeSend();
    const r = await flushOutbox(client, dir, sendRaw, { mode: 'hold', keepDir: keep, idempotencyKey: KEY });
    assert.deepEqual([uploads, sent], [[], []]);
    assert.deepEqual(r.unsent.sort(), ['chart.png', 'r.pdf']);
    assert.equal(r.nested, 1);
    assert.ok(r.note.startsWith('📎 '));
    assert.ok(r.note.includes('这一轮没有完成'));
    assert.equal(ls(keep).length, 3);
    assert.deepEqual(ls(dir), []);
    assert.ok(logs.some((l) => l.includes('[outbox] 这一轮没完成：3 个待发文件没有发送')));
    assert.equal((await flushOutbox(client, dir, sendRaw, { mode: 'hold', keepDir: keep })).note, '');
  });

  test('O6 文件名清洗：说明里没有 < > 反引号 换行 U+202E；显示名 ≤ 40 码点；保留目录文件名 ≤ 80 码点、带时间戳前缀', async (t) => {
    silence(t);
    const nasty = ['a<b>`c`.txt', '行\n换.txt', 'evil‮gnp.exe', `${'长'.repeat(100)}.txt`, '​\u0007.bin', 'x'.repeat(200)];
    const dir = mk('ob-');
    const made = [];
    for (const n of nasty) { try { fs.writeFileSync(path.join(dir, n), 'x'); made.push(n); } catch { /* 文件系统不接受的名字跳过 */ } }
    assert.ok(made.length >= 5);
    const keep = mk('keep-');
    const { client } = fakeClient(); const { sendRaw } = fakeSend();
    const r = await flushOutbox(client, dir, sendRaw, { mode: 'hold', keepDir: keep });
    assert.ok(!/[<>`\n‮]/.test(r.note));
    for (const n of r.unsent) assert.ok(cps(n) <= 40, n);
    for (const n of ls(keep)) { assert.ok(cps(n) <= 80 + 23, n); assert.match(n, /^\d{8}T\d{6}Z-[0-9a-f]{4}-/); }
    assert.equal(displayName('a<b>`c`.txt'), 'a_b__c_.txt');
    assert.equal(displayName('​\u0007'), '（无名文件）');
    assert.equal(displayName('长'.repeat(100)).endsWith('…'), true);
    assert.equal(cps(displayName('长'.repeat(100))), 40);
    assert.equal(cps(fsName('长'.repeat(200))), 80);
    assert.equal(fsName('a b'), 'a_b');
    assert.equal(fsName('\u0007'), 'file');
  });

  const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  test('O7 保留目录：0700；超过 14 天的清掉、13 天的留；满 200 份时删最旧的；名字不匹配规则的不动', async (t) => {
    silence(t);
    const keep = mk('keep-');
    const now = Date.UTC(2026, 10, 20, 12, 0, 0);
    const day = 86_400_000;
    const put = (ms, tag, hex = 'abcd') => fs.writeFileSync(path.join(keep, `${stampOf(ms)}-${hex}-${tag}`), 'x');
    put(now - 15 * day, 'old'); put(now - 13 * day, 'recent');
    fs.writeFileSync(path.join(keep, 'README.txt'), 'mine');
    fs.mkdirSync(path.join(keep, 'handmade'));
    pruneKeepDir(keep, { now });
    assert.deepEqual(ls(keep).filter((n) => n.includes('-abcd-')).map((n) => n.slice(22)), ['recent']);
    assert.ok(ls(keep).includes('README.txt') && ls(keep).includes('handmade'));

    const keep2 = mk('keep-');
    for (let i = 0; i < KEEP_MAX_ENTRIES + 20; i += 1) fs.writeFileSync(path.join(keep2, `${stampOf(now - 3 * day + i * 1000)}-${String(i).padStart(4, '0').replace(/\d/g, 'a')}-f${i}`), 'x');
    const src = path.join(mk('src-'), 'new.txt'); fs.writeFileSync(src, 'n');
    assert.equal(keepEntry(src, 'new.txt', { keepDir: keep2, now }), true);
    const left = ls(keep2);
    assert.equal(left.length, KEEP_MAX_ENTRIES); // 删到 199 再放进 1 份
    assert.ok(left.some((n) => n.endsWith('-new.txt')));
    assert.ok(!left.some((n) => n.endsWith('-f0')), '最旧的被删');
    assert.ok(left.some((n) => n.endsWith(`-f${KEEP_MAX_ENTRIES + 19}`)));

    const keep3 = path.join(mk('keep-'), 'nested', 'dir');
    const src3 = path.join(mk('src-'), 'a.txt'); fs.writeFileSync(src3, 'a');
    assert.equal(keepEntry(src3, 'a.txt', { keepDir: keep3, now }), true);
    assert.equal((fs.statSync(keep3).mode & 0o777).toString(8), '700');
    fs.chmodSync(keep3, 0o755);
    const src4 = path.join(mk('src-'), 'b.txt'); fs.writeFileSync(src4, 'b');
    keepEntry(src4, 'b.txt', { keepDir: keep3, now });
    assert.equal((fs.statSync(keep3).mode & 0o777).toString(8), '700', '已存在且权限不对也收紧');
  });

  test('O8 保留目录建不出来（路径上是个普通文件）：原件删掉、lost 计数、说明写「没能留存」、不抛', async (t) => {
    silence(t);
    const blocker = path.join(mk('blk-'), 'not-a-dir'); fs.writeFileSync(blocker, 'x');
    const dir = outboxWith({ 'bad.pdf': '2', 'sub/x.txt': 'x' });
    const { client } = fakeClient({ failUpload: () => true }); const { sent, sendRaw } = fakeSend();
    const r = await flushOutbox(client, dir, sendRaw, { keepDir: path.join(blocker, 'keep') });
    assert.equal(r.lost, 2);
    assert.deepEqual(ls(dir), []);
    assert.match(r.note, /其中 2 个没能留存，已清掉/);
    assert.equal(JSON.parse(sent.at(-1).content).text, r.note);
    assert.equal(keepEntry(path.join(dir, 'ghost'), 'ghost', { keepDir: path.join(blocker, 'keep') }), false);
  });

  test('O8c 上传在读流之前就失败（流还没打开、文件已被挪走）：不会冒出未捕获的 ENOENT', async (t) => {
    silence(t);
    const uncaught = [];
    const onUncaught = (e) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const dir = outboxWith({ 'bad.pdf': '2', 'bad.png': '3' });
      const client = { im: { v1: {
        image: { create: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } },
        file: { create: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } },
      } } };
      const r = await flushOutbox(client, dir, fakeSend().sendRaw, { keepDir: mk('keep-') });
      assert.equal(r.unsent.length, 2);
      for (let i = 0; i < 20; i += 1) await new Promise((res) => setImmediate(res));
    } finally { process.off('uncaughtException', onUncaught); }
    assert.deepEqual(uncaught.map((e) => e.message), []);
  });

  test('O8b unsentNote：各项都为 0 返回空串；超过 10 个文件名只列 10 个并加「 等」', () => {
    assert.equal(unsentNote({}), '');
    const note = unsentNote({ names: Array.from({ length: 12 }, (_, i) => `f${i}`) });
    assert.equal((note.match(/「/g) ?? []).length, 10);
    assert.ok(note.includes('等（共 12 个'));
  });

  // —— runTurn 接线：切 index.js 的真实代码段，依赖全是桩（与 turn-wiring.test.js 同一写法）——
  const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  function cut(start, end, { inclusive = false } = {}) {
    const a = SRC.indexOf(start);
    assert.ok(a >= 0, `index.js 里找不到：${start}`);
    const b = SRC.indexOf(end, a + start.length);
    assert.ok(b > a, `index.js 里找不到 ${start} 之后的：${JSON.stringify(end)}`);
    return SRC.slice(a, inclusive ? b + end.length : b);
  }
  const DM = 'oc_ownerdm0000000001';
  const OWNER = 'ou_owner';
  const settle = async (n = 12) => { for (let i = 0; i < n; i += 1) await new Promise((res) => setImmediate(res)); };
  let factory;
  function indexFactory() {
    if (factory) return factory;
    const code = [
      cut('const chatQueues = new Map();', 'async function reply(messageId, text) {'),
      cut('async function react(messageId, emoji) {', '\n}\n', { inclusive: true }),
      cut('async function handleMessage(data', '\nconst eventDispatcher'),
      cut('const shutdown = createShutdown({', '\n});', { inclusive: true }),
    ].join('\n');
    // eslint-disable-next-line no-new-func
    factory = new Function('scope', `with (scope) {\n${code}\nreturn { handleMessage, trackedHandleMessage };\n}`);
    return factory;
  }
  function bridge(t, { files = {}, run = async () => '答复', keepFail = false } = {}) {
    silence(t);
    const outDir = outboxWith(files);
    const keep = mk('keep-');
    const r = { replies: [], rawSent: [], flushArgs: [], keep, outDir, n: 0 };
    const fc = fakeClient();
    const scope = {
      console, process: { env: {} },
      createOwnerMessageQueue: mq.createOwnerMessageQueue, messageQueueEnabled: mq.messageQueueEnabled,
      mergeQueuedTurns: mq.mergeQueuedTurns, MERGED_NO_CONFIRM: mq.MERGED_NO_CONFIRM, withClearedNote: mq.withClearedNote,
      routeTurn, detectConfirm, createToolTurn, OWNER_TOOL_PROFILE: 'legacy', resolveTurn, BIZ_ON: false,
      createShutdown: (o) => createShutdown({ ...o, pollMs: 1000, exit: () => {}, now: () => 0, timers: { setTimeout: () => ({}), clearTimeout: () => {} } }),
      shutdownGraceSec: () => 120, replyIfDraining,
      heartbeat: { isInflight: () => false, stop: () => {} },
      HEARTBEAT_KEY: 'sched:heartbeat', VERIFY_KEY: 'sched:verify',
      client: { im: { v1: { ...fc.client.im.v1, message: { reply: async (x) => { r.rawSent.push(x); return { data: { message_id: 'om_r' } }; } }, messageReaction: { create: async () => ({ code: 0 }) } } } },
      reply: async (mid, text) => { r.replies.push([mid, text]); },
      isDuplicate: () => false, getBotOpenId: async () => 'ou_bot', isAllowed: () => true,
      OWNER_OPEN_ID: OWNER, loadOwner: () => OWNER, saveOwner: () => true, ALLOW_USERS: [],
      workspaceFor: () => '/tmp/s2-ws', buildPrompt: async (_c, m) => ({ prompt: m.__text, attachments: [] }),
      describeError: (e) => ({ text: String(e?.message ?? e), hint: '' }),
      heartbeatReplyShortcut: async () => null, privateHeartbeatCommand: () => null,
      sessionInfo: () => 's', describeTasks: () => 't', HELP_TEXT: '帮助',
      getRuntimeConfig: () => ({ model: 'm', effort: 'e', execModel: '' }), setRuntimeConfig: () => ({}), checkCliEnvironment: () => null,
      MODEL_ALIASES: {}, EFFORT_LEVELS: [], voiceChats: new Set(),
      resetSession: () => {}, isRunning: () => false, cancelRun: () => false, abortRetries: () => false,
      sessionKeysWithPrefix: () => [], runningKeysWithPrefix: () => [],
      runClaude: async (...a) => run(...a),
      redact: (s) => s, resolveSenderName: async () => '张三', recallHint: () => '', WORKSPACE_DIR: '/tmp/s2-ws',
      shouldRecycleSession: () => false, consumeMemoryNudge: () => false, formatInboundLog: () => '[in]',
      createProgressChannel: () => ({ update: () => {}, finish: async () => {} }),
      flushOutbox: (client, dir, sendRaw, o) => { r.flushArgs.push(o); return flushOutbox(client, dir, sendRaw, { ...o, keepDir: keepFail ? path.join(outDir, 'a', 'b') : keep }); },
      outboxDirFor: () => outDir,
      sendVoice: async () => {}, claudeFailureReply: async (m) => `⚠️ 出错了：${m}`,
    };
    const proxy = new Proxy(scope, { has: (tt, k) => typeof k === 'string' && Object.hasOwn(tt, k), get: (tt, k) => (k === Symbol.unscopables ? undefined : tt[k]) });
    Object.assign(r, indexFactory()(proxy));
    r.send = async (text) => {
      r.n += 1;
      const message = { message_id: `om_${r.n}`, chat_id: DM, chat_type: 'p2p', message_type: 'text', create_time: String(Date.now()), mentions: [], __text: text };
      await r.trackedHandleMessage({ message, sender: { sender_id: { open_id: OWNER } } });
      await settle();
    };
    return r;
  }

  test('O9a runTurn 成功路径：flushOutbox 第 4 参仍是 undefined（缺省 = 发送），文件照发', async (t) => {
    const b = bridge(t, { files: { 'r.pdf': 'R' } });
    await b.send('你好');
    assert.deepEqual(b.flushArgs, [undefined]);
    assert.equal(b.rawSent.length, 1);
    assert.equal(b.rawSent[0].data.msg_type, 'file');
    assert.deepEqual(ls(b.keep), []);
  });

  test('O9b runTurn 失败：{mode:\'hold\'}、文件进保留目录、不上传；失败回复末尾带「📎」说明，原错误文字在前', async (t) => {
    const b = bridge(t, { files: { 'r.pdf': 'R' }, run: async () => { throw new Error('boom'); } });
    await b.send('你好');
    assert.deepEqual(b.flushArgs, [{ mode: 'hold' }]);
    assert.deepEqual(b.rawSent, []);
    assert.equal(ls(b.keep).length, 1);
    assert.equal(b.replies.length, 1);
    const [, text] = b.replies[0];
    assert.ok(text.startsWith('⚠️ 出错了：boom'));
    assert.ok(text.includes('\n\n📎 ') && text.includes('「r.pdf」') && text.includes('这一轮没有完成'));
  });

  test('O9c runTurn 取消：{mode:\'discard\'}、文件清掉、不进保留目录、不回复', async (t) => {
    const b = bridge(t, { files: { 'r.pdf': 'R' }, run: async () => { throw Object.assign(new Error('cancelled'), { cancelled: true }); } });
    await b.send('你好');
    assert.deepEqual(b.flushArgs, [{ mode: 'discard' }]);
    assert.deepEqual([ls(b.outDir), ls(b.keep), b.rawSent, b.replies], [[], [], [], []]);
  });

  test('O9d runTurn 失败且没有待发文件：回复就是原来的错误文字（不多出空行或说明）；保留目录写不进去时仍回复', async (t) => {
    const b = bridge(t, { run: async () => { throw new Error('boom'); } });
    await b.send('你好');
    assert.deepEqual(b.replies, [['om_1', '⚠️ 出错了：boom']]);
    const c = bridge(t, { files: { 'r.pdf': 'R' }, keepFail: true, run: async () => { throw new Error('boom'); } });
    fs.writeFileSync(path.join(c.outDir, 'a'), 'x'); // 保留目录路径落在这个普通文件下面 → 建不出来
    await c.send('你好');
    assert.equal(c.replies.length, 1);
    assert.match(c.replies[0][1], /没能留存/);
  });

  // —— 调度器 onRunFailure 接线（K4 写法）——
  function buildSched(t, { runFails = true, cancelled = false, heldNote = '📎 N' } = {}) {
    silence(t);
    const toChat = []; const flushArgs = [];
    const scope = {
      resolveTurn, schedDestOf, ownerDmChatId: DM, OWNER_TOOL_PROFILE: 'legacy', BIZ_ON: false,
      startScheduler: (opts) => { scope.captured = opts; return { stop() {}, inflightCount: () => 0 }; },
      SCHEDULES_DIR: '/tmp/x', SCHED_STATE_FILE: '/tmp/x.json',
      sendToOwner: async () => {}, setRuntimeConfig: () => ({ model: 'm', effort: 'e', execModel: '' }),
      client: { im: { v1: { message: { create: async (x) => { toChat.push(x); return { data: { message_id: 'om_1' } }; } } } } },
      fireJob, redact, sendCardWithFallback: async (create, chunk) => { toChat.push(chunk); return 'om_1'; },
      runClaude: async () => { if (runFails) throw (cancelled ? Object.assign(new Error('c'), { cancelled: true }) : new Error('boom')); return 'A'; },
      flushOutbox: async (...a) => { flushArgs.push(a[3]); return a[3]?.mode ? (heldNote ? { note: heldNote } : {}) : { sent: 0 }; },
      outboxDirFor: (id, p) => `/out/${id}/${p}`,
      isQuietAnswer: () => false, schedDiagPrompt,
      handleScheduledFailure: async (o) => { await o.send('DIAG'); },
      OWNER_OPEN_ID: 'ou_x', loadOwner: () => 'ou_x',
    };
    const proxy = new Proxy(scope, { has: (tt, k) => typeof k === 'string' && Object.hasOwn(tt, k), get: (tt, k) => (k === Symbol.unscopables ? undefined : tt[k]) });
    const inc = { inclusive: true };
    const src = [cut('function schedTurnFor(source, job) {', '\n}\n', inc), cut('async function sendToChat(', '\n}\n', inc), cut('async function sendMarkdown(', '\n}\n', inc), cut('const scheduler = startScheduler({', '\n});', inc)].join('\n');
    // eslint-disable-next-line no-new-func
    new Function('scope', `with (scope) {\n${src}\nreturn { scheduler };\n}`)(proxy);
    return { toChat, flushArgs, opts: scope.captured };
  }
  const job = () => ({ _file: 'daily.json', name: '晨报', prompt: 'P', chat_id: DM });
  const fire = (o) => o.opts.onFire(job(), { sendKey: KEY, notifyOnce: async () => {} });

  test('O10a 定时任务失败：flushOutbox 第 4 参 {mode:\'hold\'}，有 note → 目的会话多发一条，内容就是 note', async (t) => {
    const s = buildSched(t);
    await fire(s);
    assert.deepEqual(s.flushArgs, [{ mode: 'hold' }]);
    assert.equal(s.toChat.filter((x) => x === '📎 N').length, 1);
  });
  test('O10b 失败但 held 没有 note → 不多发', async (t) => {
    const s = buildSched(t, { heldNote: '' });
    await fire(s);
    assert.ok(!s.toChat.includes('📎 N') && s.toChat.every((x) => typeof x !== 'string' || !x.startsWith('📎')));
    assert.deepEqual(s.flushArgs, [{ mode: 'hold' }]);
  });
  test('O10c 取消：{mode:\'discard\'}', async (t) => {
    const s = buildSched(t, { cancelled: true });
    await fire(s);
    assert.ok(s.flushArgs.some((a) => a?.mode === 'discard'));
    assert.ok(!s.flushArgs.some((a) => a?.mode === 'hold'));
  });
  test('O10d 成功路径：flush 带发送选项（没有 mode）', async (t) => {
    const s = buildSched(t, { runFails: false });
    await fire(s);
    assert.ok(s.flushArgs.length >= 1 && s.flushArgs.every((a) => a?.mode === undefined));
  });
});
