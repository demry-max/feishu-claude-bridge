// BRIDGE-EV-1：按钮 / 引用回复的确定性回写（src/ledger-actions.js）。测试 7 的单元部分：
// 只改目标字段、未知字段保留、原子写（同目录临时文件 + rename）、拒绝时不改任何文件。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const { LEDGER_ACTIONS, ACTION_BY_PHRASE, ledgerButtons, readTaskRaw, addOneDay, checkActionable, appendJournal, applyLedgerAction } =
  await import('../src/ledger-actions.js');
const { validateTask } = await import('../src/heartbeat.js');

const NOW = new Date(2026, 10, 16, 10, 5); // 2026-11-16 10:05 本地
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function mkEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbl-'));
  const tasksDir = path.join(dir, 'tasks');
  const journalDir = path.join(dir, 'memory', 'journal');
  fs.mkdirSync(tasksDir, { recursive: true });
  return { dir, tasksDir, journalDir, journal: path.join(journalDir, '2026-11-16.md') };
}
const TASK = {
  title: '跟进报价单',
  status: 'open',
  next_check_at: '2026-11-16T09:00',
  escalate_after: '2026-11-18T18:00',
  created_at: '2026-11-10T09:00',
  owner_note: { who: '王总', tags: ['报价', 'Q4'] }, // 台账里不认识的字段：原样保留
  x_custom: 42,
};
const writeTask = (env, slug, obj, mode) => {
  const f = path.join(env.tasksDir, `${slug}.json`);
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  if (mode) fs.chmodSync(f, mode);
  return f;
};
const act = (env, slug, action, over = {}) =>
  applyLedgerAction({ tasksDir: env.tasksDir, journalDir: env.journalDir, slug, action, now: NOW, validate: validateTask, log: () => {}, ...over });
const leftovers = (env) => fs.readdirSync(env.tasksDir).filter((f) => f.endsWith('.tmp'));
const journalText = (env) => (fs.existsSync(env.journal) ? fs.readFileSync(env.journal, 'utf8') : '');

describe('按钮定义', () => {
  test('三个按钮的文字、样式与回传 value 逐字固定', () => {
    assert.deepEqual(LEDGER_ACTIONS, { ack: '知道了', snooze1d: '推迟一天', drop: '不做了' });
    assert.deepEqual(ACTION_BY_PHRASE, { 知道了: 'ack', 推迟一天: 'snooze1d', 不做了: 'drop' });
    assert.ok(Object.isFrozen(LEDGER_ACTIONS) && Object.isFrozen(ACTION_BY_PHRASE));
    assert.deepEqual(ledgerButtons('quote', '0123abcd'), [
      { label: '知道了', type: 'primary_filled', value: { v: 1, a: 'ack', s: 'quote', n: '0123abcd' } },
      { label: '推迟一天', type: 'default', value: { v: 1, a: 'snooze1d', s: 'quote', n: '0123abcd' } },
      { label: '不做了', type: 'danger', value: { v: 1, a: 'drop', s: 'quote', n: '0123abcd' } },
    ]);
  });
});

