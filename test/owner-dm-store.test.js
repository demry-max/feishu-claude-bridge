// BRIDGE-DMID-1：owner 私聊 chat id 落盘（data/owner-dm.json），重启后定时任务立即能判出「发往 owner 私聊」。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OWNER_DM_FILE_NAME, OWNER_DM_CHAT_ID_RE, loadOwnerDm, saveOwnerDm, ownerDmBootLine, createOwnerDmRecorder,
} from '../src/owner-dm-store.js';
import { schedDestOf, SCHED_DEST_OWNER_P2P } from '../src/biz-wiring.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(REPO, 'src', 'index.js'), 'utf8');
const CHAT = 'oc_0123456789abcdef0123456789abcdef'; // 飞书 chat_id 的实际形态：oc_ + 32 位小写十六进制
const CHAT2 = 'oc_fedcba9876543210fedcba9876543210';
const OWNER = 'ou_1111aaaa2222bbbb3333cccc4444dddd';
const OTHER = 'ou_9999zzzz8888yyyy7777xxxx6666wwww';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'owner-dm-')); }
function logs() { const out = []; const log = (...a) => out.push(a.join(' ')); return { out, log }; }
const noLeak = (lines) => {
  for (const l of lines) {
    assert.ok(!l.includes('oc_'), `日志里出现了 chat id：${l}`);
    assert.ok(!l.includes('ou_'), `日志里出现了 open_id：${l}`);
  }
};

