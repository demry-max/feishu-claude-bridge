// BRIDGE-PERM-1：owner 工具档（OWNER_TOOL_PROFILE=audit|strict）的纯策略层。
// 只有数据和纯函数：除称呼 OWNER_NAME（owner-name.js）外不读环境变量、不碰文件、不联网（realpath/readlink/home/vars/tmpDirs 由调用方注入）。
// claude.js 用它生成 --allowedTools/--disallowedTools，tool-audit.js 用它给审计记录和回执分级，
// hooks/untrusted-note.js 用它判断哪些输出含第三方内容，hooks/output-guard.js 用它判 lark 写文件落点。
//
// 分级：read（两档都放行）/ write（只对话放行，回复末尾附回执）/ confirm（先出草稿，owner 回「确认」的下一轮才放行）
//      / chat-only（只对话放行，如 auth login）/ deny（一律拒绝）。不在表里的 lark 子命令一律按 deny 处理。

import path from 'node:path';
import { ownerText, OWNER } from './owner-name.js';
import { BIZ_TOOL } from './biz-targets.js';

export const STRICT_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebSearch', 'ToolSearch', 'Skill']);
export const FEISHU_MCP_READ = Object.freeze(['doc_read', 'sheet_read', 'bitable_tables', 'bitable_fields', 'bitable_records', 'mail_attachment_download']);
export const FEISHU_MCP_WRITE = Object.freeze(['doc_append', 'bitable_create_record', 'bitable_update_record', 'sheet_write']);
export const HELP_DOMAINS = Object.freeze(['im', 'contact', 'approval', 'calendar', 'mail', 'docs', 'sheets', 'drive', 'whiteboard', 'auth']);
export const CONFIRM_DEFAULT_PROMPT = ownerText`（${OWNER}已确认上一轮的草稿，请执行）`;
const OTHER = '<其他>';

const entry = (cls, domain, cmd = null, method = null) => Object.freeze({ domain, cmd, method, class: cls });
const IM_READ = ['+chat-messages-list', '+messages-mget', '+threads-messages-list', '+messages-search', '+chat-list',
  '+chat-search', '+chat-members-list', '+messages-resources-download', '+messages-resource-download'];

export const LARK_POLICY = Object.freeze([
  // ---- read ----
  ...IM_READ.map((c) => entry('read', 'im', c)),
  entry('read', 'im', 'chats', 'list'), entry('read', 'im', 'chats', 'get'), entry('read', 'im', 'chat.members', 'get'),
  entry('read', 'im', 'messages', 'list'), entry('read', 'im', 'messages', 'get'),
  entry('read', 'contact', '+search-user'), entry('read', 'contact', '+get-user'),
  entry('read', 'approval', 'tasks', 'query'), entry('read', 'approval', 'instances', 'get'),
  entry('read', 'approval', 'instances', 'initiated'), entry('read', 'approval', 'approvals', 'search'),
  entry('read', 'approval', 'approvals', 'get'),
  entry('read', 'calendar', '+agenda'), entry('read', 'calendar', '+freebusy'),
  entry('read', 'mail', '+message'), entry('read', 'mail', '+triage'), entry('read', 'mail', '+thread'),
  entry('read', 'docs', '+fetch'),
  entry('read', 'sheets', '+workbook-info'), entry('read', 'sheets', '+csv-get'), entry('read', 'sheets', '+cells-get'),
  entry('read', 'sheets', '+info'),
  entry('read', 'drive', '+download'), entry('read', 'drive', '+inspect'),
  entry('read', 'whiteboard', '+export'),
  entry('read', 'schema'),
  ...HELP_DOMAINS.map((d) => entry('read', d, '+help')),
  entry('read', 'auth', 'status'),
  // ---- write：直接执行，回复末尾附回执 ----
  entry('write', 'im', '+messages-send'), entry('write', 'im', '+messages-reply'),
  entry('write', 'drive', '+import'), entry('write', 'calendar', '+create'),
  // ---- confirm：先出草稿，owner 回「确认」的下一轮才放行 ----
  ...['+reply', '+reply-all', '+send', '+draft-send'].map((c) => entry('confirm', 'mail', c)),
  ...['approve', 'reject', 'transfer', 'rollback', 'add_sign', 'remind'].map((m) => entry('confirm', 'approval', 'tasks', m)),
  ...['create', 'cancel', 'cc'].map((m) => entry('confirm', 'approval', 'instances', m)),
  entry('confirm', 'im', 'messages', 'delete'),
  entry('confirm', 'im', '+chat-create'), entry('confirm', 'im', '+chat-update'),
  entry('confirm', 'im', 'chat.members', 'create'), entry('confirm', 'im', 'chat.members', 'delete'),
  // ---- chat-only ----
  entry('chat-only', 'auth', 'login'), entry('chat-only', 'auth', 'qrcode'),
  // ---- deny（其余原生写方法不在表里，同样按 deny） ----
  entry('deny', 'api'), entry('deny', 'auth', 'logout'),
]);

const PREFIXES = ['', '--as user ', '--as bot '];
const entryText = (e) => [e.domain, e.cmd, e.method].filter(Boolean).join(' ');
const prefixRules = (e) => PREFIXES.map((p) => `Bash(lark-cli ${p}${entryText(e)}:*)`);
// 有方法名的原生资源（im chats / approval tasks …）：第三个词是方法
const NATIVE = new Set(LARK_POLICY.filter((e) => e.method).map((e) => `${e.domain} ${e.cmd}`));
const KNOWN_NAMES = new Set([...LARK_POLICY.flatMap((e) => [e.domain, e.cmd, e.method]).filter(Boolean), '--help']);

