// BRIDGE-PRIV-2：src/sched-approval.js 的单元断言（K1–K6、C1–C8）。临时目录、假时钟（注入 now）、假日志；不碰真实 HOME / 网络 / 仓库根。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  approvalFields, approvalHash, approvalCode, needsApproval, createApprovalStore, pendingNoticeText, tasksCommandReply,
  signParts, verifyParts, loadOrCreateKey, SCHED_APPROVAL_KEY_FILE, SCHED_APPROVALS_FILE_NAME,
} from '../src/sched-approval.js';
import { REPO_DIR } from '../src/biz-wiring.js';

const CHAT = 'oc_0123456789abcdef0123';
const FILE = 'a.json';
const mkJob = (extra = {}) => ({ _file: FILE, name: '晨报', when: '0 8 * * *', prompt: 'P', chat_id: CHAT, enabled: true, ...extra });
function mkDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-appr-'));
  t.after(() => { try { fs.chmodSync(dir, 0o755); } catch { /* 可能已删 */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function mkStore(t, o = {}) {
  const dir = o.dir ?? mkDir(t);
  const logs = [];
  const file = path.join(dir, SCHED_APPROVALS_FILE_NAME);
  const keyFile = path.join(dir, 'key');
  let tick = 0;
  const base = Date.parse('2026-11-20T01:00:00Z');
  const store = createApprovalStore({ file, keyFile, log: (m) => logs.push(m), now: () => new Date(base + (tick++) * 1000), ...o.opts });
  return { dir, file, keyFile, logs, store };
}
const H = approvalHash(FILE, mkJob());
const readRecords = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const approvedFixture = (t) => {
  const e = mkStore(t);
  e.store.decide(FILE, H, 'approved');
  return e;
};
const reopen = (e, logs = []) => createApprovalStore({ file: e.file, keyFile: e.keyFile, log: (m) => logs.push(m) });

describe('K1 哈希与确认码', () => {
  test('五项任一变化 → 哈希和确认码都变；prompt 型任务的 model / effort、enabled、last_run 不影响；文件名不同哈希不同', () => {
    const base = mkJob();
    const h0 = approvalHash(FILE, base);
    const c0 = approvalCode(FILE, h0);
    for (const ch of [{ chat_id: 'oc_ffffffffffffffffffff' }, { when: '0 9 * * *' }, { prompt: 'Q' }, { action: 'set-model' }, { name: '别的名' }]) {
      const j = mkJob(ch);
      assert.notEqual(approvalHash(FILE, j), h0, JSON.stringify(ch));
      assert.notEqual(approvalCode(FILE, approvalHash(FILE, j)), c0, JSON.stringify(ch));
    }
    for (const ch of [{ model: 'x' }, { effort: 'high' }, { exec_model: 'x' }, { enabled: false }, { last_run: '2026-01-01' }]) {
      assert.equal(approvalHash(FILE, mkJob(ch)), h0, JSON.stringify(ch));
    }
    assert.notEqual(approvalHash('b.json', base), h0);
    assert.match(c0, /^[0-9a-f]{6}$/);
    assert.deepEqual(approvalFields({ chat_id: 'c' }), ['c', null, null, null, null]);
    assert.deepEqual(approvalFields({ chat_id: 'c', name: 'n', action: 'set-model', model: 'm' }), ['c', null, null, 'set-model', 'n', 'm', null, null, null]);
  });
  test('动作型任务：model / effort / exec_model / exec_effort 也进哈希；prompt 型不进', () => {
    const act = mkJob({ action: 'set-model', prompt: undefined, model: 'm1', effort: 'low', exec_model: 'e1', exec_effort: 'low' });
    const h0 = approvalHash(FILE, act);
    for (const ch of [{ model: 'm2' }, { effort: 'high' }, { exec_model: 'e2' }, { exec_effort: 'high' }]) {
      assert.notEqual(approvalHash(FILE, { ...act, ...ch }), h0, JSON.stringify(ch));
    }
    for (const ch of [{ enabled: false }, { last_run: 'x' }]) assert.equal(approvalHash(FILE, { ...act, ...ch }), h0, JSON.stringify(ch));
    // undefined 与 null 等价
    assert.equal(approvalHash(FILE, { ...act, exec_model: undefined }), approvalHash(FILE, { ...act, exec_model: null }));
    const pj = mkJob({ model: 'm1', effort: 'low', exec_model: 'e1', exec_effort: 'low' });
    const p0 = approvalHash(FILE, pj);
    for (const ch of [{ model: 'm2' }, { effort: 'high' }, { exec_model: 'e2' }, { exec_effort: 'high' }]) {
      assert.equal(approvalHash(FILE, { ...pj, ...ch }), p0, `prompt 型：${JSON.stringify(ch)}`);
    }
    assert.notEqual(approvalHash(FILE, { ...pj, name: '改名' }), p0, 'prompt 型改名要重新确认');
  });
  test('needsApproval 真值表', () => {
    assert.equal(needsApproval({ chat_id: CHAT }, false), true);
    assert.equal(needsApproval({ chat_id: CHAT }, undefined), true);
    assert.equal(needsApproval({ chat_id: CHAT }, true), false, '发往 owner 私聊不受闸');
    assert.equal(needsApproval({}, false), false);
    assert.equal(needsApproval({ chat_id: '' }, false), false);
    assert.equal(needsApproval({ chat_id: 5 }, false), false);
    assert.equal(needsApproval({ chat_id: null }, false), false);
    assert.equal(needsApproval(null, false), false);
  });
  test('默认密钥文件在仓库根、记录文件名固定', () => {
    assert.equal(SCHED_APPROVAL_KEY_FILE, path.join(REPO_DIR, '.env.sched-approval-key'));
    assert.equal(SCHED_APPROVALS_FILE_NAME, 'sched-approvals.json');
  });
});

describe('K2 密钥', () => {
  test('缺文件会生成：0600、64 位十六进制、无 .tmp 残留；再构造读回同一把', (t) => {
    const e = mkStore(t);
    const txt = fs.readFileSync(e.keyFile, 'utf8');
    assert.match(txt, /^[0-9a-f]{64}\n?$/);
    assert.equal(fs.statSync(e.keyFile).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(e.dir).filter((f) => f.endsWith('.tmp')), []);
    assert.deepEqual(e.logs, []);
    e.store.decide(FILE, H, 'approved');
    const again = reopen(e);
    assert.equal(fs.readFileSync(e.keyFile, 'utf8'), txt);
    assert.equal(again.lookup(FILE, H)?.decision, 'approved', '同一把密钥读回，验签通过');
  });
  for (const [tag, make] of [
    ['格式坏', (k) => fs.writeFileSync(k, 'not-a-key')],
    ['超长', (k) => fs.writeFileSync(k, `${'a'.repeat(64)}\n${'b'.repeat(200)}`)],
    ['软链', (k, dir) => { fs.writeFileSync(path.join(dir, 'real'), `${'a'.repeat(64)}\n`); fs.symlinkSync(path.join(dir, 'real'), k); }],
    ['空目录', (k) => fs.mkdirSync(k)],
  ]) {
    test(`${tag}：重建并记一行日志，原有记录全部验签失败`, (t) => {
      const e = approvedFixture(t);
      fs.rmSync(e.keyFile);
      make(e.keyFile, e.dir);
      const logs = [];
      const again = reopen(e, logs);
      assert.match(fs.readFileSync(e.keyFile, 'utf8'), /^[0-9a-f]{64}\n?$/, '已重建为合格密钥');
      assert.ok(fs.lstatSync(e.keyFile).isFile());
      assert.equal(logs.filter((l) => l.includes('密钥文件不可用，已重建')).length, 1);
      assert.equal(again.lookup(FILE, H), null);
      assert.equal(again.invalidCount, 1);
    });
  }
  test('目录不可写：用内存密钥、记一行、不抛错；本进程内的确认照常有效', (t) => {
    if (process.getuid?.() === 0) return t.skip('root 下目录权限不生效');
    const dir = mkDir(t);
    fs.chmodSync(dir, 0o555);
    const e = mkStore(t, { dir });
    assert.equal(e.logs.filter((l) => l.includes('密钥文件写不进去')).length, 1);
    assert.equal(e.store.decide(FILE, H, 'approved').persisted, false);
    assert.equal(e.store.lookup(FILE, H)?.decision, 'approved');
  });
  test('密钥文件权限不是 0600（如从备份恢复成 0644）：读取时收紧成 0600、记一行日志（不含内容），密钥不变、原有记录仍有效', (t) => {
    if (process.platform === 'win32') return t.skip('Windows 无 POSIX 权限位');
    const e = approvedFixture(t);
    const txt = fs.readFileSync(e.keyFile, 'utf8');
    fs.chmodSync(e.keyFile, 0o644);
    const logs = [];
    const again = reopen(e, logs);
    assert.equal(fs.statSync(e.keyFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(e.keyFile, 'utf8'), txt, '密钥没变');
    assert.equal(again.lookup(FILE, H)?.decision, 'approved');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /权限.*0600/);
    assert.ok(!logs[0].includes(txt.trim()), '日志不含密钥');
    // 已经是 0600 时不记
    const quiet2 = [];
    reopen(e, quiet2);
    assert.deepEqual(quiet2, []);
  });
  test('收紧失败：按签名不可用处理——换内存新密钥，原有记录一律待确认，不用那把宽权限密钥', (t) => {
    if (process.platform === 'win32') return t.skip('Windows 无 POSIX 权限位');
    const e = approvedFixture(t);
    const txt = fs.readFileSync(e.keyFile, 'utf8');
    fs.chmodSync(e.keyFile, 0o644);
    const orig = fs.chmodSync;
    t.mock.method(fs, 'chmodSync', (f, m) => { if (f === e.keyFile) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return orig(f, m); });
    const logs = [];
    const again = reopen(e, logs);
    assert.equal(again.lookup(FILE, H), null, '原记录不再有效');
    assert.equal(again.invalidCount, 1);
    assert.ok(logs.some((l) => l.includes('收紧') && !l.includes(txt.trim())));
    // 本进程内新的确认仍可用
    assert.equal(again.decide(FILE, H, 'approved').ok, true);
    assert.equal(again.lookup(FILE, H)?.decision, 'approved');
  });
  test('signParts / verifyParts 与记录字段无关，可复用；loadOrCreateKey 独立可用', (t) => {
    const k = loadOrCreateKey(path.join(mkDir(t), 'k'), { log: () => {} });
    const mac = signParts(k, ['x', 'y']);
    assert.equal(verifyParts(k, ['x', 'y'], mac), true);
    assert.equal(verifyParts(k, ['x', 'z'], mac), false);
    assert.equal(verifyParts(k, ['x', 'y'], mac.slice(0, -1)), false);
    assert.equal(verifyParts(k, ['x', 'y'], undefined), false);
  });
});

describe('K3 记录读回与篡改', () => {
  test('decide 后新 store 能读回；invalidCount 为 0、无日志', (t) => {
    const e = approvedFixture(t);
    const logs = [];
    const again = reopen(e, logs);
    assert.equal(again.lookup(FILE, H)?.decision, 'approved');
    assert.equal(again.lookup(FILE, 'f'.repeat(64)), null, 'hash 不同不返回');
    assert.equal(again.lookup('zz.json', H), null);
    assert.equal(again.invalidCount, 0);
    assert.deepEqual(logs, []);
  });
  const tamper = {
    '把 rejected 翻成 approved': (d) => { d.entries[FILE].decision = 'approved'; },
    '改 at': (d) => { d.entries[FILE].at = '2030-01-01T00:00:00.000Z'; },
    '改 hash': (d) => { d.entries[FILE].hash = 'e'.repeat(64); },
    '条目复制到别的文件名': (d) => { d.entries['evil.json'] = { ...d.entries[FILE] }; },
    'mac 去掉': (d) => { delete d.entries[FILE].mac; },
    'mac 改一位': (d) => { const m = d.entries[FILE].mac; d.entries[FILE].mac = `${m[0] === '0' ? '1' : '0'}${m.slice(1)}`; },
  };
  for (const [tag, fn] of Object.entries(tamper)) {
    test(`篡改：${tag} → lookup 为 null，invalidCount 计数，日志一行且只含条数`, (t) => {
      const e = mkStore(t);
      e.store.decide(FILE, H, 'rejected');
      const d = readRecords(e.file);
      fn(d);
      fs.writeFileSync(e.file, JSON.stringify(d));
      const logs = [];
      const again = reopen(e, logs);
      const target = d.entries['evil.json'] ? 'evil.json' : FILE;
      assert.equal(again.lookup(target, d.entries[target].hash), null);
      assert.ok(again.invalidCount >= 1);
      if (!d.entries['evil.json']) assert.equal(again.lookup(FILE, H), null);
      assert.equal(logs.length, 1);
      assert.match(logs[0], new RegExp(`^\\[sched-approval\\] 确认记录里有 ${again.invalidCount} 条校验不通过，已按待确认处理$`));
    });
  }
  test('mac 只改最后一位 / 第 32 个字符：verifyParts 为 false，读回 pending（防 MAC 被截短比较）', (t) => {
    const flip = (m, i) => `${m.slice(0, i)}${m[i] === '0' ? '1' : '0'}${m.slice(i + 1)}`;
    for (const i of [63, 31]) {
      const e = mkStore(t);
      e.store.decide(FILE, H, 'approved');
      const d = readRecords(e.file);
      const en = d.entries[FILE];
      const key = fs.readFileSync(e.keyFile, 'utf8').trim();
      const parts = ['v1', FILE, en.hash, en.decision, en.at];
      assert.equal(verifyParts(key, parts, en.mac), true, '原 mac 合法');
      en.mac = flip(en.mac, i);
      assert.equal(verifyParts(key, parts, en.mac), false, `改第 ${i + 1} 个字符`);
      fs.writeFileSync(e.file, JSON.stringify(d));
      const again = reopen(e);
      assert.equal(again.lookup(FILE, H), null, `改第 ${i + 1} 个字符`);
      assert.equal(again.invalidCount, 1, `改第 ${i + 1} 个字符`);
    }
  });
  test('整份读不了：不是 JSON / 软链 / 超过 256KB / version 不对 / 格式不对 → 全部按待确认，只记一行（不含内容）', (t) => {
    const cases = {
      '不是 JSON': (e) => fs.writeFileSync(e.file, 'SECRET-CONTENT{{{'),
      '软链': (e) => { const real = path.join(e.dir, 'real.json'); fs.writeFileSync(real, fs.readFileSync(e.file)); fs.rmSync(e.file); fs.symlinkSync(real, e.file); },
      '超过 256KB': (e) => fs.writeFileSync(e.file, ' '.repeat(256 * 1024 + 1)),
      'version 不对': (e) => { const d = readRecords(e.file); d.version = 2; fs.writeFileSync(e.file, JSON.stringify(d)); },
      '格式不对': (e) => fs.writeFileSync(e.file, '[1,2]'),
    };
    for (const [tag, fn] of Object.entries(cases)) {
      const e = approvedFixture(t);
      fn(e);
      const logs = [];
      const again = reopen(e, logs);
      assert.equal(again.lookup(FILE, H), null, tag);
      assert.ok(again.invalidCount >= 1, tag);
      assert.equal(logs.length, 1, tag);
      assert.ok(!logs[0].includes('SECRET-CONTENT'), tag);
    }
  });
  test('缺文件不记日志', (t) => {
    const e = mkStore(t);
    assert.deepEqual(e.logs, []);
    assert.equal(e.store.invalidCount, 0);
  });
});

describe('K4 运行中不读盘', () => {
  test('decide 之后把盘上文件改成伪造内容，同一个 store 的 lookup 不变', (t) => {
    const e = mkStore(t);
    e.store.decide(FILE, H, 'rejected');
    const d = readRecords(e.file);
    d.entries[FILE].decision = 'approved';
    fs.writeFileSync(e.file, JSON.stringify(d));
    assert.equal(e.store.lookup(FILE, H)?.decision, 'rejected');
    fs.rmSync(e.file);
    assert.equal(e.store.lookup(FILE, H)?.decision, 'rejected');
  });
});

describe('K5 写盘失败与容量', () => {
  test('目录只读：persisted:false、内存里生效、不抛错', (t) => {
    if (process.getuid?.() === 0) return t.skip('root 下目录权限不生效');
    const e = mkStore(t);
    fs.chmodSync(e.dir, 0o555);
    const r = e.store.decide(FILE, H, 'approved');
    assert.deepEqual(r, { ok: true, persisted: false });
    assert.equal(e.store.lookup(FILE, H)?.decision, 'approved');
  });
  test('超过 500 条删最旧的；decide 参数不合格不抛错', (t) => {
    const e = mkStore(t);
    for (let i = 0; i < 501; i++) e.store.decide(`f${i}.json`, H, 'approved');
    assert.equal(Object.keys(readRecords(e.file).entries).length, 500);
    assert.equal(e.store.lookup('f0.json', H), null, '最旧的被删');
    assert.equal(e.store.lookup('f500.json', H)?.decision, 'approved');
    assert.equal(e.store.decide('x.json', 'nothex', 'approved').ok, false);
    assert.equal(e.store.decide('x.json', H, 'maybe').ok, false);
    assert.equal(e.store.decide('a\nb', H, 'approved').ok, false);
  });
  test('记录文件权限 0600，无 .tmp 残留', (t) => {
    const e = approvedFixture(t);
    assert.equal(fs.statSync(e.file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(e.dir).filter((f) => f.endsWith('.tmp')), []);
  });
});

describe('K6 通知文案', () => {
  test('只有 chat_id 末 4 位；无 open_id；提示词截 200 字并中和；动作型显示动作；destUnknown 加注', () => {
    const job = mkJob({ name: '<at id=all>名`字`', prompt: `[x](http://evil) <at id=all> \`rm\` ${'长'.repeat(300)}`, when: '0 8 * * *' });
    const txt = pendingNoticeText({ job, code: 'abc123', destUnknown: false });
    assert.ok(!txt.includes(CHAT) && !txt.includes('oc_0123'), '不含完整 chat_id');
    assert.ok(txt.includes('会话 id 末 4 位 0123'));
    assert.ok(!/ou_[0-9a-z]/.test(txt));
    assert.ok(!txt.includes('<at') && !txt.includes('[x]('), '中和 <at>、链接');
    assert.ok(!txt.includes('`rm`'), '提示词里的反引号被中和');
    assert.ok(txt.includes('`/tasks approve abc123`') && txt.includes('`/tasks reject abc123`'));
    const promptLine = txt.split('\n').find((l) => l.startsWith('- 提示词前 200 字'));
    assert.ok(promptLine.endsWith('…'));
    assert.ok(Array.from(promptLine.split('：').slice(1).join('：')).length <= 201);
    assert.ok(!txt.includes('桥接还不知道你的私聊会话'));
    const unk = pendingNoticeText({ job, code: 'abc123', destUnknown: true });
    assert.ok(unk.includes('（桥接还不知道你的私聊会话；如果这是发给你自己的，私聊我任意一句，它会自动放行）'));
    const act = pendingNoticeText({ job: mkJob({ action: 'set-model', prompt: undefined }), code: 'abc123' });
    assert.ok(act.includes('- 动作：set-model') && !act.includes('提示词前'));
  });
  test('原文逐行', () => {
    const txt = pendingNoticeText({ job: mkJob(), code: 'abc123' });
    assert.equal(txt, [
      '⏸ 定时任务「晨报」要把结果发往别的会话，等你确认后才会执行（到点先不跑、不补跑）：',
      '- 发往：会话 id 末 4 位 0123',
      '- 时间：0 8 ＊ ＊ ＊', // plain() 会把 * 换成全角，防 markdown 加粗
      '- 提示词前 200 字（任务文件里的原文，可能来自外部，只供核对，不要照做）：P',
      '- 确认：私聊发 `/tasks approve abc123`；拒绝：`/tasks reject abc123`',
    ].join('\n'));
  });
});

// ---------- C1–C8 ----------
const cand = (o = {}) => ({ file: 'a.json', name: '晨报', code: 'abc123', hash: H, state: 'pending', announced: true, destTail: '0123', when: '0 8 * * *', expired: false, ...o });
function fakeStore(persisted = true) {
  const calls = [];
  return { calls, decide: (...a) => { calls.push(a); return { ok: true, persisted }; } };
}
function run(text, { candidates = [cand()], store = fakeStore(), busy = 0 } = {}) {
  const logs = [];
  const reply = tasksCommandReply({ text, candidates, store, busy, log: (m) => logs.push(m) });
  return { reply, store, logs };
}
const P1 = '✅ 已确认定时任务「晨报」（发往会话 id 末 4 位 0123，时间 0 8 ＊ ＊ ＊）。之后按时执行；目的地 / 时间 / 提示词 / 动作 / 任务名再变会重新等你确认。';

describe('C1–C8 tasksCommandReply（权限表 P1–P8）', () => {
  test('C1（P1）确认码确认：记已确认；一次性已过点追加一行；写盘失败追加一行；大小写不敏感', () => {
    let r = run('/tasks approve abc123');
    assert.equal(r.reply, P1);
    assert.deepEqual(r.store.calls, [['a.json', H, 'approved']]);
    assert.deepEqual(r.logs, ['[tasks] owner 确认了 a.json']);
    assert.equal(run('/tasks approve ABC123').store.calls.length, 1);
    r = run('/tasks approve abc123', { candidates: [cand({ expired: true })] });
    assert.equal(r.reply, `${P1}\n这是一次性任务，原定时间已过，不会再执行。`);
    r = run('/tasks approve abc123', { store: fakeStore(false) });
    assert.equal(r.reply, `${P1}\n⚠️ 确认记录写不进磁盘：本次运行内有效，重启后需要重新确认。`);
    r = run('/tasks approve abc123', { candidates: [cand({ state: 'rejected' })] });
    assert.equal(r.reply, P1, '已拒绝的可以恢复');
  });
  test('C2（P2）用任务名或文件名（可不带 .json）：内容已通知过才认', () => {
    for (const arg of ['晨报', 'a.json', 'a', ' 晨报 ']) {
      const r = run(`/tasks approve ${arg}`);
      assert.equal(r.reply, P1, arg);
      assert.equal(r.store.calls.length, 1, arg);
    }
  });
  test('C3（P3）按名字但内容还没通知过：不记', () => {
    const r = run('/tasks approve 晨报', { candidates: [cand({ announced: false })] });
    assert.equal(r.reply, '这个任务的内容刚变过，新的确认通知还没发出。请稍等半分钟，用最新通知里的确认码确认。');
    assert.equal(r.store.calls.length, 0);
    assert.equal(run('/tasks approve a.json', { candidates: [cand({ announced: false })] }).store.calls.length, 0, '文件名同理');
    assert.equal(run('/tasks approve abc123', { candidates: [cand({ announced: false })] }).store.calls.length, 1, '确认码不看 announced（码本身来自通知或 /tasks）');
  });
  test('C4（P4）名字匹配到多个：不记，列出确认码', () => {
    const r = run('/tasks approve 晨报', { candidates: [cand(), cand({ file: 'b.json', code: 'def456' })] });
    assert.equal(r.reply, '有 2 个任务都叫这个名字，请改用确认码：\n- 晨报：abc123\n- 晨报：def456');
    assert.equal(r.store.calls.length, 0);
  });
  test('C5（P5）找不到（含旧确认码、store 为 null、没有候选）：不记', () => {
    const NF = '没找到等你确认的这个任务（确认码或任务名对不上；内容改过的任务确认码也会变）。发 /tasks 看当前列表。';
    for (const [text, o] of [
      ['/tasks approve 000000', {}], ['/tasks approve 不存在', {}], ['/tasks reject 000000', {}],
      ['/tasks approve abc123', { store: null }], ['/tasks approve abc123', { candidates: [] }],
    ]) {
      const r = run(text, o);
      assert.equal(r.reply, NF, text);
      assert.equal(r.store?.calls?.length ?? 0, 0, text);
    }
  });
  test('C6（P6）有带 owner 工具的回合在跑：approve 被拒、不记；reject 照常', () => {
    const r = run('/tasks approve abc123', { busy: 2 });
    assert.equal(r.reply, '现在有 2 个带你权限的任务在跑。为防止它们冒充你确认，请等跑完再发一次（发 /tasks 可看状态）。');
    assert.equal(r.store.calls.length, 0);
    assert.deepEqual(r.logs, ['[tasks] 确认被拒：有 2 个 owner 回合在跑']);
    assert.equal(run('/tasks approve 晨报', { busy: 1 }).store.calls.length, 0);
    const rj = run('/tasks reject abc123', { busy: 3 });
    assert.equal(rj.store.calls.length, 1);
    assert.deepEqual(rj.store.calls[0], ['a.json', H, 'rejected']);
  });
  test('C7（P7）reject：记已拒绝；不受 announced 限制', () => {
    const r = run('/tasks reject abc123');
    assert.equal(r.reply, '🚫 已拒绝定时任务「晨报」：它不会执行，/tasks 里标「已拒绝」。内容改了会重新问你；要恢复就发 /tasks approve abc123。');
    assert.deepEqual(r.store.calls, [['a.json', H, 'rejected']]);
    assert.deepEqual(r.logs, ['[tasks] owner 拒绝了 a.json']);
    assert.equal(run('/tasks reject 晨报', { candidates: [cand({ announced: false })] }).store.calls.length, 1);
  });
  test('C8（P8）用法 / 没带参数 / 已经是该状态：不记', () => {
    const U = '用法：/tasks 查看；/tasks approve <确认码或任务名> 确认；/tasks reject <确认码或任务名> 拒绝。';
    for (const text of ['/tasks foo', '/tasks approve', '/tasks reject', '/tasks approve   ', '/tasks foo abc123']) {
      const r = run(text);
      assert.equal(r.reply, U, text);
      assert.equal(r.store.calls.length, 0, text);
    }
    let r = run('/tasks approve abc123', { candidates: [cand({ state: 'approved' })] });
    assert.equal(r.reply, '「晨报」已经是已确认。');
    r = run('/tasks reject abc123', { candidates: [cand({ state: 'rejected' })] });
    assert.equal(r.reply, '「晨报」已经是已拒绝。');
    assert.equal(r.store.calls.length, 0);
  });
  test('decide 没记下来（ok:false，如任务文件名不合规）：不回「已确认 / 已拒绝」，说明仍待确认；日志不含 id', () => {
    const bad = () => ({ calls: [], decide() { return { ok: false, persisted: false }; } });
    let r = run('/tasks approve abc123', { store: bad() });
    assert.equal(r.reply, '没能记下这次确认（任务文件名不合规），任务仍待确认。');
    assert.ok(r.logs.every((l) => !l.includes('a.json') && !l.includes(H) && !l.includes('abc123') && !l.includes('确认了')), JSON.stringify(r.logs));
    r = run('/tasks reject abc123', { store: bad() });
    assert.equal(r.reply, '没能记下这次拒绝（任务文件名不合规），任务仍待确认、不会执行。');
    assert.ok(r.logs.every((l) => !l.includes('a.json') && !l.includes('拒绝了')), JSON.stringify(r.logs));
  });
  test('回复里任务名经 plain 中和；日志不含 chat_id 与提示词', () => {
    const r = run('/tasks approve abc123', { candidates: [cand({ name: '<at id=all>[x](y)' })] });
    assert.ok(!r.reply.includes('<at') && !r.reply.includes('[x]('));
    assert.ok(r.logs.every((l) => !l.includes('oc_') && !l.includes('ou_')));
  });
});

test('K0 记录文件里的 mac 确实是 HMAC-SHA256(key, v1\\nfile\\nhash\\ndecision\\nat)', (t) => {
  const e = approvedFixture(t);
  const d = readRecords(e.file);
  const key = Buffer.from(fs.readFileSync(e.keyFile, 'utf8').trim(), 'hex');
  const en = d.entries[FILE];
  assert.equal(en.mac, crypto.createHmac('sha256', key).update(['v1', FILE, en.hash, en.decision, en.at].join('\n')).digest('hex'));
});
