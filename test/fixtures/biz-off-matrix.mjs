// BRIDGE-BMS-1：业务只读查询开关（BMS_TOOL_ENABLED）关闭时，三档、各条路径的 argv 基线夹具。
//
// 夹具 test/fixtures/owner-args-biz-off-419d56f.json 用基线 419d56f 的源码生成，没有经过本卡改动后的代码：
//   mkdir <空目录> && git archive 419d56f | tar -x -C <空目录>
//   node test/fixtures/biz-off-matrix.mjs <空目录> test/fixtures/owner-args-biz-off-419d56f.json
// test/biz-profiles.test.js 只从这里 import 用例与快照函数，用改后的 src 在各种「关」的写法下跑同样的用例，再与夹具逐字比对；
// 测试本身从不重新生成夹具。被直接运行时才生成（见文件末尾）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE_ENV, makeNorm, snapArgs } from './perm2-legacy-matrix.mjs';

export const PROFILES = { legacy: undefined, audit: 'audit', strict: 'strict' };

// chatType 是 index.js 经 createToolTurn 往下带的字段；基线不认识它，关闭时也必须当它不存在
export const CASES = {
  ownerP2p: { env: {}, call: ['oc_x', true, [], { lane: 'chat', resumeId: 'sess-1', chatType: 'p2p' }] },
  ownerP2pFresh: { env: {}, call: ['oc_x', true, [], { lane: 'chat', chatType: 'p2p' }] },
  ownerP2pConfirm: { env: { LARK_CLI: 'true' }, call: ['oc_x', true, [], { lane: 'chat', resumeId: 'sess-1', confirm: true, chatType: 'p2p' }] },
  ownerP2pAllowed: {
    env: { ALLOWED_TOOLS: 'Read,Grep,Bash(git status:*),Edit(./skills/**)' },
    call: ['oc_x', true, [], { lane: 'chat', chatType: 'p2p' }],
  },
  ownerP2pNoFeishu: { env: { FEISHU_TOOLS: 'false' }, call: ['oc_x', true, [], { lane: 'chat', resumeId: 'sess-1', chatType: 'p2p' }] },
  ownerP2pFile: { env: { LARK_CLI: 'true' }, call: ['oc_x', true, ['Read(./incoming/**)'], { lane: 'chat', chatType: 'p2p' }] },
  ownerExec: {
    env: { LARK_CLI: 'true', CLAUDE_EXEC_MODEL: 'claude-test-exec' },
    call: ['oc_x', true, ['Read(./incoming/**)'], { lane: 'exec', resumeId: 'sess-1', chatType: 'p2p' }],
  },
  ownerNoChatType: { env: {}, call: ['oc_x', true, [], { lane: 'chat', resumeId: 'sess-1' }] },
  ownerGroup: { env: { LARK_CLI: 'true' }, call: ['oc_group1', true, [], { lane: 'chat', resumeId: 'sess-g', chatType: 'group' }] },
  sched: {
    env: { LARK_CLI: 'true', CLAUDE_EXEC_MODEL: 'claude-test-exec' },
    call: ['sched:daily.json', true, [], { model: 'claude-test-sched', effort: 'low', toolProfile: 'sched' }],
  },
  schedPlain: { env: { CLAUDE_EXEC_MODEL: 'claude-test-exec' }, call: ['sched:weekly.json', true, []] },
  schedNoFeishu: { env: { FEISHU_TOOLS: 'false' }, call: ['sched:daily.json', true, [], { toolProfile: 'sched' }] },
  schedDiag: {
    env: { LARK_CLI: 'true', CLAUDE_EXEC_MODEL: 'claude-test-exec' },
    call: ['sched-diag:daily.json', true, [], { model: 'claude-test-diag', effort: 'low' }],
  },
  heartbeat: {
    env: { LARK_CLI: 'true' },
    call: ['sched:heartbeat', true, [], { toolProfile: 'heartbeat', model: 'claude-test-hb', effort: 'low' }],
  },
  verifier: { env: {}, call: ['verify:task-1', true, [], { toolProfile: 'verifier' }] },
  guest: { env: { LARK_CLI: 'true' }, call: ['guest:oc_g:ou_y', false, [], { chatType: 'p2p' }] },
  guestFile: { env: { LARK_CLI: 'true' }, call: ['guest:oc_g:ou_y', false, ['Read(./incoming/**)'], { chatType: 'group' }] },
};

