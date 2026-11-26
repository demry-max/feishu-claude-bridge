// BRIDGE-PERM-1：owner 工具档（OWNER_TOOL_PROFILE=audit|strict）的审计记录、每日汇总、本轮回执、MCP 第三方内容围栏。
//
// 审计文件 data/tool-audit.jsonl 每行只有 8 个字段：{ts, kind, tool, domain, cmd, method, decision, denied}。
// 名字一律过 auditName / safeToolName：参数、正文、路径、chat_id、怪名字都不落盘。
// 原始工具输入只留在进程内存里给本轮回执用（回执同样先 redact、只露目标尾号与正文前 20 字）。
// 本模块加载时没有副作用（不读环境变量、不建目录、不开定时器）：claude.js、index.js、mcp-feishu.js 都可以直接 import。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyCommand, classifySegments, auditName, safeToolName, STRICT_TOOLS, FEISHU_MCP_READ, checkOutputTargets, usesEqAsPrefix } from './tool-policy.js';
import { fenceUntrusted } from './messages.js';
import { BIZ_TOOL, bizAuditFields } from './biz-targets.js';
import { BRAIN_ALLOWED_TOOLS } from './brain-targets.js';

const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const nameOrNull = (v) => (v == null ? null : auditName(v));
// 定时 strict 档：--tools 之外，只有这些非 Bash 工具能用（WebSearch 没预批，-p 下会被拒）
const SCHED_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'ToolSearch', 'Skill']);
const SCHED_MCP = new Set(FEISHU_MCP_READ.map((t) => `mcp__feishu__${t}`));

// BRIDGE-PERM-2：strict/audit 的输出路径提权闸用的注入项。owner 写文件只能落在 workspace 的 outbox/ 或系统临时目录；
// .claude / CLAUDE.md / skills / schedules / tasks 一律不可作为落点（判定逻辑在纯函数 checkOutputTargets 里）。
// 真实 fs 每次判定时现取，模块加载时不碰文件系统（与本模块「加载无副作用」的约定一致）。
function guardOptions(workspace) {
  const readlink = (p) => {
    try { return fs.readlinkSync(p); } catch { return null; }
  };
  return {
    cwd: workspace,
    workspace,
    tmpDirs: [os.tmpdir(), '/tmp'],
    realpath: fs.realpathSync,
    readlink,
    home: os.homedir(),
    vars: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  };
}

/**
 * 按 strict 档的规则预判一次调用（audit 档用它预演 strict；strict 档用它和真实的 permission_denials 对账）。
 * 只返回安全名，不返回任何参数。workspace 非空时再过一道输出路径闸：写到 outbox/临时目录之外（或保护区）判拒。
 */
function judge(use, kind, profile, confirm, workspace, brain) {
  const name = use?.name;
  // BRIDGE-BMS-1：biz_get 只读 GET，对话与定时都放行；只记 target、路径类别、方法，不记 path / query 的值
  if (name === BIZ_TOOL) {
    const f = bizAuditFields(use?.input);
    return { tool: BIZ_TOOL, domain: nameOrNull(f.domain), cmd: nameOrNull(f.cmd), method: nameOrNull(f.method), decision: 'allow' };
  }
  if (BRAIN_ALLOWED_TOOLS.includes(name)) {
    return { tool: name, domain: null, cmd: null, method: null, decision: brain ? 'allow' : 'deny' };
  }
  if (name === 'Bash') {
    const command = typeof use?.input?.command === 'string' ? use.input.command : '';
    const c = classifyCommand(command);
    let decision;
    if (kind === 'sched') decision = c.profileAllowed.sched ? 'allow' : 'deny';
    else if (c.class === 'confirm') decision = profile === 'strict' && confirm === true ? 'allow' : 'confirm';
    else decision = c.decision;
    // R1：`lark-cli --as=user …` 前置等号写法——strict 的规则只有 `--as user` / `--as bot` 前缀，CLI 侧不会命中，审计也判 deny
    if (usesEqAsPrefix(command)) decision = 'deny';
    // 输出路径提权闸：strict 真拒（PreToolUse 钩子落地），audit 记「将拒绝」。已判 deny 的不必再过。
    if (workspace && decision !== 'deny' && !checkOutputTargets(command, guardOptions(workspace)).ok) decision = 'deny';
    if (c.lark) return { tool: 'Bash', domain: nameOrNull(c.domain), cmd: nameOrNull(c.cmd), method: nameOrNull(c.method), decision };
    return { tool: 'Bash', domain: null, cmd: nameOrNull(c.program), method: null, decision };
  }
  const ok = kind === 'sched'
    ? SCHED_TOOLS.has(name) || SCHED_MCP.has(name)
    : STRICT_TOOLS.includes(name) || (typeof name === 'string' && name.startsWith('mcp__feishu__'));
  return { tool: safeToolName(name), domain: null, cmd: null, method: null, decision: ok ? 'allow' : 'deny' };
}

