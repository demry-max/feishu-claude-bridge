// BRIDGE-RUN-1 M7：账号不可用分类器（classifyAccountError）。
// 两个问题：
//   漏判——claude 2.1.280 的几种真实登录故障文案（组织不允许 OAuth、Invalid auth token、钥匙串不可写、
//         账号无权访问 Claude、组织停用订阅访问、403 令牌被吊销）旧正则认不出来，备用账号切换不触发；
//   误判——裸的 \b401\b / \b429\b 会把「工单 WO-401 找不到」、stderr 里 lark-cli 的 `HTTP 429` 当成账号问题，
//         白白切到备用并给 owner 发通知。
// 本文件用「登录故障签名夹具」逐条钉分类结果，再钉误判反例，最后走一遍 runWithAccount 看切换行为。
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAccountError, runWithAccount, configureAccountFallback, ACCOUNT } from '../src/account-fallback.js';
import { CLAUDE_AUTH_SIGNATURES } from './fixtures/claude-auth-signatures.js';

const expectedKind = (f) => (f.kind === 'auth' || f.kind === 'keychain' ? 'auth' : null);
const shorten = (s) => (s.length > 64 ? `${s.slice(0, 64)}…` : s);

describe('R9 夹具驱动：result 文本口径（单参数）', () => {
  test('夹具里确有 auth 与 keychain 条目，也有 network / transient_refresh / none 反例', () => {
    const kinds = new Set(CLAUDE_AUTH_SIGNATURES.map((f) => f.kind));
    for (const k of ['auth', 'keychain', 'network', 'transient_refresh', 'none']) assert.ok(kinds.has(k), `夹具缺 ${k} 类`);
  });

  for (const f of CLAUDE_AUTH_SIGNATURES) {
    test(`[${f.kind}] ${shorten(f.text)} → ${expectedKind(f)}`, () => {
      assert.equal(classifyAccountError(f.text), expectedKind(f));
    });
  }
});

describe('R9 夹具驱动：只有 stderr 时（严格口径：只认强信号）', () => {
  for (const f of CLAUDE_AUTH_SIGNATURES) {
    test(`stderr [${f.kind}] ${shorten(f.text)} → ${expectedKind(f)}`, () => {
      assert.equal(classifyAccountError('', f.text), expectedKind(f));
    });
  }
});

describe('R9 误判反例', () => {
  test('工单号里的 401 不是登录失效', () => {
    assert.equal(classifyAccountError('工单 WO-401 找不到'), null);
    assert.equal(classifyAccountError('工单 WO-401 找不到', '工单 WO-401 找不到'), null);
    assert.equal(classifyAccountError('Found 401 rows and 429 records'), null);
    assert.equal(classifyAccountError('订单 #429 已取消，金额 401.50'), null);
  });

  test('stderr 里 lark-cli 之类工具的 HTTP 429 / rate limit 不是账号额度问题', () => {
    assert.equal(classifyAccountError('', '[lark] 请求失败 HTTP 429'), null);
    assert.equal(classifyAccountError('', '[lark] calendar events: HTTP 429 Too Many Requests'), null);
    assert.equal(classifyAccountError('', '[lark] rate limit exceeded, retry later'), null);
    assert.equal(classifyAccountError('', 'tool X hit a rate_limit; backing off 401 ms'), null);
    assert.equal(classifyAccountError('[lark] 请求失败 HTTP 429'), null, '没有 API Error: 前缀的 429 也不算');
  });

  test('网络类、套餐类、瞬时刷新类仍然不算', () => {
    assert.equal(classifyAccountError('API Error: 529 Overloaded'), null);
    assert.equal(classifyAccountError('API Error: 500 {"type":"error","error":{"type":"api_error"}}'), null);
    assert.equal(classifyAccountError('Connection error.'), null);
    assert.equal(classifyAccountError('Failed to refresh OAuth token: another Claude Code process is refreshing it'), null);
    assert.equal(classifyAccountError('Claude Opus is not available with the Claude Pro plan.'), null);
    assert.equal(classifyAccountError('文档里提到 OAuth scopes 的配置方法'), null);
  });

  test('会话不存在优先，来自哪一路都不是账号问题', () => {
    assert.equal(classifyAccountError('No conversation found with session ID: x'), null);
    assert.equal(classifyAccountError('', 'No conversation found with session ID: x'), null);
    assert.equal(classifyAccountError('No conversation found with session ID: x\nNot logged in · Please run /login'), null);
    assert.equal(classifyAccountError('Not logged in · Please run /login', 'No conversation found with session ID: x'), null);
  });

  test('空 / 非字符串输入不抛错、返回 null', () => {
    assert.equal(classifyAccountError(), null);
    assert.equal(classifyAccountError(undefined, undefined), null);
    assert.equal(classifyAccountError(null, null), null);
    assert.equal(classifyAccountError(''), null);
    assert.equal(classifyAccountError('', ''), null);
    assert.equal(classifyAccountError({}, 42), null);
  });
});

