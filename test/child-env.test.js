// BRIDGE-RUN-1 H3 / L13：给 claude 子进程的环境变量。
// 子进程原先直接继承 process.env——桥接自己的配置（飞书 App Secret、owner open_id、白名单、各类开关……）
// 全部躺在子进程环境里，模型用任何一个能读环境的工具（或被提示词注入诱导）就能拿到。
// 现在改成「去掉桥接自己的键」的黑名单过滤：src/child-env.js。
//
// 本文件三类测试：
//   1. 防漂移（anti-leak）：模板与代码里出现过的每个环境变量名，必须落在「桥接自己的键」或「放行名单」之一——
//      有人新加了配置项却忘了归类，这里就红。只比对键名，从不输出任何值。
//   2. childEnv 纯函数单测。
//   3. 行为：真起一个假 claude 子进程（只把环境变量的键名写进日志），看它实际收到了什么；
//      并看启动自检的两处 spawn.sync 也走同一个过滤。
import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import { BRIDGE_OWN_KEYS, PASSTHROUGH, childEnv } from '../src/child-env.js';
import { makeSandbox, applyEnv, loadClaude, reapAll, within } from './fixtures/run-helpers.mjs';

const ROOT = new URL('..', import.meta.url);
const NAME_RE = /^[A-Z][A-Z0-9_]{2,}$/;

// ---------------------------------------------------------------------------------------------
// 1. 防漂移
// ---------------------------------------------------------------------------------------------

/** 模板里出现的键名（含被注释掉的 `# KEY=`）。只取名字。 */
function templateKeys() {
  const txt = fs.readFileSync(new URL('.env.example', ROOT), 'utf8');
  const keys = new Set();
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]{2,})=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

function listJs(dir) {
  const abs = new URL(`${dir}/`, ROOT);
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules') return [];
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return listJs(rel);
    return /\.(js|mjs|cjs)$/.test(e.name) ? [rel] : [];
  });
}

/** src/ 与 scripts/ 里读取过的环境变量名（与 AUDIT-D §2.3 的扫描同一套写法：process.env.X / env.X / env['X'] / values.X …） */
function codeReadNames() {
  const re = /\b(?:process\.env|env|e|values|envValues|merged|before|after|envFile(?:\.values)?)(?:\?)?\.([A-Z][A-Z0-9_]{2,})\b|\b(?:process\.env|env)\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g;
  const names = new Set();
  for (const f of [...listJs('src'), ...listJs('scripts')]) {
    const text = fs.readFileSync(new URL(f, ROOT), 'utf8');
    for (const line of text.split('\n')) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) names.add(m[1] || m[2]);
    }
  }
  return names;
}

