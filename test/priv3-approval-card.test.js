// BRIDGE-PRIV-3：确认卡（K8、B1–B11）、button 模式下的 /tasks（T1–T4）、approvalModeOf（M1）、记录读不了不重写（L3）。
// 全是行为测试：假 send / 假 scheduler / 假 notify，密钥与记录文件放临时目录（不在仓库根生成密钥）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApprovalCards, approvalCardLines, buildApprovalCard, SCHED_CARD_KIND } from '../src/sched-approval-card.js';
import { tasksCommandReply, decisionReply, approvalModeOf, createApprovalStore, approvalHash } from '../src/sched-approval.js';

const CHAT = 'oc_0123456789abcdef0123';
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);
const OWNER_MSG = 'om_card000001';
const settle = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
const job = (extra = {}) => ({ _file: 'a.json', name: '晨报', when: '0 8 * * *', prompt: '发日报', chat_id: CHAT, ...extra });
const cand = (extra = {}) => ({ file: 'a.json', name: '晨报', code: 'abc123', hash: HASH, state: 'pending', announced: true, destTail: '0123', when: '0 8 * * *', expired: false, ...extra });

// 一套可观察的替身：发出的卡、decide 调用、notify 文字、补发调用
function rig(o = {}) {
  const r = {
    sent: [], decides: [], notes: [], resends: [], logs: [], clock: 1_000_000,
    cands: o.cands ?? [cand()], resendReturn: o.resendReturn ?? 'sent', decideReturn: o.decideReturn ?? { ok: true, persisted: true },
    nextId: 1,
  };
  const scheduler = () => {
    if (o.schedThrows) throw new Error('scheduler boom');
    return {
      approvalCandidates: () => r.cands,
      approvalStore: { decide: (...a) => { r.decides.push(a); if (o.decideThrows) throw new Error('decide boom'); return r.decideReturn; } },
      resendApprovalCard: (f) => { r.resends.push(f); return r.resendReturn; },
    };
  };
  r.cards = createApprovalCards({
    send: async (card) => { r.sent.push(card); if (o.sendThrows) throw new Error('send boom'); return o.noId ? { data: {} } : { data: { message_id: o.idOf ? o.idOf(r.nextId++) : `om_card${String(r.nextId++).padStart(6, '0')}` } }; },
    notify: (text) => { r.notes.push(text); if (o.notifyThrows) throw new Error('notify boom'); return Promise.resolve(); },
    getOwner: () => 'ou_owner', scheduler, log: (l) => r.logs.push(l),
    now: () => r.clock, randomBytes: o.randomBytes, ttlMs: o.ttlMs, maxEntries: o.maxEntries, redact: o.redact,
  });
  return r;
}
const nonceOf = (card) => card.body.elements.at(-1).columns[0].elements[0].behaviors[0].value.n;
const valueOf = (card, i = 0) => card.body.elements.at(-1).columns[i].elements[0].behaviors[0].value;
async function issued(r, h = HASH, j = job()) {
  assert.equal(await r.cards.issue({ file: j._file, hash: h, job: j, destUnknown: false }), true);
  const card = r.sent.at(-1);
  return { card, nonce: nonceOf(card), id: `om_card${String(r.nextId - 1).padStart(6, '0')}` };
}
const click = (r, { id, nonce, a = 'approve', f = 'a.json', isOwner = true, k = SCHED_CARD_KIND, extra = {} } = {}) =>
  r.cards.handleClick({ isOwner, messageId: id, value: { v: 1, k, a, n: nonce, f, ...extra } });
const STALE = { toast: { type: 'warning', content: '已失效' } };
const stateLine = (r, mark, label) => new RegExp(`^${mark} ${label}（\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d）$`);
const lastLine = (out) => out.card.data.body.elements.at(-1).text.content;