/**
 * 一轮 claude 调用的审计收集器：喂 stream-json 的 assistant / user / result 事件。
 * result 事件（带 permission_denials）到了才落盘；进程中途退出没有 result 时由 flush() 补写。flush 幂等。
 * onToolEvent 收到 {phase:'use'|'result'|'denied', …}（含原始输入，只在进程内给回执用）。
 */
export function createToolRecorder({ kind = 'chat', profile = 'audit', confirm = false, workspace = null, brain = false, file, onToolEvent = null, now = () => new Date(), log = console } = {}) {
  const uses = [];
  const seen = new Set();
  const denied = new Set();
  let written = false;
  const emit = (e) => {
    if (typeof onToolEvent !== 'function') return;
    try {
      onToolEvent(e);
    } catch {
      log.error?.('[tool-audit] 工具事件回调出错（已忽略）');
    }
  };
  const flush = () => {
    if (written) return;
    written = true;
    const records = uses.map((u) => ({
      ts: u.ts,
      kind,
      ...judge(u, kind, profile, confirm, workspace, brain),
      denied: u.fromDenial === true || (typeof u.id === 'string' && denied.has(u.id)),
    }));
    if (records.length) appendToolAudit(file, records, { log });
  };
  return {
    assistant(d) {
      const content = d?.message?.content;
      if (!Array.isArray(content)) return;
      for (const c of content) {
        if (c?.type !== 'tool_use') continue;
        if (typeof c.id === 'string') {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
        }
        const u = { id: c.id, name: c.name, input: c.input ?? {}, ts: now().toISOString() };
        uses.push(u);
        emit({ phase: 'use', id: u.id, name: u.name, input: u.input });
      }
    },
    user(d) {
      const content = d?.message?.content;
      if (!Array.isArray(content)) return;
      for (const c of content) {
        if (c?.type !== 'tool_result') continue;
        emit({ phase: 'result', id: c.tool_use_id, isError: c.is_error === true });
      }
    },
    result(d) {
      const list = Array.isArray(d?.permission_denials) ? d.permission_denials : [];
      for (const p of list) {
        const id = p?.tool_use_id;
        if (typeof id === 'string') denied.add(id);
        // 被拒但流里没见过对应的 tool_use：照样记一条（标 denied）
        if (typeof id !== 'string' || !seen.has(id)) {
          uses.push({ id, name: p?.tool_name, input: p?.tool_input ?? {}, ts: now().toISOString(), fromDenial: true });
          if (typeof id === 'string') seen.add(id);
        }
        emit({ phase: 'denied', id, name: p?.tool_name, input: p?.tool_input });
      }
      flush();
    },
    flush,
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DECISIONS = new Set(['allow', 'deny', 'confirm']);

// 落盘前再裁一遍：只留 8 个字段，名字过滤，未知判定按 deny
function sanitizeRecord(r) {
  return {
    ts: typeof r?.ts === 'string' && ISO.test(r.ts) ? r.ts : new Date().toISOString(),
    kind: r?.kind === 'sched' ? 'sched' : 'chat',
    tool: safeToolName(r?.tool),
    domain: nameOrNull(r?.domain),
    cmd: nameOrNull(r?.cmd),
    method: nameOrNull(r?.method),
    decision: DECISIONS.has(r?.decision) ? r.decision : 'deny',
    denied: r?.denied === true,
  };
}

/** 追加审计记录：只追加；文件到 maxBytes 先轮转成 .1（覆盖旧的 .1）。写失败只记一行日志，不抛。 */
export function appendToolAudit(file, records, { maxBytes = MAX_AUDIT_BYTES, log = console } = {}) {
  try {
    const list = Array.isArray(records) ? records : [];
    if (!list.length) return;
    const text = `${list.map((r) => JSON.stringify(sanitizeRecord(r))).join('\n')}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    if (size >= maxBytes) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, text, { mode: 0o600 });
  } catch (e) {
    log.error?.('[tool-audit] 审计写入失败：', e?.code || 'unknown');
  }
}

// ---------------- 每日汇总 ----------------
const KIND_LABEL = { sched: '定时', chat: '对话' };
const MAX_SUMMARY_ITEMS = 20;

function summaryName(r) {
  const tool = safeToolName(r?.tool);
  if (tool !== 'Bash') return tool;
  const domain = nameOrNull(r?.domain);
  const cmd = nameOrNull(r?.cmd);
  const method = nameOrNull(r?.method);
  if (domain === null) {
    if (cmd === null) return 'lark-cli';
    if (cmd === '--help') return 'lark-cli --help';
    return `Bash ${cmd}`;
  }
  const parts = [];
  for (const p of [domain, cmd, method]) {
    if (p === null) break;
    parts.push(p);
    if (p === '<其他>') break;
  }
  return `lark-cli ${parts.join(' ')}`;
}

function summaryLabel(r) {
  if (r?.denied === true) return '已拒绝';
  if (r?.decision === 'deny') return '将拒绝';
  if (r?.decision === 'confirm') return '需确认';
  return null;
}

/** 把审计记录汇成一条私聊文本：只列被拒 / 将拒绝 / 需确认的命令名与次数；最多 21 行；没有就返回 ''。 */
export function buildToolAuditSummary(records, { profile = 'audit' } = {}) {
  const groups = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    const label = summaryLabel(r);
    if (!label) continue;
    const kind = r?.kind === 'sched' ? 'sched' : 'chat';
    const name = summaryName(r);
    const key = `${kind}\u0000${name}\u0000${label}`;
    const g = groups.get(key) ?? { kind, name, label, n: 0 };
    g.n++;
    groups.set(key, g);
  }
  if (!groups.size) return '';
  const items = [...groups.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind)
    || a.label.localeCompare(b.label));
  const shown = items.length > MAX_SUMMARY_ITEMS ? items.slice(0, MAX_SUMMARY_ITEMS - 1) : items;
  const lines = [`🔒 工具审计日报（${profile === 'strict' ? 'strict' : 'audit'} 档）：上次汇总以来被拒或需确认的调用，只列命令名`];
  for (const g of shown) lines.push(`${KIND_LABEL[g.kind]} · \`${g.name}\` · ${g.label} × ${g.n}`);
  if (shown.length < items.length) lines.push(`另有 ${items.length - shown.length} 类未列出（明细见 data/tool-audit.jsonl）`);
  return lines.join('\n');
}

function readAuditRecords(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object' && !Array.isArray(r)) out.push(r);
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

function writeStateAtomic(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 跑一次日报：读上次汇总时间之后、now 之前的审计（含轮转出去的 .1），有内容就 send 一条。
 * 发出去（或没东西可发）才推进 lastSummaryAt；发送失败不推进，下次补发。永不抛。
 */
export async function runToolAuditSummary({ auditFile, stateFile, send, now = () => new Date(), profile = 'audit', log = console } = {}) {
  try {
    const nowMs = now().getTime();
    let since = 0;
    try {
      const t = Date.parse(JSON.parse(fs.readFileSync(stateFile, 'utf8'))?.lastSummaryAt);
      if (Number.isFinite(t)) since = t;
    } catch {
      since = 0;
    }
    const records = [...readAuditRecords(`${auditFile}.1`), ...readAuditRecords(auditFile)].filter((r) => {
      const t = Date.parse(r.ts);
      return Number.isFinite(t) && t > since && t <= nowMs;
    });
    const text = buildToolAuditSummary(records, { profile });
    if (text) {
      try {
        await send(text);
      } catch (e) {
        log.error?.('[tool-audit] 日报发送失败，下次补发：', e?.message ?? e);
        return false;
      }
    }
    writeStateAtomic(stateFile, { lastSummaryAt: new Date(nowMs).toISOString() });
    return true;
  } catch (e) {
    log.error?.('[tool-audit] 日报失败：', e?.code || e?.message || e);
    return false;
  }
}

/**
 * 每天 at（默认 21:30，本地时间）跑一次日报。legacy 或 at 为空白不启用；格式不对记一行日志不启用。
 * 返回 {stop} 或 null。定时器 unref，不拖住进程退出。
 */
export function startToolAuditSummary({ profile, at, auditFile, stateFile, send, now = () => new Date(), setTimer = setTimeout,
  clearTimer = clearTimeout, log = console } = {}) {
  if (profile !== 'audit' && profile !== 'strict') return null;
  const spec = at == null ? '21:30' : String(at).trim();
  if (!spec) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(spec);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    log.error?.('[tool-audit] TOOL_AUDIT_SUMMARY_AT 应为 HH:MM（如 21:30），当前值无效，工具审计日报不启用');
    return null;
  }
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  let stopped = false;
  let current = null;
  const nextAfter = (baseMs) => {
    const d = new Date(baseMs);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= baseMs) d.setDate(d.getDate() + 1);
    return d.getTime();
  };
  const arm = (baseMs) => {
    if (stopped) return;
    const due = nextAfter(baseMs);
    current = setTimer(async () => {
      try {
        await runToolAuditSummary({ auditFile, stateFile, send, now, profile, log });
      } catch {
        log.error?.('[tool-audit] 日报异常（已忽略）');
      } finally {
        // 定时器可能提前几毫秒触发：至少越过本次到点时刻再排，避免同一分钟连发
        arm(Math.max(now().getTime(), due + 1000));
      }
    }, Math.max(0, due - now().getTime()));
    current?.unref?.();
  };
  arm(now().getTime());
  log.log?.(`[tool-audit] 工具审计日报已启用：每天 ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}（${profile} 档）`);
  return {
    stop() {
      stopped = true;
      if (current) clearTimer(current);
    },
  };
}

// ---------------- 本轮回执 ----------------
const RECEIPT_KINDS = [
  { label: '发消息', unit: '条', match: (s) => s.domain === 'im' && (s.cmd === '+messages-send' || s.cmd === '+messages-reply') },
  { label: '导入文档', unit: '个', match: (s) => s.domain === 'drive' && s.cmd === '+import' },
  { label: '建日程', unit: '个', match: (s) => s.domain === 'calendar' && s.cmd === '+create' },
  { label: '发邮件', unit: '封', match: (s) => s.domain === 'mail' },
  { label: '处理审批', unit: '项', match: (s) => s.domain === 'approval' && s.cmd === 'tasks' },
  { label: '审批实例操作', unit: '项', match: (s) => s.domain === 'approval' && s.cmd === 'instances' },
  { label: '撤回消息', unit: '条', match: (s) => s.domain === 'im' && s.cmd === 'messages' },
  { label: '建群', unit: '个', match: (s) => s.domain === 'im' && s.cmd === '+chat-create' },
  { label: '改群', unit: '次', match: (s) => s.domain === 'im' && s.cmd === '+chat-update' },
  { label: '群成员变更', unit: '次', match: (s) => s.domain === 'im' && s.cmd === 'chat.members' },
  { label: '其他操作', unit: '次', match: () => true },
];
const TARGET_FLAGS = ['--chat-id', '--user-id', '--open-id', '--union-id', '--receive-id', '--message-id'];
const TEXT_FLAGS = ['--text', '--markdown'];
const MAX_DETAILS = 3;

function flagValue(tokens, keys) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    for (const k of keys) {
      if (t === k) return tokens[i + 1] ?? null;
      if (t.startsWith(`${k}=`)) return t.slice(k.length + 1);
    }
  }
  return null;
}

