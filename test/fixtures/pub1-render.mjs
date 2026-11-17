// BRIDGE-PUB-1：把「发给 owner 的消息」与「发给模型的 prompt」里带称呼的模板逐个渲染成一份 JSON，用来钉住
// OWNER_NAME=光总 时与基线逐字相同。
//
// 夹具 test/fixtures/pub1-baseline-419d56f.json 用基线 419d56f 的源码生成，没有经过本卡改动后的代码：
//   mkdir <空目录> && git archive 419d56f | tar -x -C <空目录>
//   TZ=Asia/Shanghai node test/fixtures/pub1-render.mjs <空目录> > test/fixtures/pub1-baseline-419d56f.json
// test/owner-name.test.js 用子进程对改后的源码跑同一个脚本（OWNER_NAME 由父进程决定）再逐字比对；测试本身从不重新生成夹具。
// 全部用桩：不连飞书、不起 lark-cli、不调真实 claude。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'));
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pub1-render-')));
const ws = path.join(TMP, 'ws');
const gws = path.join(TMP, 'gws');
const data = path.join(TMP, 'data');
const home = path.join(TMP, 'home');
for (const d of [ws, gws, data, home]) fs.mkdirSync(d, { recursive: true });
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

// 模块在加载时读的环境变量全部钉死（OWNER_NAME / OWNER_EXTRA_WRITE_DIRS 由父进程决定，不在这里改）
Object.assign(process.env, {
  WORKSPACE_DIR: ws, GUEST_WORKSPACE_DIR: gws, DATA_DIR: data, HOME: home,
  CLAUDE_BIN: path.join(TMP, 'no-claude'), CLAUDE_MODEL: 'claude-test-chat', CLAUDE_EFFORT: 'high',
  FEISHU_APP_ID: 'cli_test_app', FEISHU_APP_SECRET: 'test-app-secret', LARK_CLI: 'true',
});
for (const k of ['CLAUDE_EXEC_MODEL', 'CLAUDE_EXEC_EFFORT', 'ALLOWED_TOOLS', 'NON_OWNER_TOOLS', 'GUEST_TOOLS', 'GUEST_DENIED_TOOLS',
  'FEISHU_TOOLS', 'FEISHU_DOMAIN', 'OWNER_TOOL_PROFILE', 'OWNER_EXTRA_SKILLS', 'TOOL_AUDIT_SUMMARY_AT', 'DIAG_MODEL']) delete process.env[k];
// OWNER_EXTRA_WRITE_DIRS 要落在本脚本的临时 HOME 下：父进程用 PUB1_EXTRA_DIRS_UNDER_HOME 给相对路径（逗号分隔），这里拼成绝对路径
if (process.env.PUB1_EXTRA_DIRS_UNDER_HOME !== undefined) {
  process.env.OWNER_EXTRA_WRITE_DIRS = process.env.PUB1_EXTRA_DIRS_UNDER_HOME.split(',').map((r) => path.join(home, r)).join(',');
}

const mod = (rel, q = '') => import(pathToFileURL(path.join(ROOT, rel)).href + q);
const out = {};

// 归一化：临时目录、仓库根、node 路径、随机 nonce
const norm = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (typeof x !== 'string' ? x : x
  .split(TMP).join('<tmp>').split(ROOT).join('<root>').split(process.execPath).join('<node>')
  .replace(/UNTRUSTED_([0-9a-f]{16})/g, 'UNTRUSTED_<nonce>')
  .replace(/UNTRUSTED_END_([0-9a-f]{16})/g, 'UNTRUSTED_END_<nonce>'))));
const btnNonce = (acts) => (acts ?? []).map((a) => ({ ...a, value: { ...a.value, n: '<n>' } }));