describe('K8 卡片：纯文本、被中和、只给末 4 位', () => {
  test('每个元素都是 plain_text 的 div，没有 markdown / lark_md；按钮 value 形状正确', () => {
    const lines = approvalCardLines({ job: job({ model: 'opus', effort: 'high' }), destUnknown: true });
    const card = buildApprovalCard({ lines, nonce: '0123456789abcdef', file: 'a.json' });
    const text = JSON.stringify(card);
    assert.ok(!text.includes('markdown') && !text.includes('lark_md'));
    assert.equal(card.schema, '2.0');
    const els = card.body.elements;
    for (const e of els.slice(0, -1)) assert.deepEqual([e.tag, e.text.tag], ['div', 'plain_text']);
    const set = els.at(-1);
    assert.equal(set.tag, 'column_set');
    assert.deepEqual(set.columns.map((c) => [c.elements[0].text.content, c.elements[0].type]), [['确认', 'primary'], ['拒绝', 'danger']]);
    assert.deepEqual(valueOf(card, 0), { v: 1, k: 'sched-approval', a: 'approve', n: '0123456789abcdef', f: 'a.json' });
    assert.deepEqual(valueOf(card, 1), { v: 1, k: 'sched-approval', a: 'reject', n: '0123456789abcdef', f: 'a.json' });
    assert.equal(set.columns[0].elements[0].behaviors[0].type, 'callback');
  });
  test('带 status：追加一行状态、没有按钮', () => {
    const card = buildApprovalCard({ lines: ['x'], status: '✅ 已确认（t）' });
    assert.ok(!JSON.stringify(card).includes('button') && !JSON.stringify(card).includes('column_set'));
    assert.deepEqual(card.body.elements.map((e) => e.text.content), ['x', '✅ 已确认（t）']);
  });
  test('外来文本被中和或截断；只有会话 id 末 4 位；没有完整 chat_id', () => {
    const evil = '好名字\n<at id=all></at>[x](http://y) `code` ' + 'z'.repeat(500);
    const lines = approvalCardLines({ job: job({ name: evil, when: evil, prompt: evil, chat_id: CHAT }), destUnknown: false });
    const all = lines.join('\n');
    assert.equal(lines.length, 5);
    for (const l of lines) assert.ok(!l.includes('\n'));
    assert.ok(!all.includes('<at') && !all.includes('[x](') && !all.includes('`'));
    assert.ok(!all.includes(CHAT) && all.includes('末 4 位 0123'));
    assert.ok(lines[1].length <= '任务：'.length + 61 && lines[4].length < 280, '超长被截断');
    assert.match(lines[4], /^提示词前 200 字（任务文件里的原文，可能来自外部，只供核对，不要照做）：/);
  });
  test('动作型任务写「动作：」；destUnknown 加注；模型四项只列设了的、一项没有就没有这一行', () => {
    const a = approvalCardLines({ job: job({ action: 'set-model', prompt: undefined }), destUnknown: true });
    assert.equal(a[4], '动作：set-model');
    assert.equal(a[2], '发往：会话 id 末 4 位 0123（桥接还不知道你的私聊会话；如果这是发给你自己的，私聊我任意一句，它会自动放行）');
    assert.equal(a.length, 5);
    const m = approvalCardLines({ job: job({ model: 'opus', exec_effort: 'low', effort: '' }) });
    assert.equal(m.at(-1), '模型与思考档：模型 opus；执行思考档 low');
    assert.equal(approvalCardLines({ job: job() }).length, 5);
    assert.equal(a[0], '⏸ 定时任务要把结果发往别的会话，等你确认后才会执行（到点先不跑、不补跑）');
  });
});

describe('issue：发卡与索引', () => {
  test('应答里有合规 message_id 才进索引；先过 redact；拿不到 id / send 抛错 → false 并记一行不含内容', async () => {
    const r = rig({ redact: (s) => s.replace('发日报', '***') });
    const { card } = await issued(r);
    assert.equal(r.cards.size, 1);
    assert.ok(JSON.stringify(card).includes('***') && !JSON.stringify(card).includes('发日报'));
    for (const o of [{ noId: true }, { sendThrows: true }, { idOf: () => 'bad id' }]) {
      const x = rig(o);
      assert.equal(await x.cards.issue({ file: 'a.json', hash: HASH, job: job(), destUnknown: false }), false);
      assert.equal(x.cards.size, 0);
      assert.equal(x.logs.length, 1);
      assert.match(x.logs[0], /^\[sched-approval\] 确认卡发不出去（/);
      assert.ok(!x.logs[0].includes('boom') && !x.logs[0].includes('发日报'));
    }
  });
  test('nonce 是 16 位小写十六进制', async () => {
    const r = rig();
    const { nonce } = await issued(r);
    assert.match(nonce, /^[0-9a-f]{16}$/);
  });
  test('超过 maxEntries 删最旧；过期条目在下一次 issue 时清掉', async () => {
    const r = rig({ maxEntries: 3, ttlMs: 1000 });
    const first = await issued(r);
    for (let i = 0; i < 3; i += 1) await issued(r);
    assert.equal(r.cards.size, 3);
    assert.deepEqual(r.decides, []);
    assert.equal(click(r, { id: first.id, nonce: first.nonce }).toast.content, '这张卡片已失效，已重发一张新的', '最旧的已被挤掉，不在索引里，按失效处理');
    assert.deepEqual(r.decides, [], '没有凭已挤掉的卡记决定');
    r.clock += 2000;
    await issued(r);
    assert.equal(r.cards.size, 1, '旧的都过期被清');
  });
  test('默认上限 200', async () => {
    const r = rig();
    for (let i = 0; i < 205; i += 1) await r.cards.issue({ file: 'a.json', hash: HASH, job: job(), destUnknown: false });
    assert.equal(r.cards.size, 200);
  });
});

