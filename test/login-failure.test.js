// LW-1：Claude 登录故障收口。
//   (a) 定时任务失败命中登录故障 → 跳过 haiku 自诊断，直接发确定性修复步骤
//   (b) 私聊失败回复：匹配器覆盖全部真实签名 + 钥匙串分支；瞬时刷新不算登录失效
//   (c) 入站 [msg] 日志行先脱敏再截断（bms_sk_… 明文曾被原样记进日志）
// 签名清单与 ~/claude-login-watchdog 共用同一份夹具内容（test/fixtures/claude-auth-signatures.js，两边逐字节相同）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  classifyClaudeError, isClaudeLoginFailure, claudeFailureReply, handleScheduledFailure,
  formatInboundLog, isLoginKeychainLocked, loginFixLines, loginFixVariant, redact, UNLOCK_KEYCHAIN_CMD,
} from '../src/outbound.js';
import { CLAUDE_AUTH_SIGNATURES } from './fixtures/claude-auth-signatures.js';

// 假密钥：形态与真 BMS Key 相同（bms_sk_ + 40 位 hex），值是编的
const FAKE_BMS_KEY = `bms_sk_${'0123456789abcdef'.repeat(3).slice(0, 40)}`;
const FAKE_BODY = FAKE_BMS_KEY.slice('bms_sk_'.length);

const keychainStub = (value) => {
  const calls = [];
  const fn = async () => { calls.push(1); return value; };
  fn.calls = calls;
  return fn;
};

describe('登录故障签名（共享夹具）', () => {
  for (const { text, kind, source } of CLAUDE_AUTH_SIGNATURES) {
    test(`${kind} ← ${text.slice(0, 60)}（${source}）`, () => {
      assert.equal(classifyClaudeError(text), kind);
    });
  }
  test('登录故障的修复方向与夹具 fix 字段一致（组织停用订阅 → subscription，其余 → relogin）', () => {
    for (const { text, kind, fix } of CLAUDE_AUTH_SIGNATURES) {
      if (kind === 'auth') assert.equal(loginFixVariant(text), fix ?? 'relogin', text);
    }
  });

  test('只有 auth / keychain 算登录故障', () => {
    for (const { text, kind } of CLAUDE_AUTH_SIGNATURES) {
      assert.equal(isClaudeLoginFailure(classifyClaudeError(text)), kind === 'auth' || kind === 'keychain', text);
    }
  });
});

describe('(b) 私聊失败回复', () => {
  const REAL_AUTH = CLAUDE_AUTH_SIGNATURES.filter((s) => s.kind === 'auth');

  test('每条鉴权签名都给修复步骤，而不是原样甩报错（旧匹配器漏了 Not logged in / OAuth session expired）', async () => {
    for (const { text: msg, fix } of REAL_AUTH) {
      const r = await claudeFailureReply(msg, { checkKeychain: keychainStub(false) });
      assert.ok(!r.startsWith('⚠️ Claude 调用失败'), `${msg} 被当成普通错误了`);
      assert.ok(r.includes('claude auth login'), msg);
      assert.match(r, fix === 'subscription' ? /订阅访问被组织停用/ : /Claude 登录失效了/, msg);
    }
  });

  test('钥匙串锁住 → 写明要本人在 Mac 前输入登录密码 + 解锁命令原文', async () => {
    const r = await claudeFailureReply('Not logged in · Please run /login', { checkKeychain: keychainStub(true) });
    assert.match(r, /登录钥匙串被锁住/);
    assert.match(r, /需要你本人在 Mac 前输入登录密码/);
    assert.ok(r.includes(UNLOCK_KEYCHAIN_CMD));
    assert.ok(r.includes('claude auth login'));
  });

  test('「Keychain is not writable」直接走钥匙串分支，不用再查', async () => {
    const stub = keychainStub(false);
    const r = await claudeFailureReply('macOS Keychain is not writable (-25293)', { checkKeychain: stub });
    assert.ok(r.includes(UNLOCK_KEYCHAIN_CMD));
    assert.equal(stub.calls.length, 0);
  });

  test('钥匙串状态查不到 → 给登录步骤，并写明登录报钥匙串错误时先解锁', async () => {
    const r = await claudeFailureReply('Not logged in · Please run /login', { checkKeychain: keychainStub(null) });
    assert.ok(r.includes('claude auth login'));
    assert.ok(r.includes(UNLOCK_KEYCHAIN_CMD));
  });

  test('瞬时刷新不算登录失效：不查钥匙串、不叫人重新登录', async () => {
    const stub = keychainStub(true);
    const r = await claudeFailureReply('Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh', { checkKeychain: stub });
    assert.match(r, /瞬时状态，不是登录失效/);
    assert.ok(!r.includes('claude auth login'));
    assert.equal(stub.calls.length, 0);
  });

  test('非登录错误照旧原样报；「401」字样出现在别处不误判', async () => {
    assert.equal(await claudeFailureReply('API Error: 529 Overloaded', { checkKeychain: keychainStub(false) }), '⚠️ Claude 调用失败：API Error: 529 Overloaded');
    assert.equal(await claudeFailureReply('工单 WO-00401 找不到', { checkKeychain: keychainStub(false) }), '⚠️ Claude 调用失败：工单 WO-00401 找不到');
  });

  test('修复话术不写概率话术', () => {
    for (const keychainLocked of [true, false, null]) {
      const t = loginFixLines({ kind: 'auth', keychainLocked }).join('\n');
      for (const w of ['可能', '也许', '或许', '大概']) assert.ok(!t.includes(w), w);
    }
  });
});

