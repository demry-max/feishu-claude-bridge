// BRIDGE-PRIV-1 T6：定时任务 chat_id 格式校验（真 startScheduler + 临时目录，onFire 是桩）。
// chat_id 决定「回答发往哪、跑在哪一档」；写法不是飞书会话 id（^oc_[a-z0-9]{16,64}$）的任务不执行，并且日志只记文件名、不记值。
// 没写 chat_id 的任务行为不变（照旧被排程、执行时由 onFire 报缺）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startScheduler } = await import('../src/scheduler.js');

const localWhen = (msFromNow) => {
  const d = new Date(Date.now() + msFromNow);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const GOOD = 'oc_0123456789abcdef0123';

async function run(t, jobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-chatid-'));
  const sd = path.join(dir, 'jobs');
  fs.mkdirSync(sd, { recursive: true });
  const past = localWhen(-60_000);
  for (const [name, extra] of Object.entries(jobs)) {
    fs.writeFileSync(path.join(sd, `${name}.json`), JSON.stringify({ name, when: past, prompt: 'x', enabled: true, ...extra }));
  }
  t.mock.timers.enable({ apis: ['setInterval'] });
  const logs = [];
  const errs = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => errs.push(a.map(String).join(' '));
  const fired = [];
  let h;
  try {
    h = startScheduler({ schedulesDir: sd, stateFile: path.join(dir, 'state.json'), onFire: async (j) => { fired.push(j._file); } });
    await h.whenIdle();
  } finally {
    console.log = log;
    console.error = err;
    h?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { fired, logs, errs };
}

test('T6 chat_id 写法不对的任务不执行：oc_x / ou_… / 含空格 / 太长 / 非字符串；日志只记文件名不记值', async (t) => {
  const bad = {
    short: { chat_id: 'oc_x' },
    openid: { chat_id: 'ou_0123456789abcdef0123' },
    space: { chat_id: 'oc_0123456789abcdef 0123' },
    long: { chat_id: `oc_${'a'.repeat(65)}` },
    upper: { chat_id: 'oc_0123456789ABCDEF0123' },
    num: { chat_id: 12345 },
    obj: { chat_id: { id: GOOD } },
    arr: { chat_id: [GOOD] },
    bool: { chat_id: true },
    zero: { chat_id: 0 },
  };
  const { fired, errs } = await run(t, { ...bad, good: { chat_id: GOOD } });
  assert.deepEqual(fired, ['good.json'], '只有写法正确的触发');
  for (const name of Object.keys(bad)) {
    assert.ok(errs.includes(`[sched] 任务 ${name}.json 的 chat_id 格式不对，已跳过`), name);
  }
  const all = errs.join('\n');
  for (const v of ['oc_x', 'ou_0123', '0123456789abcdef 0123', 'aaaaaaaa', 'ABCDEF']) assert.ok(!all.includes(v), `日志不含值：${v}`);
});

test('T6 边界：长度 16 与 64 通过；15 与 65 不通过', async (t) => {
  const { fired } = await run(t, {
    min: { chat_id: `oc_${'a'.repeat(16)}` },
    max: { chat_id: `oc_${'1'.repeat(64)}` },
    under: { chat_id: `oc_${'a'.repeat(15)}` },
    over: { chat_id: `oc_${'a'.repeat(65)}` },
  });
  assert.deepEqual(fired.sort(), ['max.json', 'min.json']);
});

test('T6 没写 chat_id 的任务行为不变：照旧触发（由 onFire 报缺），不打格式不对的日志', async (t) => {
  const { fired, errs } = await run(t, { nochat: {}, good: { chat_id: GOOD } });
  assert.deepEqual(fired.sort(), ['good.json', 'nochat.json']);
  assert.ok(!errs.some((e) => e.includes('格式不对')));
});