describe('测试 7（单元）：合法的 ack / snooze1d / drop 只改目标字段', () => {
  test('ack：台账文件一个字节都不改，journal 记一行', () => {
    const env = mkEnv();
    const f = writeTask(env, 'quote', TASK);
    const before = sha(f);
    const mtime = fs.statSync(f).mtimeMs;
    assert.deepEqual(act(env, 'quote', 'ack'), { ok: true, changed: [] });
    assert.equal(sha(f), before);
    assert.equal(fs.statSync(f).mtimeMs, mtime);
    assert.equal(journalText(env), '（桥接）光总点了『知道了』：tasks/quote.json\n');
  });

  test('snooze1d：next_check_at 与 escalate_after 各加一天、updated_at 更新，未知字段保留，原子写、保留权限位', () => {
    const env = mkEnv();
    const f = writeTask(env, 'quote', TASK, 0o600);
    const ino = fs.statSync(f).ino;
    const r = act(env, 'quote', 'snooze1d', { source: 'reply' });
    assert.deepEqual(r, { ok: true, changed: ['next_check_at', 'escalate_after', 'updated_at'] });
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(after, { ...TASK, next_check_at: '2026-11-17T09:00', escalate_after: '2026-11-19T18:00', updated_at: '2026-11-16T10:05' });
    assert.deepEqual(Object.keys(after).slice(0, Object.keys(TASK).length), Object.keys(TASK), '字段顺序不变');
    assert.ok(fs.readFileSync(f, 'utf8').endsWith('}\n'));
    assert.notEqual(fs.statSync(f).ino, ino, '换了 inode：临时文件 rename 过来，不是就地改写');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, '权限位沿用原文件');
    assert.deepEqual(leftovers(env), [], '不留临时文件');
    assert.equal(validateTask(after, 'quote').ok, true, '写回的仍是合法台账');
    assert.equal(journalText(env), '（桥接）光总回复『推迟一天』：tasks/quote.json\n');
  });

  test('snooze1d：只有 next_check_at 时只改它；两个都没有时按现在加一天写 next_check_at', () => {
    const env = mkEnv();
    const f1 = writeTask(env, 'one', { title: '只有检查时间', status: 'waiting', next_check_at: '2026-12-31T23:30' });
    assert.deepEqual(act(env, 'one', 'snooze1d'), { ok: true, changed: ['next_check_at', 'updated_at'] });
    assert.deepEqual(JSON.parse(fs.readFileSync(f1, 'utf8')),
      { title: '只有检查时间', status: 'waiting', next_check_at: '2027-01-01T23:30', updated_at: '2026-11-16T10:05' });
    const f2 = writeTask(env, 'none', { title: '没有时间', status: 'open', notes: '保留' });
    assert.deepEqual(act(env, 'none', 'snooze1d'), { ok: true, changed: ['next_check_at', 'updated_at'] });
    assert.deepEqual(JSON.parse(fs.readFileSync(f2, 'utf8')),
      { title: '没有时间', status: 'open', notes: '保留', next_check_at: '2026-11-17T10:05', updated_at: '2026-11-16T10:05' });
  });

  test('drop：只把 status 改成 dropped（加 updated_at），其余字段原样', () => {
    const env = mkEnv();
    const f = writeTask(env, 'quote', TASK);
    assert.deepEqual(act(env, 'quote', 'drop'), { ok: true, changed: ['status', 'updated_at'] });
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { ...TASK, status: 'dropped', updated_at: '2026-11-16T10:05' });
    assert.deepEqual(leftovers(env), []);
    assert.equal(journalText(env), '（桥接）光总点了『不做了』：tasks/quote.json\n');
  });

  test('journal 写不进去不影响回写本身，只记日志', () => {
    const env = mkEnv();
    const f = writeTask(env, 'quote', TASK);
    const logs = [];
    const r = act(env, 'quote', 'drop', { journalDir: null, log: (l) => logs.push(l) });
    assert.equal(r.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).status, 'dropped');
    assert.deepEqual(logs, ['[heartbeat] journal 追加失败（tasks/quote.json 的『不做了』已写回）']);
  });
});

