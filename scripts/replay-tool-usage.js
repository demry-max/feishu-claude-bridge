#!/usr/bin/env node
// BRIDGE-PERM-1：把 owner 会话的 lark-cli 用量统计（只有子命令名与次数）按 strict 档策略回放一遍。
// 用法：node scripts/replay-tool-usage.js <usage.txt>
// 输入格式：「## lark-cli 子命令」段下每行「次数 子命令…」（见 test/fixtures/owner-lark-usage-45d.txt）。
// 只读这一个文件、只往 stdout 打表；不联网、不调 lark-cli。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCommand, LARK_POLICY } from '../src/tool-policy.js';

const NATIVE = new Set(LARK_POLICY.filter((e) => e.method).map((e) => `${e.domain} ${e.cmd}`));
const TRUNCATED_SINGLE = new Set(['drive', 'docs', 'sheets', 'mail', 'whiteboard']);
const AMBIGUITY_NOTE = {
  'global-flag-first': '统计时子命令前带了全局参数（如 --as user）被截成「user im」，真实子命令看不出来，按 deny 计；strict 对前置的 --as user / --as bot 有专门的放行规则（子命令本身放行就放行），其他全局参数前置会被拒',
  method: '原生资源只统计到资源名、方法名被截掉，按 deny 计；实际多为 list/get（读）或 approve 等（确认级）',
  truncated: '统计行被重定向或截断（2> / 只剩域名），看不出子命令，按 deny 计',
};

/** 用量行的含糊程度：统计口径丢了信息的行单独标注，不当成真实的拒绝量。 */
function ambiguity(line) {
  const words = line.split(/\s+/).filter(Boolean);
  if (words[0] === 'user' || words[0] === 'bot') return 'global-flag-first';
  if (words.length === 2 && NATIVE.has(`${words[0]} ${words[1]}`)) return 'method';
  if (line.includes('2>') || (words.length === 1 && TRUNCATED_SINGLE.has(words[0]))) return 'truncated';
  return null;
}

/** 解析用量文本并逐行分级：{rows:[{line,count,class,chat,sched,ambiguous}], totals:{count,byClass,chatAllowed,schedAllowed,ambiguous}}。 */
export function replayUsage(text) {
  const rows = [];
  let inSection = false;
  for (const raw of String(text ?? '').split('\n')) {
    if (/^##\s*lark-cli 子命令/.test(raw)) { inSection = true; continue; }
    if (/^##\s/.test(raw)) { inSection = false; continue; }
    if (!inSection) continue;
    const m = /^(\d+)\s+(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const line = m[2];
    const c = classifyCommand(`lark-cli ${line}`);
    rows.push({ line, count: Number(m[1]), class: c.class, chat: c.profileAllowed.chat, sched: c.profileAllowed.sched, ambiguous: ambiguity(line) });
  }
  const totals = { count: 0, byClass: {}, chatAllowed: 0, schedAllowed: 0, ambiguous: 0 };
  for (const r of rows) {
    totals.count += r.count;
    totals.byClass[r.class] = (totals.byClass[r.class] ?? 0) + r.count;
    if (r.chat) totals.chatAllowed += r.count;
    if (r.sched) totals.schedAllowed += r.count;
    if (r.ambiguous) totals.ambiguous += r.count;
  }
  return { rows, totals };
}

const yn = (b) => (b ? '放行' : '拒绝');

/** 回放结果的文本表（制表符分隔）+ 合计。 */
export function formatReplay({ rows, totals }) {
  const out = ['次数\t子命令\t分级\t对话档\t定时档\t备注'];
  for (const r of rows) out.push([r.count, r.line, r.class, yn(r.chat), yn(r.sched), r.ambiguous ? `ambiguous:${r.ambiguous}` : ''].join('\t'));
  out.push('');
  out.push(`合计 ${totals.count} 次；按分级：${Object.entries(totals.byClass).map(([k, n]) => `${k} ${n}`).join('，')}`);
  out.push(`strict 对话档放行 ${totals.chatAllowed} 次，定时档放行 ${totals.schedAllowed} 次；含糊行合计 ${totals.ambiguous} 次`);
  const tags = [...new Set(rows.map((r) => r.ambiguous).filter(Boolean))];
  for (const t of tags) out.push(`ambiguous:${t} —— ${AMBIGUITY_NOTE[t]}`);
  return out.join('\n');
}

function isMain() {
  try {
    return fs.realpathSync(path.resolve(process.argv[1] ?? '')) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('用法：node scripts/replay-tool-usage.js <usage.txt>\n');
    process.exit(2);
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`读不到用量文件：${e?.code ?? e?.message ?? e}\n`);
    process.exit(1);
  }
  process.stdout.write(`${formatReplay(replayUsage(text))}\n`);
}
