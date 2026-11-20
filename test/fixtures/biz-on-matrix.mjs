// BRIDGE-PRIV-1：BMS_TOOL_ENABLED=1 时「仓主私聊 / 心跳 / 发往仓主私聊的定时」的 argv 夹具。
//
// 夹具 test/fixtures/owner-args-biz-on-3c2d3ae.json 用基线 3c2d3ae（BRIDGE-PRIV-1 之前的 main）的源码生成：
//   mkdir <空目录> && git archive 3c2d3ae | tar -x -C <空目录>
//   node test/fixtures/biz-on-matrix.mjs <空目录> test/fixtures/owner-args-biz-on-3c2d3ae.json
// 测试只从这里 import 用例与名单，用改后的 src 在开关开时跑同样的用例，再与夹具逐字比对；测试从不重新生成夹具。
// 被直接运行时才生成（见文件末尾）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CASES, PROFILES, makeHarness, snapCase } from './biz-off-matrix.mjs';

/** 开关开时挂 biz_get 的用例（与 biz-profiles.test.js 的 ELIGIBLE + 发往仓主私聊的定时一致）。 */
export const ON_NAMES = ['ownerP2p', 'ownerP2pFresh', 'ownerP2pConfirm', 'ownerP2pAllowed', 'ownerP2pNoFeishu', 'ownerP2pFile',
  'ownerExec', 'heartbeat', 'sched', 'schedPlain', 'schedNoFeishu'];
const SCHED = ['sched', 'schedPlain', 'schedNoFeishu'];

/** CASES 的调用参数；三个定时用例补上 schedDest: 'owner-p2p'。 */
export function onCallOf(name) {
  const c = structuredClone(CASES[name].call);
  if (SCHED.includes(name)) {
    if (c.length < 4) c[3] = {};
    c[3] = { ...c[3], schedDest: 'owner-p2p' };
  }
  return c;
}

export async function runOnMatrix(h, extraEnv = {}) {
  const out = {};
  for (const [pname, profile] of Object.entries(PROFILES)) {
    out[pname] = {};
    for (const name of ON_NAMES) {
      const m = await h.load({ ...CASES[name].env, OWNER_TOOL_PROFILE: profile, BMS_TOOL_ENABLED: '1', ...extraEnv });
      out[pname][name] = snapCase(m.buildClaudeArgs(...onCallOf(name)), h.norm);
    }
  }
  return out;
}

async function generate(baseDir, outFile) {
  const h = makeHarness(baseDir, 'biz-on-gen-');
  const profiles = await runOnMatrix(h);
  fs.writeFileSync(outFile, JSON.stringify({ _source: 'git archive 3c2d3ae（BRIDGE-PRIV-1 之前的 main），BMS_TOOL_ENABLED=1', profiles }, null, 2) + '\n');
  fs.rmSync(h.p.tmp, { recursive: true, force: true });
  console.log(`已写入 ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [baseDir, outFile] = process.argv.slice(2);
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (!baseDir || !outFile) {
    console.error('用法：node test/fixtures/biz-on-matrix.mjs <基线源码目录> <输出 json>');
    process.exit(2);
  }
  if (path.resolve(baseDir) === here) {
    console.error('拒绝用当前工作树生成：夹具必须来自基线源码（git archive 3c2d3ae）');
    process.exit(2);
  }
  await generate(baseDir, outFile);
}