describe('R9 仍要认出的（不能因收紧而漏）', () => {
  const WEEKLY = "You've hit your weekly limit · resets 4am (Asia/Manila)";
  const FIVE_HOUR = "You've hit your 5-hour limit · resets 9pm (Asia/Manila)";

  test('result 文本里的 API Error: 429 / rate_limit_error → quota', () => {
    assert.equal(classifyAccountError('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'), 'quota');
    assert.equal(classifyAccountError('API Error: 429 Too many requests'), 'quota');
    assert.equal(classifyAccountError('rate_limit_error'), 'quota');
    assert.equal(classifyAccountError('This request would exceed your account\'s rate limit'), 'quota');
  });

  test('result 文本里的 API Error: 401 → auth', () => {
    assert.equal(classifyAccountError('API Error: 401 {"type":"error","error":{"message":"invalid x-api-key"}}'), 'auth');
    assert.equal(classifyAccountError('API Error: 401'), 'auth');
  });

  test('额度用完的几种真实文案（result 与 stderr 两路都认）', () => {
    for (const t of [WEEKLY, FIVE_HOUR, 'Claude AI usage limit reached|1763380800', 'You are out of extra usage · resets 3pm', 'Monthly spend limit reached']) {
      assert.equal(classifyAccountError(t), 'quota', `result：${t}`);
      assert.equal(classifyAccountError('', t), 'quota', `stderr：${t}`);
    }
  });

  test('登录失效的几种文案，stderr 一路也认', () => {
    for (const t of ['Not logged in · Please run /login', 'Failed to authenticate. API Error: 401', 'Invalid API key · Fix external API key', 'OAuth session expired']) {
      assert.equal(classifyAccountError('', t), 'auth', t);
    }
  });

  test('result 与 stderr 并存：任何一路有强信号就判；两路都有时 auth 优先', () => {
    assert.equal(classifyAccountError('Execution error', WEEKLY), 'quota');
    assert.equal(classifyAccountError('Execution error', 'Not logged in · Please run /login'), 'auth');
    assert.equal(classifyAccountError(WEEKLY, 'Not logged in · Please run /login'), 'auth');
    assert.equal(classifyAccountError('Execution error', 'ordinary noise'), null);
  });
});

