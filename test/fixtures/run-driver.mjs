// BRIDGE-RUN-1 R4 驱动：在独立进程里加载多份 claude.js 实例，跑一轮会起孙进程并挂住的 turn，然后 process.exit(0)。
// 父测试据此检查：exit 监听器只有一个、桥接退出时子进程与孙进程一起被清走。
// 环境由父测试给（隔离目录、假 CLI、DRIVER_PIDFILE、DRIVER_IMPORTS），只输出 pid 与计数，不输出任何环境变量的值。
import fs from 'node:fs';
import { CLAUDE_URL, readPid, waitFor } from './run-helpers.mjs';

const n = Number(process.env.DRIVER_IMPORTS || 3);
const before = process.listenerCount('exit');
const mods = [];
for (let i = 0; i < n; i += 1) mods.push(await import(`${CLAUDE_URL}?inst=${i}`));
const after = process.listenerCount('exit');
const named = process.listeners('exit').filter((f) => f.name === 'bridgeClaudeGroupCleanup').length;

// 用最后一个实例跑一轮：退出清理用的活进程表是各实例共享的，由第一个实例注册的那一个监听器统一处理
mods[mods.length - 1].runClaude('oc_exit', 'hi', true, [], null).catch(() => {});
const lastSpawn = () => {
  const lines = fs.readFileSync(process.env.FAKE_LOG, 'utf8').split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]).pid : null;
};
const childPid = await waitFor(lastSpawn, 8000, '假 CLI 启动');
const gcPid = await waitFor(() => readPid(process.env.DRIVER_PIDFILE), 8000, '孙进程 pid');

process.stdout.write(`DRIVER_RESULT ${JSON.stringify({ before, after, named, childPid, gcPid })}\n`, () => process.exit(0));
