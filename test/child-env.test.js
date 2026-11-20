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
import { BRIDGE_OWN_KEYS, PASSTHROUGH, childEnv, readEnvFileKeys, registerEnvFileKeys } from '../src/child-env.js';
import { configureAccountFallback } from '../src/account-fallback.js';
import { makeSandbox, applyEnv, loadClaude, captureConsole, reapAll, within } from './fixtures/run-helpers.mjs';

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

// ---------------------------------------------------------------------------------------------
// 4. BRIDGE-RUN-2：桥接自己 .env 文件里写了的键，一律不交给 claude（放行项除外）
//    E1  放行名单里不能混进密钥类键名（RUN-1 复审点名补的测试①：放行项不受 .env 规则约束，名单一脏就是一个后门）
//    E2  registerEnvFileKeys + childEnv 的纯函数行为        E3  readEnvFileKeys 只取键名、不泄值、不抛
//    E4  真起子进程：看它实际收到什么                        E5  主用额度用完、切到备用账号后的第二个子进程（RUN-1 复审点名补的测试②）
//    只用假值与假 CLI、只比对键名；每个用例收尾都清掉登记（registerEnvFileKeys([])）与备用账号配置，
//    也只还原自己动过的环境变量（原来没有的删掉、原来有的放回去）。
// ---------------------------------------------------------------------------------------------

const SECRET_LIKE = /SECRET|TOKEN|KEY|PASSWORD/i;
const secretLike = (names) => names.filter((k) => SECRET_LIKE.test(k));

/** 先记下这几个变量现在的值，返回还原函数（原来没有的删掉）——收尾时不会误删测试进程本来就有的变量 */
const snapshotEnv = (names) => {
  const prev = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  return () => applyEnv(prev);
};