describe('B1–B11 handleClick', () => {
  test('B1 确认：提示条、卡片更新、文字行与 command 模式同一原文；decide 取索引条目；卡作废', async () => {
    const r = rig();
    const { id, nonce } = await issued(r);
    const out = click(r, { id, nonce, f: 'EVIL.json', extra: { file: 'EVIL.json', hash: HASH2 } });
    assert.deepEqual(out.toast, { type: 'success', content: '已确认' });
    assert.equal(out.card.type, 'raw');
    assert.match(lastLine(out), stateLine(r, '✅', '已确认'));
    assert.ok(!JSON.stringify(out.card.data).includes('button'));
    assert.deepEqual(r.decides, [['a.json', HASH, 'approved']], '用索引条目的 file/hash，不取 value 里的');
    await settle();
    const expected = tasksCommandReply({ text: '/tasks approve abc123', candidates: [cand()], store: { decide: () => ({ ok: true, persisted: true }) }, busy: 0, log: () => {} });
    assert.deepEqual(r.notes, [expected]);
    assert.match(expected, /^✅ 已确认定时任务「晨报」.*任务内容（目的地 \/ 时间 \/ 提示词 \/ 动作 \/ 任务名 \/ 模型 \/ 思考档）再变会重新等你确认。$/);
    assert.deepEqual(click(r, { id, nonce }), STALE, '一次性');
    assert.equal(r.decides.length, 1);
    assert.ok(r.logs.some((l) => l === '[sched-approval] 确认卡：owner 点了确认（a.json）'));
  });
  test('B1 的两行附加：一次性已过点、写盘失败', async () => {
    const r = rig({ cands: [cand({ expired: true })], decideReturn: { ok: true, persisted: false } });
    const { id, nonce } = await issued(r);
    click(r, { id, nonce });
    await settle();
    assert.deepEqual(r.notes[0].split('\n').slice(1), ['这是一次性任务，原定时间已过，不会再执行。', '⚠️ 确认记录写不进磁盘：本次运行内有效，重启后需要重新确认。']);
  });
  test('B2 拒绝：当前是待确认或已确认都记；文字行 = P7 原文', async () => {
    for (const state of ['pending', 'approved']) {
      const r = rig({ cands: [cand({ state })] });
      const { id, nonce } = await issued(r);
      const out = click(r, { id, nonce, a: 'reject' });
      assert.deepEqual(out.toast, { type: 'success', content: '已拒绝' });
      assert.match(lastLine(out), stateLine(r, '🚫', '已拒绝'));
      assert.deepEqual(r.decides, [['a.json', HASH, 'rejected']]);
      await settle();
      assert.equal(r.notes[0], '🚫 已拒绝定时任务「晨报」：它不会执行，/tasks 里标「已拒绝」。内容改了会重新问你；要恢复就发 /tasks approve abc123。');
    }
  });
  test('B3 内容改过：不记、卡作废、提示条 warning', async () => {
    const r = rig({ cands: [cand({ hash: HASH2 })] });
    const { id, nonce } = await issued(r);
    const out = click(r, { id, nonce });
    assert.deepEqual(out.toast, { type: 'warning', content: '任务内容已变，请看新的卡片' });
    assert.equal(lastLine(out), '⚠️ 任务内容已变，这张卡已作废，请看新的卡片');
    assert.deepEqual(r.decides, []);
    assert.deepEqual(click(r, { id, nonce }), STALE);
  });
  test('B4 任务不在候选里：不记、卡作废、提示条 info', async () => {
    const r = rig({ cands: [] });
    const { id, nonce } = await issued(r);
    const out = click(r, { id, nonce });
    assert.deepEqual(out.toast, { type: 'info', content: '这个任务已不需要确认' });
    assert.equal(lastLine(out), '这个任务已不需要确认（已删除、停用，或改成发给你本人）');
    assert.deepEqual(r.decides, []);
    assert.deepEqual(click(r, { id, nonce }), STALE);
  });
  test('B5 已经是要设的状态：不记、卡作废', async () => {
    for (const [a, state, toast, mark] of [['approve', 'approved', '已经是已确认', '✅'], ['reject', 'rejected', '已经是已拒绝', '🚫']]) {
      const r = rig({ cands: [cand({ state })] });
      const { id, nonce } = await issued(r);
      const out = click(r, { id, nonce, a });
      assert.deepEqual(out.toast, { type: 'info', content: toast });
      assert.match(lastLine(out), new RegExp(`^${mark} `));
      assert.deepEqual(r.decides, []);
      assert.deepEqual(click(r, { id, nonce, a }), STALE);
    }
  });
  test('B6 decide 返回 ok:false：不记、提示条 error、另发「没能记下」文字；卡作废', async () => {
    const r = rig({ decideReturn: { ok: false, persisted: false } });
    const { id, nonce } = await issued(r);
    const out = click(r, { id, nonce });
    assert.deepEqual(out, { toast: { type: 'error', content: '没能记下，任务仍待确认' } });
    await settle();
    assert.deepEqual(r.notes, ['没能记下这次确认（任务文件名不合规），任务仍待确认。']);
    assert.deepEqual(click(r, { id, nonce }), STALE);
  });
  test('B7 操作者不是 owner：STALE、不记、不补发', async () => {
    const r = rig();
    const { id, nonce } = await issued(r);
    assert.deepEqual(click(r, { id, nonce, isOwner: false }), STALE);
    assert.deepEqual(click(r, { id: 'om_nope', nonce, isOwner: false }), STALE);
    assert.deepEqual([r.decides, r.resends], [[], []]);
    assert.equal(click(r, { id, nonce }).toast.content, '已确认', '非 owner 点过不消耗卡');
  });
  test('B8 伪造卡 / nonce 差一位 / 过期：不记；f 合规且受闸 → 补发；限频内 / gone → 对应提示', async () => {
    const r = rig();
    const { id, nonce } = await issued(r);
    const flip = nonce.slice(0, -1) + (nonce.endsWith('0') ? '1' : '0');
    // 伪造卡：id 不在索引（即使 nonce 碰巧是对的）
    assert.deepEqual(click(r, { id: 'om_forged1', nonce }), { toast: { type: 'warning', content: '这张卡片已失效，已重发一张新的' } });
    assert.deepEqual(r.resends, ['a.json']);
    assert.equal(click(r, { id, nonce: flip }).toast.content, '这张卡片已失效，已重发一张新的');
    assert.deepEqual(r.decides, []);
    r.resendReturn = 'recent';
    assert.deepEqual(click(r, { id: 'om_forged1', nonce }), { toast: { type: 'warning', content: '这张卡片已失效，新卡刚发过，请往下找' } });
    r.resendReturn = 'gone';
    assert.deepEqual(click(r, { id: 'om_forged1', nonce }), STALE);
    r.resends.length = 0;
    for (const f of ['', 'a\nb', 'x'.repeat(256), 7, null]) assert.deepEqual(click(r, { id: 'om_forged1', nonce, f }), STALE);
    assert.deepEqual(r.resends, [], 'f 不合规不补发');
    assert.deepEqual(r.decides, []);
    assert.equal(click(r, { id, nonce }).toast.content, '已确认', 'nonce 不对不消耗卡');
  });
  test('B8 过期：7 天后点 → 失效 + 补发；刚好 7 天内仍有效', async () => {
    const r = rig();
    const a = await issued(r);
    r.clock += 7 * 86_400_000;
    assert.equal(click(r, a).toast.content, '已确认', '7 天整仍有效');
    const b = await issued(r);
    r.clock += 7 * 86_400_000 + 1;
    assert.equal(click(r, b).toast.content, '这张卡片已失效，已重发一张新的');
    assert.deepEqual(r.decides.length, 1);
  });
  test('B8 重启（索引为空，command 模式同）：补发或 STALE', () => {
    const r = rig();
    assert.equal(click(r, { id: OWNER_MSG, nonce: '0'.repeat(16) }).toast.content, '这张卡片已失效，已重发一张新的');
  });
  test('B9 value 形状不对：STALE，不查索引、不补发', async () => {
    const r = rig();
    const { id, nonce } = await issued(r);
    const bad = [null, 'str', 7, [], { v: 2, k: SCHED_CARD_KIND, a: 'approve', n: nonce }, { v: 1, k: SCHED_CARD_KIND, a: 'delete', n: nonce },
      { v: 1, k: SCHED_CARD_KIND, a: 'approve', n: 'XYZ' }, { v: 1, k: SCHED_CARD_KIND, a: 'approve', n: nonce.toUpperCase() }, { v: 1, k: SCHED_CARD_KIND, a: 'approve' },
      { v: 1, k: 'other', a: 'approve', n: nonce }];
    for (const value of bad) assert.deepEqual(r.cards.handleClick({ isOwner: true, messageId: id, value }), STALE);
    assert.deepEqual([r.decides, r.resends], [[], []]);
  });
  test('B10 handleClick 只依赖权限表列出的输入：不需要任何「忙」参数', async () => {
    const r = rig();
    const { id, nonce } = await issued(r);
    assert.equal(r.cards.handleClick.length <= 1, true);
    assert.equal(click(r, { id, nonce }).toast.content, '已确认');
  });
  test('B11 scheduler / decide 抛错：STALE 且不抛、不记；notify 抛错不影响应答', async () => {
    for (const o of [{ schedThrows: true }, { decideThrows: true }]) {
      const r = rig(o);
      const { id, nonce } = await issued(r);
      assert.deepEqual(click(r, { id, nonce }), STALE);
    }
    const r = rig({ notifyThrows: true });
    const { id, nonce } = await issued(r);
    assert.equal(click(r, { id, nonce }).toast.content, '已确认', '决定已记，文字行失败不改应答');
    const x = rig();
    assert.deepEqual(x.cards.handleClick(undefined), STALE);
    assert.deepEqual(x.cards.handleClick({ isOwner: true, messageId: 5, value: { v: 1, k: SCHED_CARD_KIND, a: 'approve', n: '0'.repeat(16) } }).toast.type, 'warning');
  });
  test('日志与应答不含 message_id / nonce / chat_id / 提示词', async () => {
    const r = rig();
    const { id, nonce } = await issued(r);
    click(r, { id: 'om_forged1', nonce }); click(r, { id, nonce, isOwner: false }); click(r, { id, nonce });
    await settle();
    const blob = JSON.stringify([r.logs, r.notes]);
    for (const s of [id, nonce, CHAT, 'om_forged1', '发日报']) assert.ok(!blob.includes(s), s);
  });
});

