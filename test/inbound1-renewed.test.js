// BRIDGE-INBOUND-1（S30）：「原会话已失效，这一轮在新会话里回答」的附注——文字照旧带，语音朗读与每日会话原话记录不要。
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound1-renewed-'));
process.env.WORKSPACE_DIR = path.join(TMP, 'ws');
process.env.GUEST_WORKSPACE_DIR = path.join(TMP, 'gws');
process.env.DATA_DIR = path.join(TMP, 'data');
for (const d of [process.env.WORKSPACE_DIR, process.env.GUEST_WORKSPACE_DIR, process.env.DATA_DIR]) fs.mkdirSync(d, { recursive: true });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力而为 */ } });

const { SESSION_RENEWED_NOTE, stripRenewedNote } = await import('../src/renewed-note.js');
const { voiceText } = await import('../src/outbound.js');
const ds = await import('../src/daily-session.js');
const claude = await import('../src/claude.js?inbound1-renewed');
const NOTE = SESSION_RENEWED_NOTE;

describe('R 换新附注不进语音与原话', () => {
  test('R1 stripRenewedNote：只去末尾「空一行 + 附注」；中间、缺空行、前后多字都原样；非字符串不抛', () => {
    assert.equal(stripRenewedNote(`答案\n\n${NOTE}`), '答案');
    assert.equal(stripRenewedNote(`${NOTE}`), NOTE, '没有前导空行的整句不动');
    assert.equal(stripRenewedNote(`答案\n${NOTE}`), `答案\n${NOTE}`, '只有一个换行不动');
    assert.equal(stripRenewedNote(`答案\n\n${NOTE}\n\n后面还有`), `答案\n\n${NOTE}\n\n后面还有`, '不在末尾不动');
    assert.equal(stripRenewedNote(`答案\n\n${NOTE}。`), `答案\n\n${NOTE}。`);
    assert.equal(stripRenewedNote('普通答案'), '普通答案');
    assert.equal(stripRenewedNote(''), '');
    assert.equal(stripRenewedNote(null), '');
    assert.equal(stripRenewedNote(undefined), '');
    assert.equal(stripRenewedNote(42), '42');
  });

  test('R2 voiceText：带附注与不带附注的朗读文本相同；附注的关键字不出现；其余处理照旧（代码块、markdown、截断）', () => {
    const body = '这是答案，**加粗**见 [链接](http://x.y)。```\ncode\n```';
    assert.equal(voiceText(`${body}\n\n${NOTE}`), voiceText(body));
    assert.ok(!voiceText(`${body}\n\n${NOTE}`).includes('会话已失效'));
    assert.equal(voiceText(body), '这是答案，加粗见 链接。（代码块略）');
    assert.ok(voiceText('字'.repeat(5000)).length <= 500);
    assert.equal(voiceText(`\n\n${NOTE}`), '', '只剩附注时朗读为空（sendVoice 因此不发语音）');
  });

  test('R3 每日会话：成功轮记下的原话不含附注（不切的轮次走 wrapRecord→recordRound；换新轮次与它共用 recordRound）', async () => {
    const dataDir = path.join(TMP, 'dsdata'); const wsDir = path.join(TMP, 'dsws');
    fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(wsDir, { recursive: true });
    const sessions = { k: 's-1' };
    const now = new Date(2026, 10, 17, 9).getTime();
    const d = ds.createDailySession({
      config: ds.dailySessionConfig({ DAILY_SESSION: 'on' }),
      dataDir, workspaceDir: wsDir,
      enqueue: (k, task) => task(),
      runClaude: async () => '',
      getSessionId: (k) => sessions[k] ?? null,
      restoreSession: () => true, resetSession: () => {}, isRunning: () => false, cancelRun: () => true, abortRetries: () => {},
      isDraining: () => false, log: () => {}, now: () => now,
      timers: { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} },
    });
    const toolTurn = { runClaude: async () => `第一轮答案\n\n${NOTE}`, withReceipt: (a) => a };
    const route = { lane: 'main', prompt: '问一句' };
    d.beforeTurn({ sessionKey: 'k', prompt: '问一句', text: '问一句', isOwner: true, chatType: 'p2p', confirmed: false, queued: false, merged: null, route, toolTurn });
    const answer = await toolTurn.runClaude('k', 'p', true, [], null, {});
    assert.ok(answer.includes(NOTE), '返回给调用方（文字回复）的答案照旧带附注');
    const file = path.join(dataDir, 'daily-session', `rounds-${ds.keyHash('k')}.jsonl`);
    const rounds = ds.readRounds(file);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].answer, '第一轮答案');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('会话已失效'));
  });

  test('R4 claude.js 导出的常量与 renewed-note.js 是同一个；claude.js 与 daily-session.js 没有互相 import', () => {
    assert.equal(claude.SESSION_RENEWED_NOTE, NOTE);
    const dsSrc = fs.readFileSync(new URL('../src/daily-session.js', import.meta.url), 'utf8');
    assert.ok(!/from '\.\/claude\.js'/.test(dsSrc), 'daily-session.js 不 import claude.js');
    const noteSrc = fs.readFileSync(new URL('../src/renewed-note.js', import.meta.url), 'utf8');
    assert.ok(!/^\s*import\s/m.test(noteSrc), 'renewed-note.js 不 import 任何模块');
    const claudeSrc = fs.readFileSync(new URL('../src/claude.js', import.meta.url), 'utf8');
    assert.ok(!claudeSrc.includes("'（提示：原来的会话已失效"), 'claude.js 里没有第二份附注原文');
  });
});
