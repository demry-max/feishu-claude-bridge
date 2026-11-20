// BRIDGE-RUN-2：index.js 里新接的三处线路。index.js 是启动脚本、不能 import，
// 这里一半看源码形状（位置、唯一性），一半把真实代码段切出来放进注入的作用域里跑（写法同 owner-dm-store.test.js）。
//   W1  位置与唯一性：登记 .env 键名、清理上一代残留各只出现一次，且在调度 / 心跳 / 每日会话 / 长连接 / 启动自检之前
//   W2  启动段：.env 路径怎么取、键名表怎么登记、残留清理怎么调、日志里只有键名
//   W3  通知：只有真的清掉了进程才通知；走 deferUntilAwake；免打扰沿用心跳的设置
// 只用注入的假依赖，不读真实 .env、不碰真实 data/、不起任何进程。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CHILD_REGISTRY_FILE, orphanNoticeText } from '../src/child-registry.js';

const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const BOOT_MARK = 'console.log(ownerDmBootLine(ownerDmBoot));';
const count = (needle) => SRC.split(needle).length - 1;

// ---------------------------------------------------------------------------------------------
describe('W1 位置与唯一性', () => {
  test('登记 .env 键名、清理上一代残留、通知三处调用点各出现一次', () => {
    for (const needle of ['registerEnvFileKeys(', 'childRegistryFor(', 'orphanReap.killed > 0']) {
      assert.equal(count(needle), 1, `${needle} 应恰好出现一次，实际 ${count(needle)} 次`);
    }
  });

  test('登记 .env 键名与清理残留都在启动日志之后、调度 / 心跳 / 每日会话 / 长连接 / 启动自检之前', () => {
    const boot = SRC.indexOf(BOOT_MARK);
    assert.ok(boot > 0, `找不到锚点 ${BOOT_MARK}——index.js 的结构变了，请更新这条测试`);
    const later = ['startScheduler(', 'startHeartbeat(', 'createLiveDailySession(', 'wsClient.start(', 'checkCliEnvironment(cfg.model)']
      .map((n) => [n, SRC.indexOf(n)]);
    for (const [n, at] of later) assert.ok(at > 0, `找不到 ${n}——index.js 的结构变了，请更新这条测试`);
    for (const needle of ['registerEnvFileKeys(', 'childRegistryFor(']) {
      const at = SRC.indexOf(needle);
      assert.ok(at > boot, `${needle} 应在启动日志之后`);
      for (const [n, l] of later) assert.ok(at < l, `${needle} 必须在 ${n} 之前：键名登记要赶在任何 claude 子进程之前，残留清理要赶在新的子进程登记之前`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('W2 启动段（把真实代码段拿出来跑）', () => {
  /** 切出「启动日志之后、const voiceChats 之前」的那段，放进注入的作用域里跑；返回 run(opts) */
  function bootRunner() {
    const a = SRC.indexOf(BOOT_MARK);
    assert.ok(a > 0);
    const from = a + BOOT_MARK.length;
    const to = SRC.indexOf('const voiceChats', from);
    assert.ok(to > from, '找不到 const voiceChats——index.js 的结构变了，请更新这条测试');
    const body = SRC.slice(from, to);
    // eslint-disable-next-line no-new-func
    const make = new Function('scope', `with (scope) {\n${body}\nreturn { envFileExtraKeys, orphanReap };\n}`);
    return ({
      env = {}, cwd = '/inj/cwd', fileKeys = ['R2_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'FEISHU_APP_SECRET'],
      extra = ['GITHUB_TOKEN', 'R2_SECRET_ACCESS_KEY'], reaped = { killed: 2, dropped: 1, unreadable: false },
    } = {}) => {
      const seq = [];
      const calls = { read: [], register: [], registry: [], reap: [] };
      const logs = [];
      const errs = [];
      const scope = {
        process: { env, cwd: () => cwd },
        path,
        DATA_DIR: '/inj/data',
        CHILD_REGISTRY_FILE,
        readEnvFileKeys: (file, o) => { seq.push('read'); calls.read.push({ file, o }); return fileKeys; },
        registerEnvFileKeys: (names) => { seq.push('register'); calls.register.push(names); return extra; },
        childRegistryFor: (file) => {
          seq.push('registry');
          calls.registry.push(file);
          return { reapPrevious: (o) => { seq.push('reap'); calls.reap.push(o); return reaped; } };
        },
        console: { log: (m) => logs.push(String(m)), error: (m) => errs.push(String(m)) },
      };
      return { out: make(scope), seq, calls, logs, errs, scope };
    };
  }

  test('.env 路径：设了 DOTENV_CONFIG_PATH 用它（原样），没设或为空串用「当前目录/.env」；读键名的日志走 console.error', () => {
    const run = bootRunner();
    const custom = run({ env: { DOTENV_CONFIG_PATH: '/x/custom.env' } });
    assert.equal(custom.calls.read.length, 1);
    assert.equal(custom.calls.read[0].file, '/x/custom.env');
    assert.equal(custom.calls.read[0].o.log, custom.scope.console.error, '读不了 .env 的警告应走 console.error');

    for (const env of [{}, { DOTENV_CONFIG_PATH: '' }]) {
      const dflt = run({ env, cwd: '/inj/cwd' });
      assert.equal(dflt.calls.read[0].file, path.resolve('/inj/cwd', '.env'), `env=${JSON.stringify(env)}`);
    }
  });

  test('键名表：读出来的原样交给 registerEnvFileKeys；顺序是 读 → 登记 → 取记录文件 → 清理', () => {
    const fileKeys = ['A_KEY', 'B_TOKEN'];
    const r = bootRunner()({ fileKeys });
    assert.equal(r.calls.register.length, 1);
    assert.equal(r.calls.register[0], fileKeys, '读到的键名表要原样交给 registerEnvFileKeys');
    assert.deepEqual(r.seq, ['read', 'register', 'registry', 'reap']);
  });

  test('残留清理：记录文件是 DATA_DIR 下的 claude-children.json，reapPrevious 恰好调一次、日志走 console.log，结果留给后面的通知用', () => {
    assert.equal(CHILD_REGISTRY_FILE, 'claude-children.json');
    const reaped = { killed: 3, dropped: 0, unreadable: false };
    const r = bootRunner()({ reaped });
    assert.deepEqual(r.calls.registry, [path.join('/inj/data', 'claude-children.json')]);
    assert.equal(r.calls.reap.length, 1);
    assert.equal(r.calls.reap[0].log, r.scope.console.log);
    assert.equal(r.out.orphanReap, reaped, '清理结果要原样留在 orphanReap 里，后面的通知据此决定发不发');
  });

  test('日志：有清单之外的键时恰好一行，只含数量与键名、不含值；没有就不打', () => {
    const run = bootRunner();
    const VALUE = 'w2-secret-value-should-never-be-logged';
    const r = run({ env: { GITHUB_TOKEN: VALUE, R2_SECRET_ACCESS_KEY: VALUE }, extra: ['GITHUB_TOKEN', 'R2_SECRET_ACCESS_KEY'] });
    assert.deepEqual(r.out.envFileExtraKeys, ['GITHUB_TOKEN', 'R2_SECRET_ACCESS_KEY']);
    assert.deepEqual(r.logs.filter((l) => l.startsWith('[config]')), ['[config] .env 里另有 2 个未登记的键，不交给 claude：GITHUB_TOKEN, R2_SECRET_ACCESS_KEY']);
    assert.ok(![...r.logs, ...r.errs].some((l) => l.includes(VALUE)), '日志里不能出现任何值');

    const none = run({ extra: [] });
    assert.deepEqual(none.logs.filter((l) => l.startsWith('[config]')), [], '没有未登记的键就不打这一行');
  });
});

// ---------------------------------------------------------------------------------------------
describe('W3 通知（把真实代码段拿出来跑）', () => {
  /** 切出含 orphanReap.killed > 0 的那一整行，放进注入的作用域里跑 */
  function noticeRunner() {
    const i = SRC.indexOf('if (orphanReap.killed > 0)');
    assert.ok(i > 0, '找不到通知那一行——index.js 的结构变了，请更新这条测试');
    const lineEnd = SRC.indexOf('\n', i);
    const line = SRC.slice(i, lineEnd);
    // eslint-disable-next-line no-new-func
    const make = new Function('scope', `with (scope) {\n${line}\n}`);
    return (reaped) => {
      const defers = [];
      const sent = [];
      const quiet = [];
      const scope = {
        orphanReap: reaped,
        deferUntilAwake: (o) => { defers.push(o); },
        sendToOwner: async (text) => { sent.push(text); return 'sent-ok'; },
        orphanNoticeText,
        inQuietHours: (now, hours) => { quiet.push({ now, hours }); return 'quiet-flag'; },
        heartbeatSettings: { quietHours: 'QUIET-HOURS-SENTINEL' },
        console: { log: () => {}, error: () => {} },
      };
      make(scope);
      return { defers, sent, quiet, scope };
    };
  }

  test('没清掉任何进程（killed 为 0，哪怕只删了对不上的记录）→ 不通知', () => {
    const run = noticeRunner();
    for (const reaped of [{ killed: 0, dropped: 0, unreadable: false }, { killed: 0, dropped: 3, unreadable: false }, { killed: 0, dropped: 0, unreadable: true }]) {
      const r = run(reaped);
      assert.equal(r.defers.length, 0, JSON.stringify(reaped));
      assert.equal(r.sent.length, 0, JSON.stringify(reaped));
    }
  });

  test('清掉了 2 组 → 恰好交给 deferUntilAwake 一次；send 发给 owner 的正是 orphanNoticeText(2)', async () => {
    const r = noticeRunner()({ killed: 2, dropped: 0, unreadable: false });
    assert.equal(r.defers.length, 1);
    const o = r.defers[0];
    assert.equal(typeof o.send, 'function');
    assert.equal(typeof o.isQuiet, 'function');
    assert.equal(o.log, r.scope.console.error, '通知失败的日志走 console.error');
    assert.deepEqual(r.sent, [], '交给 deferUntilAwake 时还不能已经发出去');
    assert.equal(await o.send(), 'sent-ok', 'send 要把 sendToOwner 的结果交回去');
    assert.deepEqual(r.sent, [orphanNoticeText(2)]);
    assert.ok(r.sent[0].includes('2'), '提示里要有被中断的任务数');
  });

  test('免打扰沿用心跳的设置：isQuiet 用当前时间和 heartbeatSettings.quietHours 问 inQuietHours，并把答案原样交回', () => {
    const r = noticeRunner()({ killed: 1, dropped: 0, unreadable: false });
    const before = Date.now();
    assert.equal(r.defers[0].isQuiet(), 'quiet-flag');
    assert.equal(r.quiet.length, 1);
    assert.ok(r.quiet[0].now instanceof Date);
    assert.ok(Math.abs(r.quiet[0].now.getTime() - before) < 5_000, '传的应是此刻的时间');
    assert.equal(r.quiet[0].hours, 'QUIET-HOURS-SENTINEL');
  });
});
