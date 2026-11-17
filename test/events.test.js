// BRIDGE-EV-1 测试 7–13，外加协调者补充的三项（时钟自愈 / 队首阻塞 / 队满告知）：
// 卡片按钮回调、表情与已读、引用回复快捷、未读暂停、默认关回归、message_id、Sonnet 默认值。
// 全部用注入的桩：不连飞书、不起 lark-cli、不调真实 claude。index.js 一 import 就连飞书，接线只做源码文本断言。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ownerText, OWNER as O_NAME, YOU as O_YOU } from '../src/owner-name.js'; // BRIDGE-PUB-1：称呼按配置（测试里未设：owner / 你）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const { createEventHandlers, heartbeatReplyShortcut, sendCardWithFallback, buildMarkdownCard, shortcutPhrase } =
  await import('../src/events.js');
const { heartbeatConfig, createHeartbeat, heartbeatCommand } = await import('../src/heartbeat.js');
const { createWatchSources } = await import('../src/watch-sources.js');
const { ledgerButtons } = await import('../src/ledger-actions.js');

const INDEX_SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

// 与 src/index.js 的 isQuietAnswer 同一判定（同 heartbeat.test.js）
const isQuiet = (a) => {
  const b = String(a ?? '').trim();
  return !b || /^HEARTBEAT_OK[.。!！]?$/i.test(b);
};
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi); // 本地时间
const plus = (d, min) => new Date(d.getTime() + min * 60_000);
const quietLog = () => {};
const OWNER = 'ou_owner';
const T0 = at(2026, 11, 16, 10, 0);
const TOAST_OK = { toast: { type: 'success', content: '已记下' } };
const TOAST_STALE = { toast: { type: 'warning', content: '已失效' } };
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);

const TASK = {
  title: '跟进报价单',
  status: 'open',
  next_check_at: '2026-11-16T09:00',
  escalate_after: '2026-11-18T18:00',
  created_at: '2026-11-10T09:00',
  owner_note: { who: '王总', tags: ['报价', 'Q4'] }, // 台账里不认识的字段：原样保留
  x_custom: 42,
};

function mkEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbe-'));
  const tasksDir = path.join(dir, 'ws', 'tasks');
  const journalDir = path.join(dir, 'ws', 'memory', 'journal');
  fs.mkdirSync(tasksDir, { recursive: true });
  return {
    dir, tasksDir, journalDir,
    stateFile: path.join(dir, 'data', 'heartbeat-state.json'),
    signalsFile: path.join(dir, 'data', 'heartbeat-signals.json'),
  };
}
const taskFile = (env, slug) => path.join(env.tasksDir, `${slug}.json`);
const writeTask = (env, slug, obj) => fs.writeFileSync(taskFile(env, slug), JSON.stringify(obj, null, 2));
const readTask = (env, slug) => JSON.parse(fs.readFileSync(taskFile(env, slug), 'utf8'));
const journalOf = (env, day = '2026-11-16') => {
  const f = path.join(env.journalDir, `${day}.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const CFG = (env = {}) => heartbeatConfig({ HEARTBEAT_ENABLED: 'true', HEARTBEAT_QUIET_HOURS: 'none', ...env }, quietLog);
// 每拍顺手改一下台账的 notes：文件一变退避就清零，多拍测试不会被退避挡住
const touch = (env, slug, n) => writeTask(env, slug, { ...readTask(env, slug), notes: `第 ${n} 次看过` });

// 心跳 + 事件处理函数。send 桩默认返回 om_<第几次调用>，并记下参数个数（没有按钮时应只传一个参数）；
// sendImpl(rec, n) 可以改成抛错 / 返回 undefined。defer 默认同步（排队的回写立刻执行），syncDefer:false 用真实的 setImmediate
function harness(env, { config = CFG(), answer, runImpl, sendImpl, now = T0, collectDeltas, syncDefer = true } = {}) {
  const calls = [];
  const sent = [];
  const logs = [];
  let clock = now;
  const log = (...a) => logs.push(a.join(' '));
  const hb = createHeartbeat({
    config, tasksDir: env.tasksDir, stateFile: env.stateFile, journalDir: env.journalDir, isQuiet,
    ...(collectDeltas ? { collectDeltas } : {}),
    ...(syncDefer ? { defer: (fn) => fn() } : {}),
    runClaude: async (...args) => {
      calls.push(args);
      if (runImpl) return runImpl(calls.length, ...args);
      if (answer !== undefined) return typeof answer === 'function' ? answer(calls.length) : answer;
      return `第 ${calls.length} 拍：报价单还没回`;
    },
    send: async function send(text, opts) {
      const rec = { text, opts, argc: arguments.length };
      sent.push(rec);
      if (sendImpl) return sendImpl(rec, sent.length);
      rec.mid = `om_${sent.length}`;
      return rec.mid;
    },
    now: () => clock,
    log,
    logError: log,
  });
  const handlers = createEventHandlers({ getOwner: () => OWNER, heartbeat: hb, log });
  return {
    hb, handlers, calls, sent, logs,
    setNow: (d) => { clock = d; },
    readState: () => JSON.parse(fs.readFileSync(env.stateFile, 'utf8')),
    readSignals: () => JSON.parse(fs.readFileSync(env.signalsFile, 'utf8')),
  };
}

// 卡片回调载荷（card.action.trigger 的形状：operator.open_id / context.open_message_id / action.value）
const click = (mid, value, operator = OWNER) => ({ operator: { open_id: operator }, context: { open_message_id: mid }, action: { value } });
const btn = (sentRec, action) => sentRec.opts.actions.find((a) => a.value.a === action).value;

// 跑一拍、发出一条带按钮的心跳消息（只涉及 tasks/quote.json）
async function beatWithButtons(env, extra = {}) {
  writeTask(env, 'quote', TASK);
  const h = harness(env, { config: CFG({ HEARTBEAT_BUTTONS: 'true' }), ...extra });
  const r = await h.hb.beat();
  assert.equal(r.action, 'sent');
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].argc, 2, '开了按钮、只涉及一条台账：send 收到 { actions }');
  return h;
}

describe('测试 7：卡片回调', () => {
  test('非 owner、nonce 不符、message_id 不在索引里、slug 不存在：都返回「已失效」，台账 / 状态 / journal / 信号一律不改', async () => {
    const env = mkEnv();
    const h = await beatWithButtons(env);
    const mid = h.sent[0].mid;
    const ack = btn(h.sent[0], 'ack');
    assert.deepEqual(h.sent[0].opts.actions, ledgerButtons('quote', ack.n), '按钮就是 ledgerButtons 的三个');
    assert.match(ack.n, /^[0-9a-f]{16}$/);
    h.setNow(plus(T0, 5));
    const snap = () => ({
      task: sha(taskFile(env, 'quote')),
      state: sha(env.stateFile),
      signals: sha(env.signalsFile),
      journal: journalOf(env),
      files: fs.readdirSync(env.tasksDir).sort(),
    });
    const before = snap();
    assert.equal(before.journal, '');
    const bad = [
      ['非 owner', click(mid, ack, 'ou_someone_else')],
      ['owner 未绑定的空 operator', click(mid, ack, '')],
      ['nonce 不符（同长度）', click(mid, { ...ack, n: 'f'.repeat(16) })],
      ['nonce 不符（长度不同）', click(mid, { ...ack, n: 'x' })],
      ['nonce 缺失', click(mid, { v: 1, a: 'ack', s: 'quote' })],
      ['message_id 不在索引里', click('om_unknown', ack)],
      ['message_id 不合规', click('../om_1', ack)],
      ['slug 不是这条消息的', click(mid, { ...ack, s: 'missing' })],
      ['未知动作', click(mid, { ...ack, a: 'approve' })],
      ['value 版本不认识', click(mid, { ...ack, v: 2 })],
    ];
    for (const [why, payload] of bad) {
      assert.deepEqual(await h.handlers.cardAction(payload), TOAST_STALE, why);
      assert.deepEqual(snap(), before, `${why}：不应改任何文件`);
    }
    // 台账文件被删（slug 不存在）：同样「已失效」，不会重新建出文件
    fs.rmSync(taskFile(env, 'quote'));
    const gone = snap();
    assert.deepEqual(await h.handlers.cardAction(click(mid, ack)), TOAST_STALE);
    assert.deepEqual(snap(), gone);
    assert.equal(fs.existsSync(taskFile(env, 'quote')), false);
    assert.ok(h.logs.some((l) => l.includes('已失效') && l.includes('台账不存在')), '日志写了失效原因');
    assert.ok(h.logs.every((l) => !l.includes('已按『')), '没有任何回写');
  });

  test('合法的 ack / snooze1d / drop：只改目标字段、未知字段保留、原子写；每次 journal 一行；重复点击「已失效」', async () => {
    const env = mkEnv();
    const h = await beatWithButtons(env);
    const mid = h.sent[0].mid;
    const f = taskFile(env, 'quote');
    const leftovers = () => fs.readdirSync(env.tasksDir).filter((x) => x.endsWith('.tmp'));

    // ack：台账一个字节都不改，acked_at 记在心跳自己的状态文件里
    h.setNow(plus(T0, 5));
    const bytes = fs.readFileSync(f, 'utf8');
    assert.deepEqual(await h.handlers.cardAction(click(mid, btn(h.sent[0], 'ack'))), TOAST_OK);
    assert.equal(fs.readFileSync(f, 'utf8'), bytes);
    let st = h.readState();
    assert.equal(st.tasks.quote.acked_at, plus(T0, 5).toISOString());
    assert.equal(st.msg_index[mid].acted.ack, plus(T0, 5).toISOString());
    assert.equal(st.msg_index[mid].read_at, plus(T0, 5).toISOString(), '点了按钮＝读过');

    // snooze1d：next_check_at 与 escalate_after 各 +1 天，加 updated_at；其余字段（含不认识的）原样、顺序不变
    h.setNow(plus(T0, 6));
    const inoBefore = fs.statSync(f).ino;
    assert.deepEqual(await h.handlers.cardAction(click(mid, btn(h.sent[0], 'snooze1d'))), TOAST_OK);
    const snoozed = readTask(env, 'quote');
    assert.deepEqual(snoozed, {
      ...TASK, next_check_at: '2026-11-17T09:00', escalate_after: '2026-11-19T18:00', updated_at: '2026-11-16T10:06',
    });
    assert.deepEqual(Object.keys(snoozed), [...Object.keys(TASK), 'updated_at']);
    assert.notEqual(fs.statSync(f).ino, inoBefore, '临时文件 + rename（原子写）');
    assert.deepEqual(leftovers(), []);

    // drop：只改 status（加 updated_at）
    h.setNow(plus(T0, 7));
    assert.deepEqual(await h.handlers.cardAction(click(mid, btn(h.sent[0], 'drop'))), TOAST_OK);
    assert.deepEqual(readTask(env, 'quote'), { ...snoozed, status: 'dropped', updated_at: '2026-11-16T10:07' });
    assert.deepEqual(leftovers(), []);

    assert.equal(journalOf(env), [
      ownerText`（桥接）${O_NAME}点了『知道了』：tasks/quote.json`,
      ownerText`（桥接）${O_NAME}点了『推迟一天』：tasks/quote.json`,
      ownerText`（桥接）${O_NAME}点了『不做了』：tasks/quote.json`,
      '',
    ].join('\n'));
    st = h.readState();
    assert.deepEqual(Object.keys(st.msg_index[mid].acted).sort(), ['ack', 'drop', 'snooze1d']);

    // 重复点击：同一动作已处理过 → 「已失效」，不再改文件
    const snap = [sha(f), sha(env.stateFile), journalOf(env)];
    assert.deepEqual(await h.handlers.cardAction(click(mid, btn(h.sent[0], 'ack'))), TOAST_STALE);
    assert.deepEqual([sha(f), sha(env.stateFile), journalOf(env)], snap);
    assert.equal(h.calls.length, 1, '按钮全程不调模型');
  });

  test('回调先回 toast、回写异步：真实 setImmediate 调度下，返回时台账还没改，下一个宏任务才写', async () => {
    const env = mkEnv();
    const h = await beatWithButtons(env, { syncDefer: false });
    const before = fs.readFileSync(taskFile(env, 'quote'), 'utf8');
    const t0 = Date.now();
    const toast = await h.handlers.cardAction(click(h.sent[0].mid, btn(h.sent[0], 'snooze1d')));
    assert.ok(Date.now() - t0 < 3000, '3 秒内返回');
    assert.deepEqual(toast, TOAST_OK);
    assert.equal(fs.readFileSync(taskFile(env, 'quote'), 'utf8'), before, '返回 toast 时还没写');
    await new Promise((r) => setImmediate(r));
    assert.equal(readTask(env, 'quote').next_check_at, '2026-11-17T09:00');
  });

  test('心跳 inflight 时排队：这一拍里点的按钮，这一拍结束后才写；同一动作连点两次只写一次', async () => {
    const env = mkEnv();
    const inside = {};
    let h;
    h = await beatWithButtons(env, {
      runImpl: async (n) => {
        if (n === 2) {
          const v = btn(h.sent[0], 'snooze1d');
          inside.inflight = h.hb.isInflight();
          inside.toast1 = await h.handlers.cardAction(click(h.sent[0].mid, v));
          inside.toast2 = await h.handlers.cardAction(click(h.sent[0].mid, v)); // 还没写回，校验照样通过
          inside.afterClick = readTask(env, 'quote');
          await new Promise((r) => setImmediate(r));
          await new Promise((r) => setTimeout(r, 5));
          inside.afterTick = readTask(env, 'quote');
        }
        return `第 ${n} 拍：报价单还没回`;
      },
    });
    h.setNow(plus(T0, 30));
    const r = await h.hb.beat();
    assert.equal(r.action, 'sent');
    assert.equal(inside.inflight, true);
    assert.deepEqual(inside.toast1, TOAST_OK);
    assert.deepEqual(inside.toast2, TOAST_OK);
    assert.equal(inside.afterClick.next_check_at, TASK.next_check_at, '一拍还没结束：不写');
    assert.equal(inside.afterTick.next_check_at, TASK.next_check_at, '等了宏任务也不写');
    const after = readTask(env, 'quote');
    assert.equal(after.next_check_at, '2026-11-17T09:00', '这一拍结束后写了，且只推迟了一天');
    assert.equal(after.escalate_after, '2026-11-19T18:00');
    const st = h.readState();
    assert.ok(st.msg_index[h.sent[0].mid].acted.snooze1d);
    assert.ok(st.msg_index[h.sent[1].mid], '这一拍自己发的消息也在索引里（排队的回写没有覆盖这一拍的状态）');
    assert.equal(journalOf(env).trim().split('\n').length, 1);
    assert.ok(h.logs.some((l) => l.includes('已处理过，跳过重复回写')));
  });
});

describe('测试 8：表情和已读', () => {
  test('app 回显 / 非 owner / 非心跳消息只计数、不写信号；owner 的已读与表情下一拍写进 read_at / reacted_at', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', TASK);
    const h = harness(env);
    await h.hb.beat();
    h.setNow(plus(T0, 30));
    await h.hb.beat();
    assert.deepEqual(h.sent.map((s) => s.mid), ['om_1', 'om_2']);
    const ms = (min) => String(plus(T0, min).getTime());

    await h.handlers.reaction({ operator_type: 'app', user_id: { open_id: OWNER }, message_id: 'om_1', action_time: ms(31) });
    await h.handlers.reaction({ operator_type: 'user', user_id: { open_id: 'ou_someone_else' }, message_id: 'om_1', action_time: ms(31) });
    await h.handlers.reaction({ operator_type: 'user', user_id: { open_id: OWNER }, message_id: 'om_not_heartbeat', action_time: ms(31) });
    await h.handlers.read({ reader: { reader_id: { open_id: 'ou_someone_else' }, read_time: ms(31) }, message_id_list: ['om_1'] });
    await h.handlers.read({ reader: { reader_id: { open_id: OWNER }, read_time: ms(31) }, message_id_list: ['om_x', 'om_y'] });
    await h.handlers.recalled({ message_id: 'om_1' });
    let sig = h.readSignals();
    assert.deepEqual(sig.signals, [], '以上都不写信号');
    assert.deepEqual(sig.counts, {
      reaction_app: 1, reaction_not_owner: 1, reaction_not_heartbeat: 1, read_other: 1, read_not_heartbeat: 1, recalled: 1,
    });

    // owner 读了 om_2（和一条不认识的），对 om_1 贴了表情
    await h.handlers.read({ reader: { reader_id: { open_id: OWNER }, read_time: ms(32) }, message_id_list: ['om_2', 'om_zzz'] });
    await h.handlers.reaction({ operator_type: 'user', user_id: { open_id: OWNER }, message_id: 'om_1', action_time: ms(33) });
    sig = h.readSignals();
    assert.deepEqual(sig.signals, [
      { type: 'read', message_id: 'om_2', at: plus(T0, 32).toISOString() },
      { type: 'reaction', message_id: 'om_1', at: plus(T0, 33).toISOString() },
    ]);
    assert.equal(sig.counts.read_owner, 1);
    assert.equal(sig.counts.reaction_owner, 1);
    assert.equal(h.readState().msg_index.om_2.read_at, undefined, '信号由下一拍并进状态，事件处理函数不碰状态文件');

    h.setNow(plus(T0, 60));
    await h.hb.beat();
    const st = h.readState();
    assert.equal(st.msg_index.om_2.read_at, plus(T0, 32).toISOString());
    assert.equal(st.msg_index.om_2.reacted_at, undefined);
    assert.equal(st.msg_index.om_1.reacted_at, plus(T0, 33).toISOString());
    assert.equal(st.msg_index.om_1.read_at, plus(T0, 33).toISOString(), '贴了表情也算读过');
    sig = h.readSignals();
    assert.deepEqual(sig.signals, [], '读走后清空');
    assert.equal(sig.counts.reaction_app, 1, '计数保留（按天）');
    assert.equal(h.calls.length, 3, '事件本身不调模型（3 次都是到期的心跳拍）');
  });

  test('坏载荷一律不抛；卡片回调回「已失效」', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', TASK);
    const h = harness(env);
    await h.hb.beat();
    const payloads = [
      undefined, null, 'x', 42, [], {},
      { reader: 5 }, { reader: { reader_id: null } }, { message_id_list: 'om_1' },
      { reader: { reader_id: { open_id: OWNER }, read_time: 'NaN' }, message_id_list: [null, 42, { a: 1 }, 'om_1'] },
      { operator_type: 'user', user_id: null, message_id: 'om_1' },
      { operator_type: 'user', user_id: { open_id: OWNER }, message_id: { toString: () => 'om_1' } },
      { operator: { open_id: OWNER }, context: { open_message_id: 'om_1' }, action: { value: '{坏 JSON' } },
      { operator: { open_id: OWNER }, context: { open_message_id: 42 }, action: { value: [1, 2] } },
      { operator: 'ou_owner', action: null },
    ];
    for (const p of payloads) {
      await assert.doesNotReject(h.handlers.reaction(p));
      await assert.doesNotReject(h.handlers.read(p));
      await assert.doesNotReject(h.handlers.recalled(p));
      assert.deepEqual(await h.handlers.cardAction(p), TOAST_STALE);
    }
    // 心跳 / owner / 日志本身抛错也不外泄
    const boom = () => { throw new Error('boom'); };
    const throwing = { indexEntry: boom, recordSignal: boom, countEvent: boom, validateCardAction: boom, submitAction: boom };
    for (const hbArg of [boom, throwing, null, undefined]) {
      const ev = createEventHandlers({ getOwner: boom, heartbeat: hbArg, log: boom });
      await assert.doesNotReject(ev.reaction({ operator_type: 'user', user_id: { open_id: OWNER }, message_id: 'om_1' }));
      await assert.doesNotReject(ev.read({ reader: { reader_id: { open_id: OWNER } }, message_id_list: ['om_1'] }));
      await assert.doesNotReject(ev.recalled({}));
      assert.deepEqual(await ev.cardAction(click('om_1', { v: 1, a: 'ack', s: 'quote', n: 'x' })), TOAST_STALE);
    }
    assert.equal(h.calls.length, 1);
  });
});

describe('测试 9：引用回复', () => {
  const quoted = (parent, text, over = {}) => ({
    chat_type: 'p2p', parent_id: parent, message_type: 'text', content: JSON.stringify({ text }), ...over,
  });

  test('开关关（默认）：精确短语也不处理，返回 null（逐字走原流程）', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', TASK);
    const h = harness(env);
    await h.hb.beat();
    assert.equal(await heartbeatReplyShortcut({ message: quoted('om_1', '知道了'), isOwner: true, heartbeat: h.hb }), null);
    assert.equal(await heartbeatReplyShortcut({ message: quoted('om_1', '推迟一天吧'), isOwner: true, heartbeat: h.hb }), null);
    assert.equal(journalOf(env), '');
  });

  test('开关开：精确短语确定性回写（不调模型）；非精确短语给台账提示行；群聊 / 非 owner / 非心跳消息不管', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', TASK);
    const h = harness(env, { config: CFG({ HEARTBEAT_REPLY_SHORTCUTS: 'true' }) });
    await h.hb.beat();
    assert.equal(h.calls.length, 1);
    const ask = (message, isOwner = true) => heartbeatReplyShortcut({ message, isOwner, heartbeat: h.hb });

    h.setNow(plus(T0, 5));
    assert.deepEqual(await ask(quoted('om_1', ' 推迟一天。')), { reply: '已记下：『推迟一天』 tasks/quote.json' });
    assert.equal(readTask(env, 'quote').next_check_at, '2026-11-17T09:00');
    assert.equal(journalOf(env), ownerText`（桥接）${O_NAME}回复『推迟一天』：tasks/quote.json\n`);
    assert.equal(h.calls.length, 1, 'runClaude 调用 0 次');
    assert.deepEqual(await ask(quoted('om_1', '推迟一天')), { reply: '这条心跳消息已经按『推迟一天』处理过了，不重复执行。' });
    assert.equal(readTask(env, 'quote').next_check_at, '2026-11-17T09:00', '不重复推迟');

    const hint = { hint: '（你在回复关于 tasks/quote.json 的心跳消息）' };
    assert.deepEqual(await ask(quoted('om_1', '推迟一天吧')), hint);
    assert.deepEqual(await ask(quoted('om_1', '知道了，周五再说')), hint);
    assert.deepEqual(await ask(quoted('om_1', '', { message_type: 'image', content: '{"image_key":"img_1"}' })), hint);
    assert.equal(await ask(quoted('om_1', '知道了', { chat_type: 'group' })), null);
    assert.equal(await ask(quoted('om_1', '知道了'), false), null);
    assert.equal(await ask(quoted('om_unknown', '知道了')), null);
    assert.equal(await ask(quoted(undefined, '知道了')), null);
    assert.equal(h.calls.length, 1);

    assert.equal(shortcutPhrase(quoted('om_1', '  知道了！！ ')), '知道了');
    assert.equal(shortcutPhrase({ message_type: 'text', content: '{坏' }), '');
  });

  test('心跳 inflight 时的精确短语：先回「结束后再写回」，这一拍结束后才写', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', TASK);
    const inside = {};
    let h;
    h = harness(env, {
      config: CFG({ HEARTBEAT_REPLY_SHORTCUTS: 'true' }),
      runImpl: async (n) => {
        if (n === 2) {
          inside.r = await heartbeatReplyShortcut({ message: quoted('om_1', '不做了'), isOwner: true, heartbeat: h.hb });
          inside.status = readTask(env, 'quote').status;
        }
        return `第 ${n} 拍`;
      },
    });
    await h.hb.beat();
    h.setNow(plus(T0, 30));
    await h.hb.beat();
    assert.deepEqual(inside.r, { reply: '已记下：『不做了』 tasks/quote.json（心跳这一拍正在跑，结束后再写回）' });
    assert.equal(inside.status, 'open');
    assert.equal(readTask(env, 'quote').status, 'dropped');
  });

  test('index.js 接线：引用回复块在 /heartbeat 块之后、/status 之前；精确短语回复后 return（不进模型）；提示行只插一行', () => {
    const iHeartbeat = INDEX_SRC.indexOf("if (text === '/heartbeat' || text.startsWith('/heartbeat ')) {");
    const iBlock = INDEX_SRC.indexOf("let ledgerHint = '';");
    const iStatus = INDEX_SRC.indexOf("if (text === '/status') {");
    assert.ok(iHeartbeat > 0 && iHeartbeat < iBlock && iBlock < iStatus, '块的位置');
    const block = INDEX_SRC.slice(iBlock, iStatus);
    assert.match(block, /if \(isOwner && message\.chat_type === 'p2p' && message\.parent_id\) \{/);
    assert.match(block, /const shortcut = await heartbeatReplyShortcut\(\{ message, isOwner, heartbeat \}\);/);
    assert.match(block, /if \(shortcut\?\.reply\) \{\n\s+await reply\(message\.message_id, shortcut\.reply\);\n\s+return;\n\s+\}/);
    assert.match(block, /ledgerHint = shortcut\?\.hint \?\? '';/);
    assert.doesNotMatch(block, /runClaude/);

    const hintLine = 'if (ledgerHint) prompt += `\\n${ledgerHint}`;';
    assert.equal(INDEX_SRC.split(hintLine).length, 2, '提示行只有一行');
    const iHint = INDEX_SRC.indexOf(hintLine);
    const iSpeaker = INDEX_SRC.indexOf('if (name) prompt = `[群成员 ${name}]：${prompt}`;');
    const iRecall = INDEX_SRC.indexOf('// 记忆自动召回');
    const iRedirect = INDEX_SRC.indexOf("if (text.startsWith('/redirect')) {");
    const iChat = INDEX_SRC.indexOf('const answer = await runClaude(sessionKey, prompt, isOwner, extraTools');
    assert.ok(iRedirect < iSpeaker && iSpeaker < iHint && iHint < iRecall && iRecall < iChat, '在群聊发言人块与记忆召回块之间（/redirect 改写过的提示词也带上）');
  });
});

describe('测试 10：未读暂停', () => {
  // 3 拍各发一条（10:00 / 10:30 / 11:00），第 4 拍在 26 小时后
  async function threeUnread(config) {
    const env = mkEnv();
    writeTask(env, 'quote', TASK);
    let h;
    h = harness(env, {
      config,
      runImpl: async (n) => {
        touch(env, 'quote', n);
        return `第 ${n} 拍：报价单还没回`;
      },
    });
    for (const min of [0, 30, 60]) {
      h.setNow(plus(T0, min));
      assert.equal((await h.hb.beat()).action, 'sent');
    }
    h.setNow(plus(T0, 26 * 60));
    const r4 = await h.hb.beat();
    return { env, h, r4 };
  }

  test('N=3：3 条超过 24 小时未读后不再 send、只排队；owner 已读任一条后恢复，补发带开头说明', async () => {
    const { h, r4 } = await threeUnread(CFG({ HEARTBEAT_UNREAD_PAUSE: '3' }));
    assert.equal(r4.action, 'queued');
    assert.equal(h.sent.length, 3, '暂停中不调 send');
    assert.equal(h.calls.length, 4, '模型照常看台账（只是消息不发）');
    let st = h.readState();
    assert.equal(st.unread_pause.active, true);
    assert.equal(st.unread_pause.count, 3);
    assert.equal(st.pending.length, 1);
    assert.ok(h.logs.some((l) => l.includes('最近 3 条心跳消息都超过 24 小时未读，暂停发送')));
    assert.match(h.hb.statusText(), /未读暂停：已暂停/);

    // 暂停中再跑一拍：仍不发
    h.setNow(plus(T0, 26 * 60 + 30));
    await h.hb.beat();
    assert.equal(h.sent.length, 3);

    // owner 读了其中一条
    await h.handlers.read({
      reader: { reader_id: { open_id: OWNER }, read_time: String(plus(T0, 26 * 60 + 40).getTime()) },
      message_id_list: ['om_2'],
    });
    h.setNow(plus(T0, 27 * 60));
    await h.hb.beat();
    st = h.readState();
    assert.equal(st.unread_pause.active, false);
    assert.equal(st.notices.resumed, undefined, '恢复说明已随补发用掉');
    assert.equal(h.sent.length, 5, '补发的汇总 + 本拍新消息');
    const pack = h.sent[3].text;
    assert.ok(pack.startsWith('💓 **心跳 · 待发汇总（2 条）**\n\n（心跳此前因最近 3 条消息都超过 24 小时未读，暂停了发送；现已恢复，暂停期间攒下的消息按顺序补发。）\n\n**1.** '), pack);
    assert.ok(pack.includes('第 4 拍') && pack.includes('第 5 拍'));
    assert.equal(h.sent[4].text, '💓 **心跳**\n\n第 6 拍：报价单还没回', '恢复后的新消息不再带说明');
    assert.ok(h.logs.some((l) => l.includes(ownerText`未读暂停解除（${O_NAME}已读心跳消息）`)));
  });

  test('N=3：/heartbeat on 也能恢复', async () => {
    const { h } = await threeUnread(CFG({ HEARTBEAT_UNREAD_PAUSE: '3' }));
    assert.equal(h.readState().unread_pause.active, true);
    assert.equal(heartbeatCommand('/heartbeat on', { isOwner: true, heartbeat: h.hb }), '💓 心跳已恢复（只改运行时开关，不写 .env；重启后回到配置值）。');
    const st = h.readState();
    assert.equal(st.unread_pause.active, false);
    assert.deepEqual(st.notices.resumed, { count: 3 });
    h.setNow(plus(T0, 26 * 60 + 30));
    await h.hb.beat();
    assert.equal(h.sent.length, 5);
    assert.ok(h.sent[3].text.includes('现已恢复，暂停期间攒下的消息按顺序补发'));
    assert.ok(h.logs.some((l) => l.includes('未读暂停解除（/heartbeat on）')));
  });

  test('N=0（默认）：与基线相同，照常发送，不记暂停', async () => {
    const { h, r4 } = await threeUnread(CFG());
    assert.equal(r4.action, 'sent');
    assert.equal(h.sent.length, 4);
    assert.equal(h.readState().unread_pause, null);
    assert.ok(h.logs.every((l) => !l.includes('未读暂停') && !l.includes('暂停发送')));
  });
});

describe('测试 11：默认关的回归', () => {
  test('四个开关都没配：heartbeatConfig 全是关', () => {
    const c = heartbeatConfig({ HEARTBEAT_ENABLED: 'true' }, quietLog);
    assert.equal(c.watch, 'none');
    assert.deepEqual(c.watchSources, []);
    assert.equal(c.watchMax, 10);
    assert.equal(c.buttons, false);
    assert.equal(c.replyShortcuts, false);
    assert.equal(c.unreadPause, 0);
  });

  test('心跳行为与基线相同：runner 0 次、send 只收一个参数、正文格式不变、卡片没有按钮、引用回复不处理', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', { ...TASK, watch: { type: 'chat_reply', chat_id: 'oc_team', after: String(at(2026, 11, 16, 8, 0).getTime()) } });
    const argvs = [];
    const runner = (argv) => {
      argvs.push(argv);
      return { ok: true, stdout: '{"data":{"messages":[]}}' };
    };
    const h = harness(env, { collectDeltas: createWatchSources({ runner, getOwner: () => OWNER, log: quietLog }) });
    const r = await h.hb.beat();
    assert.equal(r.action, 'sent');
    assert.equal(argvs.length, 0, 'HEARTBEAT_WATCH 没配：一次 lark-cli 都不跑');
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].argc, 1, '没有按钮时 send 只收一个参数（与改造前逐字相同）');
    assert.equal(h.sent[0].text, '💓 **心跳**\n\n第 1 拍：报价单还没回');
    const prompt = h.calls[0][1];
    assert.ok(prompt.includes('8. 本轮没有外部增量，只依据台账判断。'));
    assert.ok(!prompt.includes('## 外部增量'));
    const st = h.readState();
    assert.equal(st.msg_index.om_1.buttons, undefined);
    assert.equal(st.unread_pause, null);
    assert.deepEqual(st.watch_cursor, {});

    // 卡片：没有 actions 时逐字是原来的 1.0 markdown 卡片（没有任何 action / button 元素）
    const card = buildMarkdownCard('正文');
    assert.deepEqual(card, { config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: '正文' }] });
    const created = [];
    await sendCardWithFallback(async (d) => { created.push(d); return { data: { message_id: 'om_c' } }; }, '正文', {});
    await sendCardWithFallback(async (d) => { created.push(d); return { data: { message_id: 'om_c' } }; }, '正文');
    for (const d of created) {
      assert.deepEqual(d, {
        msg_type: 'interactive',
        content: JSON.stringify({ config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: '正文' }] }),
      });
      assert.doesNotMatch(d.content, /button|action|callback/);
    }

    // 关着时按钮回调照样校验（这条消息没带按钮 → 已失效）；引用回复返回 null
    assert.deepEqual(await h.handlers.cardAction(click('om_1', { v: 1, a: 'ack', s: 'quote', n: 'x' })), TOAST_STALE);
    const msg = { chat_type: 'p2p', parent_id: 'om_1', message_type: 'text', content: JSON.stringify({ text: '知道了' }) };
    assert.equal(await heartbeatReplyShortcut({ message: msg, isOwner: true, heartbeat: h.hb }), null);
    assert.equal(journalOf(env), '');
    assert.equal(h.calls.length, 1);
  });

  test('index.js 接线：sendToOwner / sendMarkdown 透传 opts；没有 opts 时走 1.0 卡片；事件注册不调模型', () => {
    assert.match(INDEX_SRC, /async function sendToOwner\(text, opts\) \{/);
    assert.match(INDEX_SRC, /return sendMarkdown\('open_id', owner, text, opts\);/);
    assert.match(INDEX_SRC, /async function sendMarkdown\(receiveIdType, receiveId, text, opts = \{\}\) \{/);
    assert.match(INDEX_SRC, /return sendCardWithFallback\(body, chunk, opts, /);
    for (const ev of ['im.message.reaction.created_v1', 'im.message.message_read_v1', 'im.message.recalled_v1', 'card.action.trigger']) {
      assert.ok(INDEX_SRC.includes(`'${ev}': ev.`), ev);
    }
    const reg = INDEX_SRC.slice(INDEX_SRC.indexOf('new lark.EventDispatcher'), INDEX_SRC.indexOf('async function sendToChat'));
    assert.doesNotMatch(reg, /runClaude/);
  });
});

describe('测试 12：message_id', () => {
  test('sendCardWithFallback：卡片失败降级纯文本时仍返回 message_id；拿不到返回 undefined', async () => {
    const calls = [];
    const fallbacks = [];
    const create = async (d) => {
      calls.push(d);
      if (d.msg_type === 'interactive') throw new Error('card rejected');
      return { data: { message_id: 'om_txt' } };
    };
    assert.equal(await sendCardWithFallback(create, '正文', {}, (e) => fallbacks.push(e.message)), 'om_txt');
    assert.deepEqual(fallbacks, ['card rejected']);
    assert.deepEqual(calls[1], { msg_type: 'text', content: JSON.stringify({ text: '正文' }) });
    assert.equal(await sendCardWithFallback(async () => ({ data: { message_id: 'om_card' } }), '正文'), 'om_card');
    assert.equal(await sendCardWithFallback(async () => undefined, '正文'), undefined);
    assert.equal(await sendCardWithFallback(async () => ({ data: {} }), '正文'), undefined);
    assert.equal(await sendCardWithFallback(async () => ({ data: { message_id: '' } }), '正文'), undefined);
    // 两条路都失败：照常抛给调用方（心跳据此进待发队列）
    await assert.rejects(sendCardWithFallback(async () => { throw new Error('down'); }, '正文'), /down/);
  });

  test('带按钮的卡片 JSON 逐字（Card JSON 2.0，按钮走 callback，回传 { v, a, s, n }）', async () => {
    const created = [];
    const mid = await sendCardWithFallback(async (d) => { created.push(d); return { data: { message_id: 'om_b' } }; }, '正文', { actions: ledgerButtons('quote', 'n0') });
    assert.equal(mid, 'om_b');
    const button = (content, type, a) => ({
      tag: 'column', width: 'auto',
      elements: [{ tag: 'button', text: { tag: 'plain_text', content }, type, behaviors: [{ type: 'callback', value: { v: 1, a, s: 'quote', n: 'n0' } }] }],
    });
    assert.equal(created[0].msg_type, 'interactive');
    assert.deepEqual(JSON.parse(created[0].content), {
      schema: '2.0',
      config: { width_mode: 'fill' },
      body: {
        elements: [
          { tag: 'markdown', content: '正文' },
          { tag: 'column_set', flex_mode: 'none', columns: [button('知道了', 'primary_filled', 'ack'), button('推迟一天', 'default', 'snooze1d'), button('不做了', 'danger', 'drop')] },
        ],
      },
    });
  });

  test('send 返回 undefined / 不是 om_ 的值：心跳不崩，照常算发出，也不记索引', async () => {
    for (const ret of [undefined, null, '', 'not-a-message-id', 42]) {
      const env = mkEnv();
      writeTask(env, 'quote', TASK);
      const h = harness(env, { config: CFG({ HEARTBEAT_BUTTONS: 'true' }), sendImpl: () => ret });
      const r = await h.hb.beat();
      assert.equal(r.action, 'sent', String(ret));
      const st = h.readState();
      assert.deepEqual(st.msg_index, {});
      assert.equal(Object.keys(st.sent).length, 1);
      assert.deepEqual(st.pending, []);
      h.setNow(plus(T0, 30));
      assert.equal((await h.hb.beat()).action, 'sent', '下一拍照常');
    }
  });
});

describe('测试 13：Sonnet 默认值', () => {
  test("normalizeModel('sonnet') 是 claude-sonnet-5-5；心跳默认模型同；haiku 别名不变", async () => {
    const claude = await import(`../src/claude.js?ev=${Math.random()}`);
    assert.equal(claude.normalizeModel('sonnet'), 'claude-sonnet-5-5');
    assert.equal(claude.MODEL_ALIASES.sonnet, 'claude-sonnet-5-5');
    assert.equal(heartbeatConfig({}, quietLog).model, 'claude-sonnet-5-5');
    assert.equal(claude.normalizeModel('haiku'), 'claude-haiku-5-5'); // BRIDGE-PUB-1：haiku 别名改指 claude-haiku-5-5
    assert.equal(claude.MODEL_ALIASES.haiku, 'claude-haiku-5-5');
  });
});

describe('协调者补充：时钟自愈', () => {
  const seed = (env, day, runs) => {
    fs.mkdirSync(path.dirname(env.stateFile), { recursive: true });
    fs.writeFileSync(env.stateFile, JSON.stringify({ version: 1, day, runs, tasks: {}, sent: {}, pending: [] }));
  };

  test('记录日期比今天晚超过 1 天：按今天计、保留原计数（不清零），记一行日志；第二天正常翻日', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', TASK);
    seed(env, '2026-11-19', 12);
    const h = harness(env);
    const r = await h.hb.beat();
    assert.equal(r.action, 'budget', '计数保留：今天额度仍是用完的');
    assert.equal(h.calls.length, 0);
    let st = h.readState();
    assert.equal(st.day, '2026-11-16', '按今天计');
    assert.equal(st.runs, 12, '不清零');
    assert.ok(h.logs.some((l) => l.includes('状态里记录的日期 2026-11-19 比本地今天 2026-11-16 晚 3 天，视为时钟曾被调快：按今天计、沿用计数 12/12')));
    // 第二天：正常翻日清零（不会卡到 11-19）
    h.setNow(at(2026, 11, 17, 10, 0));
    assert.equal((await h.hb.beat()).action, 'sent');
    st = h.readState();
    assert.equal(st.day, '2026-11-17');
    assert.equal(st.runs, 1);
  });

  test('晚 1 天以内：维持 HB-1B 现行为（沿用原日期与计数）', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', TASK);
    seed(env, '2026-11-17', 12);
    const h = harness(env);
    assert.equal((await h.hb.beat()).action, 'budget');
    const st = h.readState();
    assert.equal(st.day, '2026-11-17');
    assert.equal(st.runs, 12);
    assert.ok(h.logs.some((l) => l.includes('本机时钟回拨')));
    assert.ok(h.logs.every((l) => !l.includes('视为时钟曾被调快')));
  });

  test('记录日期解析不了（形如日期但不存在）：按「晚超过 1 天」处理，计数保留', async () => {
    const env = mkEnv();
    seed(env, '2026-99-99', 7);
    const h = harness(env);
    assert.equal((await h.hb.beat()).action, 'no-due');
    const st = h.readState();
    assert.equal(st.day, '2026-11-16');
    assert.equal(st.runs, 7);
    assert.ok(h.logs.some((l) => l.includes('晚 ? 天')));
  });
});

describe('协调者补充：队首阻塞', () => {
  test('同一条连续 5 拍发送失败后移出队列；下一次成功发送的消息末尾附一行说明；journal 记一行（不记正文）；不调模型', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', TASK);
    let failing = true;
    let ok = 0;
    const h = harness(env, {
      sendImpl: () => {
        if (failing) throw new Error('网络不可达');
        ok += 1;
        return `om_ok${ok}`;
      },
      runImpl: async (n) => {
        if (n === 1) writeTask(env, 'quote', { ...TASK, next_check_at: '2026-11-20T09:00' }); // 之后不再到期
        return n === 1 ? '第 1 拍：这条一直发不出去' : `第 ${n} 拍：合同有回音了`;
      },
    });
    assert.equal((await h.hb.beat()).action, 'queued'); // 第 1 次失败（直发）
    for (let k = 2; k <= 5; k += 1) {
      h.setNow(plus(T0, 30 * (k - 1)));
      await h.hb.beat(); // 第 k 次失败（补发）
      const st = h.readState();
      if (k < 5) {
        assert.equal(st.pending.length, 1, `第 ${k} 次失败后还在队列里`);
        assert.deepEqual(Object.values(st.send_fails), [k]);
      } else {
        assert.deepEqual(st.pending, [], '连续 5 拍失败：移出队列');
        assert.deepEqual(st.send_fails, {});
        assert.deepEqual(st.notices, { dropped_failed: 1 });
      }
    }
    assert.equal(h.sent.length, 5);
    assert.equal(h.calls.length, 1, '放弃与说明都不调模型');
    assert.ok(h.logs.some((l) => l.includes('连续 5 拍发送失败，已放弃')));
    const journal = journalOf(env);
    assert.equal(journal, '（桥接）有 1 条心跳消息连续 5 拍发送失败，已放弃（涉及 tasks/quote.json；正文不记）\n');
    assert.ok(!journal.includes('一直发不出去'));

    // 第 6 拍：网络恢复、有新到期项 → 新消息末尾附说明
    failing = false;
    writeTask(env, 'contract', { title: '催合同', status: 'open', next_check_at: '2026-11-16T12:00' });
    h.setNow(plus(T0, 150));
    assert.equal((await h.hb.beat()).action, 'sent');
    assert.equal(h.sent[5].text, '💓 **心跳**\n\n第 2 拍：合同有回音了\n\n有 1 条心跳消息多次发送失败已放弃，详见当天 journal / 日志');
    assert.deepEqual(h.readState().notices, {}, '说明发出后划掉');
  });
});

describe('协调者补充：队满丢弃要告知', () => {
  test('队列满 20 丢最旧一条：下一次成功发送的消息末尾附一行计数说明', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', TASK);
    fs.mkdirSync(path.dirname(env.stateFile), { recursive: true });
    const pending = Array.from({ length: 20 }, (_, i) => ({
      at: at(2026, 11, 16, 22, i).toISOString(), hash: `seed${String(i).padStart(2, '0')}`, body: `旧消息 ${i}`, slugs: [],
    }));
    fs.writeFileSync(env.stateFile, JSON.stringify({ version: 1, day: '2026-11-16', runs: 0, tasks: {}, sent: {}, pending }));
    const h = harness(env, {
      config: CFG({ HEARTBEAT_QUIET_HOURS: '22-08' }),
      now: at(2026, 11, 16, 23, 0),
      runImpl: async () => {
        writeTask(env, 'quote', { ...TASK, next_check_at: '2026-11-18T09:00' });
        return '夜里的新消息';
      },
    });
    assert.equal((await h.hb.beat()).action, 'queued');
    let st = h.readState();
    assert.equal(st.pending.length, 20);
    assert.equal(st.pending[0].body, '旧消息 1', '丢的是最旧的一条');
    assert.equal(st.pending[19].body, '夜里的新消息');
    assert.deepEqual(st.notices, { dropped_full: 1 });
    assert.ok(h.logs.some((l) => l.includes('待发队列超过 20 条，丢弃最早的一条')));
    assert.equal(h.sent.length, 0);

    h.setNow(at(2026, 11, 17, 9, 0));
    await h.hb.beat();
    assert.equal(h.sent.length, 1);
    const text = h.sent[0].text;
    assert.ok(text.startsWith('💓 **心跳 · 待发汇总（20 条）**\n\n**1.** '), text.slice(0, 80));
    assert.ok(text.endsWith('\n\n有 1 条心跳消息因待发队列已满（上限 20 条）被丢弃，详见日志'), text.slice(-80));
    assert.ok(!text.includes('旧消息 0') && text.includes('旧消息 1') && text.includes('夜里的新消息'));
    st = h.readState();
    assert.deepEqual(st.pending, []);
    assert.deepEqual(st.notices, {});
  });
});

// ---------------------------------------------------------------- BRIDGE-EV-1 R1（MEDIUM-1 接线、LOW-2 补测试）
describe('R1：按钮校验补测试', () => {
  const quotedReply = (parent, text) => ({ chat_type: 'p2p', parent_id: parent, message_type: 'text', content: JSON.stringify({ text }) });

  test('按钮 value 里的 slug 是另一条在跟进的台账（nonce 正确）：已失效，两条台账都不改', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', TASK); // A：到期，进这条消息
    writeTask(env, 'other', { title: '另一条在跟进', status: 'open', next_check_at: '2026-12-31T09:00' }); // B：不到期，不在这条消息里
    const h = harness(env, { config: CFG({ HEARTBEAT_BUTTONS: 'true' }) });
    assert.equal((await h.hb.beat()).action, 'sent');
    assert.equal(h.sent[0].argc, 2, '只涉及 A：带按钮');
    const mid = h.sent[0].mid;
    assert.deepEqual(h.readState().msg_index[mid].slugs, ['quote']);
    h.setNow(plus(T0, 5));
    const before = [sha(taskFile(env, 'quote')), sha(taskFile(env, 'other')), journalOf(env)];
    for (const a of ['drop', 'snooze1d', 'ack']) {
      assert.deepEqual(await h.handlers.cardAction(click(mid, { ...btn(h.sent[0], a), s: 'other' })), TOAST_STALE, a);
    }
    assert.deepEqual([sha(taskFile(env, 'quote')), sha(taskFile(env, 'other')), journalOf(env)], before, '两条台账、journal 都不改');
    assert.equal(readTask(env, 'other').status, 'open');
    assert.ok(h.logs.some((l) => l.includes('台账不属于这条消息')));
  });

  test('心跳消息发出满 14 天后点按钮或引用回复：已失效 / 不处理', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', TASK);
    const h = harness(env, { config: CFG({ HEARTBEAT_BUTTONS: 'true', HEARTBEAT_REPLY_SHORTCUTS: 'true' }) });
    assert.equal((await h.hb.beat()).action, 'sent');
    const mid = h.sent[0].mid;
    const drop = btn(h.sent[0], 'drop');
    // 中间不跑 beat（不经过 prune）：索引项还在状态文件里，只靠 indexEntry 的 14 天判断
    h.setNow(plus(T0, 14 * 24 * 60 + 1));
    assert.ok(h.readState().msg_index[mid], '索引项还在状态文件里');
    const before = [sha(taskFile(env, 'quote')), sha(env.stateFile)];
    assert.deepEqual(await h.handlers.cardAction(click(mid, drop)), TOAST_STALE, '按钮：已失效');
    assert.equal(await heartbeatReplyShortcut({ message: quotedReply(mid, '不做了'), isOwner: true, heartbeat: h.hb }), null, '引用回复：不处理');
    assert.deepEqual([sha(taskFile(env, 'quote')), sha(env.stateFile)], before);
    assert.equal(readTask(env, 'quote').status, 'open');
    assert.equal(journalOf(env, '2026-11-30'), '');
  });

  test('没带按钮的心跳消息：即使 nonce 正确，按钮回调也是已失效', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', TASK);
    const h = harness(env); // 开关关（默认）：发出的消息不带按钮
    assert.equal((await h.hb.beat()).action, 'sent');
    assert.equal(h.sent[0].argc, 1);
    const mid = h.sent[0].mid;
    const entry = h.readState().msg_index[mid];
    assert.match(entry.nonce, /^[0-9a-f]{16}$/, '索引里有 nonce');
    assert.equal(entry.buttons, undefined);
    h.setNow(plus(T0, 5));
    const before = [sha(taskFile(env, 'quote')), sha(env.stateFile)];
    for (const a of ['drop', 'snooze1d', 'ack']) {
      assert.deepEqual(await h.handlers.cardAction(click(mid, { v: 1, a, s: 'quote', n: entry.nonce })), TOAST_STALE, a);
    }
    assert.deepEqual([sha(taskFile(env, 'quote')), sha(env.stateFile)], before);
    assert.equal(journalOf(env), '');
  });

  test('nonce 只差最后一位：已失效', async () => {
    const env = mkEnv();
    const h = await beatWithButtons(env);
    const mid = h.sent[0].mid;
    const drop = btn(h.sent[0], 'drop');
    const last = drop.n.slice(-1);
    const n = drop.n.slice(0, -1) + (last === '0' ? '1' : '0');
    assert.equal(n.length, drop.n.length);
    assert.notEqual(n, drop.n);
    h.setNow(plus(T0, 5));
    const before = [sha(taskFile(env, 'quote')), sha(env.stateFile)];
    assert.deepEqual(await h.handlers.cardAction(click(mid, { ...drop, n })), TOAST_STALE);
    assert.deepEqual([sha(taskFile(env, 'quote')), sha(env.stateFile)], before);
    assert.equal(readTask(env, 'quote').status, 'open');
    // 对照：正确 nonce 照常生效
    assert.deepEqual(await h.handlers.cardAction(click(mid, drop)), TOAST_OK);
    assert.equal(readTask(env, 'quote').status, 'dropped');
  });

  test('按钮『推迟一天』走心跳默认回写：已逾期多日的台账从现在起推一天', async () => {
    const env = mkEnv();
    writeTask(env, 'quote', { ...TASK, next_check_at: '2026-11-10T09:00' });
    const h = harness(env, { config: CFG({ HEARTBEAT_BUTTONS: 'true' }) });
    assert.equal((await h.hb.beat()).action, 'sent');
    h.setNow(plus(T0, 5));
    assert.deepEqual(await h.handlers.cardAction(click(h.sent[0].mid, btn(h.sent[0], 'snooze1d'))), TOAST_OK);
    const t = readTask(env, 'quote');
    assert.equal(t.next_check_at, '2026-11-17T10:05', '逾期多日：从现在起推一天');
    assert.equal(t.escalate_after, '2026-11-19T18:00', '还在未来：原值加一天');
  });
});