describe('返工 R1：2.1.280 -p 真实鉴权文案（复审 HIGH-1）', () => {
  const REVOKED_P = 'Your account does not have access to Claude. Please login again or contact your administrator.';
  const ORG_DISABLED = 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';

  test('(b) 吊销令牌（-p）→ 重新登录的修复步骤，不再原样甩报错', async () => {
    const r = await claudeFailureReply(REVOKED_P, { checkKeychain: keychainStub(false) });
    assert.match(r, /Claude 登录失效了/);
    assert.ok(r.includes('claude auth login'));
    assert.ok(!r.includes('联系组织管理员'));
  });

  test('(b) 组织停用订阅 → 找管理员 / 查订阅，不查钥匙串、不叫人只重新登录', async () => {
    const stub = keychainStub(true);
    const r = await claudeFailureReply(ORG_DISABLED, { checkKeychain: stub });
    assert.match(r, /订阅访问被组织停用/);
    assert.match(r, /联系组织管理员恢复访问，或到 claude\.ai 检查订阅状态/);
    assert.ok(!r.includes(UNLOCK_KEYCHAIN_CMD));
    assert.equal(stub.calls.length, 0);
  });

  test('(a) 定时任务遇到吊销令牌 / 组织停用：都不跑自诊断', async () => {
    for (const err of [REVOKED_P, ORG_DISABLED]) {
      const diagCalls = [];
      const sent = [];
      const out = await handleScheduledFailure({
        err, jobName: 'job', send: async (t) => { sent.push(t); },
        runDiagnosis: async () => { diagCalls.push(1); return 'x'; }, checkKeychain: keychainStub(false), log: () => {},
      });
      assert.equal(diagCalls.length, 0, err);
      assert.equal(out.diagnosed, false);
      assert.match(sent[0], /已跳过自诊断/);
    }
  });

  test('(a) 组织停用的定时任务话术是找管理员', async () => {
    const sent = [];
    await handleScheduledFailure({
      err: ORG_DISABLED, jobName: 'job', send: async (t) => { sent.push(t); },
      runDiagnosis: async () => 'x', checkKeychain: keychainStub(true), log: () => {},
    });
    assert.match(sent[0], /联系组织管理员/);
    assert.ok(!sent[0].includes(UNLOCK_KEYCHAIN_CMD));
  });

  test('套餐问题（Opus 不在 Pro 套餐里）不是登录失效，原样报', async () => {
    const msg = 'Claude Opus is not available with the Claude Pro plan. If you have updated your subscription plan recently, run /logout and /login for the plan to take effect.';
    assert.equal(await claudeFailureReply(msg, { checkKeychain: keychainStub(false) }), `⚠️ Claude 调用失败：${msg}`);
  });
});

describe('(a) 定时任务失败', () => {
  const run = async (err, { keychain = false, diag = async () => '1) 网络 2) … 3) …' } = {}) => {
    const sent = [];
    const logs = [];
    const diagCalls = [];
    const outcome = await handleScheduledFailure({
      err,
      jobName: 'starlight-finance-group-daily',
      send: async (t) => { sent.push(t); },
      runDiagnosis: async () => { diagCalls.push(1); return diag(); },
      checkKeychain: keychainStub(keychain),
      log: (l) => logs.push(l),
    });
    return { outcome, sent, logs, diagCalls };
  };

  test('登录故障 → 不跑自诊断，直接发确定性修复步骤（9/20–9/21 每次都是「诊断也失败了」）', async () => {
    const { outcome, sent, diagCalls, logs } = await run('claude CLI 失败(code 1): Not logged in · Please run /login');
    assert.equal(diagCalls.length, 0, '自诊断也要调 claude，登录坏了只会同样失败');
    assert.equal(outcome.diagnosed, false);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /已跳过自诊断/);
    assert.ok(sent[0].includes('claude auth login'));
    assert.ok(!sent[0].includes('**自诊断**'));
    assert.match(logs[0], /跳过自诊断/);
  });

  test('登录故障 + 钥匙串锁住 → 修复步骤带解锁命令', async () => {
    const { sent } = await run('Failed to authenticate: OAuth session expired and could not be refreshed', { keychain: true });
    assert.ok(sent[0].includes(UNLOCK_KEYCHAIN_CMD));
    assert.match(sent[0], /需要你本人在 Mac 前输入登录密码/);
  });

  test('其它失败照旧自诊断', async () => {
    const { outcome, sent, diagCalls } = await run('claude CLI 超时（120s）');
    assert.equal(diagCalls.length, 1);
    assert.equal(outcome.diagnosed, true);
    assert.match(sent[0], /\*\*自诊断\*\*\n1\) 网络/);
  });

  test('瞬时刷新不是登录故障：照旧自诊断', async () => {
    const { diagCalls } = await run('Failed to refresh OAuth token: another Claude Code process is refreshing it');
    assert.equal(diagCalls.length, 1);
  });

  test('诊断自己失败 → 报「诊断也失败了」', async () => {
    const { sent } = await run('claude CLI 超时（120s）', { diag: async () => { throw new Error('boom'); } });
    assert.match(sent[0], /诊断也失败了：boom/);
  });

  test('失败日志行脱敏', async () => {
    const { logs } = await run(`Not logged in · Please run /login ${FAKE_BMS_KEY}`);
    assert.ok(!logs.join('\n').includes(FAKE_BODY));
  });
});

