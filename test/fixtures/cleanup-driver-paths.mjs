// BRIDGE-RUN-2 M1（RUN-1 复审点名补的测试）：mcp-secret 第 5 个用例的驱动。
// cleanup-driver.mjs 只跑了正常 / 错误 result / 启动失败三种收尾；这里在独立进程里用真实 runClaude 跑另外三条
// 「我们主动杀进程」的收尾路径——空闲超时、结果宽限到期、取消——看临时 MCP 配置目录（TMPDIR 下 feishu-mcp-*）
// 有没有被清掉、清了几次。计数方式与 cleanup-driver.mjs 一致。
// 环境由父测试给（隔离目录、假 CLI、FEISHU_APP_ID / FEISHU_APP_SECRET 的假值）；只输出计数与结论，不输出任何环境变量的值。
// 空闲超时与结果宽限的阈值在 claude.js import 时读取，所以每条路径单独 import 一份实例；每条路径的计划由本驱动自己写。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_URL, waitFor } from './run-helpers.mjs';

const rmCalls = [];
const realRm = fs.rmSync;
fs.rmSync = (p, o) => {
  if (path.basename(String(p)).startsWith('feishu-mcp-')) rmCalls.push(path.basename(String(p)));
  return realRm.call(fs, p, o);
};
const left = () => fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('feishu-mcp-')).length;
const spawnCount = () => fs.readFileSync(process.env.FAKE_LOG, 'utf8').split('\n').filter(Boolean).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const init = { type: 'system', subtype: 'init', session_id: 'sess-paths' };
const HANG_MS = 20_000; // 防漏收尸：假 CLI 自己也会在 20 秒后退出
const plans = {
  idle: { hang: true, hangMs: HANG_MS }, // 一个字都不出
  grace: { events: [init, { type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } }, { type: 'result', subtype: 'success', is_error: false, result: '好', session_id: 'sess-paths' }], hang: true, hangMs: HANG_MS }, // 结果到了、进程不退
  cancel: { events: [init], hang: true, hangMs: HANG_MS },
};

fs.writeFileSync(process.env.FAKE_LOG, '');

/** 阈值类配置在 import 时读：每条路径先清掉上一条的，再设自己的，然后 import 一份新实例 */
function load(tag, env) {
  delete process.env.CLAUDE_IDLE_TIMEOUT_MS;
  delete process.env.CLAUDE_RESULT_GRACE_MS;
  Object.assign(process.env, env);
  return import(`${CLAUDE_URL}?paths=${tag}`);
}

const how = (e) => (e?.cancelled ? 'cancelled' : /超时/.test(String(e?.message)) ? 'timeout' : 'other');

const out = {};
async function round(name, env, { cancelAfterSpawn = false } = {}) {
  fs.writeFileSync(process.env.FAKE_PLAN, JSON.stringify([plans[name]]));
  const mod = await load(name, env);
  const key = `oc_${name}`;
  const before = rmCalls.length;
  const spawnsBefore = spawnCount();
  const run = mod.runClaude(key, 'hi', true, [], null).then((v) => ({ outcome: 'resolved', how: 'result', value: v }), (e) => ({ outcome: 'rejected', how: how(e), value: null }));
  let cancelReturned = null;
  if (cancelAfterSpawn) {
    await waitFor(() => spawnCount() > spawnsBefore, 10_000, `${name} 轮的假 CLI 启动`);
    cancelReturned = mod.cancelRun(key);
  }
  const res = await run;
  // promise 落定的这一刻目录就必须已经没了：清理发生在 resolve / reject 之前
  const leftAtSettle = left();
  // 再等一会儿让迟到的 exit / close / 定时器都跑完，才数得出「清了几次」
  await sleep(400);
  out[name] = {
    ...res, left: leftAtSettle, leftLater: left(), rm: rmCalls.length - before,
    spawns: spawnCount() - spawnsBefore, ...(cancelAfterSpawn ? { cancelReturned } : {}),
  };
}

await round('idle', { CLAUDE_IDLE_TIMEOUT_MS: '600' });
await round('grace', { CLAUDE_RESULT_GRACE_MS: '300' });
await round('cancel', {}, { cancelAfterSpawn: true });

process.stdout.write(`DRIVER_RESULT ${JSON.stringify(out)}\n`);
