// mcp-secret 第 4 个用例的驱动：在独立进程里用真实 runClaude 跑「正常 / 错误 result / 启动失败」三种轮次，
// 看临时 MCP 配置目录（TMPDIR 下 feishu-mcp-*）有没有被清掉、清了几次。
// 环境由父测试给（隔离目录、假 CLI、FEISHU_APP_ID / FEISHU_APP_SECRET 的假值）；只输出计数，不输出任何环境变量的值。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_URL } from './run-helpers.mjs';

const rmCalls = [];
const realRm = fs.rmSync;
fs.rmSync = (p, o) => {
  if (path.basename(String(p)).startsWith('feishu-mcp-')) rmCalls.push(path.basename(String(p)));
  return realRm.call(fs, p, o);
};
const left = () => fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('feishu-mcp-')).length;

const out = {};
async function turn(name, mod, key) {
  const before = rmCalls.length;
  let outcome;
  try { await mod.runClaude(key, 'hi', true, [], null); outcome = 'resolved'; } catch { outcome = 'rejected'; }
  // promise 落定的这一刻目录就必须已经没了：清理发生在 resolve / reject 之前
  const leftAtSettle = left();
  // 再等一会儿让迟到的 error / exit / close 事件都跑完：启动失败时 node 先发 error、几个 tick 之后才发 close，
  // 旧写法两处都 cleanup()，只有等它们都跑完才数得出「清了几次」
  await new Promise((r) => setTimeout(r, 400));
  out[name] = { outcome, left: leftAtSettle, leftLater: left(), rm: rmCalls.length - before };
}

const good = await import(`${CLAUDE_URL}?cleanup=good`);
await turn('ok', good, 'oc_ok');
await turn('error', good, 'oc_err');
// 启动失败：CLAUDE_BIN 在 import 时读取，换一份实例指向不存在的可执行文件
process.env.CLAUDE_BIN = path.join(os.tmpdir(), 'no-such-claude-binary');
const bad = await import(`${CLAUDE_URL}?cleanup=bad`);
await turn('spawnFail', bad, 'oc_nospawn');

process.stdout.write(`DRIVER_RESULT ${JSON.stringify(out)}\n`);