describe('T1–T4 button 模式下的 /tasks', () => {
  const run = (text, o = {}) => {
    const calls = { decide: [], resend: [] };
    const reply = tasksCommandReply({
      text, mode: 'button', candidates: o.cands ?? [cand()], busy: o.busy ?? 0, log: () => {},
      store: { decide: (...a) => { calls.decide.push(a); return { ok: true, persisted: true }; } },
      resend: o.noResend ? undefined : (c) => { calls.resend.push(c.file); return o.resendReturn ?? 'sent'; },
    });
    return { reply, calls };
  };
  test('T1 approve 待确认 / 已拒绝：不记，补发；限频内另一句', () => {
    for (const state of ['pending', 'rejected']) {
      const x = run('/tasks approve abc123', { cands: [cand({ state })] });
      assert.equal(x.reply, '请点确认卡上的［确认］按钮：已把「晨报」的确认卡重新发给你。');
      assert.deepEqual([x.calls.decide, x.calls.resend], [[], ['a.json']]);
    }
    assert.equal(run('/tasks approve abc123', { resendReturn: 'recent' }).reply, '请点确认卡上的［确认］按钮：「晨报」的确认卡 2 分钟内刚发过，请往上翻一翻。');
    assert.match(run('/tasks approve abc123', { resendReturn: 'gone' }).reply, /^没找到等你确认的这个任务/);
    assert.match(run('/tasks approve abc123', { noResend: true }).reply, /^没找到等你确认的这个任务/);
  });
  test('T2 已确认 / 找不到 / 重名 / 用法：与 command 同原文，不记', () => {
    const same = (text, o) => {
      const b = run(text, o).reply;
      const c = tasksCommandReply({ text, candidates: o?.cands ?? [cand()], busy: 0, log: () => {}, store: { decide: () => ({ ok: true }) } });
      assert.equal(b, c, text);
      return b;
    };
    assert.match(same('/tasks approve abc123', { cands: [cand({ state: 'approved' })] }), /^「晨报」已经是已确认。$/);
    assert.match(same('/tasks approve ffffff'), /^没找到/);
    assert.match(same('/tasks approve 晨报', { cands: [cand(), cand({ file: 'b.json', code: 'def456' })] }), /^有 2 个任务都叫这个名字/);
    assert.match(same('/tasks approve'), /^用法：/);
    assert.match(same('/tasks foo bar'), /^用法：/);
  });
  test('T3 有 owner 回合在跑、按名字命中但还没通知过：照样补发', () => {
    assert.match(run('/tasks approve abc123', { busy: 3 }).reply, /^请点确认卡上的［确认］按钮：已把/);
    const x = run('/tasks approve 晨报', { cands: [cand({ announced: false })] });
    assert.match(x.reply, /^请点确认卡上的［确认］按钮：已把/);
    assert.deepEqual(x.calls.decide, []);
  });
  test('T4 reject 与 command 模式完全相同（含忙时）', () => {
    for (const busy of [0, 2]) {
      const b = run('/tasks reject abc123', { busy });
      const c = tasksCommandReply({ text: '/tasks reject abc123', candidates: [cand()], busy, log: () => {}, store: { decide: () => ({ ok: true, persisted: true }) } });
      assert.equal(b.reply, c);
      assert.deepEqual(b.calls.decide, [['a.json', HASH, 'rejected']]);
      assert.deepEqual(b.calls.resend, []);
    }
  });
  test('T5 command（缺省 / 空 / 任何不认识的值）：approve 照旧记、忙时拒绝、不调 resend', () => {
    for (const mode of [undefined, '', 'command', 'bogus']) {
      const calls = { decide: [], resend: 0 };
      const store = { decide: (...a) => { calls.decide.push(a); return { ok: true, persisted: true }; } };
      const resend = () => { calls.resend += 1; return 'sent'; };
      assert.match(tasksCommandReply({ text: '/tasks approve abc123', mode, candidates: [cand()], store, busy: 0, resend, log: () => {} }), /^✅ 已确认/);
      assert.match(tasksCommandReply({ text: '/tasks approve abc123', mode, candidates: [cand()], store, busy: 1, resend, log: () => {} }), /^现在有 1 个带你权限的任务在跑/);
      assert.deepEqual([calls.decide.length, calls.resend], [1, 0]);
    }
  });
  test('decisionReply 与文字命令同一函数：ok:false 两句', () => {
    assert.equal(decisionReply({ candidate: cand(), approve: true, result: { ok: false } }), '没能记下这次确认（任务文件名不合规），任务仍待确认。');
    assert.equal(decisionReply({ candidate: cand(), approve: false, result: { ok: false } }), '没能记下这次拒绝（任务文件名不合规），任务仍待确认、不会执行。');
  });
});