/** 给定分级的三种前缀规则（定时档纵深拒绝用）。 */
export function larkClassRules(...classes) {
  return [...new Set(LARK_POLICY.filter((e) => classes.includes(e.class)).flatMap(prefixRules))];
}

/**
 * 生成 strict 档的 lark-cli 放行规则：每个子命令三种前缀（裸、--as user、--as bot），加各域 --help 与 lark-cli --help。
 * chat：read + write + chat-only（确认轮再加 confirm）；其余任何值（含 sched）：只有 read。
 */
export function larkRules(profile = 'chat', { confirm = false } = {}) {
  const classes = profile === 'chat' ? ['read', 'write', 'chat-only', ...(confirm === true ? ['confirm'] : [])] : ['read'];
  const out = larkClassRules(...classes);
  out.push('Bash(lark-cli --help)');
  for (const d of HELP_DOMAINS) out.push(`Bash(lark-cli ${d} --help:*)`);
  return [...new Set(out)];
}

// ---------------- shell 命令切段 ----------------
// 不是完整的 shell 解析器：够用来把 | && || ; & 换行、$( )、反引号、<( )、sh -c、eval 拆成独立的简单命令，
// 去掉重定向与 heredoc 正文，再逐段判定取最严。解析不了的形状一律往严里判（lark 段未知即 deny）。
const MAX_DEPTH = 4;

function readBalanced(src, i) {
  // src[i] 是 '(' 之后的第一个字符；返回 [内部文本, 右括号之后的下标]
  let depth = 1;
  let q = null;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (q === '"') { if (c === '"') q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return [src.slice(start, i), i + 1];
  }
  return [src.slice(start), src.length];
}

function readBacktick(src, i) {
  // src[i] 是开头反引号之后的字符
  let out = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) { out += src[++i]; continue; }
    if (c === '`') return [out, i + 1];
    out += c;
  }
  return [out, src.length];
}