describe('R7 防漂移：环境变量名必须归类', () => {
  test('BRIDGE_OWN_KEYS / PASSTHROUGH 形状：名字合法、不重复、互不相交、放行项都写了理由', () => {
    assert.ok(Array.isArray(BRIDGE_OWN_KEYS) && BRIDGE_OWN_KEYS.length > 30, '桥接自己的键应有几十个');
    assert.equal(new Set(BRIDGE_OWN_KEYS).size, BRIDGE_OWN_KEYS.length, 'BRIDGE_OWN_KEYS 里有重复项');
    for (const k of BRIDGE_OWN_KEYS) assert.match(k, NAME_RE, `不合法的键名：${k}`);
    assert.ok(PASSTHROUGH && typeof PASSTHROUGH === 'object' && !Array.isArray(PASSTHROUGH));
    for (const [k, why] of Object.entries(PASSTHROUGH)) {
      assert.match(k, /^[A-Z][A-Z0-9_]+$/, `不合法的放行名：${k}`);
      assert.ok(typeof why === 'string' && why.trim().length >= 4, `放行项 ${k} 必须写理由`);
    }
    const both = BRIDGE_OWN_KEYS.filter((k) => Object.hasOwn(PASSTHROUGH, k));
    assert.deepEqual(both, [], '同一个名字不能既是桥接自己的键又在放行名单里');
    assert.ok(Object.isFrozen(BRIDGE_OWN_KEYS) && Object.isFrozen(PASSTHROUGH), '两个常量应冻结，防止运行期被改');
  });

  test('放行名单固定包含：登录令牌、HOME、USER、PATH、TMPDIR、APPDATA、NODE_TLS_REJECT_UNAUTHORIZED', () => {
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'USER', 'PATH', 'TMPDIR', 'APPDATA', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
      assert.ok(Object.hasOwn(PASSTHROUGH, k), `${k} 必须在放行名单里`);
    }
  });

  test('桥接自己的键固定包含：飞书凭据、owner、新的结果宽限、MCP 围栏开关', () => {
    for (const k of [
      'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DOMAIN', 'FEISHU_TOOLS', 'FEISHU_MCP_FENCE',
      'OWNER_OPEN_ID', 'ALLOW_USERS', 'ALLOW_CHATS', 'CLAUDE_RESULT_GRACE_MS', 'CLAUDE_IDLE_TIMEOUT_MS',
    ]) {
      assert.ok(BRIDGE_OWN_KEYS.includes(k), `${k} 必须在 BRIDGE_OWN_KEYS 里`);
    }
  });

  test('模板里的每个键（含 `# KEY=` 注释项）都已归类', () => {
    const known = new Set([...BRIDGE_OWN_KEYS, ...Object.keys(PASSTHROUGH)]);
    const missing = [...templateKeys()].filter((k) => !known.has(k)).sort();
    assert.deepEqual(missing, [], `模板里这些键既不在 BRIDGE_OWN_KEYS 也不在 PASSTHROUGH：${missing.join(', ')}`);
  });

  test('src/ 与 scripts/ 里读取过的每个环境变量名都已归类', () => {
    const known = new Set([...BRIDGE_OWN_KEYS, ...Object.keys(PASSTHROUGH)]);
    const missing = [...codeReadNames()].filter((k) => !known.has(k)).sort();
    assert.deepEqual(missing, [], `代码里读取了这些环境变量，却没归类（加进 BRIDGE_OWN_KEYS 或 PASSTHROUGH 并写理由）：${missing.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. childEnv 纯函数
// ---------------------------------------------------------------------------------------------

describe('R7 childEnv 纯函数', () => {
  test('返回新对象；不改传入的对象，也不改 process.env', () => {
    const src = { FEISHU_APP_SECRET: 's', HOME: '/h', PATH: '/bin' };
    const copy = { ...src };
    const out = childEnv(src);
    assert.notEqual(out, src);
    assert.deepEqual(src, copy, '传入对象被改了');
    out.EXTRA = '1';
    assert.equal(src.EXTRA, undefined, '返回值应是独立对象');

    const prev = process.env.FEISHU_APP_SECRET;
    process.env.FEISHU_APP_SECRET = 'still-here-for-the-bridge';
    try {
      const e = childEnv();
      assert.equal(e.FEISHU_APP_SECRET, undefined);
      assert.equal(process.env.FEISHU_APP_SECRET, 'still-here-for-the-bridge', '桥接自己还要用，process.env 不能被动');
      assert.notEqual(e, process.env);
    } finally {
      if (prev === undefined) delete process.env.FEISHU_APP_SECRET; else process.env.FEISHU_APP_SECRET = prev;
    }
  });

  test('桥接自己的每个键都被去掉', () => {
    const src = Object.fromEntries(BRIDGE_OWN_KEYS.map((k) => [k, 'v']));
    src.PATH = '/usr/bin';
    const out = childEnv(src);
    assert.deepEqual(Object.keys(out), ['PATH'], `这些键漏过去了：${Object.keys(out).filter((k) => k !== 'PATH').join(', ')}`);
  });

  test('任何 FEISHU_* 都被去掉（含将来新增、模板里没有的）', () => {
    const out = childEnv({
      FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b', FEISHU_DOMAIN: 'lark', FEISHU_TOOLS: 'false',
      FEISHU_BRAND_NEW_KEY: 'c', FEISHU_: 'd', PATH: '/bin',
    });
    assert.deepEqual(Object.keys(out), ['PATH']);
  });

  test('放行：登录令牌、HOME / USER / PATH / TMPDIR / APPDATA、TLS 开关，以及代理 / 区域设置 / ANTHROPIC_* / CLAUDE_CODE_* / CLAUDE_CONFIG_DIR', () => {
    const keep = {
      CLAUDE_CODE_OAUTH_TOKEN: 't', HOME: '/h', USER: 'u', PATH: '/bin', TMPDIR: '/t', APPDATA: 'C:\\a',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      HTTP_PROXY: 'p', HTTPS_PROXY: 'p', NO_PROXY: 'n', http_proxy: 'p', https_proxy: 'p', ALL_PROXY: 'p',
      LANG: 'en_US.UTF-8', LC_ALL: 'C', TZ: 'Asia/Manila', SHELL: '/bin/zsh', TERM: 'xterm',
      ANTHROPIC_BASE_URL: 'u', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1', CLAUDE_CONFIG_DIR: '/c',
      FAKE_PLAN: 'x', SOME_OTHER_TOOL_VAR: 'y',
    };
    const planted = { ...keep, FEISHU_APP_SECRET: 's', OWNER_OPEN_ID: 'o', CLAUDE_MODEL: 'm', CLAUDE_BIN: 'b' };
    const out = childEnv(planted);
    assert.deepEqual(out, keep);
  });

  test('空对象与空串值：{} → {}；被去掉的键即使值为空串也不残留', () => {
    assert.deepEqual(childEnv({}), {});
    assert.deepEqual(childEnv({ OWNER_NAME: '', FEISHU_TOOLS: '', PATH: '/bin' }), { PATH: '/bin' });
  });
});

// ---------------------------------------------------------------------------------------------
// 3. 行为：真起子进程看它收到什么
// ---------------------------------------------------------------------------------------------

const SB = makeSandbox('child-env');
after(() => SB.cleanup());
afterEach(() => reapAll(SB));

const okPlan = (answer = '好') => ({
  events: [
    { type: 'system', subtype: 'init', session_id: 'sid-env' },
    { type: 'assistant', message: { content: [{ type: 'text', text: answer }] } },
    { type: 'result', is_error: false, result: answer, session_id: 'sid-env' },
  ],
});

// 全是假值；这些值从不被打印，断言只比对键名
const PLANTED = {
  FEISHU_APP_ID: 'cli_fake_app', FEISHU_APP_SECRET: 'fake-secret-value-do-not-leak', FEISHU_DOMAIN: 'feishu',
  FEISHU_BRAND_NEW_KEY: 'fake-1', OWNER_OPEN_ID: 'ou_fake_owner', ALLOW_USERS: 'ou_fake_a', ALLOW_CHATS: 'oc_fake_a',
  HEARTBEAT_WATCH: 'chat_reply', LARK_CLI_BIN: '/fake/lark-cli', TTS_VOICE: 'fake-voice',
  // 以下应当原样传给子进程
  CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token', HTTPS_PROXY: 'http://127.0.0.1:9', LANG: 'en_US.UTF-8',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', CLAUDE_CONFIG_DIR: path.join(SB.root, 'claude-config'),
};
const MUST_REACH_CHILD = ['PATH', 'HOME', 'TMPDIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'HTTPS_PROXY', 'LANG', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'FAKE_PLAN', 'FAKE_LOG'];

const leaked = (keys) => keys.filter((k) => BRIDGE_OWN_KEYS.includes(k) || k.startsWith('FEISHU_')).sort();
const unplant = () => applyEnv(Object.fromEntries(Object.keys(PLANTED).map((k) => [k, undefined])));

describe('R7 行为：子进程实际收到的环境', () => {
  test('一轮 owner 私聊：子进程环境里没有桥接自己的键与任何 FEISHU_*，登录令牌与代理等照常传', { timeout: 30_000 }, async () => {
    SB.plan(okPlan());
    // FEISHU_TOOLS 不设：飞书 MCP 照常挂上，凭据走临时 mcp.json，不经子进程环境
    const m = await loadClaude(SB, { ...PLANTED, FEISHU_TOOLS: undefined, CLAUDE_MAX_RETRIES: '0' });
    try {
      assert.equal(await within(m.runClaude('oc_env', 'hi', true, [], null), 15_000, '一轮'), '好');
    } finally {
      unplant();
    }
    const spawns = SB.spawns();
    assert.equal(spawns.length, 1);
    const keys = spawns[0].envKeys;
    assert.deepEqual(leaked(keys), [], '这些桥接自己的键出现在了子进程环境里');
    for (const k of MUST_REACH_CHILD) assert.ok(keys.includes(k), `${k} 应当传给子进程`);
  });

  test('访客与定时任务两条路径也一样（都经 runClaudeOnce 的同一个 spawn）', { timeout: 30_000 }, async () => {
    SB.plan(okPlan('访客'), okPlan('定时'));
    const m = await loadClaude(SB, { ...PLANTED, CLAUDE_MAX_RETRIES: '0' });
    try {
      assert.equal(await within(m.runClaude('guest:oc_g:ou_g', 'hi', false, [], null), 15_000, '访客'), '访客');
      assert.equal(await within(m.runClaude('sched:job.json', 'go', true, [], null, { toolProfile: 'sched' }), 15_000, '定时'), '定时');
    } finally {
      unplant();
    }
    const spawns = SB.spawns();
    assert.equal(spawns.length, 2);
    for (const s of spawns) assert.deepEqual(leaked(s.envKeys), []);
  });

  test('checkCliEnvironment 的两次 spawn.sync（--version 与 which / where）用的是过滤后的新环境', { timeout: 30_000 }, async () => {
    SB.plan(okPlan());
    const m = await loadClaude(SB, { ...PLANTED });
    const calls = [];
    const orig = crossSpawn.sync;
    crossSpawn.sync = (...a) => { calls.push(a); return orig.apply(crossSpawn, a); };
    let res;
    try {
      res = m.checkCliEnvironment();
    } finally {
      crossSpawn.sync = orig;
      unplant();
    }
    assert.equal(res.ok, true, '过滤后的环境下假 CLI 的 --version 仍应跑得通');
    assert.equal(calls.length, 2, '应是 --version 与 which / where 两次');
    for (const [, , o] of calls) {
      assert.ok(o && o.env, '必须显式传 env');
      assert.notEqual(o.env, process.env, '不能再把 process.env 本体交给子进程');
      assert.deepEqual(leaked(Object.keys(o.env)), []);
      assert.ok(o.env.PATH, 'PATH 要保留，否则找不到命令');
    }
  });

  test('verifyFallbackAtStartup 对备用 CLI 跑 --version 时同样过滤', { timeout: 30_000 }, async () => {
    await loadClaude(SB, { ...PLANTED }); // 只为设好隔离环境
    const acct = await import('../src/account-fallback.js');
    acct.configureAccountFallback({ fallbackBin: SB.bin, log: () => {} });
    const calls = [];
    const orig = crossSpawn.sync;
    crossSpawn.sync = (...a) => { calls.push(a); return orig.apply(crossSpawn, a); };
    let r;
    try {
      r = acct.verifyFallbackAtStartup({ log: () => {}, warn: () => {} });
    } finally {
      crossSpawn.sync = orig;
      acct.configureAccountFallback({}); // 还原成未配置备用
      unplant();
    }
    assert.equal(r?.ok, true, '过滤后的环境下假 CLI 的 --version 仍应跑得通');
    assert.equal(calls.length, 1);
    const o = calls[0][2];
    assert.ok(o && o.env, '必须显式传 env');
    assert.notEqual(o.env, process.env);
    assert.deepEqual(leaked(Object.keys(o.env)), []);
    assert.ok(o.env.PATH);
  });
});