// ---------- 排队合并（message-queue）----------
{
  const mq = await mod('src/message-queue.js');
  const T = new Date(2026, 10, 16, 10, 5).getTime();
  out.queue = {
    consts: ['QUEUED_FALLBACK_REPLY', 'QUEUE_SHUTDOWN_REPLY', 'QUEUE_FAILED_REPLY', 'MERGED_PREFACE', 'MERGED_CONFIRM_NOTE',
      'MERGED_CONFIRM_NOTICE', 'QUEUED_CONFIRM_NOTICE', 'QUEUE_FULL_REPLY'].map((k) => [k, mq[k]]),
    merged: mq.buildMergedPrompt([{ at: T, text: '先查报价' }, { at: T + 60_000, text: '改成明天' }]),
    mergedConfirm: mq.buildMergedPrompt([{ at: T, text: '确认' }, { at: T + 60_000, text: '再发一份' }], { confirmNote: true }),
    cleared: mq.withClearedNote('已取消', 2),
  };
}

// ---------- 确认通道（tool-policy）----------
{
  const tp = await mod('src/tool-policy.js');
  out.confirmDefault = tp.CONFIRM_DEFAULT_PROMPT;
}

// ---------- 日结（digest）----------
{
  const dg = await mod('src/digest.js');
  const now = new Date(2026, 10, 16, 21, 30);
  const day = (h) => new Date(2026, 10, 16, h, 0).toISOString();
  const tasks = [
    { slug: 'a', title: '任务甲', status: 'done' }, { slug: 'b', title: '任务乙', status: 'done' },
    { slug: 'c', title: '任务丙', status: 'done' }, { slug: 'd', title: '任务丁', status: 'done' },
    { slug: 'e', title: '任务戊', status: 'done' }, { slug: 'f', title: '任务己', status: 'dropped' },
    { slug: 'g', title: '跟进报价单', status: 'open', next_check_at: '2026-11-15T09:00', escalate_after: '2026-11-14T09:00' },
  ];
  const changes = ['rule', 'model', 'heartbeat', 'owner', 'chat'].map((via, i) => ({ slug: 'abcde'[i], to: 'done', via, at: day(10 + i) }))
    .concat([{ slug: 'f', to: 'dropped', via: 'owner', at: day(16) }]);
  const taskState = { g: { esc: { level: 2, for: '2026-11-14T09:00', at: day(9) } } };
  out.digest = {
    labels: dg.METHOD_LABELS,
    plain: dg.buildDigest({ tasks, changes, taskState, now, ladder: true, escalateMax: 2 }),
    buttons: dg.buildDigest({ tasks, changes, taskState, now, ladder: true, escalateMax: 2, buttons: true }),
  };
}

// ---------- 验收（verifier）----------
{
  const vf = await mod('src/verifier.js');
  const SENT = String(new Date(2026, 10, 15, 9, 0).getTime());
  const MSG = {
    title: '等王总回复', status: 'verify', created_at: '2026-11-10T09:00', watch: { type: 'chat_reply', chat_id: 'oc_c1' },
    done_evidence: { kind: 'message', ref: 'om_r1', summary: '王总回了' },
  };
  const reply = (sender) => async () => ({
    ok: true,
    stdout: JSON.stringify({ data: { items: [{ message_id: 'om_r1', chat_id: 'oc_c1', msg_type: 'text', create_time: SENT, sender: { id: sender, sender_type: 'user' }, body: { content: '{"text":"收到了"}' } }] } }),
  });
  const hbv = await mod('src/heartbeat.js');
  const valid = (raw) => { const r = hbv.validateTask(raw, 'msg'); return r.ok ? r.task : raw; };
  const ownMsg = await vf.ruleCheck({ task: valid(MSG), runner: reply('ou_owner'), owner: 'ou_owner' });
  const noOwner = await vf.ruleCheck({ task: valid(MSG), runner: reply('ou_x'), owner: '' });
  const ownerKind = await vf.ruleCheck({ task: valid({ ...MSG, done_evidence: { kind: 'owner', ref: '', summary: '说办完了' } }), runner: reply('ou_x'), owner: 'ou_owner' });
  const rejected = await vf.ruleCheck({
    task: valid({ title: '报销审批', status: 'verify', created_at: '2026-11-10T09:00', watch: { type: 'approval', instance_code: 'INST-1' },
      done_evidence: { kind: 'approval', ref: 'INST-1', summary: '审批已通过' } }),
    runner: async () => ({ ok: true, stdout: JSON.stringify({ data: { instance: { status: 'REJECTED' } } }) }), owner: 'ou_owner',
  });
  const VT = { title: '跟进报价单', status: 'verify', notes: '王总说收到了', done_evidence: { kind: 'other', ref: '', summary: '已经邮件发出' } };
  out.verify = {
    findings: [ownMsg, noOwner, ownerKind, rejected].map((r) => [r.outcome, r.finding]),
    card: vf.buildVerifyCard({ slug: 'quote', task: VT, finding: ownMsg.finding, buttons: true, shortcuts: true }),
    prompt: vf.buildVerifyPrompt({ slug: 'quote', task: VT, finding: ownerKind.finding, nowMs: new Date(2026, 10, 16, 10, 0).getTime() }),
  };
}

