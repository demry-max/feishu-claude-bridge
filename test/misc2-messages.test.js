// BRIDGE-MISC-2：机器人 id 同步抛错照常重试（S01）、并发首查共享一次请求、at 节点 user_name 优先、
// 回给用户的错误说明不含本机路径（S02）。假 client、临时目录，不联网。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLAUDE_FALLBACK_BIN = '';
const { buildPrompt, describeError, stripLocalPaths } = await import('../src/messages.js');

const BOT = 'ou_bot';
let ws; let realNow; let clock; let realErr;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'misc2-msg-'));
  realNow = Date.now; clock = 5_000_000; Date.now = () => clock;
  realErr = console.error; console.error = () => {};
});
afterEach(() => {
  Date.now = realNow; console.error = realErr;
  fs.rmSync(ws, { recursive: true, force: true });
});
const mentions = [
  { key: '@_user_1', id: { open_id: BOT }, name: '机器人' },
  { key: '@_user_2', id: { open_id: 'ou_a' }, name: '张三' },
];
const textMsg = () => ({ message_id: 'om_t', message_type: 'text', content: JSON.stringify({ text: '@_user_1 请通知 @_user_2' }), mentions });
const FULL = '请通知 @张三';
const NONAME = '请通知';

describe('S01 机器人 open_id 查询', () => {
  test('M1 request 同步抛错：第一条退回全部删掉；61 秒后再调 1 次；连续 4 个 61 秒共调 4 次；buildPrompt 从不抛错', async () => {
    let calls = 0;
    const c = { request() { calls++; throw new Error('sync boom'); } };
    const first = await buildPrompt(c, textMsg(), ws);
    assert.equal(first.prompt, NONAME);
    assert.equal(calls, 1);
    await buildPrompt(c, textMsg(), ws);
    assert.equal(calls, 1, '60 秒内不再查');
    clock += 61_000;
    assert.equal((await buildPrompt(c, textMsg(), ws)).prompt, NONAME);
    assert.equal(calls, 2);
    for (let i = 0; i < 2; i++) { clock += 61_000; await buildPrompt(c, textMsg(), ws); }
    assert.equal(calls, 4);
  });

  test('M1b 同步抛错之后接口恢复：下一个 61 秒后拿到名字', async () => {
    let bad = true;
    const c = { request() { if (bad) throw new Error('sync boom'); return Promise.resolve({ bot: { open_id: BOT } }); } };
    assert.equal((await buildPrompt(c, textMsg(), ws)).prompt, NONAME);
    bad = false; clock += 61_000;
    assert.equal((await buildPrompt(c, textMsg(), ws)).prompt, FULL);
  });

  test('M2 三条带 mentions 的消息同时进来、接口挂起再放行 → 只调 1 次，三条都得到 @张三', async () => {
    let calls = 0; let release;
    const gate = new Promise((r) => { release = r; });
    const c = { request: async () => { calls++; await gate; return { bot: { open_id: BOT } }; } };
    const ps = [1, 2, 3].map(() => buildPrompt(c, textMsg(), ws));
    await new Promise((r) => setImmediate(r));
    release();
    const rs = await Promise.all(ps);
    assert.equal(calls, 1);
    for (const r of rs) assert.equal(r.prompt, FULL);
  });

  test('M3 post 的 at 节点：user_name 优先于 mentions 里同 key 的名字', async () => {
    const c = { request: async () => ({ bot: { open_id: BOT } }) };
    const msg = {
      message_id: 'om_p', message_type: 'post',
      content: JSON.stringify({ content: [[{ tag: 'at', user_id: '@_user_2', user_name: '王五' }, { tag: 'text', text: ' 好' }]] }),
      mentions: [
        { key: '@_user_1', id: { open_id: BOT }, name: '机器人' },
        { key: '@_user_2', id: { open_id: 'ou_a' }, name: '赵六' },
      ],
    };
    const b = await buildPrompt(c, msg, ws);
    assert.match(b.prompt, /@王五/);
    assert.doesNotMatch(b.prompt, /赵六/);
  });
});