/** snapArgs 之外再把验收档的随机临时 cwd（系统临时目录下 feishu-verifier-XXXXXX）换成占位符。 */
export function snapCase(r, norm) {
  const verifierDir = typeof r.cwd === 'string' && path.basename(r.cwd).startsWith('feishu-verifier-');
  const s = snapArgs(r, norm);
  if (verifierDir) s.cwd = '<os-tmp>/feishu-verifier-<rand>';
  return s;
}

function setEnv(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * 建临时工作区与假 claude，返回 { p, norm, load }。load(repoDir, env) 以全新模块实例加载 repoDir/src/claude.js。
 * 生成夹具与测试共用同一套环境，免得两边漂移。
 */
export function makeHarness(repoDir, prefix = 'biz-off-') {
  const repo = path.resolve(repoDir);
  const claudeUrl = pathToFileURL(path.join(repo, 'src', 'claude.js')).href;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const p = { ws: path.join(tmp, 'ws'), gws: path.join(tmp, 'gws'), data: path.join(tmp, 'data'), home: path.join(tmp, 'home'), repo, tmp };
  for (const d of [p.ws, p.gws, p.data, p.home]) fs.mkdirSync(d, { recursive: true });
  const norm = makeNorm(p);
  // 夹具按基线生成：基线里写死的称呼与 strict 拒写目录，在这里用配置项设回同样的值
  setEnv({
    WORKSPACE_DIR: p.ws, GUEST_WORKSPACE_DIR: p.gws, DATA_DIR: p.data, HOME: p.home,
    OWNER_NAME: '光总', OWNER_STRICT_DENY_WRITE_DIRS: path.join(p.home, 'code', 'ias-ops'),
  });
  const fake = path.join(tmp, 'fake-claude.sh');
  fs.writeFileSync(fake, '#!/bin/sh\ncat > /dev/null\ncat "$FAKE_STREAM"\n', { mode: 0o755 });
  process.env.CLAUDE_BIN = fake;
  process.env.FAKE_STREAM = path.join(tmp, 'stream.jsonl');
  fs.writeFileSync(process.env.FAKE_STREAM, [
    { type: 'system', subtype: 'init', session_id: 's-gen' },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's-gen' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  let seq = 0;
  const load = async (env) => {
    setEnv({ ...BASE_ENV, BMS_TOOL_ENABLED: undefined, ...env });
    const orig = console.error;
    console.error = () => {};
    try { return await import(`${claudeUrl}?bizoff=${++seq}`); } finally { console.error = orig; }
  };
  return { p, norm, load };
}

/** 对一个 claude.js 跑完整矩阵：{ legacy: { ownerP2p: snap, … }, audit: …, strict: … }。extraEnv 叠在每个用例上。 */
export async function runMatrix(h, extraEnv = {}) {
  const out = {};
  for (const [pname, profile] of Object.entries(PROFILES)) {
    out[pname] = {};
    for (const [name, c] of Object.entries(CASES)) {
      const m = await h.load({ ...c.env, OWNER_TOOL_PROFILE: profile, ...extraEnv });
      out[pname][name] = snapCase(m.buildClaudeArgs(...structuredClone(c.call)), h.norm);
    }
  }
  return out;
}

async function generate(baseDir, outFile) {
  const h = makeHarness(baseDir, 'biz-off-gen-');
  const profiles = await runMatrix(h);
  fs.writeFileSync(outFile, JSON.stringify({ _source: 'git archive 419d56f（BRIDGE-BMS-1 之前的 main）', profiles }, null, 2) + '\n');
  fs.rmSync(h.p.tmp, { recursive: true, force: true });
  console.log(`已写入 ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [baseDir, outFile] = process.argv.slice(2);
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (!baseDir || !outFile) {
    console.error('用法：node test/fixtures/biz-off-matrix.mjs <基线源码目录> <输出 json>');
    process.exit(2);
  }
  if (path.resolve(baseDir) === here) {
    console.error('拒绝用当前工作树生成：夹具必须来自基线源码（git archive 419d56f）');
    process.exit(2);
  }
  await generate(baseDir, outFile);
}
