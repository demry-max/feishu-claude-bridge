// 心跳外部增量（BRIDGE-EV-1）：HEARTBEAT_WATCH 的 chat_reply / approval 两个源。
//
// 桥接以光总身份（lark-cli --as user）执行**固定的只读命令**，拉取台账 watch 指定的增量；
// argv 模板逐字冻结在下面 TEMPLATES 里，变量只来自校验过的值（会话 ID、消息 ID、审批实例码、
// 桥接自己算的时间），runner 再按模板逐项比对一遍，对不上一律不执行。
// 子进程不经 shell、15 秒超时、输出上限 1MB，环境变量只给 HOME、PATH、LANG（不带 FEISHU_* 等密钥）。
// 某一条拉取失败或超时只影响这一条：本拍不出它的增量、游标不动（降级为只看台账），不抛异常。
import { execFile as nodeExecFile } from 'node:child_process';
import crypto from 'node:crypto';
import { parseTime } from './heartbeat.js';

/**
 * 三个只读模板（参数名以 lark-cli v1.0.97 内置文档为准）：
 * - chatMessages：lark-im references/lark-im-chat-messages-list（--chat-id / --start / --order / --page-size / --no-reactions）
 * - messageGet：lark-im references/lark-im-messages-mget（只用来把 watch.after 的 om_ 游标换成发送时间）
 * - approvalGet：lark-approval references/lark-approval-instances-get（--params '{"instance_code":"…"}'）
 * `<…>` 是变量槽，其余每一项都是定值；`--as user` 固定在末尾。
 */
export const TEMPLATES = Object.freeze({
  chatMessages: Object.freeze([
    'im', '+chat-messages-list', '--chat-id', '<chat_id>', '--start', '<start>', '--order', 'desc',
    '--page-size', '50', '--no-reactions', '--format', 'json', '--as', 'user',
  ]),
  messageGet: Object.freeze([
    'im', '+messages-mget', '--message-ids', '<message_id>', '--no-reactions', '--format', 'json', '--as', 'user',
  ]),
  approvalGet: Object.freeze([
    'approval', 'instances', 'get', '--params', '<params>', '--format', 'json', '--as', 'user',
  ]),
});

/** 白名单只能是只读：模板的定值里出现这些字样即视为越权（测试逐项断言）。 */
export const FORBIDDEN_WORDS = Object.freeze(['send', 'reply', 'approve', 'reject', 'create', 'delete', 'update', 'patch', 'api', 'auth']);

const SLOT_RE = Object.freeze({
  '<chat_id>': /^oc_[A-Za-z0-9_-]{1,64}$/,
  '<message_id>': /^om_[A-Za-z0-9_-]{1,64}$/,
  '<start>': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
  '<params>': /^\{"instance_code":"[A-Za-z0-9][A-Za-z0-9_-]{0,127}"\}$/,
});
const MS_TS_RE = /^\d{10,13}$/;
const MAX_SHOWN = 5; // 每条台账最多列几条新消息
const MAX_TEXT = 300; // 每条消息正文最多取多少字
const MAX_COMMENT = 200; // 每条审批评论最多取多少字
const MAX_COMMENTS = 3;
const MAX_SEEN_IDS = 50;
const APPROVAL_EVERY = 2; // 同一条审批最多隔拍拉一次
const CONCURRENCY = 3;
const APPROVAL_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'CANCELED', 'DELETED']);

const pad2 = (n) => String(n).padStart(2, '0');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fmtShort = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** argv 是否逐项对得上某个模板（定值逐字相等、变量槽过正则）。 */
export function isAllowedArgv(argv) {
  if (!Array.isArray(argv)) return false;
  return Object.values(TEMPLATES).some((tpl) => tpl.length === argv.length && tpl.every((t, i) => {
    const v = argv[i];
    if (typeof v !== 'string') return false;
    const re = SLOT_RE[t];
    return re ? re.test(v) : v === t;
  }));
}

/** 按模板填变量槽；填完对不上白名单返回 null（调用方跳过这一条，不执行）。 */
export function fillTemplate(name, slots) {
  const tpl = TEMPLATES[name];
  if (!tpl) return null;
  const argv = tpl.map((t) => (SLOT_RE[t] ? slots?.[t.slice(1, -1)] : t));
  return isAllowedArgv(argv) ? argv : null;
}

