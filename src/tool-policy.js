// BRIDGE-PERM-1：owner 工具档（OWNER_TOOL_PROFILE=audit|strict）的纯策略层。
// 只有数据和纯函数：不读环境变量、不碰文件、不联网。claude.js 用它生成 --allowedTools/--disallowedTools，
// tool-audit.js 用它给审计记录和回执分级，hooks/untrusted-note.js 用它判断哪些输出含第三方内容。
//
// 分级：read（两档都放行）/ write（只对话放行，回复末尾附回执）/ confirm（先出草稿，光总回「确认」的下一轮才放行）
//      / chat-only（只对话放行，如 auth login）/ deny（一律拒绝）。不在表里的 lark 子命令一律按 deny 处理。

export const STRICT_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebSearch', 'ToolSearch', 'Skill']);
export const FEISHU_MCP_READ = Object.freeze(['doc_read', 'sheet_read', 'bitable_tables', 'bitable_fields', 'bitable_records', 'mail_attachment_download']);
export const FEISHU_MCP_WRITE = Object.freeze(['doc_append', 'bitable_create_record', 'bitable_update_record', 'sheet_write']);
export const HELP_DOMAINS = Object.freeze(['im', 'contact', 'approval', 'calendar', 'mail', 'docs', 'sheets', 'drive', 'whiteboard', 'auth']);
export const CONFIRM_DEFAULT_PROMPT = '（光总已确认上一轮的草稿，请执行）';
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
  // ---- confirm：先出草稿，光总回「确认」的下一轮才放行 ----
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
  let words = [];
  let cur = null;
  let quote = null;
  let skipNext = false; // 重定向目标
  let heredoc = null; // 'want'：下一个词是 heredoc 定界符
  const heredocs = [];
  const push = () => {
    if (cur === null) return;
    if (heredoc === 'want') { heredocs.push(cur.replace(/^-/, '')); heredoc = null; }
    else if (skipNext) skipNext = false;
    else words.push(cur);
    cur = null;
  };
  const endSeg = () => {
    push();
    if (words.length) segs.push(words);
    words = [];
    skipNext = false;
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
      else if (c === '$' && n === '(') { const [inner, j] = readBalanced(src, i + 2); subs.push(inner); cur += '$()'; i = j - 1; }
      else if (c === '`') { const [inner, j] = readBacktick(src, i + 1); subs.push(inner); cur += '``'; i = j - 1; }
      else cur += c;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { push(); continue; }
    if (c === '\n') {
      endSeg();
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
    if (c === '$' && n === "'") { quote = "'"; cur = cur ?? ''; i++; continue; }
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
      continue;
    }
    if (c === '`') {
      const [inner, j] = readBacktick(src, i + 1);
      subs.push(inner);
      cur = (cur ?? '') + '``';
      i = j - 1;
      continue;
    }
    if ((c === '<' || c === '>') && n === '(') {
      // 进程替换 <( ) >( )
      push();
      const [inner, j] = readBalanced(src, i + 2);
      subs.push(inner);
      i = j - 1;
      continue;
    }
    if (c === '(' || c === ')') { endSeg(); continue; }
    if (c === ';') { endSeg(); continue; }
    if (c === '|') { endSeg(); if (n === '|' || n === '&') i++; continue; }
    if (c === '&' && n === '&') { endSeg(); i++; continue; }
    if (c === '&' && n === '>') {
      push();
      i++;
      if (src[i + 1] === '>') i++;
      skipNext = true;
      continue;
    }
    if (c === '&') { endSeg(); continue; }
    if (c === '>' || c === '<') {
      // 重定向：可带 fd 前缀（2>）、>> >| >& <& << <<- <<<
      if (cur !== null && /^\d+$/.test(cur)) cur = null; else push();
      let op = c;
      while (src[i + 1] !== undefined && '<>|&'.includes(src[i + 1]) && op.length < 3) op += src[++i];
      if (op === '<<' && src[i + 1] === '-') { op += '-'; i++; }
      if (op.endsWith('&')) {
        // >&1 <&- 这种 fd 复制：后面紧跟数字或 -，没有目标词
        let k = i + 1;
        while (k < src.length && /[\d-]/.test(src[k])) k++;
        if (k > i + 1) { i = k - 1; continue; }
        skipNext = true;
        continue;
      }
      if (op === '<<' || op === '<<-') heredoc = 'want';
      else skipNext = true;
      continue;
    }
    cur = (cur ?? '') + c;
  }
  endSeg();
  return { segs, subs };
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

function stripLead(words) {
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
  return words.slice(i);
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

const MCP_KNOWN = new Set([...FEISHU_MCP_READ, ...FEISHU_MCP_WRITE].map((t) => `mcp__feishu__${t}`));
/** 工具名：内置工具形如 Read/WebFetch；MCP 只认飞书的 10 个；其余 <其他>。 */
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
