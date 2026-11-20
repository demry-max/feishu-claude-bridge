// BRIDGE-PRIV-3 R1：command 模式不变（D1 的完整强度）。同一组任务在三份临时目录里各跑一遍：不传 approvalMode / 'command' / 'bogus'，
// 都另传一个会记录调用的 sendApprovalCard；逐拍比较 onFire 序列、data/ 下全部文件字节、notifyOwner 全文、/tasks 回复与日志：三份完全相等，发卡 0 次。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startScheduler } = await import('../src/scheduler.js');
const { tasksCommandReply } = await import('../src/sched-approval.js');

const CHAT = 'oc_0123456789abcdef0123';
const CHAT2 = 'oc_ffff456789abcdef9999';
const DM = 'oc_dddd456789abcdef0000';
const NOW = new Date(2026, 10, 20, 9, 30, 0);
const KEY1 = 'a1'.repeat(32) + '\n';
const KEY2 = 'b2'.repeat(32) + '\n';
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

async function scenario(t, mode) {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW.getTime() });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'priv3-cmd-'));
  const jobs = path.join(tmp, 'jobs'); const data = path.join(tmp, 'data'); const key = path.join(tmp, 'key');
  fs.mkdirSync(jobs, { recursive: true }); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(key, KEY1, { mode: 0o600 });
  const w = (n, j) => fs.writeFileSync(path.join(jobs, n), typeof j === 'string' ? j : JSON.stringify(j));
  w('g1.json', { name: '晨报', when: '0 10 * * *', prompt: 'P1', chat_id: CHAT, enabled: true }); // 发往群
  w('g2.json', { name: '一次', when: '2026-11-20T09:45', prompt: 'P2', chat_id: CHAT2, enabled: true }); // 发往群，目的地未知
  w('g3.json', { name: '晚报', when: '*/5 * * * *', prompt: 'P3', chat_id: CHAT, model: 'opus', enabled: true }); // 带 model
  w('dm.json', { name: '私', when: '0 10 * * *', prompt: 'D', chat_id: DM, enabled: true }); // 发往 owner 私聊
  w('dmonce.json', { name: '私一次', when: '2026-11-20T09:00', prompt: 'D2', chat_id: DM, enabled: true }); // 启动补跑（已过点）
  w('nochat.json', { name: '无会话', when: '*/10 * * * *', prompt: 'N', enabled: true });
  w('badwhen.json', { name: '坏时间', when: 'nonsense', prompt: 'X', chat_id: DM, enabled: true }); // 坏 when
  w('badchat.json', { name: '坏会话', when: '0 10 * * *', prompt: 'X', chat_id: 'oc_bad id', enabled: true }); // 坏 chat_id
  w('act.json', { name: '切模型', when: '0 10 * * *', action: 'set-model', model: 'sonnet', chat_id: CHAT, enabled: true }); // set-model
  w('bad.json', '{not json');
  w('off.json', { name: '停', when: '* * * * *', prompt: 'O', chat_id: CHAT, enabled: false });
  const out = [];
  const log = (k, v) => out.push([k, typeof v === 'string' ? v : JSON.stringify(v)]);
  const files = () => Object.fromEntries(fs.readdirSync(data).sort().map((f) => [f, fs.readFileSync(path.join(data, f), 'utf8')]));
  const cardCalls = [];
  const mk = () => {
    const opts = {
      schedulesDir: jobs, stateFile: path.join(data, 'schedule-state.json'), requireApproval: true, approvalKeyFile: key,
      turnFor: (_s, j) => ({ private: j.chat_id === DM, destUnknown: j.chat_id === CHAT2 }),
      notifyOwner: async (x) => log('note', x),
      onFire: async (j, ctx) => log('fire', { f: j._file, p: j.prompt, a: j.action ?? null, ctx: ctx ? Object.keys(ctx).sort() : null }),
      sendApprovalCard: async (i) => { cardCalls.push(i.file); return true; },
    };
    if (mode !== '<unset>') opts.approvalMode = mode;
    return startScheduler(opts);
  };
  const reply = (h, text, busy = 0) => log('reply', tasksCommandReply({ text, candidates: h.approvalCandidates(), store: h.approvalStore, busy, log: (m) => log('rlog', m), mode: h.approvalMode, resend: (c) => h.resendApprovalCard?.(c) }));
  const adv = async (ms) => { t.mock.timers.tick(ms); await settle(); };
  let h = mk();
  try {
    await settle(); log('files0', files()); log('cands0', h.approvalCandidates());
    await adv(30_000); log('files1', files());
    const code = (f) => h.approvalCandidates().find((c) => c.file === f).code;
    reply(h, `/tasks approve ${code('g1.json')}`, 2); // 忙时
    reply(h, `/tasks approve ${code('g1.json')}`);
    reply(h, `/tasks approve ${code('g1.json')}`); // 重复
    reply(h, '/tasks reject 一次');
    reply(h, '/tasks approve 晚报'); // 按名
    reply(h, '/tasks approve nothing'); // 找不到
    reply(h, '/tasks approve'); // 用法
    reply(h, `/tasks approve ${code('act.json')}`); // 动作任务
    log('cands1', h.approvalCandidates()); log('files2', files());
    w('g3.json', { name: '晚报', when: '*/5 * * * *', prompt: 'P3 changed', chat_id: CHAT, model: 'opus', enabled: true });
    await adv(30_000); // 改内容后重新通知
    reply(h, '/tasks approve 晚报');
    reply(h, `/tasks approve ${code('g3.json')}`);
    for (let i = 0; i < 70; i++) { await adv(30_000); log('tick', files()['schedule-state.json'] ?? null); } // 逐拍：到点执行
    log('files3', files()); log('cands2', h.approvalCandidates());
    h.stop(); await settle();
    fs.writeFileSync(key, KEY2, { mode: 0o600 }); // 换密钥重启：作废说明
    h = mk(); await settle(); await adv(30_000);
    log('files4', files()); log('cands3', h.approvalCandidates());
    reply(h, `/tasks reject ${code('g1.json')}`);
    for (let i = 0; i < 12; i++) { await adv(30_000); log('tick', files()['schedule-state.json'] ?? null); }
    log('files5', files());
  } finally { h.stop(); await settle(); fs.rmSync(tmp, { recursive: true, force: true }); }
  return { out, cardCalls };
}

describe('D1 command 模式不变（完整强度）', () => {
  test('不传 / command / bogus 三份完全相等；sendApprovalCard 一次都不调', async (t) => {
    const runs = {};
    for (const mode of ['<unset>', 'command', 'bogus']) {
      await t.test(`approvalMode=${mode}`, async (tt) => { runs[mode] = await scenario(tt, mode); });
    }
    const base = runs['<unset>'];
    const kinds = base.out.reduce((m, [k]) => ((m[k] = (m[k] ?? 0) + 1), m), {});
    assert.ok(kinds.fire >= 5 && kinds.note >= 3 && kinds.reply >= 10, `场景要有内容：${JSON.stringify(kinds)}`);
    assert.ok(base.out.some(([k, v]) => k === 'note' && v.includes('/tasks approve')), '通知里有确认码用法');
    for (const mode of ['command', 'bogus']) {
      assert.deepEqual(runs[mode].out, base.out, `${mode} 与不传逐拍相同`);
    }
    for (const mode of Object.keys(runs)) assert.deepEqual(runs[mode].cardCalls, [], `${mode}：发卡 0 次`);
  });
});
