// 调度器并发已满时的「延后」语义（BRIDGE-HB-1 第 9 项 / 调研 §8.6 测试 12）。
// 旧实现先把任务标成 running、再检查并发：被挡下的那次触发在下一轮会被当成「已经跑过」
// （due <= last）直接跳过，永久丢失，状态还一直停在 running。
// 修复后被挡的任务不留占位，下一拍照常触发并落 done。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { startScheduler } = await import('../src/scheduler.js');

// 一次性任务的 when 按本地时区解析（与 bridge.test.js 同一写法）
const localWhen = (msFromNow) => {
  const d = new Date(Date.now() + msFromNow);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const settle = async (cond) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
};

test('并发已满被延后的任务下一拍触发，且不会停在 running', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-defer-'));
  const jobs = path.join(dir, 'jobs');
  const stateFile = path.join(dir, 'state.json');
  fs.mkdirSync(jobs, { recursive: true });
  const past = localWhen(-60_000);
  for (const name of ['a', 'b']) {
    fs.writeFileSync(path.join(jobs, `${name}.json`), JSON.stringify({ name, when: past, prompt: 'x', enabled: true }));
  }
  const saved = process.env.SCHED_MAX_CONCURRENT;
  process.env.SCHED_MAX_CONCURRENT = '1';
  // 只接管 setInterval：调度器的 30s 周期 tick 由测试手动推进
  t.mock.timers.enable({ apis: ['setInterval'] });
  const fired = [];
  const h = startScheduler({ schedulesDir: jobs, stateFile, onFire: async (j) => { fired.push(j.name); } });
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  try {
    await h.whenIdle();
    assert.equal(fired.length, 1, '并发上限 1：首拍只跑一个');
    const deferred = fired[0] === 'a' ? 'b.json' : 'a.json';
    assert.notEqual(state()[deferred]?.status, 'running', '被延后的任务不能先占 running 位（否则下一拍被当成已跑过）');

    t.mock.timers.tick(30_000); // 下一拍
    await settle(() => fired.length >= 2 && state()[deferred]?.status === 'done');
    assert.deepEqual([...fired].sort(), ['a', 'b'], '被延后的任务下一拍必须触发');
    assert.equal(state()[deferred]?.status, 'done', '补跑后落 done，不停在 running');
  } finally {
    h.stop();
    if (saved === undefined) delete process.env.SCHED_MAX_CONCURRENT; else process.env.SCHED_MAX_CONCURRENT = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
