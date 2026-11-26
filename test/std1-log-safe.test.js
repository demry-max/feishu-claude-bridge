// BRIDGE-STD-1 §3.5（C9）：tail6 / console id 兜底 / 日志文件权限收紧
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as lark from '@larksuiteoapi/node-sdk';
import { findOwnerCandidates } from '../scripts/lib/checks.js';
import { tail6, maskIds, installConsoleIdMask, tightenLogFds } from '../src/log-safe.js';

const OM = (s) => `om_${s}`; // 避免源码里出现 om_ 加 6 位以上字母数字的字面量（脱敏门）

function fakeConsole() {
  const calls = [];
  const c = {};
  for (const name of ['log', 'info', 'warn', 'error']) c[name] = (...args) => { calls.push([name, args]); };
  return { c, calls };
}

test('tail6：… 加末 6 位；空值给 ?', () => {
  assert.equal(tail6('ou_test0001'), '…st0001');
  assert.equal(tail6('abc'), '…abc');
  assert.equal(tail6(''), '?');
  assert.equal(tail6(undefined), '?');
});

test('maskIds：oc_ / ou_ / on_ 只留末 6 位，om_ 与短串不动，已截过的再过一遍不变', () => {
  assert.equal(maskIds('x oc_test0001 y'), 'x oc_…st0001 y');
  assert.equal(maskIds('ou_test0001'), 'ou_…st0001');
  assert.equal(maskIds('on_test0001'), 'on_…st0001');
  assert.equal(maskIds(OM('keep01234')), OM('keep01234'));
  assert.equal(maskIds('ou_abc'), 'ou_abc', '不足 6 位不是 id');
  const once = maskIds('ou_test0001 oc_test0002');
  assert.equal(maskIds(once), once, '幂等');
  assert.equal(maskIds('prefix_ou_test0001'), 'prefix_ou_test0001', '前面是单词字符：不是 id 的开头');
});

test('installConsoleIdMask：字符串参数脱 id，Error 取栈再脱，om_ 不动，非字符串不崩', () => {
  const { c, calls } = fakeConsole();
  installConsoleIdMask(c);
  c.log('[x] ou_test0001 说 oc_test0002', 42);
  const err = new Error('boom ou_test0003');
  c.error('[y]', err);
  c.warn(OM('keep01234'), null, undefined, { a: 'ou_test0004' }, Symbol.for('s'), 7n);
  c.info('plain');
  assert.deepEqual(calls[0], ['log', ['[x] ou_…st0001 说 oc_…st0002', 42]]);
  assert.equal(calls[1][0], 'error');
  assert.equal(typeof calls[1][1][1], 'string', 'Error 变成已脱敏的字符串');
  assert.ok(calls[1][1][1].includes('ou_…st0003') && !calls[1][1][1].includes('ou_test0003'));
  assert.equal(calls[2][1][0], OM('keep01234'));
  assert.equal(calls[2][1][1], null);
  assert.equal(calls[2][1][2], undefined);
  assert.deepEqual(calls[2][1][3], { a: 'ou_…st0004' }, '普通对象里的字符串也脱');
  assert.deepEqual(calls[3], ['info', ['plain']]);
});

test('installConsoleIdMask：没有栈的 Error 用 String(e)；重复安装只包一层；有毒的参数不让 console 抛', () => {
  const { c, calls } = fakeConsole();
  installConsoleIdMask(c);
  installConsoleIdMask(c);
  const noStack = new Error('no stack ou_test0005');
  noStack.stack = undefined;
  c.log(noStack);
  assert.equal(calls.length, 1, '只调用一次底层 console');
  assert.match(calls[0][1][0], /Error: no stack ou_…st0005/);
  const poison = new Proxy({}, { get() { throw new Error('toxic'); }, has() { throw new Error('toxic'); } });
  assert.doesNotThrow(() => c.log(poison));
  const trap = { get bad() { throw new Error('toxic'); } };
  assert.doesNotThrow(() => c.log(trap));
  assert.equal(calls.at(-1)[1][0], trap, '遍历抛错：原样交出去');
});

test('installConsoleIdMask：SDK 默认 logger 的形态（参数装在数组里、嵌套普通对象）也脱到；不改原对象、环引用不崩、类实例原样', () => {
  const { c, calls } = fakeConsole();
  installConsoleIdMask(c);
  const params = { container_id: 'oc_test0006', ou_test0007: 1 };
  const failure = { message: 'user ou_test0008', config: { url: 'https://x.invalid/chats/oc_test0006', params, data: '{"receive_id":"ou_test0009"}' }, cause: new Error('on_test0010') };
  failure.self = failure;
  class Boxed { constructor() { this.v = 'ou_test0011'; } }
  const boxed = new Boxed();
  c.log('[error]:', [[failure], { request_id: 12, boxed }]); // 与 LoggerProxy → defaultLogger 交给 console 的层次一致
  const out = calls[0][1][1];
  const seen = out[0][0];
  assert.equal(seen.message, 'user ou_…st0008');
  assert.deepEqual(seen.config, { url: 'https://x.invalid/chats/oc_…st0006', params: { container_id: 'oc_…st0006', 'ou_…st0007': 1 }, data: '{"receive_id":"ou_…st0009"}' });
  assert.ok(seen.cause.includes('on_…st0010'));
  assert.equal(seen.self, '[…]');
  assert.equal(out[1].request_id, 12);
  assert.equal(out[1].boxed, boxed, '类实例不拆');
  assert.equal(params.container_id, 'oc_test0006', '原对象不动');
  assert.equal(failure.message, 'user ou_test0008');
  let deep = 'ou_test0012';
  for (let i = 0; i < 40; i += 1) deep = [deep];
  assert.doesNotThrow(() => c.log(deep));
  assert.ok(!JSON.stringify(calls[1][1][0]).includes('ou_test0012'), '太深的部分整段不输出，不会漏出原值');
});