// ---------- 台账按钮回写（ledger-actions）----------
{
  const la = await mod('src/ledger-actions.js');
  const hbm = await mod('src/heartbeat.js');
  const now = new Date(2026, 10, 16, 10, 0);
  const runs = [];
  for (const [fn, action, source] of [['applyLedgerAction', 'ack', 'button'], ['applyLedgerAction', 'snooze1d', 'reply'],
    ['applyVerifyAction', 'done', 'button'], ['applyVerifyAction', 'done', 'reply'], ['applyVerifyAction', 'accept', 'reply']]) {
    const dir = fs.mkdtempSync(path.join(TMP, 'la-'));
    const tasksDir = path.join(dir, 'tasks');
    const journalDir = path.join(dir, 'journal');
    fs.mkdirSync(tasksDir, { recursive: true });
    const status = action === 'accept' ? 'verify' : 'open';
    fs.writeFileSync(path.join(tasksDir, 'quote.json'), JSON.stringify({ title: '跟进报价单', status, next_check_at: '2026-11-16T09:00' }, null, 2));
    const r = la[fn]({ tasksDir, journalDir, slug: 'quote', action, now, validate: hbm.validateTask, parseTime: hbm.parseTime, source, via: 'owner', log: () => {} });
    const jf = path.join(journalDir, '2026-11-16.md');
    const task = JSON.parse(fs.readFileSync(path.join(tasksDir, 'quote.json'), 'utf8'));
    runs.push({ fn, action, source, ok: r?.ok ?? null, journal: fs.existsSync(jf) ? fs.readFileSync(jf, 'utf8') : '', evidence: task.done_evidence ?? null });
  }
  out.ledger = runs;
}

// ---------- 定时任务自诊断与失败通知（outbound / claude）----------
{
  const ob = await mod('src/outbound.js');
  const sent = [];
  const send = async (t) => { sent.push(t); };
  await ob.handleScheduledFailure({ err: 'Failed to authenticate. API Error: 401', jobName: '日报', send, runDiagnosis: async () => 'x', checkKeychain: async () => false, log: () => {} });
  await ob.handleScheduledFailure({ err: 'Error: boom', jobName: '日报', send, runDiagnosis: async () => '1) 其他\n2) 根因\n3) 动作', checkKeychain: async () => false, log: () => {} });
  out.failures = {
    sched: sent,
    replies: [
      await ob.claudeFailureReply('Error: boom', { checkKeychain: async () => false }),
      await ob.claudeFailureReply('Not logged in · Please run /login', { checkKeychain: async () => false }),
      await ob.claudeFailureReply('Not logged in · Please run /login', { checkKeychain: async () => true }),
      await ob.claudeFailureReply('Keychain is not writable', { checkKeychain: async () => null }),
    ],
  };
}