describe('S02 错误说明去掉本机路径', () => {
  const PLACE = '<本机路径>';
  test('P1 各种路径写法都被换成占位；网址 / 错误码 / 飞书码 / 无路径文本逐字不变', () => {
    const cases = [
      ["ENOENT: no such file or directory, open '/Users/张 三/工作 区/a b.png'", `ENOENT: no such file or directory, open '${PLACE}'`],
      ['EACCES: permission denied, open "/tmp/x y/z.png"', `EACCES: permission denied, open "${PLACE}"`],
      ['写入 /var/data/x.png 失败', `写入 ${PLACE} 失败`],
      ['open ~/foo/bar.txt failed', `open ${PLACE} failed`],
      ["rename '/a/b' -> '/c d/e'", `rename '${PLACE}' -> '${PLACE}'`],
      ["open 'C:\\Users\\me\\a b.png'", `open '${PLACE}'`],
    ];
    for (const [msg, want] of cases) {
      const d = describeError(new Error(msg));
      assert.equal(d.kind, 'unknown');
      assert.ok(d.text.includes(PLACE), msg);
      assert.ok(!/\/(Users|tmp|var)\/|~\/|C:\\/.test(d.text), `${msg} → ${d.text}`);
    }
    assert.equal(describeError(new Error("ENOENT: x, open '/Users/张 三/工作 区/a b.png'")).text, "ENOENT: x, open '<本机路径>'");
    assert.equal(stripLocalPaths("a '/x y' b '/p q'"), "a '<本机路径>' b '<本机路径>'");
    for (const [msg, want] of cases) assert.equal(describeError(new Error(msg)).text, want);
    // 逐字不变
    for (const keep of ['GET https://open.feishu.cn/x 失败', '飞书码 99991672', '普通文本，没有路径 1/2 a/b', '未知错误']) {
      assert.equal(describeError(new Error(keep)).text, keep);
    }
    assert.equal(describeError(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' })).text, '网络暂时不可达（EHOSTUNREACH）');
    // 其他两个分支也过去路径
    assert.ok(!describeError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).text.includes('/'));
    const perm = describeError(Object.assign(new Error('x'), { response: { status: 400, data: { code: 99991672, msg: "no scope for '/Users/a/b'" } } }));
    assert.equal(perm.kind, 'permission');
    assert.ok(perm.text.includes('99991672') && perm.text.includes(PLACE) && !perm.text.includes('/Users'));
    assert.ok(perm.hint.includes('im:resource'));
  });

  test('P2 富文本只有图片、落盘抛带路径的 EACCES → unsupported 不含工作区 / 临时目录路径；file 消息落盘失败的错误经 describeError 后同样不含', async () => {
    const client = { im: { v1: { messageResource: { get: async () => ({ writeFile: async (d) => { const er = new Error(`EACCES: permission denied, open '${d}'`); er.code = 'EACCES'; throw er; } }) } } } };
    const r = await buildPrompt(client, { message_id: 'om_x', message_type: 'post', content: JSON.stringify({ content: [[{ tag: 'img', image_key: 'img_k' }]] }) }, ws);
    assert.ok(r.unsupported.includes('图片没取到'));
    assert.ok(!r.unsupported.includes(ws), r.unsupported);
    assert.ok(!r.unsupported.includes(os.tmpdir()), r.unsupported);
    assert.ok(r.unsupported.includes('<本机路径>'));
    let err;
    try {
      await buildPrompt(client, { message_id: 'om_f', message_type: 'file', content: JSON.stringify({ file_key: 'fk', file_name: 'a b.txt' }) }, ws);
    } catch (e) { err = e; }
    assert.ok(err, 'file 消息落盘失败会抛');
    const d = describeError(err);
    assert.ok(!d.text.includes(ws) && !d.text.includes(os.tmpdir()), d.text);
  });
});
