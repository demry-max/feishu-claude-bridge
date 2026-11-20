// BRIDGE-RUN-2：桥接被强杀后，下次启动清理上一代留下的 claude 进程组（真进程测试）。
//
// 真进程、真 ps、真 kill；全部在临时目录里，孩子是假 CLI（test/fixtures/fake-claude-run.mjs），
// 不碰线上 data/ 与 workspace/，不调真实 claude CLI，不联网。
// 收尸只收本测试自己起的 pid：沙箱记录过、命令行带 fake-claude-run.mjs 或本沙箱目录名（见 reap-helpers 的 killRecorded / run-helpers 的 reapAll）。
// 每个用例自带 timeout，等待都有上限。
//
// 用例分两类：
//   B1–B6  独立进程：reap-driver 里跑真实 claude.js，被 SIGKILL 之后留下孤儿；本进程再用 createChildRegistry 扮「下一代」去清。
//   B7–B9  本进程里跑真实 runClaude，看登记簿在运行中、写不进去、各种收尾时的行为。
// Windows 没有进程组语义：整个文件跳过。孤儿 3 秒内没被 1 号进程收养（例如容器里有 subreaper）：该用例跳过并写明原因。
import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  makeSandbox, sandboxEnv, applyEnv, captureConsole, within, settle, sleep, waitGone, waitFor, reapAll, alive, CLAUDE_URL,
} from './fixtures/run-helpers.mjs';
import {
  IS_WIN, MARKED_ARGS, UNMARKED_ARGS, logSink, psRow, spawnOrphan, waitPpid1, startReapDriver, registryFileOf, readRegistry,
} from './fixtures/reap-helpers.mjs';
import { createChildRegistry, childRegistryFor } from '../src/child-registry.js';

// 本文件在进程内用的沙箱（B7–B9）。DATA_DIR 在 store.js 首次 import 时定下来，所以整个文件只用这一个沙箱跑进程内的 runClaude。
const SB = makeSandbox('reaper');
applyEnv(sandboxEnv(SB));
after(() => SB.cleanup());
afterEach(() => reapAll(SB));

// ---- 假 CLI 的事件 ----
const init = (sid = 'sid-x') => ({ type: 'system', subtype: 'init', session_id: sid });
const text = (t) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const result = (r, sid = 'sid-x') => ({ type: 'result', subtype: 'success', is_error: false, result: r, session_id: sid });
const errResult = (r, sid = 'sid-x') => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result: r, session_id: sid });
const okPlan = (sid, answer, extra = {}) => ({ events: [init(sid), text(answer), result(answer, sid)], ...extra });

// 登记簿在创建时把当时的 console.error 记成自己的日志出口（线上就是真的 console.error）。
// 这里在 import claude.js 的那一刻把 console.error 换成收集器：此后登记簿的警告都进 REG_LINES，用例可以数行数。
const REG_LINES = [];
let seq = 0;
async function load(env = {}) {
  applyEnv(sandboxEnv(SB, { CLAUDE_MAX_RETRIES: '0', ...env }));
  const orig = console.error;
  console.error = (...a) => { REG_LINES.push(a.map(String).join(' ')); };
  try { return await import(`${CLAUDE_URL}?reaper=${++seq}`); } finally { console.error = orig; }
}

const recordedPids = () => (readRegistry(SB)?.entries ?? []).map((e) => e.pid);
const lastSpawnPid = () => SB.spawns().at(-1)?.pid ?? null;

/** 每个用例一个独立沙箱；驱动与孤儿的收尸放在 finally 里（只收这个沙箱记录过的 pid） */
async function inWorld(name, fn) {
  const sb = makeSandbox(`reaper-${name}`);
  const drivers = [];
  const startDriver = async (opts) => {
    const d = await startReapDriver(sb, opts);
    drivers.push(d);
    return d;
  };
  try {
    return await fn(sb, startDriver);
  } finally {
    for (const d of drivers) d.kill9();
    sb.cleanup(); // reapAll：假 CLI（含孤儿、孙进程）
  }
}