function messageDetail(tokens, redact) {
  const target = flagValue(tokens, TARGET_FLAGS);
  const rawText = flagValue(tokens, TEXT_FLAGS);
  const text = rawText == null ? '' : [...String(redact(String(rawText))).replace(/\s+/g, ' ').trim()].slice(0, 20).join('');
  return `${target ? `→ …${String(target).slice(-4)}` : ''}${text ? `「${text}」` : ''}`;
}

/**
 * 本轮以 owner 名义执行成功的写 / 确认级 lark-cli 调用，按类计数成一行回执；没有就返回 ''。
 * 失败、被拒、没等到结果、只读的调用都不算。detail=true 时发消息附前 3 条明细（目标尾 4 位 + 正文前 20 字，先 redact）。
 */
export function formatReceipt(events, { redact = String, detail = true } = {}) {
  const list = Array.isArray(events) ? events : [];
  const results = new Map();
  const denied = new Set();
  for (const e of list) {
    if (e?.phase === 'result') results.set(e.id, e.isError === true);
    else if (e?.phase === 'denied') denied.add(e.id);
  }
  const counts = new Map();
  const details = [];
  for (const e of list) {
    if (e?.phase !== 'use' || e.name !== 'Bash' || results.get(e.id) !== false || denied.has(e.id)) continue;
    const command = typeof e.input?.command === 'string' ? e.input.command : '';
    for (const s of classifySegments(command)) {
      if (!s.lark || s.program !== 'lark-cli' || (s.class !== 'write' && s.class !== 'confirm')) continue;
      const k = RECEIPT_KINDS.find((x) => x.match(s));
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (k === RECEIPT_KINDS[0] && detail) {
        const d = messageDetail(s.tokens, redact);
        if (d) details.push(d);
      }
    }
  }
  const parts = [];
  for (const k of RECEIPT_KINDS) {
    const n = counts.get(k);
    if (!n) continue;
    if (k === RECEIPT_KINDS[0] && detail && details.length) {
      const shown = details.slice(0, MAX_DETAILS);
      parts.push(`${k.label} ${n} ${k.unit}（${shown.join('；')}${n > shown.length ? '等' : ''}）`);
    } else {
      parts.push(`${k.label} ${n} ${k.unit}`);
    }
  }
  return parts.length ? `— 本轮以你名义：${parts.join('、')}` : '';
}

