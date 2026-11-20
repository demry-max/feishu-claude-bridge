// BRIDGE-PRIV-3：owner-dm.json 加签名（O1–O8）。临时目录里的密钥与记录文件；send 是假的；不碰仓库根、不碰 data/。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadOwnerDm, saveOwnerDm, bootOwnerDm, createOwnerDmRecorder, ownerDmBootLine, OWNER_DM_FILE_NAME } from '../src/owner-dm-store.js';
import { loadOrCreateKey, signParts } from '../src/sched-approval.js';

const CHAT = 'oc_0123456789abcdef0123456789abcdef';
const CHAT2 = 'oc_fedcba9876543210fedcba9876543210';
const OWNER = 'ou_1111aaaa2222bbbb3333cccc4444dddd';
const OTHER = 'ou_9999zzzz8888yyyy7777xxxx6666wwww';
const TEXT_UNSIGNED = '🔐 桥接已重新记下和你的私聊会话（用来判断定时任务的结果是不是发给你本人），不用回复。';
const TEXT_TAMPERED = '⚠️ 私聊会话记录被改动过（签名对不上），已按你的账号重新记下并恢复。';
const TEXT_NEWKEY = '🔐 签名密钥是新建的，之前记下的私聊会话没法核对，已按你的账号重新记下，不用回复。';