describe('(c) 入站 [msg] 日志行', () => {
  const line = (text, over = {}) => formatInboundLog({ who: 'owner', chatType: 'p2p', messageType: 'post', text, messageId: 'm1', ...over });

  test('真实泄漏形态：密钥单独占一行 → 不留密钥，整条仍是一行', () => {
    const out = line(`密钥仅显示一次\n${FAKE_BMS_KEY}\nhttps://crm.example.com`);
    assert.ok(!out.includes(FAKE_BODY));
    assert.ok(!out.includes('密钥仅显示一次') && !out.includes('crm.example.com'), out);
    assert.ok(!out.includes('\n'));
  });

  test('不带正文：长正文里夹着密钥也一个字不进日志，只记长度和消息尾号', () => {
    const out = line(`${'密'.repeat(70)}${FAKE_BMS_KEY}`);
    assert.ok(!/bms_sk_|密密/.test(out), out);
    assert.match(out, / len=\d+ id=…m1$/);
  });

  test('紧贴中文、Bearer、等号后面都能抹掉', () => {
    for (const t of [`密钥是${FAKE_BMS_KEY}`, `Authorization: Bearer ${FAKE_BMS_KEY}`, `BMS_API_KEY=${FAKE_BMS_KEY}`]) {
      assert.ok(!line(t).includes(FAKE_BODY), t);
    }
  });

  test('紧贴 ASCII 字母 / 下划线后面也能抹掉（旧正则的前导 \\b 在这里不成立）', () => {
    for (const t of [`key${FAKE_BMS_KEY}`, `BMS_KEY_${FAKE_BMS_KEY}`]) {
      assert.ok(!redact(t).includes(FAKE_BODY), t);
    }
  });

  test('前缀与格式不变', () => {
    assert.equal(line('你好'), '[msg] owner @ p2p [post] len=2 id=…m1');
    assert.equal(line('去做', { who: 'ou_x', chatType: 'group', messageType: 'text', exec: true }), '[msg] ou_x @ group [text] [exec] len=2 id=…m1');
  });
});

describe('redact 对 bms_sk_ 的正反例', () => {
  test('正例：真实形态（bms_sk_ + 40 位 hex）被抹掉', () => {
    assert.equal(redact(FAKE_BMS_KEY), 'bms_sk_***');
    assert.equal(redact(`key: ${FAKE_BMS_KEY}.`), 'key: bms_sk_***.');
  });
  test('反例：只提到前缀的说明文字、普通词不动', () => {
    for (const t of ['用 Authorization: Bearer bms_sk_… 接入', 'bms_sk_*', 'bms_sk_abc', 'bms_skeleton 与 sk_learn']) {
      assert.equal(redact(t), t, t);
    }
  });
});

describe('isLoginKeychainLocked（只读，不解锁）', () => {
  test('退出码 0 → false；非 0 → true；命令起不来 → null', async () => {
    const calls = [];
    const ok = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '' }; };
    assert.equal(await isLoginKeychainLocked({ exec: ok, keychainPath: '/k' }), false);
    assert.deepEqual(calls[0], ['/usr/bin/security', 'show-keychain-info', '/k']);
    assert.equal(await isLoginKeychainLocked({ exec: async () => { throw Object.assign(new Error('x'), { code: 51 }); } }), true);
    assert.equal(await isLoginKeychainLocked({ exec: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }), null);
  });
});

describe('index.js 接线（源码断言——只证明写法，不证明行为；行为见上面各组）', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

  test('[msg] 日志走 formatInboundLog，不再原样打印 text', () => {
    assert.match(src, /console\.log\(formatInboundLog\(\{/);
    assert.ok(!/console\.log\(`\[msg\][^`]*\$\{text/.test(src));
  });

  test('私聊失败回复走 claudeFailureReply，旧的 includes(\'401\') 匹配器已删', () => {
    assert.match(src, /await claudeFailureReply\(String\(e\.message \?\? e\)\)/);
    assert.ok(!src.includes("msg.includes('401')"));
  });

  test('定时任务失败走 handleScheduledFailure，自诊断只作为回调传进去', () => {
    assert.match(src, /await handleScheduledFailure\(\{/);
    assert.match(src, /runDiagnosis: \(\) => runClaude\(\s*`sched-diag:/);
    assert.equal(src.match(/`sched-diag:/g).length, 1, '不能在 handleScheduledFailure 之外另跑自诊断');
  });
});
