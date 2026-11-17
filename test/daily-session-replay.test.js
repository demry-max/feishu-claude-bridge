// 每日新会话回放对比脚本（scripts/daily-session-replay.js）：假 CLI，只读两臂、产物只写 --out、盲评可对上、stdout 不含回答正文。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, armArgs, readQuestions } from '../scripts/daily-session-replay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'daily-session-replay.js');
const EXAMPLE = path.resolve(__dirname, '..', 'scripts', 'daily-session-replay.questions.example.txt');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-replay-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力而为 */ } });

const WS = path.join(TMP, 'ws');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(path.join(WS, 'memory', 'journal'), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(WS, 'memory', 'journal', '2026-11-16.md'), '昨天的日记');
fs.writeFileSync(path.join(DATA, 'sessions.json'), '{"oc_x":"sess-old"}');
const ROUNDS = path.join(DATA, 'rounds.jsonl');
fs.writeFileSync(ROUNDS, `${JSON.stringify({ ts: 1, sid: 'sess-old', user: '上一轮的话', answer: '上一轮的回答' })}\n`);
const Q = path.join(TMP, 'q.txt');
fs.writeFileSync(Q, '# 注释\n\n第一题是什么\n第二题是什么\n第三题是什么\n');

// 假 CLI：记录 argv 与 stdin；旧臂（带 --resume）答 ANSWER-OLD-<题>，新臂答 ANSWER-NEW-<题>，交接回摘要
const FAKE = path.join(TMP, 'fake.mjs');
const LOG = path.join(TMP, 'fake.log');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
import fs from 'node:fs';
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, stdin, cwd: process.cwd() }) + '\\n');
  const q = stdin.split('\\n').pop();
  const text = stdin.includes('<<<HANDOFF') ? '<<<HANDOFF\\nREPLAY-SUMMARY\\nHANDOFF>>>' : (argv.includes('--resume') ? 'ANSWER-OLD-' : 'ANSWER-NEW-') + q;
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 3, output_tokens: 2 } }) + '\\n');
});
`, { mode: 0o755 });

function treeHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      h.update(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}\n`);
      if (st.isDirectory()) walk(p);
      else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}
const run = (args) => execFileSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8', env: { ...process.env, CLAUDE_BIN: FAKE, FAKE_LOG: LOG, WORKSPACE_DIR: WS, DATA_DIR: DATA, CLAUDE_MODEL: '' },
});

test('参数：必填、--rounds 范围、会话 id 形状、--out 不许在工作区里；示例题目文件可读', () => {
  assert.throws(() => parseArgs(['--questions', Q, '--session', 's1'], {}), /缺少 --out/);
  assert.throws(() => parseArgs(['--questions', Q, '--session', 's1', '--out', path.join(TMP, 'o'), '--rounds', '31'], {}), /0–30/);
  assert.throws(() => parseArgs(['--questions', Q, '--session', 'a b', '--out', path.join(TMP, 'o')], {}), /会话 id/);
  assert.throws(() => parseArgs(['--questions', Q, '--session', 's1', '--out', path.join(WS, 'out'), '--workspace', WS], {}), /不能放在工作区里/);
  assert.throws(() => parseArgs(['--bogus'], {}), /不认识的参数/);
  const o = parseArgs(['--questions', Q, '--session', 's1', '--out', path.join(TMP, 'o'), '--workspace', WS, '--rounds', '5'], {});
  assert.equal(o.rounds, 5);
  assert.deepEqual(readQuestions(Q), ['第一题是什么', '第二题是什么', '第三题是什么']);
  assert.ok(readQuestions(EXAMPLE).length >= 3);
  const all = ['old', 'handoff', 'new'].map((k) => armArgs(k, { session: 's1', model: '' }));
  for (const a of all) {
    assert.equal(a[a.indexOf('--tools') + 1], 'Read,Grep,Glob');
    assert.equal(a[a.indexOf('--setting-sources') + 1], '');
    assert.ok(a.includes('--strict-mcp-config') && !a.includes('--mcp-config'));
  }
  assert.ok(!all[2].includes('--resume'), '新臂每题全新会话');
});

test('--dry-run：打印旧臂 argv（--fork-session + 只读工具面），不起进程、不写文件', () => {
  fs.writeFileSync(LOG, '');
  const out = path.join(TMP, 'dry');
  const stdout = run(['--questions', Q, '--session', 'sess-old', '--out', out, '--dry-run']);
  const oldLine = stdout.split('\n').find((l) => l.startsWith('旧臂'));
  assert.ok(oldLine.includes('--resume sess-old --fork-session'));
  assert.ok(oldLine.includes('--tools Read,Grep,Glob') && oldLine.includes("--setting-sources ''") && oldLine.includes('--strict-mcp-config'));
  assert.equal(fs.readFileSync(LOG, 'utf8'), '', '没起 CLI');
  assert.equal(fs.existsSync(out), false, '没写产物');
});

test('实跑：data/ 与工作区不变；blind.md 与 key.json 对得上；stdout 不含回答正文', () => {
  fs.writeFileSync(LOG, '');
  const before = [treeHash(DATA), treeHash(WS)];
  const out = path.join(TMP, 'out');
  const stdout = run(['--questions', Q, '--session', 'sess-old', '--out', out, '--rounds-file', ROUNDS, '--rounds', '3']);
  assert.deepEqual([treeHash(DATA), treeHash(WS)], before, 'data/ 与工作区一字不变');
  assert.ok(!/ANSWER-|REPLAY-SUMMARY|上一轮的|昨天的日记/.test(stdout), 'stdout 不含回答与材料正文');
  assert.match(stdout, /\[3\/3\]/);
  const calls = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(calls.length, 1 + 3 * 2);
  for (const c of calls) {
    assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(WS));
    assert.equal(c.argv[c.argv.indexOf('--tools') + 1], 'Read,Grep,Glob');
  }
  const newCalls = calls.filter((c) => !c.argv.includes('--resume'));
  assert.equal(newCalls.length, 3);
  for (const c of newCalls) {
    assert.ok(c.stdin.startsWith('【接续材料'));
    assert.ok(c.stdin.includes('REPLAY-SUMMARY') && c.stdin.includes('昨天的日记') && c.stdin.includes('上一轮的话'));
  }
  const results = fs.readFileSync(path.join(out, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(results.length, 6);
  const key = JSON.parse(fs.readFileSync(path.join(out, 'key.json'), 'utf8'));
  const blind = fs.readFileSync(path.join(out, 'blind.md'), 'utf8');
  const sections = blind.split(/^## 第 \d+ 题$/m).slice(1);
  assert.equal(sections.length, 3);
  for (const [i, s] of sections.entries()) {
    const k = key.questions[i];
    const [a, b] = s.split('### 回答 B');
    const tag = (arm) => (arm === 'old' ? 'ANSWER-OLD-' : 'ANSWER-NEW-');
    assert.ok(a.includes(`${tag(k.A)}第${['一', '二', '三'][i]}题是什么`), `第 ${i + 1} 题 A 对得上`);
    assert.ok(b.includes(tag(k.B)));
    assert.notEqual(k.A, k.B);
  }
  assert.ok(fs.readFileSync(path.join(out, 'carryover.md'), 'utf8').includes('REPLAY-SUMMARY'));
});