// ---------- 审计日报（tool-audit）----------
{
  const ta = await mod('src/tool-audit.js');
  const recs = [
    { kind: 'chat', tool: 'Bash', domain: 'mail', cmd: '+send', decision: 'deny' },
    { kind: 'chat', tool: 'Bash', domain: 'approval', cmd: '+approve', decision: 'confirm' },
    { kind: 'sched', tool: 'Bash', cmd: 'rm', decision: 'deny', denied: true },
  ];
  out.auditSummary = [ta.buildToolAuditSummary(recs, { profile: 'audit' }), ta.buildToolAuditSummary(recs, { profile: 'strict' })];
}

// ---------- claude CLI 参数（三档；含运行配置提示词与 strict 的拒绝清单）----------
{
  const argv = {};
  let seq = 0;
  for (const profile of ['legacy', 'audit', 'strict']) {
    process.env.OWNER_TOOL_PROFILE = profile;
    const cl = await mod('src/claude.js', `?pub1=${++seq}`);
    const take = (r) => { const a = norm(r.args.map((x, i) => (r.args[i - 1] === '--mcp-config' ? '<mcp-config>' : x))); r.cleanup?.(); return a; };
    argv[profile] = {
      chat: take(cl.buildClaudeArgs('oc_x', true, [], { lane: 'chat', resumeId: 'sess-1' })),
      chatConfirm: take(cl.buildClaudeArgs('oc_x', true, [], { lane: 'chat', resumeId: 'sess-1', confirm: true })),
      sched: take(cl.buildClaudeArgs('sched:daily.json', true, [], { model: 'claude-test-sched', effort: 'low', toolProfile: 'sched' })),
      diagPrompt: norm(cl.schedDiagPrompt({ _file: 'daily.json', name: '日报', prompt: '汇总今天的群消息' }, 'Error: boom')),
    };
  }
  delete process.env.OWNER_TOOL_PROFILE;
  out.argv = argv;
}