describe('owner-dm-store', () => {
  test('文件名与格式：data/owner-dm.json；只认 oc_ + 16–64 位小写字母数字', () => {
    assert.equal(OWNER_DM_FILE_NAME, 'owner-dm.json');
    assert.ok(OWNER_DM_CHAT_ID_RE.test(CHAT));
    for (const bad of ['', 'oc_', 'oc_short', `ou_${CHAT.slice(3)}`, `${CHAT}\n`, `${CHAT} `, 'oc_ABCDEF0123456789ABCD', `oc_${'a'.repeat(65)}`, 'oc_0123456789abcdef;rm', null, 42]) {
      assert.equal(OWNER_DM_CHAT_ID_RE.test(bad), false, `不该认：${JSON.stringify(bad)}`);
    }
  });

  test('落盘 → 新进程读回 → schedDestOf 判为 owner 私聊', () => {
    const dir = tmpDir();
    const file = path.join(dir, OWNER_DM_FILE_NAME);
    assert.equal(saveOwnerDm(file, CHAT, OWNER), true);
    const mod = path.join(REPO, 'src', 'owner-dm-store.js');
    const wiring = path.join(REPO, 'src', 'biz-wiring.js');
    const code = `const m = await import(${JSON.stringify(mod)}); const w = await import(${JSON.stringify(wiring)});
      const b = m.loadOwnerDm(process.argv[1], process.argv[2], { log: () => {} });
      process.stdout.write(JSON.stringify({ reason: b.reason, dest: w.schedDestOf(process.argv[3], b.chatId), destGroup: w.schedDestOf('oc_group', b.chatId) }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, file, OWNER, CHAT], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { reason: 'ok', dest: SCHED_DEST_OWNER_P2P, destGroup: 'other' });
  });

  test('写入是原子的（临时文件 + rename，不留临时文件）且权限 0600', () => {
    const dir = tmpDir();
    const file = path.join(dir, OWNER_DM_FILE_NAME);
    fs.writeFileSync(file, '{"old":1}', { mode: 0o644 });
    const ino = fs.statSync(file).ino;
    assert.equal(saveOwnerDm(file, CHAT, OWNER), true);
    const st = fs.statSync(file);
    if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600);
    assert.notEqual(st.ino, ino, '换了新 inode＝rename 进来的，不是原地改写');
    assert.deepEqual(fs.readdirSync(dir), [OWNER_DM_FILE_NAME], '不留临时文件');
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(d.chat_id, CHAT);
    assert.equal(d.owner_open_id, OWNER);
    // 源码：writeFileSync 带 0600 + wx 写临时文件，再 renameSync
    const src = fs.readFileSync(path.join(REPO, 'src', 'owner-dm-store.js'), 'utf8');
    assert.match(src, /writeFileSync\(tmp, [^)]*mode: 0o600, flag: 'wx'/);
    assert.match(src, /renameSync\(tmp, file\)/);
  });

  test('写失败（目录不存在）：返回 false、不抛、不留临时文件', () => {
    const dir = tmpDir();
    assert.equal(saveOwnerDm(path.join(dir, 'nope', OWNER_DM_FILE_NAME), CHAT, OWNER), false);
    assert.equal(saveOwnerDm(path.join(dir, OWNER_DM_FILE_NAME), 'oc_bad', OWNER), false, '格式不对不写');
    assert.equal(saveOwnerDm(path.join(dir, OWNER_DM_FILE_NAME), CHAT, ''), false, '没有 owner 不写');
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('读回：缺失 / 损坏 JSON / 格式不对 / owner 不一致 / 没有 owner / 不是普通文件 / 过大 → 未知、不抛、日志不含内容', () => {
    const dir = tmpDir();
    const file = path.join(dir, OWNER_DM_FILE_NAME);
    const cases = [
      ['missing', null, OWNER],
      ['bad-json', '{"chat_id":', OWNER],
      ['bad-json', '', OWNER],
      ['bad-format', 'null', OWNER],
      ['bad-format', '[]', OWNER],
      ['bad-format', JSON.stringify({ chat_id: 'oc_short', owner_open_id: OWNER }), OWNER],
      ['bad-format', JSON.stringify({ chat_id: `${CHAT}\n`, owner_open_id: OWNER }), OWNER],
      ['bad-format', JSON.stringify({ chat_id: 12, owner_open_id: OWNER }), OWNER],
      ['owner-mismatch', JSON.stringify({ chat_id: CHAT, owner_open_id: OTHER }), OWNER],
      ['owner-mismatch', JSON.stringify({ chat_id: CHAT }), OWNER],
      ['no-owner', JSON.stringify({ chat_id: CHAT, owner_open_id: OWNER }), ''],
      ['no-owner', JSON.stringify({ chat_id: CHAT, owner_open_id: OWNER }), null],
      ['too-big', JSON.stringify({ chat_id: CHAT, owner_open_id: OWNER, pad: 'x'.repeat(5000) }), OWNER],
    ];
    for (const [reason, body, owner] of cases) {
      fs.rmSync(file, { force: true, recursive: true });
      if (body !== null) fs.writeFileSync(file, body, { mode: 0o600 });
      const { out, log } = logs();
      const b = loadOwnerDm(file, owner, { log });
      assert.equal(b.chatId, null, `${reason}: ${body}`);
      assert.equal(b.reason, reason, `${reason}: ${body}`);
      if (reason === 'missing') assert.equal(out.length, 0, '首次安装没有文件是常态，不额外记日志');
      else assert.equal(out.length, 1, `${reason} 记一行：${out}`);
      noLeak(out);
      assert.equal(ownerDmBootLine(b), '[biz] owner 私聊目的地：未知（等 owner 私聊一次）');
    }
    // 目录 / 软链：不是普通文件
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    assert.equal(loadOwnerDm(file, OWNER, { log: () => {} }).reason, 'not-file');
    fs.rmSync(file, { recursive: true });
    const real = path.join(dir, 'real.json');
    fs.writeFileSync(real, JSON.stringify({ chat_id: CHAT, owner_open_id: OWNER }));
    fs.symlinkSync(real, file);
    assert.equal(loadOwnerDm(file, OWNER, { log: () => {} }).reason, 'not-file', '软链不跟随');
  });

  test('读回：权限不可读 → 未知、不抛', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const dir = tmpDir();
    const file = path.join(dir, OWNER_DM_FILE_NAME);
    assert.equal(saveOwnerDm(file, CHAT, OWNER), true);
    fs.chmodSync(file, 0o000);
    try {
      const { out, log } = logs();
      const b = loadOwnerDm(file, OWNER, { log });
      assert.deepEqual([b.chatId, b.reason], [null, 'unreadable']);
      assert.equal(out.length, 1);
      noLeak(out);
    } finally { fs.chmodSync(file, 0o600); }
  });

  test('读回成功：chatId 恢复，启动日志「已从落盘恢复」，不含 id', () => {
    const dir = tmpDir();
    const file = path.join(dir, OWNER_DM_FILE_NAME);
    saveOwnerDm(file, CHAT, OWNER);
    const { out, log } = logs();
    const b = loadOwnerDm(file, OWNER, { log });
    assert.deepEqual([b.chatId, b.reason], [CHAT, 'ok']);
    assert.equal(out.length, 0);
    const line = ownerDmBootLine(b);
    assert.equal(line, '[biz] owner 私聊目的地：已从落盘恢复');
    noLeak([line]);
  });

  test('recorder：值不变不重写；变了才写；owner 变了也重写；格式不对不写只记一次日志', () => {
    const dir = tmpDir();
    const file = path.join(dir, OWNER_DM_FILE_NAME);
    let writes = 0;
    const save = (...a) => { writes += 1; return saveOwnerDm(...a); };
    const { out, log } = logs();
    const rec = createOwnerDmRecorder({ file, boot: { chatId: null, reason: 'missing' }, log, save });
    rec.remember(CHAT, OWNER);
    assert.equal(writes, 1);
    assert.equal(loadOwnerDm(file, OWNER, { log: () => {} }).chatId, CHAT);
    const ino = fs.statSync(file).ino;
    for (let i = 0; i < 5; i += 1) rec.remember(CHAT, OWNER);
    assert.equal(writes, 1, '值没变不重复写盘');
    assert.equal(fs.statSync(file).ino, ino);
    rec.remember(CHAT2, OWNER);
    assert.equal(writes, 2);
    assert.equal(loadOwnerDm(file, OWNER, { log: () => {} }).chatId, CHAT2);
    rec.remember(CHAT2, OTHER);
    assert.equal(writes, 3, 'owner 变了要重写，绑定新身份');
    assert.equal(loadOwnerDm(file, OTHER, { log: () => {} }).chatId, CHAT2);
    rec.remember('oc_bad id', OTHER);
    rec.remember('oc_bad id', OTHER);
    assert.equal(writes, 3, '格式不对不写');
    assert.equal(out.length, 1, '格式不对只记一次');
    assert.equal(loadOwnerDm(file, OTHER, { log: () => {} }).chatId, CHAT2, '原记录不动');
    noLeak(out);
  });

  test('recorder：启动已从落盘恢复同一个值 → owner 再私聊不重写', () => {
    const dir = tmpDir();
    const file = path.join(dir, OWNER_DM_FILE_NAME);
    saveOwnerDm(file, CHAT, OWNER);
    const mtime = fs.statSync(file).mtimeMs;
    const boot = loadOwnerDm(file, OWNER, { log: () => {} });
    let writes = 0;
    const rec = createOwnerDmRecorder({ file, boot, log: () => {}, save: (...a) => { writes += 1; return saveOwnerDm(...a); } });
    rec.remember(CHAT, OWNER);
    assert.equal(writes, 0);
    assert.equal(fs.statSync(file).mtimeMs, mtime);
    // owner 不一致被丢弃的启动：同一个 chat id 也要重写（绑定到当前 owner）
    fs.writeFileSync(file, JSON.stringify({ chat_id: CHAT, owner_open_id: OTHER }));
    const boot2 = loadOwnerDm(file, OWNER, { log: () => {} });
    const rec2 = createOwnerDmRecorder({ file, boot: boot2, log: () => {}, save: (...a) => { writes += 1; return saveOwnerDm(...a); } });
    rec2.remember(CHAT, OWNER);
    assert.equal(writes, 1);
    assert.equal(loadOwnerDm(file, OWNER, { log: () => {} }).chatId, CHAT);
  });

  test('recorder：写失败不抛、记一行（同一个值只记一次），下一条消息再试', () => {
    const { out, log } = logs();
    let ok = false; let writes = 0;
    const rec = createOwnerDmRecorder({ file: '/x', boot: { chatId: null, reason: 'missing' }, log, save: () => { writes += 1; return ok; } });
    assert.doesNotThrow(() => rec.remember(CHAT, OWNER));
    rec.remember(CHAT, OWNER);
    assert.equal(writes, 2, '没写成功就下一条再试');
    assert.equal(out.length, 1);
    ok = true;
    rec.remember(CHAT, OWNER);
    rec.remember(CHAT, OWNER);
    assert.equal(writes, 3);
    noLeak(out);
    const boom = createOwnerDmRecorder({ file: '/x', boot: { chatId: null }, log: () => {}, save: () => { throw new Error(CHAT); } });
    assert.doesNotThrow(() => boom.remember(CHAT, OWNER));
  });

  test('/status 一行：只在 owner 私聊出现；已知（来自落盘 / 本次会话）/ 未知；不含 id', () => {
    const p2p = { isOwner: true, chatType: 'p2p' };
    const fromDisk = createOwnerDmRecorder({ file: '/x', boot: { chatId: CHAT, reason: 'ok' }, log: () => {}, save: () => true });
    assert.equal(fromDisk.statusLine(p2p), '\n- owner 私聊目的地: 已知（来自落盘）');
    fromDisk.remember(CHAT, OWNER);
    assert.equal(fromDisk.statusLine(p2p), '\n- owner 私聊目的地: 已知（来自落盘）', '同一个值仍算落盘恢复的');
    fromDisk.remember(CHAT2, OWNER);
    assert.equal(fromDisk.statusLine(p2p), '\n- owner 私聊目的地: 已知（本次会话）');
    const fresh = createOwnerDmRecorder({ file: '/x', boot: { chatId: null, reason: 'missing' }, log: () => {}, save: () => true });
    assert.equal(fresh.statusLine(p2p), '\n- owner 私聊目的地: 未知');
    fresh.remember(CHAT, OWNER);
    assert.equal(fresh.statusLine(p2p), '\n- owner 私聊目的地: 已知（本次会话）');
    fresh.remember('oc_bad id', OWNER);
    assert.equal(fresh.statusLine(p2p), '\n- owner 私聊目的地: 已知（本次会话）', '格式不对不落盘，但内存里照旧知道（同 index.js 的 ownerDmChatId）');
    for (const ctx of [{ isOwner: true, chatType: 'group' }, { isOwner: false, chatType: 'p2p' }, { isOwner: false, chatType: 'group' }, {}]) {
      assert.equal(fromDisk.statusLine(ctx), '', JSON.stringify(ctx));
    }
    noLeak([fromDisk.statusLine(p2p), fresh.statusLine(p2p)]);
  });
});

describe('index.js 接线（BRIDGE-DMID-1）', () => {
  test('启动时读回并赋给 ownerDmChatId（绑定 OWNER_OPEN_ID || loadOwner()），打一行启动日志', () => {
    assert.match(SRC, /\nconst OWNER_DM_FILE = path\.join\(DATA_DIR, OWNER_DM_FILE_NAME\);\n/);
    assert.match(SRC, /\nconst ownerDmBoot = await bootOwnerDm\(\{ file: OWNER_DM_FILE, ownerId: OWNER_OPEN_ID \|\| loadOwner\(\), keyFile: SCHED_APPROVAL_KEY_FILE, send: \(payload\) => client\.im\.v1\.message\.create\(payload\), log: console\.error \}\);/);
    assert.match(SRC, /\nlet ownerDmChatId = ownerDmBoot\.chatId;/);
    assert.match(SRC, /\nconsole\.log\(ownerDmBootLine\(ownerDmBoot\)\);\n/);
    assert.ok(SRC.indexOf('let ownerDmChatId = ownerDmBoot.chatId;') < SRC.indexOf('startScheduler({'), '定时器起来之前就已读回');
    // 仍然只有声明与 owner 私聊那一处赋值（biz-profiles 11 号的钉）
    assert.equal(SRC.match(/ownerDmChatId =/g).length, 2);
  });

  test('写入只在「已通过 owner 校验 且 p2p」那一处；整文件只有这一处 remember', () => {
    const calls = SRC.match(/ownerDm\.remember\(/g) ?? [];
    assert.equal(calls.length, 1);
    const line = "\n  if (isOwner && message.chat_type === 'p2p') ownerDmChatId = message.chat_id;\n  if (isOwner && message.chat_type === 'p2p') ownerDm.remember(message.chat_id, owner);";
    assert.ok(SRC.includes(line), '紧跟在原赋值后、同一条件');
    assert.ok(SRC.indexOf('const isOwner = senderOpenId === owner;') < SRC.indexOf(line));
    // 占位实例在 handleMessage 之前，启动段换成真的（与 dailySession 同一写法）
    assert.match(SRC, /\nlet ownerDm = \{ remember: \(\) => \{\}, statusLine: \(\) => '' \};/);
    assert.match(SRC, /\nownerDm = createOwnerDmRecorder\(\{ file: OWNER_DM_FILE, boot: ownerDmBoot, log: console\.error \}\);\n/);
    assert.ok(SRC.indexOf('ownerDm = createOwnerDmRecorder(') < SRC.indexOf('wsClient.start('), '收消息之前换成真的');
  });

  test('/status 回复末尾接 ownerDm.statusLine（只给 isOwner 与 chatType，不给 id）', () => {
    const i = SRC.indexOf("if (text === '/status')");
    const seg = SRC.slice(i, SRC.indexOf('return;', i));
    assert.match(seg, /\+ ownerDm\.statusLine\(\{ isOwner, chatType: message\.chat_type \}\)\);/);
  });

  test('行为：把 index.js 里从认 owner 到落盘的真实代码段拿出来跑——非 owner、非 p2p、未登记 owner 都不写盘', async () => {
    const start = '  let owner = OWNER_OPEN_ID || loadOwner();';
    const endMark = 'ownerDm.remember(message.chat_id, owner);';
    const a = SRC.indexOf(start);
    const b = SRC.indexOf(endMark, a);
    assert.ok(a > 0 && b > a);
    const body = SRC.slice(a, b + endMark.length);
    // eslint-disable-next-line no-new-func
    const make = new Function('scope', `return (async () => { with (scope) {\n${body}\nreturn 'reached';\n} })();`);
    const run = async ({ sender, chatType, configured = OWNER, claim = false, chatId = CHAT }) => {
      const dir = tmpDir();
      const file = path.join(dir, OWNER_DM_FILE_NAME);
      const rec = createOwnerDmRecorder({ file, boot: { chatId: null, reason: 'missing' }, log: () => {} });
      const prevClaim = process.env.ALLOW_OWNER_CLAIM;
      if (claim) process.env.ALLOW_OWNER_CLAIM = 'true'; else delete process.env.ALLOW_OWNER_CLAIM;
      const scope = {
        OWNER_OPEN_ID: configured, loadOwner: () => null, saveOwner: () => true, ALLOW_USERS: [],
        senderOpenId: sender, message: { chat_type: chatType, chat_id: chatId, message_id: 'om_1' },
        reply: async () => {}, console: { log: () => {}, error: () => {} },
        ownerDmChatId: null, ownerDm: rec, process,
      };
      try { await make(scope); } finally { if (prevClaim === undefined) delete process.env.ALLOW_OWNER_CLAIM; else process.env.ALLOW_OWNER_CLAIM = prevClaim; }
      return { written: fs.existsSync(file), mem: scope.ownerDmChatId, file };
    };
    const ok = await run({ sender: OWNER, chatType: 'p2p' });
    assert.equal(ok.written, true, 'owner 私聊：写盘');
    assert.equal(ok.mem, CHAT);
    assert.equal(loadOwnerDm(ok.file, OWNER, { log: () => {} }).chatId, CHAT);
    for (const c of [
      { sender: OWNER, chatType: 'group' },
      { sender: OTHER, chatType: 'p2p' },
      { sender: OTHER, chatType: 'group' },
      { sender: OTHER, chatType: 'p2p', configured: '' }, // 没登记 owner、没开认领：直接拒绝
      { sender: OTHER, chatType: 'p2p', configured: '', claim: true }, // 认领那一条本身回「已登记」后 return
    ]) {
      const r = await run(c);
      assert.equal(r.written, false, JSON.stringify(c));
      assert.equal(r.mem, null, JSON.stringify(c));
    }
  });
});
