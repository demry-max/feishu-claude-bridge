#!/usr/bin/env node
// 每日新会话上线前的新旧对比回放（只读）：同一批题目分别问「旧方式」和「新方式」，产出盲评材料。
//
// 用法：
//   node scripts/daily-session-replay.js --questions <题目文件> --session <旧会话 id> --out <目录>
//        [--rounds N] [--rounds-file <原话环形文件>] [--workspace <目录>] [--model <模型>] [--dry-run]
//
//   旧臂：每题 claude -p --resume <id> --fork-session（分叉出去问，旧会话本身不变）。
//   新臂：先分叉旧会话跑一遍只读交接（同一份交接提示词，但只有 Read/Grep/Glob，只出摘要），
//         再用 buildCarryover 拼接续材料（摘要 + 最近两份 journal + 最后 N 轮原话），每题开一个全新会话。
//   两臂都只读：--tools Read,Grep,Glob、--setting-sources ''、--strict-mcp-config、不挂 MCP、cwd=工作区。
//   新臂少了「交接写记忆」这一步，比线上弱，对比结论偏保守。
//
// 题目文件一行一题（空行和 # 开头的行跳过），由使用者自己写；仓库只放占位示例 daily-session-replay.questions.example.txt。
// 产物只写 --out：results.jsonl（回答、耗时、usage）、blind.md（每题 A/B 用 CSPRNG 打乱）、key.json（A/B 对应哪一臂）、
// carryover.md（新臂用的接续材料）。不写 data/、不写工作区；stdout 只打进度和统计，不打回答正文。
// --dry-run 只打印将要执行的 argv，不起进程、不写文件。
// 不读 .env：CLI 路径用 CLAUDE_BIN（缺省 claude），工作区用 --workspace / WORKSPACE_DIR（缺省仓库下 workspace/）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { HANDOFF_PROMPT, buildCarryoverInfo, extractHandoffSummary, readRecentJournals, readRounds } from '../src/daily-session.js';
import { envDenyRules } from '../src/biz-wiring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const READONLY = ['--tools', 'Read,Grep,Glob', '--allowedTools', 'Read(./**)', '--setting-sources', '', '--strict-mcp-config',
  '--disallowedTools', envDenyRules(REPO).join(','),
  '--settings', JSON.stringify({ autoMemoryEnabled: false })];
// 交接提示词同线上；回放只读，额外说明跳过写入、只出摘要
export const REPLAY_HANDOFF_PROMPT = `${HANDOFF_PROMPT}\n（回放对比：本轮只读，跳过第 1–3 步的写入，只输出第 4 步的摘要。）`;
const USAGE = '用法：node scripts/daily-session-replay.js --questions <文件> --session <旧会话 id> --out <目录> [--rounds N] [--rounds-file <文件>] [--workspace <目录>] [--model <模型>] [--dry-run]';

/** 解析命令行；出错抛 Error（消息里带用法）。 */
export function parseArgs(argv, env = process.env) {
  const o = { rounds: 10, dryRun: false, workspace: env.WORKSPACE_DIR || path.join(REPO, 'workspace'), model: env.CLAUDE_MODEL || '' };
  const need = (i, k) => {
    if (i >= argv.length || String(argv[i]).startsWith('--')) throw new Error(`${k} 缺少取值\n${USAGE}`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--dry-run') o.dryRun = true;
    else if (k === '--questions') o.questions = need(++i, k);
    else if (k === '--session') o.session = need(++i, k);
    else if (k === '--out') o.out = need(++i, k);
    else if (k === '--rounds-file') o.roundsFile = need(++i, k);
    else if (k === '--workspace') o.workspace = need(++i, k);
    else if (k === '--model') o.model = need(++i, k);
    else if (k === '--rounds') {
      const n = Number(need(++i, k));
      if (!Number.isInteger(n) || n < 0 || n > 30) throw new Error(`--rounds 要 0–30 的整数\n${USAGE}`);
      o.rounds = n;
    } else throw new Error(`不认识的参数：${k}\n${USAGE}`);
  }
  for (const k of ['questions', 'session', 'out']) if (!o[k]) throw new Error(`缺少 --${k}\n${USAGE}`);
  if (!/^[\w-]{1,128}$/.test(o.session)) throw new Error('--session 不像会话 id（只允许字母数字、下划线、横线）');
  const ws = path.resolve(o.workspace);
  const out = path.resolve(o.out);
  if (out === ws || out.startsWith(ws + path.sep)) throw new Error('--out 不能放在工作区里（产物含私人对话，且回放不得改工作区）');
  return { ...o, workspace: ws, out };
}

/** 题目：一行一题，跳过空行和 # 注释。 */
export function readQuestions(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}

const withModel = (args, model) => (model ? [...args, '--model', model] : args);
/** 三种调用的 argv（不含 stdin）。 */
export function armArgs(kind, { session, model }) {
  const base = ['-p', '--output-format', 'stream-json', '--verbose', ...READONLY];
  if (kind === 'old' || kind === 'handoff') return withModel([...base, '--resume', session, '--fork-session'], model);
  if (kind === 'new') return withModel(base, model);
  throw new Error(`未知的臂：${kind}`);
}

/** 跑一次 CLI，解析 stream-json 的 result 事件。永不抛：失败放进 error。 */
function runCli({ bin, args, stdin, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(bin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ answer: '', ms: 0, usage: null, error: `启动失败：${e.message}` });
      return;
    }
    let buf = '';
    let err = '';
    let result = null;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          if (ev?.type === 'result') result = ev;
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); resolve({ answer: '', ms: Date.now() - t0, usage: null, error: `启动失败：${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (result && !result.is_error) resolve({ answer: String(result.result ?? ''), ms, usage: result.usage ?? null, error: null });
      else resolve({ answer: '', ms, usage: result?.usage ?? null, error: result ? String(result.result ?? 'error').slice(0, 300) : `退出码 ${code}：${err.slice(0, 300)}` });
    });
    child.stdin.end(stdin);
  });
}

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor((a.length - 1) / 2)] : 0;
};
const sumUsage = (rows, k) => rows.reduce((n, r) => n + (Number(r.usage?.[k]) || 0), 0);

/** 主流程。print 只收进度和统计行。返回 { questions, results }。 */
export async function runReplay(o, { print = console.log, bin = process.env.CLAUDE_BIN || 'claude', timeoutMs = 10 * 60_000 } = {}) {
  const questions = readQuestions(o.questions);
  if (!questions.length) throw new Error('题目文件是空的');
  if (o.dryRun) {
    const show = (label, args) => print(`${label}：${bin} ${args.map((a) => (a === '' ? "''" : /[\s{}"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    print(`（dry-run：${questions.length} 题，cwd=${o.workspace}，不起进程、不写文件）`);
    show('旧臂（每题，stdin=题目）', armArgs('old', o));
    show('新臂交接（一次，stdin=交接提示词）', armArgs('handoff', o));
    show('新臂（每题，stdin=接续材料+题目）', armArgs('new', o));
    return { questions, results: [] };
  }
  fs.mkdirSync(o.out, { recursive: true, mode: 0o700 });
  const call = (kind, stdin) => runCli({ bin, args: armArgs(kind, o), stdin, cwd: o.workspace, timeoutMs });

  print(`新臂：分叉旧会话跑只读交接…`);
  const h = await call('handoff', REPLAY_HANDOFF_PROMPT);
  const summary = h.error ? null : extractHandoffSummary(h.answer);
  print(`交接${summary ? '完成' : `没拿到摘要（${h.error ? '调用失败' : '没有标记'}）`}，用时 ${(h.ms / 1000).toFixed(1)}s`);
  const now = Date.now();
  const journals = readRecentJournals(path.join(o.workspace, 'memory', 'journal'), now);
  const rounds = o.roundsFile && o.rounds > 0 ? readRounds(o.roundsFile).slice(-o.rounds) : [];
  const carry = buildCarryoverInfo({ summary, journals, rounds });
  fs.writeFileSync(path.join(o.out, 'carryover.md'), carry.text, { mode: 0o600 });
  print(`接续材料 ${carry.text.length} 字（摘要${carry.summary ? '有' : '无'}；journal ${carry.journalNames.length} 份；原话 ${carry.rounds} 轮）`);

  const results = [];
  const resultsFile = path.join(o.out, 'results.jsonl');
  fs.writeFileSync(resultsFile, '', { mode: 0o600 });
  for (const [i, q] of questions.entries()) {
    const old = await call('old', q);
    const neu = await call('new', `${carry.text}\n\n${q}`);
    for (const [arm, r] of [['old', old], ['new', neu]]) {
      const row = { n: i + 1, arm, question: q, answer: r.answer, ms: r.ms, usage: r.usage, error: r.error };
      results.push(row);
      fs.appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
    }
    print(`[${i + 1}/${questions.length}] 旧臂 ${(old.ms / 1000).toFixed(1)}s${old.error ? '（失败）' : ''} ｜ 新臂 ${(neu.ms / 1000).toFixed(1)}s${neu.error ? '（失败）' : ''}`);
  }

  const key = { generated_at: new Date(now).toISOString(), questions: [] };
  const blind = ['# 盲评材料', '', '每题两份回答，A / B 顺序随机。评完再看 key.json。', ''];
  for (const [i, q] of questions.entries()) {
    const pair = { old: results.find((r) => r.n === i + 1 && r.arm === 'old'), new: results.find((r) => r.n === i + 1 && r.arm === 'new') };
    const flip = crypto.randomInt(2) === 1;
    const A = flip ? 'new' : 'old';
    const B = flip ? 'old' : 'new';
    key.questions.push({ n: i + 1, A, B });
    const body = (r) => (r.error ? `（调用失败：${r.error}）` : r.answer || '（空回答）');
    blind.push(`## 第 ${i + 1} 题`, '', q, '', '### 回答 A', '', body(pair[A]), '', '### 回答 B', '', body(pair[B]), '');
  }
  fs.writeFileSync(path.join(o.out, 'blind.md'), blind.join('\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(o.out, 'key.json'), `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });

  for (const arm of ['old', 'new']) {
    const rows = results.filter((r) => r.arm === arm);
    print(`${arm === 'old' ? '旧臂' : '新臂'}：失败 ${rows.filter((r) => r.error).length} 题，耗时中位 ${(median(rows.map((r) => r.ms)) / 1000).toFixed(1)}s，`
      + `input ${sumUsage(rows, 'input_tokens')} / cache_read ${sumUsage(rows, 'cache_read_input_tokens')} / output ${sumUsage(rows, 'output_tokens')} tokens`);
  }
  print(`产物：${o.out}（results.jsonl、blind.md、key.json、carryover.md）`);
  return { questions, results };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  runReplay(o).catch((e) => {
    console.error(`回放失败：${e?.message ?? e}`);
    process.exit(1);
  });
}