// ---------- 心跳（heartbeat，经 test/vr-harness.js 的桩）----------
{
  const hbm = await mod('src/heartbeat.js');
  const vr = await mod('test/vr-harness.js');
  const now = vr.T0;
  const due = [{ task: { slug: 'quote', title: '跟进报价单', status: 'open', next_check_at: '2026-11-16T09:00', notes: '王总一直没回', times: {} }, reasons: ['next_check_at'] }];
  const stats = { quote: { attempts: 2, prev_checked_at: vr.plus(now, -60).toISOString(), last_notified_at: vr.plus(now, -120).toISOString(), acked_at: vr.plus(now, -30).toISOString() } };
  let prompt;
  try { prompt = hbm.buildHeartbeatPrompt({ due, deltas: [], now, stats }); } catch (e) { prompt = `ERR ${e.message}`; }
  out.heartbeatPrompt = norm(prompt);

  // 升级阶梯：第一级（模型）→ 已读满 24 小时 → 第二级模板；最后发日结
  {
    const env = vr.mkEnv();
    const ESC = { title: '跟进报价单', status: 'open', next_check_at: '2026-11-20T09:00', escalate_after: '2026-11-16T09:00', notes: '已经发了两次邮件，王总一直没回' };
    vr.writeTask(env, 'quote', ESC);
    const h = vr.harness(env, { config: vr.CFG({ HEARTBEAT_ESCALATE_LADDER: 'true', HEARTBEAT_BUTTONS: 'true', HEARTBEAT_DIGEST_AT: '21:30' }) });
    await h.hb.beat();
    await vr.readEvent(h, h.sent[0].mid, vr.plus(now, 60));
    h.setNow(vr.plus(now, 24 * 60));
    await h.hb.beat();
    h.setNow(vr.at(2026, 11, 17, 21, 30));
    await h.hb.digestNow();
    out.ladder = { prompts: norm(h.calls.map((c) => c[1])), sent: norm(h.sent.map((s) => ({ text: s.text, actions: btnNonce(s.opts?.actions) }))) };
  }

  // 验收：点「没办完」后再写 done → 卡片「之前判过这条没办完」；以及 owner 点按钮后的心跳 prompt
  {
    const env = vr.mkEnv();
    const APPR = { title: '报销审批', status: 'verify', created_at: '2026-11-10T09:00', watch: { type: 'approval', instance_code: 'INST-1' },
      done_evidence: { kind: 'other', ref: '', summary: '审批应该过了' } };
    vr.writeTask(env, 'appr', APPR);
    let armed = false;
    const h = vr.harness(env, {
      config: vr.CFG({ HEARTBEAT_VERIFY: 'rule', HEARTBEAT_BUTTONS: 'true', HEARTBEAT_REPLY_SHORTCUTS: 'true', HEARTBEAT_DIGEST_AT: '21:30' }),
      verifyRunner: vr.mkRunner(() => ({ ok: true, stdout: JSON.stringify({ data: { instance: { status: 'APPROVED' } } }) })),
      runImpl: (n, chatId) => {
        if (chatId === 'sched:verify') return '{"verdict":"unsure","reason":"看不出"}';
        if (!armed) return 'HEARTBEAT_OK';
        const t = vr.readTask(env, 'appr');
        vr.writeTask(env, 'appr', { ...t, status: 'done', done_evidence: { kind: 'approval', ref: 'INST-1', summary: '这次真的通过了' } });
        return '审批办完了';
      },
    });
    await h.hb.beat();
    const c1 = h.sent.find((s) => s.text.startsWith('🔍'));
    h.setNow(vr.plus(now, 5));
    await h.handlers.cardAction(vr.click(c1.mid, vr.btn(c1, 'reopen')));
    armed = true;
    h.setNow(vr.at(2026, 11, 17, 10, 10));
    await h.hb.beat();
    h.setNow(vr.at(2026, 11, 17, 10, 40));
    await h.hb.beat();
    const c2 = h.sent.filter((s) => s.text.startsWith('🔍'))[1];
    if (c2) await h.handlers.cardAction(vr.click(c2.mid, vr.btn(c2, 'accept')));
    h.setNow(vr.at(2026, 11, 17, 21, 30));
    await h.hb.digestNow();
    out.verifyFlow = {
      prompts: norm(h.calls.map((c) => c[1])),
      sent: norm(h.sent.map((s) => ({ text: s.text, actions: btnNonce(s.opts?.actions) }))),
      journal: norm(vr.journalOf(env, '2026-11-17') + vr.journalOf(env, '2026-11-16')),
    };
  }
}

// ---------- 外部增量（watch-sources：chat_reply）----------
{
  const wsrc = await mod('src/watch-sources.js');
  const T = new Date(2026, 10, 16, 10, 0);
  const m = (id, min, from, name, text) => ({ message_id: id, msg_type: 'text', create_time: String(T.getTime() + min * 60_000), sender: { id: from, sender_type: 'user', name }, content: text });
  const list = [m('om_own', 1, 'ou_owner', '本人', '我先看看'), m('om_a', 2, 'ou_alice', 'Alice', '好的，周五前给你')];
  const runner = async (argv) => (argv[1] === '+chat-messages-list'
    ? { ok: true, stdout: JSON.stringify({ data: { messages: [...list].reverse(), has_more: false } }) }
    : { ok: false, reason: 'x' });
  const collect = wsrc.createWatchSources({ runner, getOwner: () => 'ou_owner', log: () => {} });
  const r = await collect({ tasks: [{ slug: 'quote', status: 'open', watch: { type: 'chat_reply', chat_id: 'oc_abc', after: String(T.getTime()) }, times: {} }], now: new Date(T.getTime() + 10 * 60_000), watch: 'chat_reply', beat: 1 });
  out.watchDelta = norm(r.deltas.map((d) => d.text));
}

process.stdout.write(`${JSON.stringify(norm(out), null, 1)}\n`);