describe('BRIDGE-RUN-2 .env 里写了的键不交给 claude', () => {
  afterEach(() => {
    registerEnvFileKeys([]);
    configureAccountFallback({ fallbackBin: '' });
  });

  // ---- E1 ----
  test('E1 放行名单里匹配 SECRET / TOKEN / KEY / PASSWORD 的键名只有 CLAUDE_CODE_OAUTH_TOKEN', () => {
    assert.deepEqual(
      secretLike(Object.keys(PASSTHROUGH)),
      ['CLAUDE_CODE_OAUTH_TOKEN'],
      '放行名单里混进了别的密钥类键名：放行项写在 .env 里也照样传给 claude。确实要放行，先确认它不会出现在桥接的 .env 里，再改这条测试并写明理由',
    );
  });

  test('E1 对照：上面那条检查本身认得出密钥类键名（含小写）', () => {
    assert.deepEqual(
      secretLike(['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'db_password', 'API_KEY', 'HOME', 'PATH', 'LANG', 'NODE_TLS_REJECT_UNAUTHORIZED']),
      ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'db_password', 'API_KEY'],
    );
  });

  // ---- E2 ----
  test('E2 .env 里写了的键都去掉（含小写、清单之外的 R2_SECRET_ACCESS_KEY）；放行项写在 .env 里照样传；没写进 .env 的代理 / 区域设置照样传', () => {
    registerEnvFileKeys(['R2_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'my_lower_case_key', 'CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH']);
    const src = {
      R2_SECRET_ACCESS_KEY: 'a', GITHUB_TOKEN: 'b', my_lower_case_key: 'c',
      CLAUDE_CODE_OAUTH_TOKEN: 't', HOME: '/h', PATH: '/bin',
      HTTPS_PROXY: 'p', LANG: 'en_US.UTF-8', UNRELATED_TOOL_VAR: 'x',
      FEISHU_APP_SECRET: 's', OWNER_OPEN_ID: 'o',
    };
    const copy = { ...src };
    const out = childEnv(src);
    assert.deepEqual(out, {
      CLAUDE_CODE_OAUTH_TOKEN: 't', HOME: '/h', PATH: '/bin', HTTPS_PROXY: 'p', LANG: 'en_US.UTF-8', UNRELATED_TOOL_VAR: 'x',
    });
    assert.notEqual(out, src, '返回新对象');
    assert.deepEqual(src, copy, '传入的对象不能被改');
  });

  test('E2 childEnv() 默认读 process.env：登记过的 .env 键不出现在返回值里，process.env 本体不动', () => {
    const [inFile, notInFile] = ['RUN2_E2_FILE_ONLY_VAR', 'RUN2_E2_NOT_IN_FILE_VAR'];
    const restore = snapshotEnv([inFile, notInFile]);
    process.env[inFile] = 'fake-1';
    process.env[notInFile] = 'fake-2';
    try {
      registerEnvFileKeys([inFile]);
      const out = childEnv();
      assert.equal(Object.hasOwn(out, inFile), false);
      assert.equal(out[notInFile], 'fake-2');
      assert.notEqual(out, process.env);
      assert.equal(process.env[inFile], 'fake-1', '桥接自己还要用，process.env 不能被动');
    } finally {
      restore();
    }
  });

  test('E2 registerEnvFileKeys 返回「只因为 .env 这一条才被去掉」的键名：去重、排序，不含清单内的、FEISHU_*、放行项，只收非空字符串', () => {
    const extra = registerEnvFileKeys([
      'ZED_TOKEN', 'ALPHA_KEY', 'ZED_TOKEN', 'my_lower_case_key',
      'FEISHU_APP_SECRET', 'FEISHU_BRAND_NEW_KEY', 'OWNER_OPEN_ID', 'CLAUDE_MODEL',
      'CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH',
      '', 5, null, undefined, {},
    ]);
    assert.deepEqual(extra, ['ALPHA_KEY', 'ZED_TOKEN', 'my_lower_case_key']);
  });

  test('E2 整体替换上一次登记；空表与非数组都回到 RUN-1 的行为（只按清单过滤），且返回空表', () => {
    const src = { R2_SECRET_ACCESS_KEY: 'a', OTHER_FILE_KEY: 'b', PATH: '/bin' };
    registerEnvFileKeys(['R2_SECRET_ACCESS_KEY']);
    registerEnvFileKeys(['OTHER_FILE_KEY']);
    assert.deepEqual(childEnv(src), { R2_SECRET_ACCESS_KEY: 'a', PATH: '/bin' }, '上一次登记的键不该还在被过滤');
    for (const v of [[], undefined, null, 'R2_SECRET_ACCESS_KEY', { R2_SECRET_ACCESS_KEY: 1 }, 42]) {
      registerEnvFileKeys(['R2_SECRET_ACCESS_KEY']);
      assert.deepEqual(childEnv(src), { OTHER_FILE_KEY: 'b', PATH: '/bin' }, '前提：登记生效');
      assert.deepEqual(registerEnvFileKeys(v), [], `registerEnvFileKeys(${JSON.stringify(v)}) 应返回空表`);
      assert.deepEqual(childEnv(src), src, `registerEnvFileKeys(${JSON.stringify(v)}) 之后应回到只按清单过滤`);
    }
  });

  // ---- E3 ----
  describe('E3 readEnvFileKeys 只取键名', () => {
    const VALUE = `e3-unique-value-${process.pid}-${Date.now()}`;

    test('E3 export、冒号写法、缩进、单双引号、多行引号值、注释、空值：得到的恰好是真正的键名', () => {
      const dir = path.join(SB.root, 'e3');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'sample.env');
      fs.writeFileSync(file, [
        '# 注释行 COMMENTED_ONE=1',
        '# COMMENTED_TWO=2',
        `export A_EXPORTED=${VALUE}`,
        `B_COLON: ${VALUE}`,
        `  C_INDENTED = "${VALUE}"`,
        `D_SINGLE='${VALUE}'`,
        `MULTI="第一行 ${VALUE}`,
        `INSIDE_QUOTES=${VALUE}`,
        '最后一行"',
        `lower_case_key=${VALUE}`,
        'EMPTY_VALUE=',
        `TRAILING_COMMENT=${VALUE} # COMMENTED_THREE=3`,
        '',
      ].join('\n'));
      const logs = [];
      const keys = readEnvFileKeys(file, { log: (m) => logs.push(m) });
      assert.deepEqual(
        [...keys].sort(),
        ['A_EXPORTED', 'B_COLON', 'C_INDENTED', 'D_SINGLE', 'EMPTY_VALUE', 'MULTI', 'TRAILING_COMMENT', 'lower_case_key'],
      );
      assert.deepEqual(logs, [], '读得出来就不打日志');
      assert.ok(!JSON.stringify(keys).includes(VALUE), '返回值里只有键名，不能带值');
    });

    test('E3 文件不存在 → []，不打日志（没有 .env、全靠服务自己的环境变量是正常配法）', () => {
      const logs = [];
      assert.deepEqual(readEnvFileKeys(path.join(SB.root, 'e3', 'no-such.env'), { log: (m) => logs.push(m) }), []);
      assert.deepEqual(logs, []);
    });

    test('E3 路径以 ~ 开头：按 dotenv 的规则展开成主目录，键名读得到并被 childEnv 剥掉', () => {
      const home = path.join(SB.root, 'e3-home');
      fs.mkdirSync(path.join(home, 'x'), { recursive: true });
      fs.writeFileSync(path.join(home, 'x', '.env'), `TILDE_SECRET=${VALUE}\nexport TILDE_OTHER=1\n`);
      const logs = [];
      const keys = readEnvFileKeys('~/x/.env', { home, log: (m) => logs.push(m) });
      assert.deepEqual([...keys].sort(), ['TILDE_OTHER', 'TILDE_SECRET']);
      assert.deepEqual(logs, []);
      assert.deepEqual(registerEnvFileKeys(keys), ['TILDE_OTHER', 'TILDE_SECRET']);
      assert.deepEqual(childEnv({ TILDE_SECRET: 'a', TILDE_OTHER: 'b', PATH: '/bin' }), { PATH: '/bin' });
      registerEnvFileKeys([]);
    });

    test('E3 路径以 ~ 开头：不给 home 时用 os.homedir()（HOME）', () => {
      const home = path.join(SB.root, 'e3-home2');
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, '.env'), 'HOME_KEY=1\n');
      const saved = process.env.HOME;
      process.env.HOME = home;
      try {
        assert.deepEqual(readEnvFileKeys('~/.env', { log: () => {} }), ['HOME_KEY']);
      } finally {
        if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
      }
    });

    test('E3 显式指定的路径读不到：恰好一行日志、不抛、日志里没有路径和键值；默认路径不存在仍不打日志', () => {
      const missing = path.join(SB.root, 'e3', 'explicit-missing.env');
      const saved = process.env.DOTENV_CONFIG_PATH;
      process.env.DOTENV_CONFIG_PATH = missing;
      try {
        const logs = [];
        assert.deepEqual(readEnvFileKeys(missing, { log: (m) => logs.push(m) }), []);
        assert.deepEqual(logs, ['[config] ⚠️ 指定的 .env 读不到，无法按文件剥离键']);
        const tilde = [];
        assert.deepEqual(readEnvFileKeys('~/no/such/.env', { explicit: true, home: SB.root, log: (m) => tilde.push(m) }), []);
        assert.equal(tilde.length, 1);
        const other = [];
        assert.deepEqual(readEnvFileKeys(path.join(SB.root, 'e3', 'default-missing.env'), { log: (m) => other.push(m) }), []);
        assert.deepEqual(other, [], '不是显式指定的路径不打日志');
        assert.deepEqual(readEnvFileKeys(missing, { log: () => { throw new Error('日志坏了'); } }), [], '日志函数抛错也不抛');
      } finally {
        if (saved === undefined) delete process.env.DOTENV_CONFIG_PATH; else process.env.DOTENV_CONFIG_PATH = saved;
      }
    });

    test('E3 读不了（路径是目录）→ []，恰好一行带错误码的日志', () => {
      const dir = path.join(SB.root, 'e3', 'a-directory.env');
      fs.mkdirSync(dir, { recursive: true });
      const logs = [];
      assert.deepEqual(readEnvFileKeys(dir, { log: (m) => logs.push(m) }), []);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /^\[config\] ⚠️ 读不了 \.env 的键名（EISDIR）/);
    });

    test('E3 读文件时抛出的错误：日志只带错误码，不带错误信息里的值；日志函数自己抛错也不影响返回；默认走 console.error', () => {
      const boom = () => { throw Object.assign(new Error(`boom ${VALUE}`), { code: 'EACCES' }); };
      const logs = [];
      assert.deepEqual(readEnvFileKeys('/unused', { read: boom, log: (m) => logs.push(m) }), []);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /EACCES/);
      assert.ok(!logs[0].includes(VALUE), '错误信息里可能夹着值，日志里不能出现');

      assert.deepEqual(readEnvFileKeys('/unused', { read: boom, log: () => { throw new Error('日志坏了'); } }), []);

      const cap = captureConsole();
      let viaDefault;
      try {
        viaDefault = readEnvFileKeys('/unused', { read: boom });
      } finally {
        cap.restore();
      }
      assert.deepEqual(viaDefault, []);
      assert.equal(cap.lines.length, 1);
      assert.ok(!cap.lines[0].includes(VALUE));
    });
  });

  // ---- E4 ----
  test('E4 一轮 owner 私聊：.env 里写了的键（含清单之外的）不进子进程环境；登录令牌与没写进 .env 的代理 / 区域设置照常传', { timeout: 30_000 }, async () => {
    const envFile = path.join(SB.root, 'e4.env');
    fs.writeFileSync(envFile, ['R2_SECRET_ACCESS_KEY=fake-r2', 'GITHUB_TOKEN=fake-gh', 'CLAUDE_CODE_OAUTH_TOKEN=fake-oauth', ''].join('\n'));
    const vars = {
      R2_SECRET_ACCESS_KEY: 'fake-r2', GITHUB_TOKEN: 'fake-gh', HTTPS_PROXY: 'http://127.0.0.1:9',
      CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth', LANG: 'en_US.UTF-8',
    };
    const restore = snapshotEnv(Object.keys(vars));
    SB.plan(okPlan());
    try {
      const extra = registerEnvFileKeys(readEnvFileKeys(envFile, { log: () => {} }));
      assert.deepEqual(extra, ['GITHUB_TOKEN', 'R2_SECRET_ACCESS_KEY'], '前提：这两个键只因为写在 .env 里才会被去掉（不在任何清单里）');
      const m = await loadClaude(SB, { ...vars, CLAUDE_MAX_RETRIES: '0' });
      assert.equal(process.env.R2_SECRET_ACCESS_KEY, 'fake-r2', '前提：桥接自己的环境里确实有这个键');
      assert.equal(await within(m.runClaude('oc_e4', 'hi', true, [], null), 15_000, '一轮'), '好');
    } finally {
      restore();
      registerEnvFileKeys([]);
    }
    const spawns = SB.spawns();
    assert.equal(spawns.length, 1);
    const keys = spawns[0].envKeys;
    for (const k of ['R2_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']) assert.ok(!keys.includes(k), `${k} 写在 .env 里，不该出现在子进程环境里`);
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'HTTPS_PROXY', 'LANG', 'HOME', 'PATH']) assert.ok(keys.includes(k), `${k} 应当传给子进程`);
    assert.deepEqual(leaked(keys), []);
  });

  // ---- E5 ----
  test('E5 主用额度用完、切到备用账号：第二个子进程（备用 CLI）的环境同样被过滤，登录令牌与 HOME 照常传', { timeout: 30_000 }, async () => {
    // 备用 CLI：同一个假程序，只多带一个 FAKE_ROLE=fallback（假 CLI 把环境变量的键名写进启动日志）
    const fallbackBin = path.join(SB.root, 'claude-fallback');
    const wrapper = fs.readFileSync(SB.bin, 'utf8').replace('exec ', 'FAKE_ROLE=fallback exec ');
    assert.match(wrapper, /FAKE_ROLE=fallback exec /, '前提：备用 CLI 的包装脚本生成成功');
    fs.writeFileSync(fallbackBin, wrapper, { mode: 0o755 });

    const fileKeys = ['R2_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
    const vars = { ...PLANTED, R2_SECRET_ACCESS_KEY: 'fake-r2', GITHUB_TOKEN: 'fake-gh' };
    const restore = snapshotEnv(Object.keys(vars));
    const limit = {
      events: [
        { type: 'system', subtype: 'init', session_id: 'sid-e5' },
        { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached|1763600000', session_id: 'sid-e5' },
      ],
      exit: 1,
    };
    SB.plan(limit, okPlan('备用答案'));
    try {
      registerEnvFileKeys(fileKeys);
      const m = await loadClaude(SB, { ...vars, FEISHU_TOOLS: undefined, CLAUDE_MAX_RETRIES: '0' });
      configureAccountFallback({ fallbackBin, log: () => {} });
      assert.equal(process.env.FEISHU_APP_SECRET, PLANTED.FEISHU_APP_SECRET, '前提：桥接自己的环境里确实有飞书凭据');
      assert.equal(await within(m.runClaude('oc_e5', 'hi', true, [], null), 20_000, '切到备用账号的一轮'), '备用答案');
    } finally {
      configureAccountFallback({ fallbackBin: '' });
      restore();
      registerEnvFileKeys([]);
    }
    const spawns = SB.spawns();
    assert.equal(spawns.length, 2, '第一个子进程撞上额度上限，第二个走备用 CLI');
    assert.ok(!spawns[0].envKeys.includes('FAKE_ROLE'), '第一个是主用 CLI');
    const second = spawns[1].envKeys;
    assert.ok(second.includes('FAKE_ROLE'), '第二个必须是备用 CLI，否则这条测试没测到备用路径');
    for (const k of ['FEISHU_APP_SECRET', 'OWNER_OPEN_ID', 'R2_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']) {
      assert.ok(!second.includes(k), `${k} 不该出现在备用 CLI 的环境里`);
    }
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH']) assert.ok(second.includes(k), `${k} 应当传给备用 CLI`);
    assert.deepEqual(leaked(second), []);
  });
});