// ---- 走一遍 runWithAccount：配置了备用时，误判不再触发切换，真信号照常切 ----
describe('R9 runWithAccount：切换行为', () => {
  let clock;
  let logs;
  const enable = () => {
    clock = 1_000_000;
    logs = [];
    configureAccountFallback({ fallbackBin: '/fake/fallback-claude', cooldownMin: 30, now: () => clock, log: (l) => logs.push(l) });
  };
  after(() => configureAccountFallback({})); // 还原成未配置备用，别影响同进程里别的测试

  const err = (message, extra = {}) => Object.assign(new Error(message), { acted: false, ...extra });
  function scripted(steps) {
    const accounts = [];
    const once = async (o) => {
      accounts.push(o[ACCOUNT]);
      const step = steps[Math.min(accounts.length - 1, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    };
    return { once, accounts };
  }
  const noSwitch = async (error) => {
    enable();
    const { once, accounts } = scripted([error]);
    await assert.rejects(() => runWithAccount(once, {}), (e) => e === error);
    assert.deepEqual(accounts, ['primary'], '不该切到备用');
    assert.deepEqual(logs.filter((l) => l.startsWith('[account]')), [], '也不该有任何账号切换日志');
  };

  test('result 里的 API Error: 429 → 切到备用并成功', async () => {
    enable();
    const { once, accounts } = scripted([err('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'), 'from-fallback']);
    assert.equal(await runWithAccount(once, {}), 'from-fallback');
    assert.deepEqual(accounts, ['primary', 'fallback']);
    assert.ok(logs.includes('[account] 主用不可用(quota)，切到备用，冷却 30 分钟'), logs.join('\n'));
  });

  test('errors 数组里的 rate_limit_error（挂在 cliErrors 上）→ 切换', async () => {
    enable();
    const { once, accounts } = scripted([err('Execution error', { cliErrors: 'rate_limit_error: slow down' }), 'from-fallback']);
    assert.equal(await runWithAccount(once, {}), 'from-fallback');
    assert.deepEqual(accounts, ['primary', 'fallback']);
  });

  test('stderr 里的强信号（周额度）→ 切换（M15 的同类）', async () => {
    enable();
    const { once, accounts } = scripted([err('Execution error', { cliStderr: "You've hit your weekly limit · resets 4am (Asia/Manila)" }), 'from-fallback']);
    assert.equal(await runWithAccount(once, {}), 'from-fallback');
    assert.deepEqual(accounts, ['primary', 'fallback']);
  });

  test('2.1.280 的新登录故障文案 → 切换（旧正则认不出）', async () => {
    for (const text of [
      'OAuth authentication is currently not allowed for this organization',
      'Invalid auth token · Fix external auth token',
      'macOS Keychain is not writable (-25293)',
      'Your account does not have access to Claude. Please login again or contact your administrator.',
      'API Error: 403 OAuth token has been revoked',
    ]) {
      enable();
      const { once, accounts } = scripted([err(text), 'from-fallback']);
      assert.equal(await runWithAccount(once, {}), 'from-fallback', text);
      assert.deepEqual(accounts, ['primary', 'fallback'], text);
      assert.ok(logs.includes('[account] 主用不可用(auth)，切到备用，冷却 30 分钟'), `${text}\n${logs.join('\n')}`);
    }
  });

  test('工单 WO-401 找不到 → 不切换', async () => {
    await noSwitch(err('工单 WO-401 找不到'));
  });

  test('stderr 里的 [lark] HTTP 429 → 不切换', async () => {
    await noSwitch(err('Execution error', { cliStderr: '[lark] 调用失败 HTTP 429 rate limit exceeded' }));
  });

  test('进程无 result 退出时 message 里嵌的是 stderr 头部：同样只认强信号（弱信号不切换）', async () => {
    const stderr = '[lark] 调用失败 HTTP 429 rate limit exceeded';
    await noSwitch(err(`claude CLI 失败(code 1): ${stderr}`, { cliStderr: stderr }));
  });

  test('进程无 result 退出、stderr 是强信号 → 切换', async () => {
    enable();
    const stderr = "You've hit your weekly limit · resets 4am (Asia/Manila)";
    const { once, accounts } = scripted([err(`claude CLI 失败(code 1): ${stderr}`, { cliStderr: stderr }), 'from-fallback']);
    assert.equal(await runWithAccount(once, {}), 'from-fallback');
    assert.deepEqual(accounts, ['primary', 'fallback']);
  });
});