/** 孤儿被 1 号进程收养了吗；等不到就让这个用例跳过（环境没有「孤儿归 1 号」的语义，本机验证不了） */
async function orphaned(t, pid) {
  if (await waitPpid1(pid, 3000)) return true;
  t.skip('孤儿 3 秒内没有被 1 号进程收养（环境可能有 subreaper）：这一条没法在本机验证');
  return false;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** ps lstart（TZ=UTC、LC_ALL=C 写法）加一天，仍写成 ps 的写法 */
function plusOneDay(lstart) {
  const m = /^\w{3} (\w{3})\s+(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(String(lstart).trim());
  assert.ok(m, 'lstart 的写法认不出来');
  const d = new Date(Date.UTC(Number(m[6]), MONTHS.indexOf(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) + 86_400_000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** 下一代：全新的登记簿实例（内存表是空的），读同一份记录文件 */
const nextGeneration = (file, log) => createChildRegistry({ file, log });

// ---------------------------------------------------------------------------------------------
describe('B1–B6 真进程：上一代被强杀之后的清理', { skip: IS_WIN ? 'Windows 没有进程组语义' : false }, () => {
  test('B1 端到端：驱动被 SIGKILL → 孤儿被 1 号进程收养 → 下次启动整组清掉，记录清空，日志只有一行个数', { timeout: 40_000 }, async (t) => {
    await inWorld('b1', async (sb, startDriver) => {
      const drv = await startDriver();
      const { childPid, grandchildPid } = drv.ready;
      const file = registryFileOf(sb);

      // 真实 runClaude 在 spawn 时写了记录：权限 0600、有这个子进程的一条（pgid == pid）
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, '记录文件权限必须是 0600');
      const before = readRegistry(sb);
      assert.equal(before.version, 1);
      const mine = before.entries.filter((e) => e.pid === childPid);
      assert.equal(mine.length, 1, '驱动起的那个 claude 子进程在记录里');
      assert.equal(mine[0].pgid, childPid);
      assert.ok(typeof mine[0].lstart === 'string' && mine[0].lstart.length > 0);

      // 强杀驱动：它没机会清理子进程
      drv.kill9();
      const ended = await within(drv.exited, 5000, '驱动退出');
      assert.equal(ended.signal, 'SIGKILL');
      if (!(await orphaned(t, childPid))) return;
      assert.ok(alive(childPid), '驱动死了，claude 子进程还活着（这就是要清的东西）');
      assert.ok(alive(grandchildPid), '它的同组孙进程也还活着');

      // 下一代启动
      const lines = logSink();
      const r = nextGeneration(file, lines).reapPrevious({ log: lines, escalateMs: 500 });
      assert.deepEqual(r, { killed: 1, dropped: 0, unreadable: false });
      assert.deepEqual(await waitGone([childPid, grandchildPid], 3000), [], '整组（含孙进程）都没了');
      assert.deepEqual(readRegistry(sb).entries, [], '记录清空');
      assert.equal(lines.lines.length, 1, `只记一行个数：${JSON.stringify(lines.lines)}`);
      assert.match(lines.lines[0], /已结束 1 组；记录对不上、只删记录 0 条/);
      assert.ok(!lines.lines[0].includes(String(childPid)), '日志里没有 pid');
    });
  });

  test('B2 领头进程忽略 SIGTERM：到点补 SIGKILL，整组照样清掉', { timeout: 40_000 }, async (t) => {
    await inWorld('b2', async (sb, startDriver) => {
      const drv = await startDriver({ ignoreTerm: true });
      const { childPid, grandchildPid } = drv.ready;
      drv.kill9();
      await within(drv.exited, 5000, '驱动退出');
      if (!(await orphaned(t, childPid))) return;

      const lines = logSink();
      const t0 = Date.now();
      const r = nextGeneration(registryFileOf(sb), lines).reapPrevious({ log: lines, escalateMs: 500 });
      const took = Date.now() - t0;
      assert.deepEqual(r, { killed: 1, dropped: 0, unreadable: false });
      assert.ok(took >= 400, `SIGTERM 杀不掉它，所以要等满 escalateMs 才补刀（实际 ${took}ms）`);
      assert.deepEqual(await waitGone([childPid, grandchildPid], 3000), [], 'SIGKILL 之后整组都没了');
    });
  });

  test('B3 pid 被别的进程复用（记录里的启动时间对不上）：只删记录，不碰进程', { timeout: 30_000 }, async (t) => {
    await inWorld('b3', async (sb) => {
      const orphan = await spawnOrphan(sb, MARKED_ARGS, 'b3');
      if (!(await orphaned(t, orphan))) return;
      const file = registryFileOf(sb);
      const lines = logSink();
      assert.equal(nextGeneration(file, lines).add(orphan), true, '带着真实的启动时间登记');

      // 把记录里的启动时间改成「一天以后」：等于记录的是另一个进程、pid 被后来者复用
      const rec = readRegistry(sb);
      assert.equal(rec.entries.length, 1);
      rec.entries[0].lstart = plusOneDay(rec.entries[0].lstart);
      fs.writeFileSync(file, JSON.stringify(rec));

      const r = nextGeneration(file, lines).reapPrevious({ log: lines, escalateMs: 500 });
      assert.deepEqual(r, { killed: 0, dropped: 1, unreadable: false });
      await sleep(1000); // escalateMs + 500ms：真要补刀的话早补完了
      assert.ok(alive(orphan), '启动时间对不上：进程不能动');
      assert.deepEqual(readRegistry(sb).entries, [], '记录删了');
    });
  });

  test('B4 命令行不带 claude 的调用形态：只删记录，不碰进程', { timeout: 30_000 }, async (t) => {
    await inWorld('b4', async (sb) => {
      const orphan = await spawnOrphan(sb, UNMARKED_ARGS, 'b4'); // 命令行里没有 -p --output-format stream-json --verbose
      if (!(await orphaned(t, orphan))) return;
      const file = registryFileOf(sb);
      const lines = logSink();
      assert.equal(nextGeneration(file, lines).add(orphan), true, '带着真实的启动时间登记（pgid、启动时间都对得上，只有形态不对）');
      assert.ok(!/stream-json/.test(psRow(orphan).command), '前提：这个孤儿的命令行确实不带形态标记');

      const r = nextGeneration(file, lines).reapPrevious({ log: lines, escalateMs: 500 });
      assert.deepEqual(r, { killed: 0, dropped: 1, unreadable: false });
      await sleep(1000);
      assert.ok(alive(orphan), '形态对不上：进程不能动');
    });
  });

  test('B5 另一个桥接还活着：它的 claude 子进程（父进程不是 1）不被牵连——只清自己记录里的孤儿；伪造的记录也不行', { timeout: 60_000 }, async (t) => {
    await inWorld('b5-other', async (sbOther, startOther) => {
      const other = await startOther(); // 「另一个桥接」：活着，它的 claude 子进程的父进程是它
      const otherChild = other.ready.childPid;
      const otherGrandchild = other.ready.grandchildPid;
      const otherRow = psRow(otherChild);
      assert.equal(otherRow.ppid, other.ready.driverPid, '前提：另一个桥接的子进程父进程是那个桥接，不是 1');
      assert.equal(otherRow.pgid, otherChild);

      await inWorld('b5-ours', async (sbOurs, startOurs) => {
        const ours = await startOurs();
        const { childPid, grandchildPid } = ours.ready;
        assert.deepEqual(readRegistry(sbOurs).entries.map((e) => e.pid), [childPid], '前提：我们的记录里只有我们自己的那一个');
        ours.kill9();
        await within(ours.exited, 5000, '我们的驱动退出');
        if (!(await orphaned(t, childPid))) return;
        const file = registryFileOf(sbOurs);

        // (a) 只清自己记录里的孤儿，另一个桥接的子进程毫发无伤
        const lines = logSink();
        const a = nextGeneration(file, lines).reapPrevious({ log: lines, escalateMs: 500 });
        assert.deepEqual(a, { killed: 1, dropped: 0, unreadable: false });
        assert.deepEqual(await waitGone([childPid, grandchildPid], 3000), [], '我们的孤儿清掉了');
        assert.ok(alive(otherChild) && alive(otherGrandchild), '另一个桥接的 claude 子进程与孙进程都活着');

        // (b) 记录被伪造成指向「别人的活子进程」，pid、进程组、启动时间、命令形态全都对得上，只有父进程不是 1
        fs.writeFileSync(file, JSON.stringify({
          version: 1,
          entries: [{ pid: otherChild, pgid: otherChild, lstart: otherRow.lstart, spawnedAt: new Date().toISOString() }],
        }));
        const b = nextGeneration(file, lines).reapPrevious({ log: lines, escalateMs: 500 });
        assert.deepEqual(b, { killed: 0, dropped: 1, unreadable: false }, '父进程不是 1：只删记录');
        await sleep(1000);
        assert.ok(alive(otherChild) && alive(otherGrandchild), '父进程不是 1 的进程不能动');
        assert.deepEqual(readRegistry(sbOurs).entries, []);
      });

      // 收尾：让「另一个桥接」正常停（SIGTERM → process.exit → claude.js 的退出监听把它的进程组一起收掉）
      other.term();
      assert.deepEqual(await waitGone([otherChild, otherGrandchild, other.ready.driverPid], 5000), [], '另一个桥接正常停：子进程、孙进程、驱动都没了');
    });
  });

  test('B6 记录文件损坏（里面有一个真孤儿的 pid）：一个都不杀，只记一行，正常返回', { timeout: 30_000 }, async (t) => {
    await inWorld('b6', async (sb) => {
      const orphan = await spawnOrphan(sb, MARKED_ARGS, 'b6');
      if (!(await orphaned(t, orphan))) return;
      const file = registryFileOf(sb);
      fs.writeFileSync(file, `{"version":1,"entries":[{"pid":${orphan},"pgid":${orphan},"lstart":"Fri Nov 20 03:`); // 写到一半就断了的 JSON

      const lines = logSink();
      const r = nextGeneration(file, lines).reapPrevious({ log: lines, escalateMs: 500 });
      assert.deepEqual(r, { killed: 0, dropped: 0, unreadable: true });
      assert.equal(lines.lines.length, 1, `只记一行：${JSON.stringify(lines.lines)}`);
      assert.match(lines.lines[0], /记录损坏/);
      assert.ok(!lines.lines[0].includes(String(orphan)), '日志里没有 pid');
      await sleep(800);
      assert.ok(alive(orphan), '记录读不懂：不能凭残缺的内容去杀进程');
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('B7–B9 本进程里的真实 runClaude：登记簿的运行时行为', { skip: IS_WIN ? 'Windows 没有进程组语义' : false }, () => {
  test('B7 本进程自己刚起、还在跑的 claude：启动清理不动它，记录也不删；取消落定之后记录才没', { timeout: 40_000 }, async () => {
    const m = await load();
    SB.plan({ events: [init('s-b7')], hang: true, hangMs: 20_000 });
    const key = 'oc_b7';
    const p = settle(m.runClaude(key, 'hi', true, [], null));
    const pid = await waitFor(lastSpawnPid, 8000, '假 CLI 启动');
    assert.ok(recordedPids().includes(pid), '进行中：记录文件里有它');

    // 同一个登记簿（同一份记录文件）再来一次启动清理：它是本进程自己登记、还没收尾的
    const lines = logSink();
    const r = childRegistryFor(registryFileOf(SB)).reapPrevious({ log: lines, escalateMs: 300 });
    assert.deepEqual(r, { killed: 0, dropped: 0, unreadable: false }, '本进程自己的条目既不杀也不算「记录对不上」');
    assert.ok(alive(pid), '它还在跑');
    assert.ok(recordedPids().includes(pid), '记录还在');

    assert.equal(m.cancelRun(key), true);
    const res = await within(p, 10_000, 'B7 取消落定');
    assert.equal(res.ok, false);
    assert.match(res.e.message, /CANCELLED/);
    assert.ok(!recordedPids().includes(pid), '落定之后记录没了');
  });

  test('B8 记录文件的位置被一个目录占着（写不进去）：这一轮照常出答案，写失败的日志至多一行，不留临时文件', { timeout: 30_000 }, async () => {
    const m = await load();
    const file = registryFileOf(SB);
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    const failLines = () => REG_LINES.filter((l) => l.includes('子进程记录写不进去'));
    const before = failLines().length;
    try {
      SB.plan(okPlan('s-b8', '答案8'));
      const r = await within(settle(m.runClaude('oc_b8', 'hi', true, [], null)), 15_000, 'B8');
      assert.equal(r.ok, true, r.e?.message);
      assert.equal(r.v, '答案8');
    } finally {
      fs.rmSync(file, { recursive: true, force: true }); // 还原：后面的用例要正常写
    }
    const added = failLines().slice(before);
    // 登记与摘除各写了一次、两次都写不进去，只记一次；「恰好一行」同时证明写失败这条路确实走到了（这是本文件里唯一让写失败的用例）
    assert.equal(added.length, 1, `写失败的日志至多一行：${JSON.stringify(added)}`);
    for (const l of added) assert.ok(!l.includes(SB.root), '日志里不带路径');
    assert.deepEqual(fs.readdirSync(SB.data).filter((n) => n.endsWith('.tmp')), [], '写失败不留临时文件');
  });

  describe('B9 每一种收尾都会摘掉自己的记录', () => {
    test('正常结束', { timeout: 30_000 }, async () => {
      const m = await load();
      SB.plan(okPlan('s-9a', '答案9a', { delayMs: 600 })); // 先等 600ms 才出答案：进行中的记录读得到
      const p = settle(m.runClaude('oc_b9a', 'hi', true, [], null));
      const pid = await waitFor(lastSpawnPid, 8000, '假 CLI 启动');
      assert.ok(recordedPids().includes(pid), '进行中：记录在');
      const r = await within(p, 15_000, 'B9 正常');
      assert.equal(r.ok, true, r.e?.message);
      assert.equal(r.v, '答案9a');
      assert.ok(!recordedPids().includes(pid), '正常结束：记录没了');
    });

    test('错误 result', { timeout: 30_000 }, async () => {
      const m = await load();
      SB.plan({ delayMs: 600, events: [init('s-9b'), errResult('API Error: 400 bad request', 's-9b')], exit: 1 });
      const p = settle(m.runClaude('oc_b9b', 'hi', true, [], null));
      const pid = await waitFor(lastSpawnPid, 8000, '假 CLI 启动');
      assert.ok(recordedPids().includes(pid), '进行中：记录在');
      const r = await within(p, 15_000, 'B9 错误 result');
      assert.equal(r.ok, false);
      assert.match(r.e.message, /400/);
      assert.ok(!recordedPids().includes(pid), '错误 result：记录没了');
    });

    test('cancelRun', { timeout: 30_000 }, async () => {
      const m = await load();
      SB.plan({ events: [init('s-9c')], hang: true, hangMs: 20_000 });
      const key = 'oc_b9c';
      const p = settle(m.runClaude(key, 'hi', true, [], null));
      const pid = await waitFor(lastSpawnPid, 8000, '假 CLI 启动');
      assert.ok(recordedPids().includes(pid), '进行中：记录在');
      assert.equal(m.cancelRun(key), true);
      const r = await within(p, 10_000, 'B9 取消');
      assert.equal(r.ok, false);
      assert.match(r.e.message, /CANCELLED/);
      assert.ok(!recordedPids().includes(pid), '取消：记录没了');
    });

    test('空闲超时（小阈值实例）', { timeout: 30_000 }, async () => {
      const m = await load({ CLAUDE_IDLE_TIMEOUT_MS: '600' });
      SB.plan({ events: [], hang: true, hangMs: 20_000 }); // 一个事件都不出
      const p = settle(m.runClaude('oc_b9d', 'hi', true, [], null));
      const pid = await waitFor(lastSpawnPid, 8000, '假 CLI 启动');
      assert.ok(recordedPids().includes(pid), '进行中：记录在');
      const r = await within(p, 15_000, 'B9 空闲超时');
      assert.equal(r.ok, false);
      assert.match(r.e.message, /超时/);
      assert.ok(!recordedPids().includes(pid), '空闲超时：记录没了');
    });

    test('结果宽限到期（小宽限实例）', { timeout: 30_000 }, async () => {
      const m = await load({ CLAUDE_RESULT_GRACE_MS: '1000' });
      SB.plan(okPlan('s-9e', '宽限答案', { hang: true, hangMs: 20_000 })); // 结果出了、进程不退
      const cap = captureConsole(); // 宽限到期那一行是 console.log
      try {
        const p = settle(m.runClaude('oc_b9e', 'hi', true, [], null));
        const pid = await waitFor(lastSpawnPid, 8000, '假 CLI 启动');
        assert.ok(recordedPids().includes(pid), '进行中：记录在');
        const r = await within(p, 15_000, 'B9 宽限到期');
        assert.equal(r.ok, true, r.e?.message);
        assert.equal(r.v, '宽限答案');
        assert.ok(cap.lines.some((l) => /结果已到但进程/.test(l)), '前提：确实是走宽限到期收尾的');
        assert.ok(!recordedPids().includes(pid), '宽限到期：记录没了');
      } finally {
        cap.restore();
      }
    });
  });
});