function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'priv3-odm-'));
  const file = path.join(dir, OWNER_DM_FILE_NAME);
  const keyFile = path.join(dir, 'key');
  const out = [];
  const log = (...a) => out.push(a.join(' '));
  const key = loadOrCreateKey(keyFile, { log: () => {} });
  const sends = [];
  const sendOk = (chat = CHAT2) => async (p) => { sends.push(p); return { data: { chat_id: chat, message_id: 'om_x1' } }; };
  return { dir, file, keyFile, out, log, key, sends, sendOk, rm: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const noLeak = (lines) => { for (const l of lines) assert.ok(!/oc_|ou_|om_/.test(l), `泄漏：${l}`); };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('O1 签名读写', () => {
  test('带 key 写入有 mac、读回 ok；mac 绑定 chat_id / owner / saved_at；不带 key 与以前逐字相同', () => {
    const e = env();
    try {
      assert.equal(saveOwnerDm(e.file, CHAT, OWNER, { key: e.key }), true);
      const d = read(e.file);
      assert.deepEqual(Object.keys(d), ['chat_id', 'owner_open_id', 'saved_at', 'mac']);
      assert.match(d.mac, /^[0-9a-f]{64}$/);
      assert.equal(d.mac, signParts(e.key, ['owner-dm/v1', CHAT, OWNER, d.saved_at]));
      assert.deepEqual(loadOwnerDm(e.file, OWNER, { log: e.log, key: e.key }), { chatId: CHAT, ownerId: OWNER, reason: 'ok' });
      assert.deepEqual(e.out, []);
      // 不带 key：没有 mac；不传 key 读也是 ok（老调用方）
      assert.equal(saveOwnerDm(e.file, CHAT, OWNER), true);
      assert.deepEqual(Object.keys(read(e.file)), ['chat_id', 'owner_open_id', 'saved_at']);
      assert.equal(loadOwnerDm(e.file, OWNER, { log: e.log }).reason, 'ok');
    } finally { e.rm(); }
  });
  test('原子写保持：0600、不留临时文件', () => {
    const e = env();
    try {
      saveOwnerDm(e.file, CHAT, OWNER, { key: e.key });
      if (process.platform !== 'win32') assert.equal(fs.statSync(e.file).mode & 0o777, 0o600);
      assert.deepEqual(fs.readdirSync(e.dir).filter((n) => n.endsWith('.tmp')), []);
    } finally { e.rm(); }
  });
});

describe('O2–O3 读回时不采信的几种情况', () => {
  const cases = [
    ['unsigned：老记录没有 mac', (e) => saveOwnerDm(e.file, CHAT, OWNER), 'unsigned'],
    ['bad-sig：改 chat_id', (e) => { saveOwnerDm(e.file, CHAT, OWNER, { key: e.key }); const d = read(e.file); d.chat_id = CHAT2; fs.writeFileSync(e.file, JSON.stringify(d)); }, 'bad-sig'],
    ['bad-sig：改 owner_open_id', (e) => { saveOwnerDm(e.file, CHAT, OWNER, { key: e.key }); const d = read(e.file); d.owner_open_id = OTHER; fs.writeFileSync(e.file, JSON.stringify(d)); }, 'bad-sig'],
    ['bad-sig：改 saved_at', (e) => { saveOwnerDm(e.file, CHAT, OWNER, { key: e.key }); const d = read(e.file); d.saved_at = '2000-01-01T00:00:00.000Z'; fs.writeFileSync(e.file, JSON.stringify(d)); }, 'bad-sig'],
    ['bad-sig：mac 不是 64 位十六进制', (e) => { saveOwnerDm(e.file, CHAT, OWNER, { key: e.key }); const d = read(e.file); d.mac = 'zz'; fs.writeFileSync(e.file, JSON.stringify(d)); }, 'bad-sig'],
    ['bad-sig：saved_at 不是字符串', (e) => { saveOwnerDm(e.file, CHAT, OWNER, { key: e.key }); const d = read(e.file); d.saved_at = 5; fs.writeFileSync(e.file, JSON.stringify(d)); }, 'bad-sig'],
    ['bad-sig：换了一把密钥', (e) => saveOwnerDm(e.file, CHAT, OWNER, { key: 'ab'.repeat(32) }), 'bad-sig'],
  ];
  for (const [name, prep, reason] of cases) {
    test(`${name} → ${reason}，chatId 为 null，日志一行且不含 id`, () => {
      const e = env();
      try {
        prep(e);
        const b = loadOwnerDm(e.file, OWNER, { log: e.log, key: e.key });
        assert.equal(b.reason, reason);
        assert.equal(b.chatId, null);
        assert.equal(e.out.length, 1);
        assert.match(e.out[0], reason === 'unsigned' ? /没有签名/ : /签名对不上/);
        noLeak(e.out);
      } finally { e.rm(); }
    });
  }
  test('O8 把确认记录的签名（第一段是 v1）换进来：bad-sig', () => {
    const e = env();
    try {
      saveOwnerDm(e.file, CHAT, OWNER, { key: e.key });
      const d = read(e.file);
      d.mac = signParts(e.key, ['v1', CHAT, OWNER, d.saved_at]);
      fs.writeFileSync(e.file, JSON.stringify(d));
      assert.equal(loadOwnerDm(e.file, OWNER, { log: () => {}, key: e.key }).reason, 'bad-sig');
    } finally { e.rm(); }
  });
});

describe('O4–O7 bootOwnerDm', () => {
  test('缺文件（首次）/ 没有签名：发一条私聊（receive_id_type=open_id），用应答里的 chat_id 恢复并签名落盘', async () => {
    for (const prep of [() => {}, (e) => saveOwnerDm(e.file, CHAT, OWNER)]) {
      const e = env();
      try {
        prep(e);
        const b = await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send: e.sendOk(), log: e.log });
        assert.equal(e.sends.length, 1);
        assert.deepEqual(e.sends[0].params, { receive_id_type: 'open_id' });
        assert.equal(e.sends[0].data.receive_id, OWNER);
        assert.equal(e.sends[0].data.msg_type, 'text');
        assert.equal(JSON.parse(e.sends[0].data.content).text, TEXT_UNSIGNED);
        assert.equal(b.chatId, CHAT2);
        assert.equal(b.reason, 'recovered');
        assert.equal(b.saved, true);
        assert.equal(b.signKey, e.key);
        assert.equal(ownerDmBootLine(b), '[biz] owner 私聊目的地：已按 owner 账号重新确认');
        const d = read(e.file);
        assert.equal(d.chat_id, CHAT2);
        assert.equal(loadOwnerDm(e.file, OWNER, { log: () => {}, key: e.key }).reason, 'ok');
        assert.ok(e.out.some((l) => l === '[owner-dm] 已按 owner 账号重新记下私聊会话'));
        noLeak(e.out);
      } finally { e.rm(); }
    }
  });
  test('签名对不上：换用「被改动过」那句；被改的 chat_id 不会被采信，落盘的是应答里的', async () => {
    const e = env();
    try {
      saveOwnerDm(e.file, CHAT, OWNER, { key: e.key });
      const d = read(e.file); d.chat_id = 'oc_attacker0000000000000000000000ff'; fs.writeFileSync(e.file, JSON.stringify(d));
      const b = await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send: e.sendOk(CHAT2), log: e.log });
      assert.equal(JSON.parse(e.sends[0].data.content).text, TEXT_TAMPERED);
      assert.equal(b.chatId, CHAT2);
      assert.equal(read(e.file).chat_id, CHAT2);
      noLeak(e.out);
    } finally { e.rm(); }
  });
  test('LOW-2 对不上的原因分开说：密钥原有 → 被改动过；密钥是这次新建的 / 只能放内存 → 新建句；没有签名 → 老的那句', async () => {
    const sentText = (e) => JSON.parse(e.sends[0].data.content).text;
    { // 密钥原有、记录被改：被改动过
      const e = env();
      try {
        saveOwnerDm(e.file, CHAT, OWNER, { key: e.key });
        const d = read(e.file); d.chat_id = 'oc_attacker0000000000000000000000ff'; fs.writeFileSync(e.file, JSON.stringify(d));
        await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send: e.sendOk(CHAT2), log: e.log });
        assert.equal(sentText(e), TEXT_TAMPERED);
      } finally { e.rm(); }
    }
    { // 密钥文件没了（这次启动新建）：记录原本是对的，也必然对不上
      const e = env();
      try {
        saveOwnerDm(e.file, CHAT, OWNER, { key: e.key });
        fs.rmSync(e.keyFile);
        const b = await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send: e.sendOk(CHAT2), log: e.log });
        assert.equal(sentText(e), TEXT_NEWKEY);
        assert.equal(b.chatId, CHAT2);
        assert.equal(loadOwnerDm(e.file, OWNER, { log: () => {}, key: b.signKey }).reason, 'ok');
      } finally { e.rm(); }
    }
    { // 密钥文件内容坏了、被重建：同样是新建句
      const e = env();
      try {
        saveOwnerDm(e.file, CHAT, OWNER, { key: e.key });
        fs.writeFileSync(e.keyFile, 'not a key');
        await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send: e.sendOk(CHAT2), log: e.log });
        assert.equal(sentText(e), TEXT_NEWKEY);
      } finally { e.rm(); }
    }
    { // 密钥写不进磁盘（路径上是非空目录）：只能用内存密钥，每次启动都对不上
      const e = env();
      try {
        saveOwnerDm(e.file, CHAT, OWNER, { key: e.key });
        fs.rmSync(e.keyFile);
        fs.mkdirSync(e.keyFile); fs.writeFileSync(path.join(e.keyFile, 'x'), '1');
        await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send: e.sendOk(CHAT2), log: e.log });
        assert.equal(sentText(e), TEXT_NEWKEY);
      } finally { e.rm(); }
    }
    { // 密钥原有、记录没有签名：老的那句（不受本条影响）
      const e = env();
      try {
        saveOwnerDm(e.file, CHAT, OWNER);
        await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send: e.sendOk(CHAT2), log: e.log });
        assert.equal(sentText(e), TEXT_UNSIGNED);
      } finally { e.rm(); }
    }
  });
  test('签名通过：不发、原样返回（带 signKey）', async () => {
    const e = env();
    try {
      saveOwnerDm(e.file, CHAT, OWNER, { key: e.key });
      const before = fs.readFileSync(e.file, 'utf8');
      const b = await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send: e.sendOk(), log: e.log });
      assert.deepEqual([b.chatId, b.reason, b.signKey, e.sends.length], [CHAT, 'ok', e.key, 0]);
      assert.equal(fs.readFileSync(e.file, 'utf8'), before);
      assert.equal(ownerDmBootLine(b), '[biz] owner 私聊目的地：已从落盘恢复');
    } finally { e.rm(); }
  });
  test('owner 换人：旧记录签名有效但 owner 不一致 → 也重新确认', async () => {
    const e = env();
    try {
      saveOwnerDm(e.file, CHAT, OTHER, { key: e.key });
      const b = await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send: e.sendOk(), log: e.log });
      assert.equal(e.sends.length, 1);
      assert.equal(e.sends[0].data.receive_id, OWNER);
      assert.equal(b.reason, 'recovered');
      assert.equal(read(e.file).owner_open_id, OWNER);
    } finally { e.rm(); }
  });
  test('没有登记 owner / owner 值不合规 / 没有 send：不发、不抛', async () => {
    for (const [ownerId, send] of [['', true], [undefined, true], ['x'.repeat(300), true], [OWNER, false]]) {
      const e = env();
      try {
        const b = await bootOwnerDm({ file: e.file, ownerId, keyFile: e.keyFile, send: send ? e.sendOk() : undefined, log: e.log });
        assert.equal(e.sends.length, 0);
        assert.equal(b.chatId, null);
        assert.equal(b.signKey, e.key);
        assert.ok(!fs.existsSync(e.file));
      } finally { e.rm(); }
    }
  });
  test('O4 send 永不返回：到时限就按未知处理，不落盘，进程不悬挂', async () => {
    const e = env();
    try {
      const t0 = Date.now();
      const b = await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send: () => new Promise(() => {}), log: e.log, timeoutMs: 30 });
      assert.ok(Date.now() - t0 < 2000);
      assert.deepEqual([b.chatId, b.signKey], [null, e.key]);
      assert.ok(!fs.existsSync(e.file));
      assert.ok(e.out.includes('[owner-dm] 重新确认私聊会话失败（超时），按未知处理'));
      noLeak(e.out);
    } finally { e.rm(); }
  });
  test('O4b 超时定时器不能 unref：send 永不返回时，独立进程里 await 仍在时限后正常走完（否则进程悬空退出）', async () => {
    const e = env();
    try {
      const mod = new URL('../src/owner-dm-store.js', import.meta.url).href;
      const code = `import(${JSON.stringify(mod)}).then(async (m) => { const b = await m.bootOwnerDm({ file: ${JSON.stringify(e.file)}, ownerId: ${JSON.stringify(OWNER)}, keyFile: ${JSON.stringify(e.keyFile)}, send: () => new Promise(() => {}), log: () => {}, timeoutMs: 100 }); console.log('DONE ' + String(b.chatId)); });`;
      const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 20_000 });
      assert.equal(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
      assert.equal(r.stdout.trim(), 'DONE null');
    } finally { e.rm(); }
  });
  test('O5 send 抛错 / 应答没有 chat_id / chat_id 形态不对：按未知，不落盘，日志不含 id', async () => {
    const sendsOf = [
      [async () => { throw new Error('boom oc_secret ou_secret'); }, '发送失败'],
      [async () => ({ data: {} }), '应答里没有可用的会话 id'],
      [async () => undefined, '应答里没有可用的会话 id'],
      [async () => ({ data: { chat_id: 'oc_BAD' } }), '应答里没有可用的会话 id'],
      [async () => ({ data: { chat_id: `${CHAT2}\n` } }), '应答里没有可用的会话 id'],
      [() => { throw new Error('sync boom'); }, '发送失败'],
    ];
    for (const [send, why] of sendsOf) {
      const e = env();
      try {
        const b = await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send, log: e.log });
        assert.equal(b.chatId, null);
        assert.ok(!fs.existsSync(e.file));
        assert.ok(e.out.includes(`[owner-dm] 重新确认私聊会话失败（${why}），按未知处理`), why);
        noLeak(e.out);
        assert.ok(!e.out.join('\n').includes('secret'));
      } finally { e.rm(); }
    }
  });
  test('O6 落盘失败：仍用应答里的 chat_id（本次运行内有效），日志注明，不抛', async () => {
    const e = env();
    try {
      const file = path.join(e.dir, 'no-such-dir', OWNER_DM_FILE_NAME);
      const b = await bootOwnerDm({ file, ownerId: OWNER, keyFile: e.keyFile, send: e.sendOk(), log: e.log });
      assert.deepEqual([b.chatId, b.reason, b.saved], [CHAT2, 'recovered', false]);
      assert.ok(e.out.includes('[owner-dm] 已按 owner 账号重新记下私聊会话（写盘失败，本次运行内有效）'));
      // 记录器：恢复了但没写进去 → 下一条 owner 私聊的 remember 会再写一次（带签名）
      const saves = [];
      const rec = createOwnerDmRecorder({ file, boot: b, log: () => {}, save: (f, c, o) => { saves.push([c, o]); return true; } });
      rec.remember(CHAT2, OWNER);
      assert.deepEqual(saves, [[CHAT2, OWNER]]);
    } finally { e.rm(); }
  });
  test('O7 记录器：恢复且已写盘 → 同值不重写；换了值 → 带 signKey 签名写；之后新进程读回 ok', async () => {
    const e = env();
    try {
      const b = await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send: e.sendOk(), log: e.log });
      const before = fs.readFileSync(e.file, 'utf8');
      const rec = createOwnerDmRecorder({ file: e.file, boot: b, log: e.log });
      rec.remember(CHAT2, OWNER);
      assert.equal(fs.readFileSync(e.file, 'utf8'), before, '值没变不写盘');
      rec.remember(CHAT, OWNER);
      assert.equal(read(e.file).chat_id, CHAT);
      assert.match(read(e.file).mac, /^[0-9a-f]{64}$/);
      assert.deepEqual(loadOwnerDm(e.file, OWNER, { log: () => {}, key: e.key }), { chatId: CHAT, ownerId: OWNER, reason: 'ok' });
      assert.equal(rec.statusLine({ isOwner: true, chatType: 'p2p' }), '\n- owner 私聊目的地: 已知（本次会话）');
    } finally { e.rm(); }
  });
  test('密钥文件在传入的位置、不在仓库根', async () => {
    const e = env();
    try {
      await bootOwnerDm({ file: e.file, ownerId: OWNER, keyFile: e.keyFile, send: e.sendOk(), log: e.log });
      assert.ok(fs.existsSync(e.keyFile));
    } finally { e.rm(); }
  });
});