describe('M1 approvalModeOf', () => {
  test('真值表', () => {
    const logs = [];
    const log = (l) => logs.push(l);
    for (const [v, want] of [['button', 'button'], [' Button ', 'button'], ['BUTTON', 'button'], ['command', 'command'], ['', 'command'], ['  ', 'command'], [undefined, 'command'], [null, 'command']]) {
      assert.equal(approvalModeOf(v, log), want, JSON.stringify(v));
    }
    assert.deepEqual(logs, []);
    assert.equal(approvalModeOf('bogus-secret-value', log), 'command');
    assert.deepEqual(logs, ['[sched] SCHED_APPROVAL_MODE 只认 command / button，按 command 处理']);
    assert.equal(approvalModeOf('x', () => { throw new Error('log boom'); }), 'command', '日志抛错也不抛');
  });
});

describe('L3 LOW-3：记录文件读不了时不重写', () => {
  const canChmod = process.getuid?.() !== 0 && process.platform !== 'win32';
  function seed() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priv3-l3-'));
    const file = path.join(dir, 'sched-approvals.json');
    const keyFile = path.join(dir, 'key');
    const s = createApprovalStore({ file, keyFile, log: () => {} });
    const j = job();
    assert.equal(s.decide('a.json', approvalHash('a.json', j), 'approved').persisted, true);
    return { dir, file, keyFile, j };
  }
  test('chmod 000：invalidated 为真、文件内容与 inode 不变；恢复权限后新 store 读回原条目', { skip: !canChmod }, () => {
    const { dir, file, keyFile, j } = seed();
    try {
      const before = fs.readFileSync(file, 'utf8');
      const ino = fs.statSync(file).ino;
      fs.chmodSync(file, 0o000);
      const logs = [];
      const s2 = createApprovalStore({ file, keyFile, log: (l) => logs.push(l) });
      assert.equal(s2.invalidated, true);
      assert.equal(s2.invalidCount, 1);
      assert.equal(s2.lookup('a.json', approvalHash('a.json', j)), null, '失败时关闭：按待确认');
      assert.ok(logs.every((l) => !l.includes('重写失败')));
      fs.chmodSync(file, 0o600);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      assert.equal(fs.statSync(file).ino, ino, '没有被 rename 换掉');
      const s3 = createApprovalStore({ file, keyFile, log: () => {} });
      assert.equal(s3.invalidated, false);
      assert.equal(s3.lookup('a.json', approvalHash('a.json', j)).decision, 'approved');
    } finally { try { fs.chmodSync(file, 0o600); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('对照：验签不过 / 不是 JSON 照旧重写', () => {
    for (const mutate of [(t) => t.replace(/"mac": "[0-9a-f]/, '"mac": "z'), () => '{not json']) {
      const { dir, file, keyFile, j } = seed();
      try {
        fs.writeFileSync(file, mutate(fs.readFileSync(file, 'utf8')));
        const s = createApprovalStore({ file, keyFile, log: () => {} });
        assert.equal(s.invalidated, true);
        assert.equal(s.lookup('a.json', approvalHash('a.json', j)), null);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, entries: {} }, '已按合格条目重写');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });
});

describe('A5 日志 / 提示条 / 文字 / 卡片里不出现完整会话 id、open_id、消息 id、nonce', () => {
  test('走一遍确认、拒绝、伪造、非 owner、用后再点、发卡失败：收集所有对外文字逐一查', async () => {
    const outs = []; // 提示条、点击应答里的卡、文字行
    const r = rig({ cands: [cand(), cand({ file: 'b.json', name: '乙', code: 'def456' })] });
    const one = await issued(r, HASH, job());
    const two = await issued(r, HASH, job({ _file: 'b.json', name: '乙' }));
    const take = (o) => { outs.push(JSON.stringify(o)); return o; };
    take(click(r, { id: one.id, nonce: one.nonce }));
    take(click(r, { id: one.id, nonce: one.nonce })); // 用后再点
    take(click(r, { id: two.id, nonce: '0'.repeat(16), f: 'b.json' })); // nonce 不对 → 补发
    take(click(r, { id: two.id, nonce: two.nonce, f: 'b.json', isOwner: false }));
    take(click(r, { id: 'om_forged0001', nonce: two.nonce, f: 'b.json' }));
    take(click(r, { id: two.id, nonce: two.nonce, a: 'reject', f: 'b.json' }));
    const bad = rig({ sendThrows: true });
    assert.equal(await bad.cards.issue({ file: 'a.json', hash: HASH, job: job(), destUnknown: false }), false);
    await settle();
    const secrets = [CHAT, 'ou_owner', 'om_card', 'om_forged', one.nonce, two.nonce];
    const texts = [...r.logs, ...bad.logs, ...r.notes, ...outs];
    assert.ok(texts.length >= 8);
    for (const s of texts) for (const k of secrets) assert.ok(!s.includes(k), `泄漏 ${k.slice(0, 6)}… 于：${s}`);
    // 发出去的卡：除按钮 value 里的 nonce / 文件名外，正文不含完整 id
    for (const c of r.sent) {
      const body = JSON.stringify(c.body.elements.filter((e) => e.tag === 'div'));
      for (const k of [CHAT, 'ou_owner', 'om_card']) assert.ok(!body.includes(k), `卡片正文泄漏 ${k}`);
    }
  });
});