function lex(src) {
  const segs = [];
  const subs = [];
  const units = []; // BRIDGE-PERM-2：与 segs 平行，另记每词是否含展开（dyns）、每个重定向目标（redirs）与收尾分隔符（sep，R1）；不影响 segs/subs
  let words = [];
  let dyns = [];
  let redirs = [];
  let cur = null;
  let curDyn = false; // 当前词是否含 $ / $() / `` / 未加引号的 * ? [ {（'ansi' 表示 $'…'，粘住）
  let quote = null;
  let skipNext = false; // 重定向目标
  let pendingOp = null; // 等待目标词的输出类重定向算符（只记含 > 的）
  let heredoc = null; // 'want'：下一个词是 heredoc 定界符
  const heredocs = [];
  const markDyn = () => { if (curDyn !== 'ansi') curDyn = true; };
  const setOp = (op) => {
    if (pendingOp) redirs.push({ op: pendingOp, target: null, dyn: true });
    pendingOp = op;
  };
  const push = () => {
    if (cur === null) return;
    if (heredoc === 'want') { heredocs.push(cur.replace(/^-/, '')); heredoc = null; }
    else if (skipNext) { skipNext = false; if (pendingOp) { redirs.push({ op: pendingOp, target: cur, dyn: curDyn }); pendingOp = null; } }
    else { words.push(cur); dyns.push(curDyn); }
    cur = null;
    curDyn = false;
  };
  const endSeg = (sep = 'end') => {
    push();
    if (pendingOp) { redirs.push({ op: pendingOp, target: null, dyn: true }); pendingOp = null; }
    if (words.length) segs.push(words);
    if (words.length || redirs.length) units.push({ words, dyns, redirs, sep });
    words = [];
    dyns = [];
    redirs = [];
    skipNext = false;
    curDyn = false;
    heredoc = null;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null; else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && n !== undefined && '"\\$`\n'.includes(n)) { cur += n; i++; }
      else if (c === '$' && n === '(') { const [inner, j] = readBalanced(src, i + 2); subs.push(inner); cur += '$()'; i = j - 1; markDyn(); }
      else if (c === '`') { const [inner, j] = readBacktick(src, i + 1); subs.push(inner); cur += '``'; i = j - 1; markDyn(); }
      else if (c === '$') { markDyn(); cur += c; }
      else cur += c;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { push(); continue; }
    if (c === '\n') {
      endSeg('\n');
      // 跳过 heredoc 正文：它是数据不是命令
      while (heredocs.length) {
        const delim = heredocs.shift();
        let j = i + 1;
        for (;;) {
          const e = src.indexOf('\n', j);
          const line = src.slice(j, e < 0 ? src.length : e);
          if (line.replace(/^\t+/, '') === delim || e < 0) { i = e < 0 ? src.length : e; break; }
          j = e + 1;
        }
      }
      continue;
    }
    if (c === '\\') {
      if (n === '\n') { i++; continue; }
      if (n !== undefined) { cur = (cur ?? '') + n; i++; }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur = cur ?? ''; continue; }
    if (c === '$' && n === "'") { quote = "'"; cur = cur ?? ''; curDyn = 'ansi'; i++; continue; }
    if (c === '#' && cur === null) {
      const e = src.indexOf('\n', i);
      i = (e < 0 ? src.length : e) - 1;
      continue;
    }
    if (c === '$' && n === '(') {
      const [inner, j] = readBalanced(src, i + 2);
      subs.push(inner);
      cur = (cur ?? '') + '$()';
      i = j - 1;
      markDyn();
      continue;
    }
    if (c === '$') { markDyn(); cur = (cur ?? '') + c; continue; }
    if (c === '`') {
      const [inner, j] = readBacktick(src, i + 1);
      subs.push(inner);
      cur = (cur ?? '') + '``';
      i = j - 1;
      markDyn();
      continue;
    }
    if ((c === '<' || c === '>') && n === '(') {
      // 进程替换 <( ) >( )：目标是进程替换本身，按子命令递归；清掉等待中的输出算符
      push();
      pendingOp = null;
      const [inner, j] = readBalanced(src, i + 2);
      subs.push(inner);
      i = j - 1;
      continue;
    }
    if (c === '(' || c === ')') { endSeg(c); continue; }
    if (c === ';') { endSeg(';'); continue; }
    if (c === '|') { endSeg(n === '|' || n === '&' ? c + n : c); if (n === '|' || n === '&') i++; continue; }
    if (c === '&' && n === '&') { endSeg('&&'); i++; continue; }
    if (c === '&' && n === '>') {
      push();
      i++;
      let op = '&>';
      if (src[i + 1] === '>') { i++; op = '&>>'; }
      setOp(op);
      skipNext = true;
      continue;
    }
    if (c === '&') { endSeg('&'); continue; }
    if (c === '>' || c === '<') {
      // 重定向：可带 fd 前缀（2>）、>> >| >& <& << <<- <<<
      if (cur !== null && /^\d+$/.test(cur)) { cur = null; curDyn = false; } else push();
      let op = c;
      while (src[i + 1] !== undefined && '<>|&'.includes(src[i + 1]) && op.length < 3) op += src[++i];
      if (op === '<<' && src[i + 1] === '-') { op += '-'; i++; }
      if (op.endsWith('&')) {
        // >&1 <&- 这种 fd 复制：后面紧跟数字或 -，没有目标词
        let k = i + 1;
        while (k < src.length && /[\d-]/.test(src[k])) k++;
        if (k > i + 1) { i = k - 1; continue; }
        if (op.includes('>')) setOp(op); // >&path 是输出重定向
        skipNext = true;
        continue;
      }
      if (op === '<<' || op === '<<-') heredoc = 'want';
      else { if (op.includes('>')) setOp(op); skipNext = true; }
      continue;
    }
    if (c === '*' || c === '?' || c === '[' || c === '{') { markDyn(); cur = (cur ?? '') + c; continue; }
    cur = (cur ?? '') + c;
  }
  endSeg();
  return { segs, subs, units };
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const LEAD_SKIP = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'builtin']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const DENY_PROGRAMS = new Set(['codex', 'nohup', 'npx']);
// 把后面的词当命令跑的包装程序：里面出现 lark-cli / sh -c 时按内层命令再判一次
const WRAPPERS = new Set(['xargs', 'timeout', 'gtimeout', 'nice', 'ionice', 'nohup', 'sudo', 'doas', 'watch', 'stdbuf',
  'parallel', 'find', 'flock', 'setsid', 'unbuffer', 'chronic', 'caffeinate', 'script', 'env', 'exec']);
const base = (p) => String(p).split('/').pop();
const isLarkWord = (w) => w === 'lark-cli' || w.endsWith('/lark-cli');

function leadIndex(words) {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) break;
    if (LEAD_SKIP.has(w) || ASSIGN.test(w)) { i++; continue; }
    if (w === 'env') {
      // env [-i] [-u NAME] [VAR=x]... cmd
      let j = i + 1;
      while (j < words.length && (words[j].startsWith('-') || ASSIGN.test(words[j]))) j += words[j] === '-u' ? 2 : 1;
      if (j < words.length) { i = j; continue; }
      break;
    }
    if ((w === 'command' || w === 'exec') && words[i + 1] !== undefined && !words[i + 1].startsWith('-')) { i++; continue; }
    break;
  }
  return i;
}

function stripLead(words) {
  return words.slice(leadIndex(words));
}

const LARK_DENY = (o) => ({ domain: null, cmd: null, method: null, ...o, class: 'deny' });

function classifyLark(rest) {
  let i = 0;
  let as = false;
  if (rest[0] === '--as' && (rest[1] === 'user' || rest[1] === 'bot')) { i = 2; as = true; }
  else if (rest[0] === '--as=user' || rest[0] === '--as=bot') { i = 1; as = true; }
  const w = rest.slice(i);
  if (!as && w.length === 1 && w[0] === '--help') return { domain: null, cmd: '--help', method: null, class: 'read' };
  const [d, c, m] = w;
  if (d === undefined || d.startsWith('-')) return LARK_DENY({}); // 裸 lark-cli、全局参数写在子命令前面
  const domainOnly = LARK_POLICY.find((e) => e.domain === d && !e.cmd);
  if (domainOnly) return { domain: d, cmd: null, method: null, class: domainOnly.class };
  if (c === undefined) return LARK_DENY({ domain: d });
  if (c === '--help') return { domain: d, cmd: c, method: null, class: !as && HELP_DOMAINS.includes(d) ? 'read' : 'deny' };
  if (c.startsWith('-')) return LARK_DENY({ domain: d });
  const direct = LARK_POLICY.find((e) => e.domain === d && e.cmd === c && !e.method);
  if (direct) return { domain: d, cmd: c, method: null, class: direct.class };
  if (NATIVE.has(`${d} ${c}`)) {
    const hit = m === undefined ? null : LARK_POLICY.find((e) => e.domain === d && e.cmd === c && e.method === m);
    return { domain: d, cmd: c, method: m ?? null, class: hit ? hit.class : 'deny' };
  }
  return LARK_DENY({ domain: d, cmd: c });
}