describe('测试 7（单元）：拒绝时不改任何文件', () => {
  const snapshot = (env) => {
    const out = {};
    for (const root of [env.tasksDir, env.journalDir]) {
      if (!fs.existsSync(root)) continue;
      for (const n of fs.readdirSync(root)) {
        const p = path.join(root, n);
        out[p] = fs.lstatSync(p).isSymbolicLink() ? `link:${fs.readlinkSync(p)}` : sha(p);
      }
    }
    return out;
  };

  test('台账不存在、slug 不合规、软链、JSON 坏、字段不合法、已不在跟进、未知动作、缺校验函数', () => {
    const env = mkEnv();
    writeTask(env, 'done', { ...TASK, status: 'done' });
    writeTask(env, 'dropped', { ...TASK, status: 'dropped' });
    writeTask(env, 'broken', '{"title": "坏 JSON",');
    writeTask(env, 'notitle', { status: 'open' });
    writeTask(env, 'arr', '[1,2]');
    const outside = path.join(env.dir, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify(TASK));
    fs.symlinkSync(outside, path.join(env.tasksDir, 'link.json'));
    writeTask(env, 'quote', TASK);
    const before = snapshot(env);
    const outsideSha = sha(outside);

    const cases = [
      ['missing', 'drop', '台账不存在'],
      ['../outside', 'drop', 'slug 不合规'],
      ['a/b', 'drop', 'slug 不合规'],
      ['.hidden', 'drop', 'slug 不合规'],
      ['', 'drop', 'slug 不合规'],
      ['link', 'snooze1d', '是软链接（台账只认普通文件）'],
      ['broken', 'drop', 'JSON 解析失败'],
      ['arr', 'drop', '顶层不是 JSON 对象'],
      ['notitle', 'drop', '台账不合法（缺 title）'],
      ['done', 'snooze1d', '台账状态是 done，已不在跟进中'],
      ['dropped', 'drop', '台账状态是 dropped，已不在跟进中'],
      ['quote', 'finish', '未知动作'],
      ['quote', '__proto__', '未知动作'],
    ];
    for (const [slug, action, reason] of cases) {
      assert.deepEqual(act(env, slug, action), { ok: false, reason }, `${slug} / ${action}`);
    }
    assert.deepEqual(act(env, 'quote', 'drop', { validate: undefined }), { ok: false, reason: '缺少台账校验函数' });
    assert.deepEqual(snapshot(env), before, '台账目录、journal 都没动');
    assert.equal(sha(outside), outsideSha, '软链指向的文件没被写穿');
    assert.equal(fs.existsSync(env.journal), false, '拒绝时不记 journal');
  });

  test('写回失败（目录不可写）：返回原因，原文件不变、不记 journal', { skip: process.getuid?.() === 0 ? 'root 不受目录权限限制' : false }, () => {
    const env = mkEnv();
    const f = writeTask(env, 'quote', TASK);
    const before = sha(f);
    fs.chmodSync(env.tasksDir, 0o500);
    try {
      const r = act(env, 'quote', 'drop');
      assert.equal(r.ok, false);
      assert.match(r.reason, /^写回失败（E[A-Z]+）$/);
    } finally {
      fs.chmodSync(env.tasksDir, 0o700);
    }
    assert.equal(sha(f), before);
    assert.deepEqual(leftovers(env), []);
    assert.equal(fs.existsSync(env.journal), false);
  });

  test('checkActionable / readTaskRaw 只点原因，不回显文件内容', () => {
    const env = mkEnv();
    writeTask(env, 'secret', '{"title": "SECRET-TOKEN-xyz", ');
    const r = readTaskRaw(env.tasksDir, 'secret');
    assert.deepEqual(r, { ok: false, reason: 'JSON 解析失败' });
    writeTask(env, 'big', JSON.stringify({ ...TASK, notes: 'x'.repeat(70 * 1024) }));
    assert.deepEqual(checkActionable(env.tasksDir, 'big', validateTask), { ok: false, reason: '超过 64KB' });
    writeTask(env, 'ok', TASK);
    const c = checkActionable(env.tasksDir, 'ok', validateTask);
    assert.equal(c.ok, true);
    assert.equal(c.task.slug, 'ok');
  });
});

describe('addOneDay / appendJournal', () => {
  test('只动日期部分：跨月、跨年、闰年，时分与时区后缀原样', () => {
    assert.equal(addOneDay('2026-11-16T09:00'), '2026-11-17T09:00');
    assert.equal(addOneDay('2026-02-28T09:00'), '2026-03-01T09:00');
    assert.equal(addOneDay('2028-02-28'), '2028-02-29');
    assert.equal(addOneDay('2026-12-31T23:30'), '2027-01-01T23:30');
    assert.equal(addOneDay('2026-11-16T09:00:00+08:00'), '2026-11-17T09:00:00+08:00');
    assert.equal(addOneDay(' 2026-11-16T09:00 '), '2026-11-17T09:00');
    for (const bad of ['tomorrow', '16/11/2026', '', null, 20261116]) assert.equal(addOneDay(bad), null, String(bad));
  });

  test('appendJournal：缺结尾换行先补一个；行内换行压成空格；journalDir 为空返回 false；不跟随软链', () => {
    const env = mkEnv();
    fs.mkdirSync(env.journalDir, { recursive: true });
    fs.writeFileSync(env.journal, '## 10:00 已有内容（没有结尾换行）');
    assert.equal(appendJournal(env.journalDir, NOW, '第一行\n第二行'), true);
    assert.equal(fs.readFileSync(env.journal, 'utf8'), '## 10:00 已有内容（没有结尾换行）\n第一行 第二行\n');
    assert.equal(appendJournal(null, NOW, 'x'), false);

    const target = path.join(env.dir, 'elsewhere.md');
    fs.writeFileSync(target, 'keep\n');
    fs.symlinkSync(target, path.join(env.journalDir, '2026-11-17.md'));
    assert.equal(appendJournal(env.journalDir, new Date(2026, 10, 17, 9, 0), 'x'), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n');
  });
});
