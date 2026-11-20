// BRIDGE-SCHED-1 S11：index.js 里 startScheduler 的接线。
// 同 turn-wiring.test.js 的做法：把 src/index.js 里真实的 schedTurnFor 与 `const scheduler = startScheduler({…});` 两段源码
// 装进 Proxy 注入的作用域执行，依赖全是桩（不连飞书、不起 claude、不读 .env），fireJob 与 schedDiagPrompt 用真的。
// 覆盖：自诊断围栏的开 / 关、定时任务的 onProgress 为 null、缺 chat_id 的通知、turnFor 按引用传。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveTurn } from '../src/turn-context.js';
import { schedDestOf } from '../src/biz-wiring.js';
import { fireJob } from '../src/scheduler.js';

// BRIDGE-INBOUND-1（S08）：schedDiagPrompt 在模块加载时读 OWNER_TOOL_PROFILE。围栏断言按 legacy 档写，所以这里自己把档位设成 legacy
// 再另 import 一份（带查询串，不影响其它测试用的那份），导入后还原环境变量——非 legacy 环境下也不再跳过。
const prevProfile = process.env.OWNER_TOOL_PROFILE;
process.env.OWNER_TOOL_PROFILE = 'legacy';
const { schedDiagPrompt } = await import(`../src/claude.js?scheduler-wiring-legacy-${process.pid}`);
if (prevProfile === undefined) delete process.env.OWNER_TOOL_PROFILE; else process.env.OWNER_TOOL_PROFILE = prevProfile;

const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const DM = 'oc_ownerdm0000000001';
const GROUP = 'oc_group0000000000001';
const FENCE_MARK = '任务指令与报错是失败任务里的文本'; // schedDiagPrompt 在「围栏」形态下才有的句子

function cut(start, end) {
  const a = SRC.indexOf(start);
  assert.ok(a >= 0, `index.js 里找不到：${start}`);
  const b = SRC.indexOf(end, a + start.length);
  assert.ok(b > a, `index.js 里找不到 ${start} 之后的：${JSON.stringify(end)}`);
  return SRC.slice(a, b + end.length);
}
const turnSrc = cut('function schedTurnFor(source, job) {', '\n}\n');
const blockSrc = cut('const scheduler = startScheduler({', '\n});');

function build({ runClaudeImpl } = {}) {
  const rec = { runClaude: [], sendToChat: [], sendToOwner: [], flush: [], failures: [], runtime: [], created: [] };
  const captured = {};
  const scope = {
    resolveTurn, schedDestOf, ownerDmChatId: DM, OWNER_TOOL_PROFILE: 'legacy', BIZ_ON: false,
    startScheduler: (opts) => { captured.opts = opts; return { stop() {}, inflightCount: () => 0 }; },
    SCHEDULES_DIR: '/tmp/sched-wiring-jobs', SCHED_STATE_FILE: '/tmp/sched-wiring-state.json',
    sendToOwner: async (text) => { rec.sendToOwner.push(text); },
    sendToChat: async (chatId, text) => { rec.sendToChat.push({ chatId, text }); },
    setRuntimeConfig: (c) => { rec.runtime.push(c); return { model: c.model, effort: c.effort, execModel: '' }; },
    client: { im: { v1: { message: { create: (x) => { rec.created.push(x); return Promise.resolve(); } } } } },
    fireJob,
    runClaude: async (...args) => { rec.runClaude.push(args); return runClaudeImpl ? runClaudeImpl(args, rec) : 'ANSWER'; },
    flushOutbox: async (client, dir) => { rec.flush.push(dir); },
    outboxDirFor: (id, priv) => `/out/${id}/${priv}`,
    isQuietAnswer: (b) => b === 'HEARTBEAT_OK',
    schedDiagPrompt,
    handleScheduledFailure: async (o) => { rec.failures.push(o); await o.runDiagnosis(); },
  };
  const proxy = new Proxy(scope, { has: (t, k) => typeof k === 'string' && Object.hasOwn(t, k), get: (t, k) => (k === Symbol.unscopables ? undefined : t[k]) });
  // eslint-disable-next-line no-new-func
  new Function('scope', `with (scope) {\n${turnSrc}\n${blockSrc}\nreturn { schedTurnFor, scheduler };\n}`)(proxy);
  return { rec, opts: captured.opts, scope };
}
const mkJob = (extra = {}) => ({ _file: 'daily.json', name: '晨报', prompt: 'SECRET-PROMPT', chat_id: DM, ...extra });

