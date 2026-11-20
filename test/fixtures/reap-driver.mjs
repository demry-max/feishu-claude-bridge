// BRIDGE-RUN-2 驱动：在独立进程里用真实 claude.js 跑一轮「挂住、带同组孙进程」的 turn，
// 打出 `READY {driverPid, childPid, grandchildPid}` 之后就一直挂着，等父测试 SIGKILL（模拟桥接被强杀）或 SIGTERM（正常停）。
// 环境由父测试给（隔离目录、假 CLI、FAKE_PLAN / FAKE_LOG；REAP_IGNORE_TERM=1 时假 CLI 忽略 SIGTERM）；
// 只输出 pid，不输出任何环境变量的值。驱动自己不写 data/claude-children.json——那是真实 runClaude 在 spawn 时登记的。
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_URL, readPid, waitFor } from './run-helpers.mjs';

// 沙箱根目录 = FAKE_PLAN 所在目录；孙进程 pid 文件放在它的 pids/ 里，父测试的收尸逻辑认得这个位置
const root = path.dirname(process.env.FAKE_PLAN);
const pidDir = path.join(root, 'pids');
fs.mkdirSync(pidDir, { recursive: true });
const gcPidfile = path.join(pidDir, `gc-${process.pid}`);

const plan = {
  events: [{ type: 'system', subtype: 'init', session_id: 'sess-reap' }],
  hang: true,
  hangMs: 25_000, // 防漏收尸：假 CLI 自己也会在 25 秒后退出
  grandchild: { sec: 25, stdio: 'ignore', pidfile: gcPidfile },
  ...(process.env.REAP_IGNORE_TERM ? { ignoreTerm: true } : {}),
};
fs.writeFileSync(process.env.FAKE_PLAN, JSON.stringify([plan]));
fs.writeFileSync(process.env.FAKE_LOG, '');

const claude = await import(`${CLAUDE_URL}?reap=${process.pid}`);

// SIGTERM = 正常停：走 process.exit，让 claude.js 的 exit 监听器把还在跑的进程组一起收掉
process.on('SIGTERM', () => process.exit(0));

// 锚点 = 测试文件进程（FAKE_ANCHOR_PID）：测试被中断 / 被杀后它没了，驱动随之退出（走 exit 监听，带走自己的进程组），不会无限期挂着
const anchor = Number(process.env.FAKE_ANCHOR_PID);
if (Number.isInteger(anchor) && anchor > 1) {
  setInterval(() => {
    try { process.kill(anchor, 0); } catch (e) { if (e?.code === 'ESRCH') process.exit(0); }
  }, 500).unref();
}

claude.runClaude('oc_reap', 'hi', true, [], null).catch(() => {});
const lastSpawn = () => {
  const lines = fs.readFileSync(process.env.FAKE_LOG, 'utf8').split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]).pid : null;
};
const childPid = await waitFor(lastSpawn, 10_000, '假 CLI 启动');
const grandchildPid = await waitFor(() => readPid(gcPidfile), 10_000, '孙进程 pid');

process.stdout.write(`READY ${JSON.stringify({ driverPid: process.pid, childPid, grandchildPid })}\n`);
setInterval(() => {}, 1 << 30); // 挂着，等被杀