function classifyWords(words) {
  const w = stripLead(words);
  const program = w[0] ?? null;
  if (program === null) return [];
  if (isLarkWord(program)) {
    const r = classifyLark(w.slice(1));
    // 带路径调用（/opt/x/lark-cli、./lark-cli）不会命中任何 Bash(lark-cli …) 规则 → 判 deny
    return [{ program, lark: true, tokens: w, ...r, class: program === 'lark-cli' ? r.class : 'deny' }];
  }
  const name = base(program);
  const out = [{ program, lark: false, tokens: w, domain: null, cmd: null, method: null, class: DENY_PROGRAMS.has(name) ? 'deny' : 'other' }];
  return out;
}

function segmentsOf(src, depth) {
  if (depth > MAX_DEPTH) return [{ program: null, lark: false, tokens: [], domain: null, cmd: null, method: null, class: 'deny' }];
  const { segs, subs } = lex(String(src ?? ''));
  const out = [];
  for (const words of segs) {
    const parts = classifyWords(words);
    out.push(...parts);
    const w = parts[0]?.tokens ?? [];
    const name = w[0] === undefined ? '' : base(w[0]);
    if (SHELLS.has(name)) {
      const k = w.findIndex((x, j) => j > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
      if (k > 0 && w[k + 1] !== undefined) out.push(...segmentsOf(w[k + 1], depth + 1));
    } else if (name === 'eval') {
      out.push(...segmentsOf(w.slice(1).join(' '), depth + 1));
    } else if (WRAPPERS.has(name)) {
      const k = w.findIndex((x, j) => j > 0 && (isLarkWord(x) || SHELLS.has(base(x))));
      if (k > 0) out.push(...segmentsOf(w.slice(k).map(shellQuote).join(' '), depth + 1));
    }
  }
  for (const s of subs) out.push(...segmentsOf(s, depth + 1));
  return out;
}

const shellQuote = (s) => (/^[A-Za-z0-9_./:=+,@%^-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);

const RANK = { other: 0, read: 1, write: 2, 'chat-only': 3, confirm: 4, deny: 5 };
const DECISION = { other: 'allow', read: 'allow', write: 'allow', 'chat-only': 'allow', confirm: 'confirm', deny: 'deny' };
const ALLOWED_IN = {
  other: { chat: true, sched: true }, read: { chat: true, sched: true }, write: { chat: true, sched: false },
  'chat-only': { chat: true, sched: false }, confirm: { chat: false, sched: false }, deny: { chat: false, sched: false },
};

/** 把一条 Bash 命令拆成简单命令段，每段带 {program, lark, tokens, domain, cmd, method, class, decision, profileAllowed}。 */
export function classifySegments(cmdline) {
  return segmentsOf(cmdline, 0).map((s) => ({ ...s, decision: DECISION[s.class], profileAllowed: { ...ALLOWED_IN[s.class] } }));
}

/**
 * 判定一条 Bash 命令：逐段判定取最严（deny > confirm > chat-only > write > read > 非 lark 命令）。
 * lark 段：剥掉子命令前的 --as user|bot / --as=user|bot，未知子命令一律 deny；重定向不影响判定。
 * 非 lark 命令不在策略表里，不判拒（codex/nohup/npx 除外）。
 */
export function classifyCommand(cmdline) {
  const segs = classifySegments(cmdline);
  if (!segs.length) {
    return { program: null, lark: false, domain: null, cmd: null, method: null, class: 'other', decision: 'allow', profileAllowed: { chat: true, sched: true } };
  }
  let top = segs[0];
  for (const s of segs) if (RANK[s.class] > RANK[top.class]) top = s;
  const profileAllowed = { chat: segs.every((s) => s.profileAllowed.chat), sched: segs.every((s) => s.profileAllowed.sched) };
  const { program, lark, domain, cmd, method } = top;
  return { program, lark, domain, cmd, method, class: top.class, decision: DECISION[top.class], profileAllowed };
}

/**
 * BRIDGE-PERM-2 R1：有没有 lark-cli 段把 --as= 写在子命令前（`lark-cli --as=user im …`）。
 * strict 的 --allowedTools 只生成 `--as user` / `--as bot` 前缀，等号写法 CLI 侧不会命中；审计判定也必须判 deny，避免误记 allow。
 */
export function usesEqAsPrefix(cmd) {
  return classifySegments(cmd).some((s) => s.lark && s.program === 'lark-cli' && /^--as=/.test(s.tokens[1] ?? ''));
}

// ---------------- BRIDGE-PERM-2：lark 写文件落点（--output/-o/重定向/tee/cd）的提取与判定 ----------------
// strict/audit 下 read 级 lark 子命令带 --output/-o、重定向（> >> >| &> >& <>）、| tee 写文件时，落点必须在
// workspace/outbox 或系统临时目录；.claude/、CLAUDE.md、schedules/、skills/、tasks/、.mcp.json 一律不可写。
// 解析不了的形状（动态展开、cd 去向不明、嵌套过深）一律往严里判（deny）。纯函数：realpath 等副作用由调用方注入。
const CD_NAMES = new Set(['cd', 'pushd', 'chdir']);
const OUT_PRECMD = new Set(['command', 'exec', 'builtin', 'noglob', 'nocorrect', 'time', '-']);
const OUT_INNER = new Set(['tee', 'eval', 'env', 'popd', 'cd', 'pushd', 'chdir']);
// --output / --out / --dest / --destination（含 -dir/-file/-path 变体）/ --save-to / --download-dir …
const OUT_LONG = /^--(?:out(?:put)?|dest(?:ination)?)(?:[-_]?(?:dir|directory|file|path))?$|^--(?:save|download)[-_]?(?:to|dir|directory|file|path)$/;
const ALWAYS_OK = new Set(['-', '/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);
const PROTECTED_BASENAMES = new Set(['claude.md', 'claude.local.md', '.mcp.json', '.claude.json']);
const PROTECTED_FIRST = new Set(['skills', 'schedules', 'tasks', '.mcp.json']);
const REASON_RANK = { empty: 1, unknown: 2, dynamic: 3, 'not-outbox': 4, outside: 5, 'cwd-protected': 6, protected: 7 };

const fold = (s) => String(s).normalize('NFKC').toUpperCase().toLowerCase();
const toPosix = (p) => String(p == null ? '' : p);
const foldAll = (arr) => [...new Set(arr.filter(Boolean).map((x) => fold(toPosix(x))))];
const worse = (a, b) => (!a ? b : !b ? a : REASON_RANK[b] > REASON_RANK[a] ? b : a);

function within(childFolded, parentFolded) {
  if (!parentFolded) return false;
  const p = parentFolded.endsWith('/') ? parentFolded.slice(0, -1) : parentFolded;
  return childFolded === p || childFolded.startsWith(p + '/');
}

function looksLikePath(w) {
  if (w.includes('/')) return true;
  if (w.startsWith('.') || w.startsWith('~')) return true;
  const f = fold(w);
  return f === '.claude' || f === 'claude.md' || f === 'claude.local.md' || PROTECTED_FIRST.has(f);
}

// 把物理路径走出来：遇 .. 时按父目录的真实路径回退，末尾再 realpath 一次，捕捉软链接逃逸。realpath 为空时退化为纯词法。
function makeRealOf(realpath, readlink) {
  if (!realpath) return (p) => p;
  const memo = new Map();
  function realOf(p, hops = 0) {
    if (memo.has(p)) return memo.get(p);
    let out;
    try {
      out = realpath(p);
    } catch {
      let link = null;
      if (readlink && hops < 40) { try { link = readlink(p); } catch { link = null; } }
      if (link != null) {
        const tgt = path.posix.isAbsolute(link) ? link : path.posix.join(path.posix.dirname(p), link);
        out = realOf(tgt, hops + 1);
      } else {
        const dir = path.posix.dirname(p);
        out = dir === p ? p : path.posix.join(realOf(dir, hops), path.posix.basename(p));
      }
    }
    memo.set(p, out);
    return out;
  }
  return realOf;
}

function physResolve(base, p, realOf) {
  const abs = path.posix.isAbsolute(p) ? p : base + '/' + p; // 不能用 join：要保留 .. 交给物理回退
  let cur = '/';
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { cur = path.posix.dirname(realOf(cur)); continue; }
    cur = cur === '/' ? '/' + part : cur + '/' + part;
  }
  return realOf(cur);
}

function candidatesOf(raw, home, vars, dyn) {
  let s = raw;
  if (dyn === 'ansi') return [{ dynamic: true }];
  if (dyn) {
    const mh = s.match(/^\$\{?HOME\}?(\/.*)?$/);
    const mt = s.match(/^\$\{?TMPDIR\}?(\/.*)?$/);
    if (mh && vars && path.posix.isAbsolute(vars.HOME || '')) s = vars.HOME + (mh[1] || '');
    else if (mt && vars && path.posix.isAbsolute(vars.TMPDIR || '')) s = vars.TMPDIR + (mt[1] || '');
  }
  if (/[$`*?[\]{}]/.test(s)) return [{ dynamic: true }];
  if (s.startsWith('~')) {
    if (s === '~' || s.startsWith('~/')) {
      if (!home) return [{ dynamic: true }];
      return [{ path: s === '~' ? home : home + '/' + s.slice(2) }, { path: s }];
    }
    return [{ dynamic: true }]; // ~user：home 未知
  }
  return [{ path: s }];
}

function verdictOf(absPath, hasLark, wsList, tmpList, realOf) {
  const p = toPosix(absPath);
  const folded = p.split('/').filter(Boolean).map(fold);
  if (folded.includes('.claude')) return 'protected';
  if (PROTECTED_BASENAMES.has(folded[folded.length - 1] ?? '')) return 'protected';
  const fp = fold(p);
  for (const w of wsList) {
    if (within(fp, w)) {
      const rel = fp.slice(w.length).replace(/^\/+/, '');
      const first = rel.split('/')[0] ?? '';
      if (PROTECTED_FIRST.has(first)) return 'protected';
      if (hasLark && first !== 'outbox') return 'not-outbox';
      return 'ok';
    }
  }
  for (const t of tmpList) if (within(fp, t)) return 'ok';
  return hasLark ? 'outside' : 'ok';
}

function checkOneTarget(t, bases, hasLark, wsList, tmpList, realOf, home, vars) {
  const raw = t.target;
  if (raw === null || raw === undefined) return { target: null, reason: 'unknown' };
  if (raw === '') return { target: raw, reason: 'empty' };
  if (ALWAYS_OK.has(raw) || /^\/dev\/fd\/\d+$/.test(raw)) return null;
  if (raw.startsWith('!') || raw.startsWith('=')) return { target: raw, reason: 'dynamic' };
  let worst = null;
  for (const cand of candidatesOf(raw, home, vars, t.dyn)) {
    if (cand.dynamic) { worst = worse(worst, 'dynamic'); continue; }
    for (const b of bases) {
      const lexAbs = path.posix.resolve(b, cand.path);
      const physAbs = physResolve(b, cand.path, realOf);
      for (const abs of lexAbs === physAbs ? [lexAbs] : [lexAbs, physAbs]) {
        const v = verdictOf(abs, hasLark, wsList, tmpList, realOf);
        if (v !== 'ok') worst = worse(worst, v);
      }
    }
  }
  return worst ? { target: raw, reason: worst } : null;
}

// R1：这几个下载子命令不带 --output / -o 时写进当前目录；--download-resources 写进 ./lark-im-resources/
const IMPLICIT_DOWNLOAD = new Set(['drive +download', 'im +messages-resources-download', 'im +messages-resource-download']);
function larkTargets(rest, restDyn, acc) {
  const before = acc.targets.length;
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k];
    if (w === '--') break;
    const eq = w.match(/^(--[^=]+)=(.*)$/s);
    const longName = (eq ? eq[1] : w).toLowerCase();
    if (w.startsWith('--') && OUT_LONG.test(longName)) {
      if (eq) acc.targets.push({ target: eq[2], dyn: restDyn[k], via: longName });
      else { acc.targets.push({ target: rest[k + 1] === undefined ? '' : rest[k + 1], dyn: restDyn[k + 1] || false, via: longName }); k++; }
      continue;
    }
    const om = /^-[^-=]/.test(w) ? w.match(/^-([A-Za-z]*?)o(.*)$/s) : null;
    if (om) {
      let val = om[2];
      if (val.startsWith('=')) val = val.slice(1);
      if (val !== '') acc.targets.push({ target: val, dyn: restDyn[k], via: '-o' });
      else { acc.targets.push({ target: rest[k + 1] === undefined ? '' : rest[k + 1], dyn: restDyn[k + 1] || false, via: '-o' }); k++; }
    }
  }
  // 子命令前缀与 classifyLark 同口径：剥掉一个 --as user|bot / --as=user|bot
  let i = 0;
  if (rest[0] === '--as' && (rest[1] === 'user' || rest[1] === 'bot')) i = 2;
  else if (rest[0] === '--as=user' || rest[0] === '--as=bot') i = 1;
  if (acc.targets.length === before && IMPLICIT_DOWNLOAD.has(`${rest[i]} ${rest[i + 1]}`)) {
    acc.targets.push({ target: '.', dyn: false, via: 'implicit' });
  }
  if (rest.some((w) => w === '--download-resources' || w.startsWith('--download-resources='))) {
    acc.targets.push({ target: './lark-im-resources/', dyn: false, via: 'implicit' });
  }
}

function teeTargets(rest, restDyn, acc) {
  let opts = true;
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k];
    if (opts && w === '--') { opts = false; continue; }
    if (opts && w.length > 1 && w.startsWith('-')) continue;
    acc.targets.push({ target: w, dyn: restDyn[k], via: 'tee' });
  }
}

function cdTarget(name, rest, restDyn, acc) {
  const args = [];
  const argDyn = [];
  let opts = true;
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k];
    if (opts && w === '--') { opts = false; continue; }
    if (opts && w.length > 1 && /^-[A-Za-z@]+$/.test(w)) continue;
    args.push(w); argDyn.push(restDyn[k]);
  }
  if (args.length === 0) {
    if (name === 'pushd') { acc.unknown = true; return; }
    acc.cds.push({ target: '~', dyn: false });
    return;
  }
  if (name === 'cd' && args.length > 1) { acc.unknown = true; return; }
  const t = args[0];
  if (argDyn[0]) { acc.unknown = true; return; }
  if (t === '-' || /^[-+]\d*$/.test(t) || /^~[^/]/.test(t)) { acc.unknown = true; return; }
  acc.cds.push({ target: t, dyn: false });
}

function envTargets(rest, restDyn, depth, acc) {
  let k = 0;
  while (k < rest.length) {
    const w = rest[k];
    if (w === '--') { k++; break; }
    if (w === '-' || !w.startsWith('-')) break;
    if (w === '-C' || w === '--chdir') { if (rest[k + 1] !== undefined) acc.cds.push({ target: rest[k + 1], dyn: restDyn[k + 1] || false }); k += 2; continue; }
    let m = w.match(/^-C(.+)$/) || w.match(/^--chdir=(.*)$/s);
    if (m) { acc.cds.push({ target: m[1], dyn: restDyn[k] }); k++; continue; }
    if (w === '-S' || w === '--split-string') { if (rest[k + 1] !== undefined) collectTargets([rest[k + 1], ...rest.slice(k + 2)].join(' '), depth + 1, acc); return; }
    m = w.match(/^-S(.+)$/) || w.match(/^--split-string=(.*)$/s);
    if (m) { collectTargets([m[1], ...rest.slice(k + 1)].join(' '), depth + 1, acc); return; }
    if (w === '-u' || w === '-U') { k += 2; continue; }
    k++;
  }
  const tail = rest.slice(k);
  const tailDyn = restDyn.slice(k);
  let j = 0;
  while (j < tail.length && ASSIGN.test(tail[j])) j++;
  if (j < tail.length) dispatchProgram(tail, tailDyn, j, depth, acc);
}

function dispatchProgram(words, dyns, start, depth, acc) {
  const prog = words[start];
  if (prog === undefined) return;
  if (isLarkWord(prog)) { larkTargets(words.slice(start + 1), dyns.slice(start + 1), acc); return; }
  const name = base(prog);
  if (name === 'tee') { teeTargets(words.slice(start + 1), dyns.slice(start + 1), acc); return; }
  if (CD_NAMES.has(name)) { cdTarget(name, words.slice(start + 1), dyns.slice(start + 1), acc); return; }
  if (name === 'popd') { acc.unknown = true; return; }
  if (SHELLS.has(name)) {
    const k = words.findIndex((x, j) => j > start && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
    if (k > start && words[k + 1] !== undefined) collectTargets(words[k + 1], depth + 1, acc);
    return;
  }
  if (name === 'eval') { collectTargets(words.slice(start + 1).join(' '), depth + 1, acc); return; }
  if (name === 'env') { envTargets(words.slice(start + 1), dyns.slice(start + 1), depth, acc); return; }
  if (WRAPPERS.has(name) || OUT_PRECMD.has(prog) || prog.startsWith('-')) {
    const inner = words.findIndex((x, j) => j > start && (isLarkWord(x) || SHELLS.has(base(x)) || OUT_INNER.has(base(x))));
    if (inner > start) dispatchProgram(words, dyns, inner, depth, acc);
    return;
  }
  if (words.length - start === 1) { // zsh AUTO_CD：单词命令看着像路径就当 cd 候选
    if (dyns[start]) { acc.unknown = true; return; }
    if (looksLikePath(prog)) acc.cds.push({ target: prog, dyn: false });
  }
}

function unitTargets(words, dyns, depth, acc) {
  if (!words.length) return;
  for (const w of words) {
    if (isLarkWord(w)) acc.hasLark = true;
    if (/cdpath/i.test(w)) acc.unknown = true;
  }
  let start = 0;
  while (start < words.length && (LEAD_SKIP.has(words[start]) || ASSIGN.test(words[start]))) start++;
  dispatchProgram(words, dyns, start, depth, acc);
}

function collectTargets(src, depth, acc) {
  if (depth > MAX_DEPTH) { acc.unknown = true; return; }
  const { subs, units } = lex(String(src == null ? '' : src));
  // R1：隐式落点（当前目录）只认顶层一串「cd X && cd Y && 下载」里确定会生效的 cd；任何别的分隔符 / 非 cd 段都断链（按全部 base 判）
  let chain = depth === 0 ? [] : null;
  for (const u of units) {
    const t0 = acc.targets.length;
    const c0 = acc.cds.length;
    const unknown0 = acc.unknown;
    for (const r of u.redirs) acc.targets.push({ target: r.target, dyn: r.dyn, via: r.op });
    unitTargets(u.words, u.dyns, depth, acc);
    for (let k = t0; k < acc.targets.length; k++) {
      const t = acc.targets[k];
      // R2：本段自己新增了 cd（env -C / --chdir / 嵌套 sh -c 里的 cd）就不按链判，退回全部 base（更严）
      if (t.via === 'implicit' && !('chain' in t)) t.chain = (chain && acc.cds.length === c0) ? chain.slice() : null;
    }
    const plainCd = (u.words[0] === 'cd' || u.words[0] === 'pushd') && acc.cds.length === c0 + 1 && !acc.unknown && !unknown0;
    if (chain && u.sep === '&&' && plainCd) chain.push(acc.cds[c0].target);
    else chain = null;
  }
  for (const s of subs) collectTargets(s, depth + 1, acc);
}

/** 把一条 Bash 命令里所有写文件落点抽出来：{hasLark, targets:[{target,dyn,via}], cds:[{target,dyn}], unknown}。 */
export function outputTargets(cmdline) {
  const acc = { hasLark: false, targets: [], cds: [], unknown: false };
  collectTargets(String(cmdline == null ? '' : cmdline), 0, acc);
  return acc;
}

/**
 * 判这条命令的写文件落点在 strict/audit 下是否放行。注入 {cwd, workspace, tmpDirs, realpath, readlink, home, vars}。
 * 返回 {ok, deny:[{target,reason}], hasLark}。reason：protected/not-outbox/outside/dynamic/empty/unknown/cwd-protected。
 */
export function checkOutputTargets(cmdline, opts = {}) {
  const { cwd = null, workspace, tmpDirs = [], realpath = null, readlink = null, home = null, vars = {} } = opts;
  const info = outputTargets(cmdline);
  const realOf = makeRealOf(realpath, readlink);
  const ws = toPosix(workspace);
  const wsList = foldAll([ws, realOf(ws)]);
  const tmpList = foldAll(tmpDirs.flatMap((d) => [toPosix(d), realOf(toPosix(d))]));
  const hasLark = info.hasLark;
  const deny = [];

  const bases = [ws];
  const cwdAbs = cwd && path.posix.isAbsolute(toPosix(cwd)) ? toPosix(cwd) : null;
  if (cwdAbs) {
    if (!bases.includes(cwdAbs)) bases.push(cwdAbs);
    // cwd 本身落在硬保护区（.claude/skills/schedules/tasks/CLAUDE.md）里 → 相对写一律进保护区，拒；
    // workspace 根、outbox 等不算（写到哪儿由各 target 自己判）
    if ((hasLark || info.targets.length) && verdictOf(cwdAbs, hasLark, wsList, tmpList, realOf) === 'protected') {
      deny.push({ target: cwdAbs, reason: 'cwd-protected' });
    }
  }
  if (info.unknown) deny.push({ target: null, reason: 'unknown' });

  for (const cd of info.cds) {
    const snapshot = bases.slice();
    const add = [];
    for (const b of snapshot) {
      for (const cand of candidatesOf(cd.target, home, vars, cd.dyn)) {
        if (cand.dynamic) { deny.push({ target: cd.target, reason: 'dynamic' }); continue; }
        const abs = path.posix.resolve(b, cand.path);
        if (verdictOf(abs, hasLark, wsList, tmpList, realOf) === 'protected') deny.push({ target: cd.target, reason: 'cwd-protected' });
        add.push(abs);
      }
    }
    for (const a of add) {
      if (bases.length > 64) { deny.push({ target: null, reason: 'unknown' }); break; }
      if (!bases.includes(a)) bases.push(a);
    }
  }

  // 隐式落点有确定的 cd 链：只按链走到的那个目录判（不再拿 workspace 根等全部 base 兜底）；链里有 ~ 就退回全部 base
  const chainBase = (chain) => {
    if (!Array.isArray(chain)) return null;
    let b = cwdAbs ?? ws;
    for (const c of chain) {
      if (typeof c !== 'string' || c === '' || c.startsWith('~')) return null;
      b = path.posix.isAbsolute(c) ? c : b + '/' + c; // 不用 resolve：保留 .. 交给 physResolve 物理回退
    }
    return b;
  };
  for (const t of info.targets) {
    const cb = t.via === 'implicit' ? chainBase(t.chain) : null;
    const r = checkOneTarget(t, cb ? [cb] : bases, hasLark, wsList, tmpList, realOf, home, vars);
    if (r) deny.push(r);
  }

  const seen = new Set();
  const uniq = [];
  for (const d of deny) { const key = `${d.reason}:${d.target == null ? '' : d.target}`; if (!seen.has(key)) { seen.add(key); uniq.push(d); } }
  return { ok: uniq.length === 0, deny: uniq, hasLark };
}

// ---------------- 名字过滤（审计、日报只落这些） ----------------
export function safeName(token) {
  return typeof token === 'string' && /^\+?[a-z][a-z0-9._-]{0,40}$/.test(token) ? token : OTHER;
}

/** 审计用名：策略表里的名字原样；其余在 safeName 之外再挡 ID 形状（带下划线、≥3 个数字 → <其他>）。 */
export function auditName(token) {
  if (typeof token === 'string' && KNOWN_NAMES.has(token)) return token;
  const s = safeName(token);
  if (s === OTHER || s.includes('_') || (s.match(/\d/g) ?? []).length >= 3) return OTHER;
  return s;
}

const MCP_KNOWN = new Set([...[...FEISHU_MCP_READ, ...FEISHU_MCP_WRITE].map((t) => `mcp__feishu__${t}`), BIZ_TOOL]);
/** 工具名：内置工具形如 Read/WebFetch；MCP 只认飞书的 10 个与 biz_get（BRIDGE-BMS-1）；其余 <其他>。 */
export function safeToolName(name) {
  if (typeof name !== 'string') return OTHER;
  if (MCP_KNOWN.has(name)) return name;
  return /^[A-Z][A-Za-z]{1,40}$/.test(name) ? name : OTHER;
}

// ---------------- 确认通道 ----------------
const CONFIRM_RE = /^(?:确认|\/confirm)(?=$|[\s\p{P}])(?![?？])/iu;

/**
 * 句首「确认」或 /confirm（只认 owner 私聊）：返回 {confirmed:true, prompt:去掉确认词后的正文}，正文为空时用默认提示；
 * 其余情况 {confirmed:false, prompt:原文}。只管这一轮，下一轮自然失效。
 */
export function detectConfirm(text, chatType, isOwner) {
  const raw = typeof text === 'string' ? text : '';
  if (chatType !== 'p2p' || isOwner !== true) return { confirmed: false, prompt: text };
  const t = raw.trim();
  const m = CONFIRM_RE.exec(t);
  if (!m) return { confirmed: false, prompt: text };
  const rest = t.slice(m[0].length).replace(/^[\s\p{P}]+/u, '').trim();
  return { confirmed: true, prompt: rest || CONFIRM_DEFAULT_PROMPT };
}