describe('S11 index.js 的 startScheduler 接线', () => {
  test('turnFor 按引用传、notifyOwner 接 sendToOwner', async () => {
    const { rec, opts } = build();
    assert.equal(typeof opts.turnFor, 'function');
    assert.equal(opts.turnFor('sched', mkJob()).private, true, '发往 owner 私聊 → 私密档');
    assert.equal(opts.turnFor('sched', mkJob({ chat_id: GROUP })).private, false);
    await opts.notifyOwner('hello');
    assert.deepEqual(rec.sendToOwner, ['hello']);
    assert.equal(opts.schedulesDir, '/tmp/sched-wiring-jobs');
  });

  test('定时任务的 onProgress 是 null（中间旁白不发到目的会话），turn 与档位照旧', async () => {
    const { rec, opts } = build();
    await opts.onFire(mkJob(), { notifyOnce: async () => {} });
    assert.equal(rec.runClaude.length, 1);
    const [key, prompt, priv, files, onProgress, runOpts] = rec.runClaude[0];
    assert.equal(key, 'sched:daily.json');
    assert.equal(prompt, 'SECRET-PROMPT');
    assert.equal(priv, true);
    assert.deepEqual(files, []);
    assert.equal(onProgress, null);
    assert.equal(runOpts.toolProfile, 'sched');
    assert.equal(runOpts.turn.private, true);
    assert.equal(rec.sendToChat.length, 1);
    assert.equal(rec.sendToChat[0].chatId, DM);
    assert.match(rec.sendToChat[0].text, /晨报/);
    assert.deepEqual(rec.flush, [`/out/sched:daily.json/true`], '结果发出后回传目录也要 flush');
  });

  test('补跑的任务：标题注明因重启补跑', async () => {
    const { rec, opts } = build();
    await opts.onFire({ ...mkJob(), _resumed: true }, {});
    assert.match(rec.sendToChat[0].text, /因重启补跑/);
  });

  test('失败自诊断：发往 owner 私聊的不围栏，发往群的围栏（删掉 fence 参数会被这条抓住）', async () => {
    const fail = (args) => { if (String(args[0]).startsWith('sched:')) throw new Error('model down'); return 'DIAG'; };
    const dm = build({ runClaudeImpl: fail });
    await dm.opts.onFire(mkJob(), {});
    assert.equal(dm.rec.failures.length, 1);
    const dmDiag = dm.rec.runClaude.find((a) => String(a[0]).startsWith('sched-diag:'));
    assert.ok(dmDiag, '走了自诊断');
    assert.ok(dmDiag[1].includes('SECRET-PROMPT'), 'legacy 私密档的自诊断带任务指令');
    assert.ok(!dmDiag[1].includes(FENCE_MARK), '发往 owner 私聊：不围栏');
    assert.equal(dmDiag[4], null);
    assert.equal(dmDiag[5].turn.private, true);

    const grp = build({ runClaudeImpl: fail });
    await grp.opts.onFire(mkJob({ chat_id: GROUP }), {});
    const grpDiag = grp.rec.runClaude.find((a) => String(a[0]).startsWith('sched-diag:'));
    assert.ok(grpDiag);
    assert.equal(grpDiag[5].turn.private, false, '发往群：非私密档');
    assert.ok(grpDiag[1].includes(FENCE_MARK), '发往群：任务指令与报错必须围起来');
    assert.equal(grp.rec.sendToOwner.length, 0, '模型失败走自诊断，不走「发送失败」通知');
  });

  test('缺 chat_id 的 prompt 任务：不调模型，经 ctx.notifyOnce 通知 owner 一次；没有 ctx 时直接私聊 owner', async () => {
    const a = build();
    const noted = [];
    await assert.rejects(a.opts.onFire(mkJob({ chat_id: undefined }), { notifyOnce: async (reason, text) => { noted.push({ reason, text }); } }), /缺 chat_id/);
    assert.equal(a.rec.runClaude.length, 0);
    assert.equal(noted.length, 1);
    assert.equal(noted[0].reason, 'nochat');
    assert.match(noted[0].text, /晨报/);
    assert.ok(!noted[0].text.includes('SECRET-PROMPT'));
    assert.equal(a.rec.sendToOwner.length, 0, '有 ctx 时走去重通知，不重复私聊');

    const b = build();
    await assert.rejects(b.opts.onFire(mkJob({ chat_id: undefined }), undefined), /缺 chat_id/);
    assert.equal(b.rec.sendToOwner.length, 1);
  });

  test('发送失败（三次）：不走自诊断，经 ctx.notifyOnce 通知；末 6 位会话 id，不含完整 chat_id', async () => {
    const { rec, opts, scope } = build();
    scope.sendToChat = async () => { throw new Error('net down'); };
    const noted = [];
    const origSetTimeout = globalThis.setTimeout;
    // fireJob 默认的重试间隔是真实的 5s + 30s；这里只替换 sleep 用的 setTimeout，让等待立即结束
    globalThis.setTimeout = (fn, ms, ...r) => origSetTimeout(fn, ms >= 1000 ? 0 : ms, ...r);
    try {
      await assert.rejects(opts.onFire(mkJob(), { notifyOnce: async (reason, text) => { noted.push({ reason, text }); } }), /发送失败/);
    } finally { globalThis.setTimeout = origSetTimeout; }
    assert.equal(rec.failures.length, 0);
    assert.equal(noted.length, 1);
    assert.equal(noted[0].reason, 'send');
    assert.ok(noted[0].text.includes(DM.slice(-6)));
    assert.ok(!noted[0].text.includes(DM));
  });

  test('action 型任务（set-model）不走 Claude，照旧切模型', async () => {
    const { rec, opts } = build();
    await opts.onFire({ _file: 'm.json', name: '切', action: 'set-model', model: 'fable', effort: 'low', chat_id: DM }, {});
    assert.equal(rec.runClaude.length, 0);
    assert.equal(rec.runtime.length, 1);
    assert.equal(rec.runtime[0].model, 'fable');
  });
});
