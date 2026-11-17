// BRIDGE-ACCT-1：主用账号额度用尽 / 登录失效时自动换备用账号。
// 全部用假的 claude 桩脚本（tmp 目录里生成），不调真实 CLI、不联网、不发飞书消息。
// 每个桩按「剧本」依次吐出 stream-json 行，并把每次调用（哪个 bin、argv）记进 calls.log——
// 断言的是真实子进程的启动次数与参数，不是源码文本。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-fallback-'));
const STUB_DIR = path.join(TMP, 'stub');
fs.mkdirSync(STUB_DIR, { recursive: true });

// 桩：读剧本 <name>.json（数组，按调用次序取，取完重复最后一条），记录调用，吐行，按 code 退出
fs.writeFileSync(path.join(STUB_DIR, 'stub.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const [name, ...args] = process.argv.slice(2);
const dir = ${JSON.stringify(STUB_DIR)};
if (args[0] === '--version') { process.stdout.write(name === 'broken' ? 'garbage\\n' : '2.9.9 (Claude Code)\\n'); process.exit(name === 'broken' ? 1 : 0); }
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify({ name, args }) + '\\n');
let script = [];
try { script = JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8')); } catch {}
const cf = path.join(dir, name + '.count');
let n = 0; try { n = Number(fs.readFileSync(cf, 'utf8')) || 0; } catch {}
fs.writeFileSync(cf, String(n + 1));
const r = script[Math.min(n, script.length - 1)] ?? { lines: [], code: 1, stderr: 'no script' };
process.stdin.resume();
process.stdin.on('data', () => {});
const go = () => {
  for (const l of r.lines ?? []) process.stdout.write(JSON.stringify(l) + '\\n');
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code ?? 0;
  setTimeout(() => process.exit(r.code ?? 0), 20);
};
process.stdin.on('end', () => setTimeout(go, r.delayMs ?? 0));
`);
const wrapper = (name) => {
  const f = path.join(STUB_DIR, name);
  fs.writeFileSync(f, `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(STUB_DIR, 'stub.mjs'))} ${name} "$@"\n`);
  fs.chmodSync(f, 0o755);
  return f;
};
const PRIMARY = wrapper('primary');
const FALLBACK = wrapper('fallback');
const BROKEN = wrapper('broken');

process.env.DATA_DIR = path.join(TMP, 'data');
process.env.WORKSPACE_DIR = path.join(TMP, 'ws');
process.env.GUEST_WORKSPACE_DIR = path.join(TMP, 'ws-guest');
process.env.FEISHU_TOOLS = 'false';
process.env.CLAUDE_BIN = PRIMARY;
process.env.CLAUDE_FALLBACK_BIN = FALLBACK;
process.env.CLAUDE_MAX_RETRIES = '2';
fs.mkdirSync(process.env.WORKSPACE_DIR, { recursive: true });
fs.mkdirSync(process.env.GUEST_WORKSPACE_DIR, { recursive: true });

const claude = await import('../src/claude.js');
const acct = await import('../src/account-fallback.js');
const { HEARTBEAT_KEY } = await import('../src/heartbeat.js');

// ---- 剧本素材 ----
const WEEKLY = "You've hit your weekly limit · resets 4am (Asia/Manila)";
const FIVE_HOUR = "You've hit your 5-hour limit · resets 9pm (Asia/Manila)";
const LOGIN = 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.';
const errorTurn = (text, sid = 'err-sess') => ({
  lines: [
    { type: 'system', subtype: 'init', session_id: sid },
    { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text }] } },
    { type: 'result', is_error: true, result: text, session_id: sid },
  ],
  code: 1,
});
const okTurn = (text = 'ok', sid = 'good-sess') => ({
  lines: [
    { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    { type: 'result', is_error: false, result: text, session_id: sid },
  ],
  code: 0,
});
// 已经调过工具（有副作用）之后才报额度
const errorAfterTool = (text) => ({
  lines: [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } },
    { type: 'result', is_error: true, result: text, session_id: 'err-sess' },
  ],
  code: 1,
});
const sessionNotFound = {
  lines: [{ type: 'result', is_error: true, result: 'No conversation found with session ID: old-sess', session_id: 'bogus-new' }],
  code: 1,
};

const setScript = (name, list) => {
  fs.writeFileSync(path.join(STUB_DIR, `${name}.json`), JSON.stringify(list));
  fs.rmSync(path.join(STUB_DIR, `${name}.count`), { force: true });
};
const calls = () => {
  try {
    return fs.readFileSync(path.join(STUB_DIR, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
const sessionsFile = () => {
  try { return JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'sessions.json'), 'utf8')); } catch { return {}; }
};

let clock = 1_000_000;
let notices = [];
let logs = [];
const fresh = ({ fallbackBin = FALLBACK, cooldownMin = 30, notify } = {}) => {
  fs.rmSync(path.join(STUB_DIR, 'calls.log'), { force: true });
  notices = [];
  logs = [];
  acct.configureAccountFallback({
    fallbackBin,
    cooldownMin,
    now: () => clock,
    log: (l) => logs.push(l),
    notify: notify ?? (async (t) => { notices.push(t); }),
  });
};
let seq = 0;
const chat = () => `oc_chat_${++seq}`;
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => { clock = 1_000_000; });

describe('A1 未设 CLAUDE_FALLBACK_BIN：与基线一致', () => {
  test('A1 差分：主用报额度 → 原样抛错、只起 1 次子进程、无通知、会话表照旧回写', async () => {
    fresh({ fallbackBin: '' });
    setScript('primary', [errorTurn(WEEKLY, 'sid-a1')]);
    setScript('fallback', [okTurn()]);
    const id = chat();
    await assert.rejects(claude.runClaude(id, 'hi', true), (e) => e.message === WEEKLY);
    assert.deepEqual(calls().map((c) => c.name), ['primary']);
    assert.equal(notices.length, 0);
    assert.equal(logs.length, 0, '未配置时不打 [account] 日志');
    assert.equal(sessionsFile()[id], 'sid-a1', '基线在 is_error 时也回写 session_id——未配置备用时保持不变');
    assert.equal(acct.accountStatusLine(), '', '/status 不加账号行');
  });

  test('A1 未配置时 configure 与 env 一样：空串 / 未设都视为关闭', () => {
    acct.configureAccountFallback({});
    assert.equal(acct.isAccountFallbackEnabled(), false);
    fresh({ fallbackBin: '   ' });
    assert.equal(acct.isAccountFallbackEnabled(), false);
  });
});

describe('A2 主用首个响应即报「账号不可用」→ 本轮在备用上成功', () => {
  for (const [label, text, kind] of [['周额度', WEEKLY, 'quota'], ['5 小时额度', FIVE_HOUR, 'quota'], ['登录失效', LOGIN, 'auth']]) {
    test(`A2 ${label}：用户只收到正常回复 + 一条切换通知`, async () => {
      fresh();
      setScript('primary', [errorTurn(text)]);
      setScript('fallback', [okTurn('fallback answer')]);
      const progress = [];
      const answer = await claude.runClaude(chat(), 'hi', true, [], (p) => progress.push(p));
      assert.equal(answer, 'fallback answer');
      assert.deepEqual(calls().map((c) => c.name), ['primary', 'fallback']);
      assert.deepEqual(progress, [], '不发「连接中断、x 秒后重试」之类的进度');
      await settle();
      assert.equal(notices.length, 1);
      assert.match(notices[0], /已自动切到备用账号/);
      assert.match(notices[0], /约 30 分钟后会再试主用账号/);
      assert.match(notices[0], kind === 'auth' ? /登录失效/ : /额度用完/);
      assert.ok(logs.includes(`[account] 主用不可用(${kind})，切到备用，冷却 30 分钟`), logs.join('\n'));
    });
  }

  test('A2 分类器：真实文案分 quota / auth，网络与瞬时刷新不算', () => {
    assert.equal(acct.classifyAccountError(WEEKLY), 'quota');
    assert.equal(acct.classifyAccountError(FIVE_HOUR), 'quota');
    assert.equal(acct.classifyAccountError('Claude AI usage limit reached|1763380800'), 'quota');
    assert.equal(acct.classifyAccountError(LOGIN), 'auth');
    assert.equal(acct.classifyAccountError('Not logged in · Please run /login'), 'auth');
    assert.equal(acct.classifyAccountError('API Error: 529 Overloaded'), null);
    assert.equal(acct.classifyAccountError('Connection error.'), null);
    assert.equal(acct.classifyAccountError('Failed to refresh OAuth token: another Claude Code process is refreshing it'), null);
    assert.equal(acct.classifyAccountError('No conversation found with session ID: x'), null, '会话不存在不是账号问题');
  });

  test('A2 stderr 里的报错也能识别（CLI 不出 result 直接退出）', async () => {
    fresh();
    setScript('primary', [{ lines: [], code: 1, stderr: 'Not logged in · Please run /login' }]);
    setScript('fallback', [okTurn('via stderr')]);
    assert.equal(await claude.runClaude(chat(), 'hi', true), 'via stderr');
    assert.deepEqual(calls().map((c) => c.name), ['primary', 'fallback']);
  });
});

describe('A3 冷却期内新轮直接走备用', () => {
  test('A3 私聊、定时任务、心跳各一轮：全部只起备用 bin', async () => {
    fresh();
    setScript('primary', [errorTurn(WEEKLY)]);
    setScript('fallback', [okTurn('x')]);
    await claude.runClaude(chat(), 'hi', true);
    fs.rmSync(path.join(STUB_DIR, 'calls.log'), { force: true });
    clock += 10 * 60_000; // 冷却 30 分钟内
    await claude.runClaude(chat(), 'dm', true);
    await claude.runClaude('sched:weekly.json', 'job', true, [], null, { toolProfile: 'sched' });
    await claude.runClaude(HEARTBEAT_KEY, 'beat', true, [], null, { toolProfile: 'heartbeat' });
    await claude.runClaude('guest:oc_g:ou_x', 'guest', false);
    assert.deepEqual(calls().map((c) => c.name), ['fallback', 'fallback', 'fallback', 'fallback']);
    assert.equal(notices.length, 1, '冷却期内不再通知');
  });

  test('A3 /status 行：备用（到几点再试主用）', async () => {
    fresh();
    setScript('primary', [errorTurn(WEEKLY)]);
    setScript('fallback', [okTurn()]);
    assert.match(acct.accountStatusLine(), /当前账号: 主用$/);
    await claude.runClaude(chat(), 'hi', true);
    assert.match(acct.accountStatusLine(), /当前账号: 备用（\d{2}:\d{2} 后再试主用）/);
  });
});

describe('A4 冷却到期', () => {
  test('A4 主用恢复 → 用主用并打「回到主用」', async () => {
    fresh();
    setScript('primary', [errorTurn(WEEKLY), okTurn('primary back')]);
    setScript('fallback', [okTurn()]);
    await claude.runClaude(chat(), 'hi', true);
    clock += 31 * 60_000;
    fs.rmSync(path.join(STUB_DIR, 'calls.log'), { force: true });
    assert.equal(await claude.runClaude(chat(), 'again', true), 'primary back');
    assert.deepEqual(calls().map((c) => c.name), ['primary']);
    assert.ok(logs.includes('[account] 冷却到期，试主用'));
    assert.ok(logs.includes('[account] 回到主用'));
    assert.match(acct.accountStatusLine(), /当前账号: 主用$/);
  });

  test('A4 主用仍不可用 → 本轮自动落到备用成功，且不重复通知；再次进入冷却', async () => {
    fresh();
    setScript('primary', [errorTurn(WEEKLY), errorTurn(WEEKLY)]);
    setScript('fallback', [okTurn('fb1'), okTurn('fb2')]);
    await claude.runClaude(chat(), 'hi', true);
    clock += 31 * 60_000;
    fs.rmSync(path.join(STUB_DIR, 'calls.log'), { force: true });
    assert.equal(await claude.runClaude(chat(), 'again', true), 'fb2');
    assert.deepEqual(calls().map((c) => c.name), ['primary', 'fallback']);
    await settle();
    assert.equal(notices.length, 1, '同一次连续备用期只通知一次');
    assert.equal(logs.filter((l) => l.startsWith('[account] 主用不可用')).length, 2);
    // 再次冷却：下一轮直接备用
    fs.rmSync(path.join(STUB_DIR, 'calls.log'), { force: true });
    clock += 5 * 60_000;
    await claude.runClaude(chat(), 'third', true);
    assert.deepEqual(calls().map((c) => c.name), ['fallback']);
  });

  test('A4 回到主用后下次再切才再发通知', async () => {
    fresh();
    setScript('primary', [errorTurn(WEEKLY), okTurn(), errorTurn(LOGIN)]);
    setScript('fallback', [okTurn()]);
    await claude.runClaude(chat(), '1', true);
    clock += 31 * 60_000;
    await claude.runClaude(chat(), '2', true);
    await claude.runClaude(chat(), '3', true);
    await settle();
    assert.equal(notices.length, 2);
  });

  test('A4 冷却前已在主用上起跑的轮，冷却期间成功也不算「回到主用」', async () => {
    fresh();
    setScript('primary', [{ ...okTurn('slow'), delayMs: 400 }, errorTurn(WEEKLY)]);
    setScript('fallback', [okTurn()]);
    const slow = claude.runClaude(chat(), 'slow', true);
    await new Promise((r) => setTimeout(r, 100));
    await claude.runClaude(chat(), 'fast', true); // 第 2 次主用调用报额度 → 进冷却
    assert.equal(await slow, 'slow');
    assert.ok(!logs.includes('[account] 回到主用'));
    assert.match(acct.accountStatusLine(), /备用/);
  });
});

describe('A5 备用也不可用', () => {
  test('A5 主用、备用都报额度 → 抛错，子进程恰好 2 次，不来回切', async () => {
    fresh();
    setScript('primary', [errorTurn(WEEKLY)]);
    setScript('fallback', [errorTurn(FIVE_HOUR)]);
    await assert.rejects(claude.runClaude(chat(), 'hi', true), (e) => e.message === FIVE_HOUR);
    assert.deepEqual(calls().map((c) => c.name), ['primary', 'fallback']);
    assert.ok(logs.includes('[account] 备用也不可用(quota)'));
  });

  test('A5 冷却期内备用报登录失效 → 只起 1 次（不回主用），照现有路径抛错', async () => {
    fresh();
    setScript('primary', [errorTurn(WEEKLY)]);
    setScript('fallback', [okTurn(), errorTurn(LOGIN)]);
    await claude.runClaude(chat(), 'hi', true);
    fs.rmSync(path.join(STUB_DIR, 'calls.log'), { force: true });
    await assert.rejects(claude.runClaude(chat(), 'again', true), (e) => e.message === LOGIN);
    assert.deepEqual(calls().map((c) => c.name), ['fallback']);
    assert.ok(logs.includes('[account] 备用也不可用(auth)'));
  });

  test('A5 备用会话不存在 + 无 --resume 重试仍报额度 → 上界 3 次', async () => {
    fresh();
    const id = chat();
    setScript('primary', [okTurn('seed', 'old-sess'), errorTurn(WEEKLY)]);
    setScript('fallback', [sessionNotFound, errorTurn(WEEKLY)]);
    await claude.runClaude(id, 'seed', true);
    fs.rmSync(path.join(STUB_DIR, 'calls.log'), { force: true });
    await assert.rejects(claude.runClaude(id, 'hi', true));
    assert.deepEqual(calls().map((c) => c.name), ['primary', 'fallback', 'fallback']);
  });
});

describe('A6 已有输出后才报额度', () => {
  test('A6 不重放，提示语含指引，后续轮走备用', async () => {
    fresh();
    setScript('primary', [errorAfterTool(WEEKLY)]);
    setScript('fallback', [okTurn('next on fallback')]);
    await assert.rejects(claude.runClaude(chat(), 'hi', true), (e) => {
      assert.match(e.message, /已切到备用账号，请再发一次，或说“继续”/);
      assert.ok(!e.message.includes(WEEKLY), '提示语不带原始错误串');
      return true;
    });
    assert.deepEqual(calls().map((c) => c.name), ['primary'], '不重放 prompt');
    fs.rmSync(path.join(STUB_DIR, 'calls.log'), { force: true });
    assert.equal(await claude.runClaude(chat(), 'continue', true), 'next on fallback');
    assert.deepEqual(calls().map((c) => c.name), ['fallback']);
  });

  test('A6 已发出进度消息（用户看见了输出）也算已有输出', async () => {
    fresh();
    setScript('primary', [{
      lines: [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'step 1' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'step 2' }] } },
        { type: 'result', is_error: true, result: WEEKLY, session_id: 'e' },
      ],
      code: 1,
    }]);
    setScript('fallback', [okTurn()]);
    const progress = [];
    await assert.rejects(claude.runClaude(chat(), 'hi', true, [], (p) => progress.push(p)), /已切到备用账号/);
    assert.deepEqual(progress, ['step 1']);
    assert.deepEqual(calls().map((c) => c.name), ['primary']);
  });
});

describe('A7 取消的轮不切换', () => {
  test('A7 /cancel 打断主用 → 不起备用、不进冷却、不通知', async () => {
    fresh();
    setScript('primary', [{ ...errorTurn(WEEKLY), delayMs: 3000 }]);
    setScript('fallback', [okTurn()]);
    const id = chat();
    const run = claude.runClaude(id, 'hi', true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(claude.cancelRun(id), true);
    await assert.rejects(run, (e) => e.cancelled === true);
    assert.deepEqual(calls().map((c) => c.name), ['primary']);
    await settle();
    assert.equal(notices.length, 0);
    assert.match(acct.accountStatusLine(), /当前账号: 主用$/);
  });
});

describe('A8 备用报会话不存在', () => {
  test('A8 不带 --resume 重试一次成功；出错结果的会话 id 没被保存', async () => {
    fresh();
    const id = chat();
    setScript('primary', [okTurn('seed', 'old-sess'), errorTurn(WEEKLY, 'quota-sess')]);
    setScript('fallback', [sessionNotFound, okTurn('fresh answer', 'new-sess')]);
    await claude.runClaude(id, 'seed', true);
    assert.equal(sessionsFile()[id], 'old-sess');
    fs.rmSync(path.join(STUB_DIR, 'calls.log'), { force: true });
    const answer = await claude.runClaude(id, 'hi', true);
    assert.equal(answer, 'fresh answer');
    const c = calls();
    assert.deepEqual(c.map((x) => x.name), ['primary', 'fallback', 'fallback']);
    assert.ok(c[0].args.includes('--resume'), '主用照常带 --resume');
    assert.ok(c[1].args.includes('--resume'), '备用重试照常带 --resume');
    assert.ok(!c[2].args.includes('--resume'), '会话不存在后只这一次不带 --resume');
    assert.equal(sessionsFile()[id], 'new-sess', '出错结果里的 bogus-new / quota-sess 没被写回');
  });

  test('A8 出错结果的会话 id 不回写（配置了备用时）', async () => {
    fresh();
    const id = chat();
    setScript('primary', [okTurn('seed', 'old-sess'), errorTurn(WEEKLY, 'quota-sess')]);
    setScript('fallback', [errorTurn(WEEKLY, 'fb-err-sess')]);
    await claude.runClaude(id, 'seed', true);
    await assert.rejects(claude.runClaude(id, 'hi', true));
    assert.equal(sessionsFile()[id], 'old-sess', 'quota-sess / fb-err-sess 都不得写回');
  });

  test('A8 主用报会话不存在不走这条（只对备用 bin）', async () => {
    fresh();
    setScript('primary', [sessionNotFound]);
    setScript('fallback', [okTurn()]);
    await assert.rejects(claude.runClaude(chat(), 'hi', true), /No conversation found/);
    assert.deepEqual(calls().map((c) => c.name), ['primary']);
  });
});

describe('A9 通知', () => {
  test('A9 发送失败不影响回复；文案不含原始错误串', async () => {
    let tried = 0;
    fresh({ notify: async () => { tried++; throw new Error('feishu down'); } });
    setScript('primary', [errorTurn(WEEKLY)]);
    setScript('fallback', [okTurn('still fine')]);
    assert.equal(await claude.runClaude(chat(), 'hi', true), 'still fine');
    await settle();
    assert.equal(tried, 1);
  });

  test('A9 一次备用期一条，且不带原始错误串', async () => {
    fresh();
    setScript('primary', [errorTurn(WEEKLY)]);
    setScript('fallback', [okTurn()]);
    await claude.runClaude(chat(), '1', true);
    await claude.runClaude(chat(), '2', true);
    await settle();
    assert.equal(notices.length, 1);
    assert.ok(!notices[0].includes('weekly') && !notices[0].includes('resets'));
    assert.equal(acct.accountNoticeText('quota', 30), '主用账号额度用完，已自动切到备用账号，约 30 分钟后会再试主用账号。');
  });

  test('A9 日志闭集：不含原始错误串', async () => {
    fresh();
    setScript('primary', [errorTurn(WEEKLY)]);
    setScript('fallback', [errorTurn(LOGIN)]);
    await assert.rejects(claude.runClaude(chat(), 'hi', true));
    const allowed = /^\[account\] (主用不可用\((quota|auth)\)，切到备用，冷却 \d+ 分钟|冷却到期，试主用|回到主用|备用也不可用\((quota|auth)\))$/;
    for (const l of logs) assert.match(l, allowed);
  });
});

describe('A10 /status 与启动自检', () => {
  test('A10 启动自检：备用 bin --version 失败 → 只告警、视为未配置', async () => {
    fresh({ fallbackBin: BROKEN });
    const out = [];
    const r = acct.verifyFallbackAtStartup({ log: (l) => out.push(l), warn: (l) => out.push(l) });
    assert.equal(r.ok, false);
    assert.equal(acct.isAccountFallbackEnabled(), false);
    assert.ok(out.some((l) => l.startsWith('[config] ⚠️')));
    assert.equal(acct.accountStatusLine(), '');
    setScript('primary', [errorTurn(WEEKLY)]);
    await assert.rejects(claude.runClaude(chat(), 'hi', true), (e) => e.message === WEEKLY);
    assert.deepEqual(calls().map((c) => c.name), ['primary']);
  });

  test('A10 启动自检：备用 bin 不存在 → 视为未配置', () => {
    fresh({ fallbackBin: path.join(TMP, 'no-such-claude') });
    const out = [];
    acct.verifyFallbackAtStartup({ log: (l) => out.push(l), warn: (l) => out.push(l) });
    assert.equal(acct.isAccountFallbackEnabled(), false);
  });

  test('A10 启动自检通过 → 打「备用 claude CLI：路径 (版本)」', () => {
    fresh();
    const out = [];
    const r = acct.verifyFallbackAtStartup({ log: (l) => out.push(l), warn: (l) => out.push(l) });
    assert.equal(r.ok, true);
    assert.ok(out.includes(`[config] 备用 claude CLI：${FALLBACK} (2.9.9)`), out.join('\n'));
    assert.equal(acct.isAccountFallbackEnabled(), true);
  });

  test('A10 未配置时自检什么也不做', () => {
    fresh({ fallbackBin: '' });
    const out = [];
    const r = acct.verifyFallbackAtStartup({ log: (l) => out.push(l), warn: (l) => out.push(l) });
    assert.equal(r, null);
    assert.deepEqual(out, []);
  });

  test('A10 冷却时长：缺省 30、范围 1–720，非法值用缺省并告警', () => {
    const w = [];
    const p = (v) => acct.parseCooldownMin({ CLAUDE_FALLBACK_COOLDOWN_MIN: v }, (l) => w.push(l));
    assert.equal(p(undefined), 30);
    assert.equal(p(''), 30);
    assert.equal(p('1'), 1);
    assert.equal(p('720'), 720);
    assert.equal(w.length, 0);
    assert.equal(p('0'), 30);
    assert.equal(p('721'), 30);
    assert.equal(p('abc'), 30);
    assert.equal(p('1.5'), 30);
    assert.equal(w.length, 4);
    assert.ok(w.every((l) => l.startsWith('[config] ⚠️')));
  });
});

describe('A11 并发', () => {
  test('A11 两个会话同时撞到额度错误 → 状态一致、通知一条、两轮都在备用上成功', async () => {
    fresh();
    setScript('primary', [{ ...errorTurn(WEEKLY), delayMs: 150 }]);
    setScript('fallback', [okTurn('fb')]);
    const [a, b] = await Promise.all([claude.runClaude(chat(), 'a', true), claude.runClaude(chat(), 'b', true)]);
    assert.equal(a, 'fb');
    assert.equal(b, 'fb');
    await settle();
    assert.equal(notices.length, 1);
    assert.equal(logs.filter((l) => l.startsWith('[account] 主用不可用')).length, 1, '第二个撞上时已在冷却期，不重复切换');
    const names = calls().map((c) => c.name).sort();
    assert.deepEqual(names, ['fallback', 'fallback', 'primary', 'primary']);
    assert.match(acct.accountStatusLine(), /备用/);
  });
});

describe('A10 /status 接线', () => {
  test('A10 sessionInfo（/status 正文）带当前账号行；未配置时不带', async () => {
    fresh();
    setScript('primary', [errorTurn(WEEKLY)]);
    setScript('fallback', [okTurn()]);
    const id = chat();
    assert.match(claude.sessionInfo(id, true), /\n- 当前账号: 主用$/);
    await claude.runClaude(id, 'hi', true);
    assert.match(claude.sessionInfo(id, true), /\n- 当前账号: 备用（\d{2}:\d{2} 后再试主用）$/);
    fresh({ fallbackBin: '' });
    assert.doesNotMatch(claude.sessionInfo(id, true), /当前账号/);
  });
});
