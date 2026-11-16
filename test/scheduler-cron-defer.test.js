// cron 任务在并发已满时被延后后的补跑（BRIDGE-HB-1B 第 5 项；REVIEW-BRIDGE-HB-1 LOW-3 指出缺测）。
// scheduler-defer.test.js 只覆盖了一次性任务；cron 任务多一层「due <= last 视为已跑过」的判断，
// 旧实现先写 running 再查并发，被挡下的 cron 任务这一天的这次触发就永久丢了、状态停在 running。
// 这里用桩时钟（mock Date + setInterval）逐拍推进，不依赖 readdir 顺序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startScheduler } = await import('../src/scheduler.js');

const settle = async (cond) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
};

test('cron 任务并发已满被延后：之后每拍补跑一个，三个都在当天落 done，不停在 running、不重复触发', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cron-defer-'));
  const jobs = path.join(dir, 'jobs');
  const stateFile = path.join(dir, 'state.json');
  fs.mkdirSync(jobs, { recursive: true });
  const WHEN = '0 9 * * *';
  const NAMES = ['a', 'b', 'c'];
  const yesterday = new Date(2026, 10, 15, 9, 0).toISOString();
  const today = new Date(2026, 10, 16, 9, 0).toISOString();
  const seed = {};
  for (const name of NAMES) {
    fs.writeFileSync(path.join(jobs, `${name}.json`), JSON.stringify({ name, when: WHEN, prompt: 'x', enabled: true }));
    seed[`${name}.json`] = { at: yesterday, when: WHEN, status: 'done' }; // 已登记、昨天 9 点跑过
  }
  fs.writeFileSync(stateFile, JSON.stringify(seed));
  const saved = process.env.SCHED_MAX_CONCURRENT;
  process.env.SCHED_MAX_CONCURRENT = '1';
  // 今天 09:05：三个任务同时到点；时钟与 30s 周期 tick 都由测试推进
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: new Date(2026, 10, 16, 9, 5).getTime() });
  const fired = [];
  const h = startScheduler({ schedulesDir: jobs, stateFile, onFire: async (j) => { fired.push(j.name); } });
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const doneToday = () => NAMES.filter((n) => state()[`${n}.json`]?.status === 'done' && state()[`${n}.json`]?.at === today);
  try {
    await h.whenIdle();
    assert.equal(fired.length, 1, '并发上限 1：首拍只跑一个');
    for (const n of NAMES.filter((x) => !fired.includes(x))) {
      const rec = state()[`${n}.json`];
      assert.equal(rec.status, 'done', `被延后的 ${n} 不能先占 running 位`);
      assert.equal(rec.at, yesterday, `被延后的 ${n} 状态原样不动（否则下一拍 due <= last 被当成已跑过）`);
    }
    for (const k of [2, 3]) {
      t.mock.timers.tick(30_000);
      await settle(() => fired.length >= k && doneToday().length >= k);
      assert.equal(fired.length, k, `第 ${k} 拍补跑一个被延后的 cron 任务`);
    }
    assert.deepEqual([...fired].sort(), NAMES, '三个任务各触发一次');
    t.mock.timers.tick(30_000); // 再走一拍：都已跑过，不得重复触发
    await settle(() => false);
    assert.equal(fired.length, 3, '补跑完不重复触发');
    for (const n of NAMES) assert.deepEqual(state()[`${n}.json`], { at: today, when: WHEN, status: 'done' }, n);
  } finally {
    h.stop();
    if (saved === undefined) delete process.env.SCHED_MAX_CONCURRENT; else process.env.SCHED_MAX_CONCURRENT = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