/** 本地时间、秒精度、带时区偏移的 ISO 8601（--start 的格式，例：2026-03-10T00:00:00+08:00）。 */
export function localIsoSeconds(ms) {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    + `${off >= 0 ? '+' : '-'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

/** 接口时间：秒或毫秒（数字或数字串，≤10 位按秒），或台账同口径的时间文本。解析不出返回 null。 */
export function apiTimeMs(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d{1,13}$/.test(s)) {
    const n = Number(s);
    if (!(n > 0)) return null;
    return s.length <= 10 ? n * 1000 : n;
  }
  const p = parseTime(s);
  if (p !== null) return p;
  const q = Date.parse(s);
  return Number.isFinite(q) ? q : null;
}

/**
 * 只读 runner：execFile(LARK_CLI_BIN || 'lark-cli', argv, { shell:false, timeout:15000, maxBuffer:1MB, env:{HOME,PATH,LANG} })。
 * 返回 Promise<{ ok:true, stdout } | { ok:false, reason }>，永不 reject；argv 不在白名单内直接拒绝、不起进程。
 */
export function createLarkRunner({ execFileImpl = nodeExecFile, env = process.env, bin } = {}) {
  const file = bin || env.LARK_CLI_BIN || 'lark-cli';
  const childEnv = {};
  for (const k of ['HOME', 'PATH', 'LANG']) if (typeof env[k] === 'string') childEnv[k] = env[k];
  return function runLarkCli(argv) {
    return new Promise((resolve) => {
      if (!isAllowedArgv(argv)) {
        resolve({ ok: false, reason: 'argv 不在只读白名单内，未执行' });
        return;
      }
      try {
        execFileImpl(file, [...argv], { shell: false, timeout: 15_000, maxBuffer: 1 << 20, env: { ...childEnv } }, (err, stdout) => {
          if (!err) {
            resolve({ ok: true, stdout: String(stdout ?? '') });
            return;
          }
          let reason;
          if (err.killed || err.signal) reason = '超时或被终止';
          else if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reason = '输出超过 1MB';
          else if (typeof err.code === 'number') reason = `退出码 ${err.code}`;
          else reason = `无法执行（${typeof err.code === 'string' ? err.code : 'error'}）`;
          resolve({ ok: false, reason });
        });
      } catch (e) {
        resolve({ ok: false, reason: `无法启动（${typeof e?.code === 'string' ? e.code : 'error'}）` });
      }
    });
  };
}

function parseJson(stdout) {
  try {
    const v = JSON.parse(String(stdout ?? '').trim() || 'null');
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

// lark-cli 的 JSON 输出：messages 可能在顶层，也可能包在 data 里
function messagesOf(o) {
  for (const c of [o?.messages, o?.data?.messages, o?.data?.items, o?.items]) if (Array.isArray(c)) return c;
  return [];
}
const hasMoreOf = (o) => o?.has_more === true || o?.data?.has_more === true;

// 发送人显示名只留安全字符（字母、数字、空格、. _ · -），最长 32 字
const safeName = (v) => String(v ?? '').replace(/[^\p{L}\p{N} _.·-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 32);
const clip = (s, n) => {
  const cps = Array.from(String(s ?? '').replace(/\s+/g, ' ').trim());
  return cps.length > n ? `${cps.slice(0, n).join('')}…` : cps.join('');
};

const PLACEHOLDER_BY_TYPE = { image: '[图片]', file: '[文件]', audio: '[语音]', media: '[视频]', video: '[视频]', sticker: '[表情]', folder: '[文件夹]' };

// 正文：图片、文件等换成占位符；行内资源标记（lark-cli 渲染格式）同样替换
function messageText(m) {
  const typed = PLACEHOLDER_BY_TYPE[m?.msg_type];
  if (typed) return typed;
  let c = m?.content;
  if (isObj(c)) c = typeof c.text === 'string' ? c.text : '';
  if (typeof c !== 'string') return '[非文本消息]';
  const text = c
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/<folder\b[^>]*\/>|<folder\b[^>]*>[\s\S]*?<\/folder>/g, '[文件夹]')
    .replace(/<file\b[^>]*\/?>/g, '[文件]')
    .replace(/<audio\b[^>]*\/?>/g, '[语音]')
    .replace(/<(?:video|media)\b[^>]*\/?>/g, '[视频]')
    .replace(/\[Sticker\]/g, '[表情]');
  return clip(text, MAX_TEXT) || '（空消息）';
}

// 只留真人发的：sender_type 为 user（缺省时要求 ou_ 开头且不是机器人）；去掉 owner 本人、system、已撤回
function isOtherHuman(m, owner) {
  if (!isObj(m) || m.msg_type === 'system' || m.deleted === true) return false;
  const s = isObj(m.sender) ? m.sender : {};
  const type = s.sender_type ?? s.type;
  const id = s.id ?? s.open_id;
  if (s.open_bot_id) return false;
  if (type !== undefined && type !== 'user') return false;
  if (type === undefined && !(typeof id === 'string' && id.startsWith('ou_'))) return false;
  if (owner && id === owner) return false;
  return true;
}

function dueKey(t) {
  const ts = ['next_check_at', 'escalate_after'].map((f) => t?.times?.[f]).filter((x) => Number.isFinite(x));
  return ts.length ? Math.min(...ts) : Infinity;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * 心跳 collectDeltas 的真实实现。heartbeat 传入 { tasks（在跟进且带 watch 的台账，watch 已按锁取生效值）,
 * now, watch（生效的源，逗号分隔或 none）, max, beat（拍号）, cursor, stats }；
 * 返回 { deltas:[{slug, source, text}], cursor, stats }。cursor 由心跳决定何时落盘（模型看过才前移）。
 */
export function createWatchSources({ runner, getOwner = () => '', log = console.log } = {}) {
  if (typeof runner !== 'function') throw new Error('createWatchSources 需要 runner');
  return async function collectDeltas({ tasks = [], now = new Date(), watch = 'none', max = 10, beat = 0, cursor = {}, stats = {} } = {}) {
    const sources = new Set(String(watch ?? '').split(',').map((s) => s.trim()).filter((s) => s === 'chat_reply' || s === 'approval'));
    const nextCursor = isObj(cursor) ? { ...cursor } : {};
    const st = isObj(stats) ? stats : {};
    const nextStats = { ...st, sources: { ...(isObj(st.sources) ? st.sources : {}) }, pulled: { ...(isObj(st.pulled) ? st.pulled : {}) } };
    const list = Array.isArray(tasks) ? tasks.filter((t) => t && typeof t.slug === 'string' && isObj(t.watch)) : [];
    // 已不在跟进 / 不再 watch 的条目：游标与隔拍记录一并清掉
    const live = new Set(list.map((t) => t.slug));
    for (const k of Object.keys(nextCursor)) if (!live.has(k)) delete nextCursor[k];
    for (const k of Object.keys(nextStats.pulled)) if (!live.has(k)) delete nextStats.pulled[k];
    if (!sources.size) return { deltas: [], cursor: nextCursor, stats: nextStats };

    const owner = String((await Promise.resolve().then(getOwner).catch(() => '')) ?? '');
    const nowMs = now.getTime();
    const skipped = {};
    const skip = (why) => { skipped[why] = (skipped[why] ?? 0) + 1; };
    const picked = [];
    for (const t of list.slice().sort((a, b) => dueKey(a) - dueKey(b) || a.slug.localeCompare(b.slug))) {
      const type = t.watch.type;
      if (type === 'calendar') skip('calendar 未实现');
      else if (type !== 'chat_reply' && type !== 'approval') skip(`${String(type).slice(0, 20)} 不认识`);
      else if (!sources.has(type)) skip(`${type} 未在 HEARTBEAT_WATCH 里启用`);
      else if (type === 'chat_reply' && !t.watch.chat_id) skip('chat_reply 缺 chat_id');
      else if (type === 'approval' && !t.watch.instance_code) skip('approval 缺 instance_code');
      else if (picked.length >= max) skip(`超过 HEARTBEAT_WATCH_MAX=${max}`);
      else picked.push(t);
    }
    const skippedText = Object.entries(skipped).map(([k, n]) => `${k} ${n} 条`).join('；');
    if (skippedText) log(`[heartbeat] 外部增量：跳过 ${skippedText}`);

    const touch = (source, ok) => {
      const prev = isObj(nextStats.sources[source]) ? nextStats.sources[source] : {};
      const failures = Number.isInteger(prev.failures) && prev.failures > 0 ? prev.failures : 0;
      nextStats.sources[source] = {
        ...prev,
        last_pull_at: new Date(nowMs).toISOString(),
        ...(ok ? { last_ok_at: new Date(nowMs).toISOString(), failures: 0 } : { failures: failures + 1 }),
      };
    };
    const run = async (source, slug, argv) => {
      if (!argv) {
        log(`[heartbeat] 外部增量 ${source}：tasks/${slug}.json 的参数没通过白名单校验，跳过`);
        return null;
      }
      const r = await Promise.resolve().then(() => runner(argv)).catch(() => ({ ok: false, reason: 'runner 异常' }));
      const o = r?.ok ? parseJson(r.stdout) : null;
      touch(source, Boolean(o));
      if (!o) {
        log(`[heartbeat] 外部增量 ${source} 拉取失败（tasks/${slug}.json：${r?.ok ? '输出不是 JSON 对象' : String(r?.reason ?? '未知原因').slice(0, 60)}），这条本拍降级为只看台账`);
        return null;
      }
      return o;
    };

    // watch.after 是 om_ 消息 ID 时，用 mget 换成发送时间（同一个 after 只换一次，记在游标里）
    async function afterMs(t, cur) {
      const a = t.watch.after;
      if (!a) return null;
      if (MS_TS_RE.test(a)) return a.length <= 10 ? Number(a) * 1000 : Number(a);
      if (cur.after_ref === a && Number.isFinite(cur.after_ms)) return cur.after_ms;
      const o = await run('chat_reply', t.slug, fillTemplate('messageGet', { message_id: a }));
      const m = messagesOf(o).find((x) => x?.message_id === a) ?? messagesOf(o)[0];
      const ms = apiTimeMs(m?.create_time);
      if (ms === null) {
        if (o) log(`[heartbeat] 外部增量 chat_reply：tasks/${t.slug}.json 的 watch.after 换不出时间，本拍先按其它起点`);
        return null;
      }
      cur.after_ref = a;
      cur.after_ms = ms;
      return ms;
    }

    async function pullChat(t) {
      const w = t.watch;
      const prev = nextCursor[t.slug];
      const cur = isObj(prev) && prev.type === 'chat_reply' && prev.chat_id === w.chat_id
        ? { ...prev, ids: Array.isArray(prev.ids) ? prev.ids.filter((x) => typeof x === 'string').slice(-MAX_SEEN_IDS) : [] }
        : { type: 'chat_reply', chat_id: w.chat_id, at: null, ids: [] };
      // 起点只进不退：首次取 watch.after → created_at → 现在；之后 watch.after 改大才前移，改小不理
      const a = await afterMs(t, cur);
      if (!Number.isFinite(cur.at)) {
        cur.at = a ?? (Number.isFinite(t?.times?.created_at) ? t.times.created_at : nowMs);
        cur.ids = [];
      } else if (a !== null && a > cur.at) {
        cur.at = a;
        cur.ids = [];
      }
      const from = cur.at;
      const o = await run('chat_reply', t.slug, fillTemplate('chatMessages', { chat_id: w.chat_id, start: localIsoSeconds(from) }));
      if (!o) {
        nextCursor[t.slug] = { ...cur }; // 起点换算的结果照样记下，拉取本身没成，游标不前移
        return null;
      }
      let maxT = -Infinity;
      let idsAtMax = [];
      const fresh = [];
      for (const m of messagesOf(o)) {
        const id = m?.message_id;
        if (typeof id !== 'string' || !SLOT_RE['<message_id>'].test(id)) continue;
        const ts = apiTimeMs(m?.create_time);
        if (ts === null) continue;
        if (ts > maxT) { maxT = ts; idsAtMax = [id]; } else if (ts === maxT) idsAtMax.push(id);
        if (ts < from || (ts === from && cur.ids.includes(id))) continue; // 看过的
        if (!isOtherHuman(m, owner)) continue;
        fresh.push({ id, ts, name: safeName(m?.sender?.name), text: messageText(m) });
      }
      if (maxT > cur.at) {
        cur.at = maxT;
        cur.ids = idsAtMax.slice(-MAX_SEEN_IDS);
      } else if (maxT === cur.at) {
        cur.ids = [...new Set([...cur.ids, ...idsAtMax])].slice(-MAX_SEEN_IDS);
      }
      nextCursor[t.slug] = cur;
      if (!fresh.length) return null;
      fresh.sort((x, y) => x.ts - y.ts || x.id.localeCompare(y.id));
      const shown = fresh.slice(-MAX_SHOWN);
      const more = hasMoreOf(o);
      const lines = [`会话 ${w.chat_id} 自 ${fmtShort(from)} 起有 ${fresh.length}${more ? '+' : ''} 条新消息（已去掉光总本人、机器人和系统消息），最近 ${shown.length} 条：`];
      for (const m of shown) lines.push(`- ${fmtShort(m.ts)} ${m.name || '（发送人未知）'}（${m.id}）：${m.text}`);
      if (more) lines.push('（另有更多较早的新消息未列出）');
      else if (fresh.length > shown.length) lines.push(`（另有 ${fresh.length - shown.length} 条较早的新消息未列出）`);
      return { slug: t.slug, source: 'chat_reply', text: lines.join('\n') };
    }

    async function pullApproval(t) {
      const w = t.watch;
      const last = nextStats.pulled[t.slug];
      if (Number.isInteger(last) && beat - last < APPROVAL_EVERY) return null; // 隔拍：上一拍刚拉过
      nextStats.pulled[t.slug] = beat;
      const o = await run('approval', t.slug, fillTemplate('approvalGet', { params: JSON.stringify({ instance_code: w.instance_code }) }));
      if (!o) return null;
      const inst = [o, o.data, o.data?.instance, o.instance].find((x) => isObj(x) && typeof x.status === 'string');
      if (!inst) {
        log(`[heartbeat] 外部增量 approval：tasks/${t.slug}.json 的返回里没有 status，跳过`);
        return null;
      }
      const status = APPROVAL_STATUSES.has(inst.status) ? inst.status : String(inst.status).replace(/[^A-Z_]/g, '').slice(0, 20) || 'UNKNOWN';
      const nodes = (Array.isArray(inst.current_nodes) ? inst.current_nodes : [])
        .filter(isObj)
        .map((n) => ({ id: String(n.node_id ?? '').slice(0, 64), name: clip(n.node_name ?? '', 40) }))
        .sort((x, y) => x.id.localeCompare(y.id) || x.name.localeCompare(y.name));
      const records = [inst.operation_records, inst.timeline, inst.comments].flatMap((x) => (Array.isArray(x) ? x.filter(isObj) : []));
      const times = records.map((r) => apiTimeMs(r.create_time)).filter((x) => x !== null);
      const latest = times.length ? Math.max(...times) : null;
      const fp = sha256(JSON.stringify([status, nodes.map((n) => [n.id, n.name]), latest]));
      const prev = nextCursor[t.slug];
      const known = isObj(prev) && prev.type === 'approval' && prev.instance_code === w.instance_code;
      nextCursor[t.slug] = { type: 'approval', instance_code: w.instance_code, fp, status };
      if (known && prev.fp === fp) return null; // 状态、当前节点、最近动态都没变
      if (!known && status === 'PENDING') return null; // 首次拉到仍在审批中：只建基线，不唤起模型
      const comments = records
        .filter((r) => typeof r.comment === 'string' && r.comment.trim())
        .map((r) => ({ ts: apiTimeMs(r.create_time), text: clip(r.comment, MAX_COMMENT) }))
        .sort((x, y) => (x.ts ?? 0) - (y.ts ?? 0))
        .slice(-MAX_COMMENTS);
      const lines = [
        `审批 ${w.instance_code}：状态 ${known && prev.status && prev.status !== status ? `${String(prev.status).replace(/[^A-Z_]/g, '').slice(0, 20)} → ${status}` : status}`,
        `当前节点：${nodes.length ? nodes.map((n) => n.name || n.id || '（未命名）').join('、') : '无'}`,
        `最近动态：${latest !== null ? fmtShort(latest) : '无'}`,
      ];
      if (comments.length) {
        lines.push(`最近评论（${comments.length} 条）：`);
        for (const c of comments) lines.push(`- ${c.ts !== null ? fmtShort(c.ts) : '时间未知'}：${c.text}`);
      }
      return { slug: t.slug, source: 'approval', text: lines.join('\n') };
    }

    const results = await mapLimit(picked, CONCURRENCY, (t) => (t.watch.type === 'chat_reply' ? pullChat(t) : pullApproval(t)));
    return { deltas: results.filter(Boolean), cursor: nextCursor, stats: nextStats };
  };
}