test('installConsoleIdMask：真实 SDK 的默认 logger 经全局 console 打出来的对象也是脱过的', () => {
  const names = ['log', 'info', 'warn', 'error'];
  const saved = names.map((n) => console[n]);
  const symbol = Symbol.for('feishu-bridge.console-id-mask');
  const seen = [];
  try {
    console.log = (...args) => { seen.push(args); };
    delete console[symbol];
    installConsoleIdMask(console);
    const client = new lark.Client({ appId: 'cli_t01', appSecret: 's' }); // 构造不联网
    seen.length = 0;
    client.logger.error([{ message: 'user ou_test0013', config: { url: 'https://x.invalid/chats/oc_test0014', params: { container_id: 'oc_test0015' } } }]);
  } finally {
    names.forEach((n, i) => { console[n] = saved[i]; });
    delete console[symbol];
  }
  const dump = JSON.stringify(seen);
  assert.ok(dump.includes('ou_…st0013') && dump.includes('oc_…st0014') && dump.includes('oc_…st0015'), dump);
  assert.ok(!/(oc|ou)_test00(13|14|15)/.test(dump), dump);
});

// §3.5 第 1 点（owner 候选换数据源）还没做：setup / doctor 仍从日志里取 owner 未登记时私聊者的完整 open_id
test('installConsoleIdMask：owner 未登记时的两种拒绝行原样保留，findOwnerCandidates 还取得到；别的行照常脱', () => {
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(index.includes('`[owner] 拒绝认领：${senderOpenId} 不在 ALLOW_USERS 名单内`'), '行的写法变了：同步改遮罩的豁免');
  assert.ok(index.includes('`[owner] owner.json 缺失且未开放认领。') && index.includes('当前请求者：${senderOpenId}`'), '行的写法变了：同步改遮罩的豁免');
  const { c, calls } = fakeConsole();
  installConsoleIdMask(c);
  c.error('[owner] 拒绝认领：ou_test0021 不在 ALLOW_USERS 名单内');
  c.error('[owner] owner.json 缺失且未开放认领。若确需重新认领……当前请求者：ou_test0022');
  c.log('[deny] ou_test0023 @ oc_test0024 不在白名单');
  c.log('[owner] 已锁定 owner open_id = ou_test0025');
  c.log('[x] 引了一句 [owner] 拒绝认领：ou_test0026');
  const text = calls.map(([, args]) => args.join(' ')).join('\n');
  assert.deepEqual(findOwnerCandidates(text), ['ou_test0022', 'ou_test0021']);
  assert.ok(!/(oc|ou)_test002[3-6]/.test(text), text);
});

test('tightenLogFds：普通文件、属于本人、权限不是 0600 → fchmod 0600；管道 / 终端 / 别人的文件 / 已是 0600 不碰', () => {
  const stats = {
    1: { isFile: () => true, uid: 501, mode: 0o100644 },
    2: { isFile: () => false, uid: 501, mode: 0o010644 },
    3: { isFile: () => true, uid: 0, mode: 0o100644 },
    4: { isFile: () => true, uid: 501, mode: 0o100600 },
  };
  const chmods = [];
  const logs = [];
  const r = tightenLogFds({ fds: [1, 2, 3, 4], fstat: (fd) => stats[fd], fchmod: (fd, m) => chmods.push([fd, m]), uid: 501, log: (s) => logs.push(s) });
  assert.deepEqual(chmods, [[1, 0o600]]);
  assert.deepEqual(r.fixed, [1]);
  assert.deepEqual(logs, []);
});

test('tightenLogFds：fchmod 失败只记一行日志、不抛；fstat 失败（fd 已关）直接略过；拿不到 uid 什么都不做', () => {
  const logs = [];
  const st = { isFile: () => true, uid: 501, mode: 0o100644 };
  const r = tightenLogFds({ fds: [1, 2], fstat: () => st, fchmod: () => { throw new Error('EPERM'); }, uid: 501, log: (s) => logs.push(s) });
  assert.equal(r.failed, 2);
  assert.equal(logs.length, 1, '两个 fd 都失败也只一行');
  assert.ok(!/\/|Users/.test(logs[0]), '不带路径');
  assert.doesNotThrow(() => tightenLogFds({ fds: [9], fstat: () => { throw new Error('EBADF'); }, uid: 501, log: () => {} }));
  const chmods = [];
  tightenLogFds({ fds: [1], fstat: () => st, fchmod: (...a) => chmods.push(a), uid: null, log: () => {} }); // null＝拿不到 uid（比如 Windows）
  assert.deepEqual(chmods, []);
});