/**
 * index.js 的一轮 owner 对话包装：audit/strict 下收集工具事件、给回复附回执；strict 的 owner 私聊处理「确认」。
 * legacy 与访客原样透传（同一个 runClaude、prompt 不变、回执恒等）。不改调用方传入的 opts。
 * BRIDGE-PERM-2 Q3：回执只在 owner 私聊出现；群里 owner 轮次不附回执（写动作照常进审计），避免在群里回放目标与正文。
 */
export function createToolTurn({ profile, isOwner, chatType, prompt, confirm, runClaude, redact = String } = {}) {
  if (isOwner !== true || (profile !== 'audit' && profile !== 'strict')) {
    return { prompt, runClaude, withReceipt: (answer) => answer };
  }
  const confirmOn = profile === 'strict' && chatType === 'p2p' && confirm?.confirmed === true;
  const events = [];
  const wrapped = (chatId, p, owner, extraTools, onProgress, opts) => runClaude(chatId, p, owner, extraTools, onProgress, {
    ...(opts ?? {}),
    onToolEvent: (e) => {
      events.push(e);
      if (typeof opts?.onToolEvent === 'function') opts.onToolEvent(e);
    },
    confirm: confirmOn,
  });
  return {
    prompt: confirmOn ? confirm.prompt : prompt,
    runClaude: wrapped,
    withReceipt: (answer) => {
      if (chatType !== 'p2p') return answer; // Q3：群聊不附回执
      const r = formatReceipt(events, { redact, detail: true });
      return r ? `${answer}\n\n${r}` : answer;
    },
  };
}

// ---------------- MCP 第三方内容围栏 ----------------
/** 包一层 mcp-feishu 的 ok()：文本内容放进随机围栏（清掉伪造标记），结构不变。只在 FEISHU_MCP_FENCE=1 时由 mcp-feishu.js 动态加载。 */
export function fencedMcpResult(label, ok) {
  return (data) => {
    const r = ok(data);
    return { ...r, content: r.content.map((c) => (c?.type === 'text' ? { ...c, text: fenceUntrusted(label, c.text) } : c)) };
  };
}
