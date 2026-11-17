// 每晚台账日结（BRIDGE-VR-1）：HEARTBEAT_DIGEST_AT=HH:MM（本地时间，默认空＝关）。
// 只读台账 + 桥接自己的状态（history.changes、升级阶梯 esc），不读 journal、不调模型；五栏全空不发。
// 这里只放纯函数（解析时间、到下一次的毫秒数、排版）；定时器、发送（deliver）、写 journal 在 heartbeat.js。
// 本文件不 import heartbeat.js / verifier.js（它们反过来用这里的 plain），避免循环依赖。
import { circled } from './ledger-actions.js';

const DAY_MS = 24 * 3600_000;
const MAX_PER_COLUMN = 5; // 每栏最多列几条，其余「另有 N 条」
const ACTIVE = new Set(['open', 'waiting']);
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const DIGEST_WINDOW_MS = 30 * 60_000; // 到点后 30 分钟内还没发出去（心跳忙、进程刚起）就不补发
export const DIGEST_JOURNAL_HEAD = '## 台账日结（桥接自动）';
/** 今天办完的方式（history.changes 的 via）。 */
export const METHOD_LABELS = Object.freeze({
  rule: '规则验收', model: '模型验收', heartbeat: '心跳轮写的', owner: '光总确认', chat: '会话里改的',
});
/** 可以从日结「撤销」的办完方式：桥接 / 模型自动判定的（光总自己确认、会话里改的不给撤销）。 */
export const UNDOABLE_VIA = Object.freeze(['rule', 'model', 'heartbeat']);
const HINT_BUTTONS = '带圈号的是自动判定办完的；判错了点下面对应的「撤销」，改回 open、明天再看。';
const HINT_CHAT = '带圈号的是自动判定办完的；判错了在对话里说一声。';

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const toMs = (v) => (v instanceof Date ? v.getTime() : Number(v));

/**
 * 标题 / 进展进消息前压成一行、中和 Markdown 记号（[ ] * < > ` ~ 换成全角），超长截断加「…」（按字符，不拆代理对）。
 * 圆括号保留（「(x.cn)」没有方括号就不成链接）。
 */
export function plain(s, max = 24) {
  const t = String(s ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .replace(/\*/g, '＊')
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/`/g, '｀')
    .replace(/~/g, '～');
  const cps = Array.from(t);
  return cps.length > max ? `${cps.slice(0, max).join('')}…` : t;
}

const inQuiet = (min, qh) => (qh.start < qh.end ? min >= qh.start && min < qh.end : min >= qh.start || min < qh.end);

/**
 * HEARTBEAT_DIGEST_AT：HH:MM（本地时间，H 可一位）；留空＝关、不记日志；写错、或落在免打扰时段里，记日志后按关。
 * quietHours 是 parseQuietHours 的结果（{ start, end, label }，分钟），null＝没有免打扰。
 */
export function parseDigestAt(raw, quietHours, log = () => {}) {
  const s = String(raw ?? '').trim();
  if (s === '') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  const h = m ? Number(m[1]) : NaN;
  const mi = m ? Number(m[2]) : NaN;
  if (!m || h > 23 || mi > 59) {
    log(`[heartbeat] HEARTBEAT_DIGEST_AT=${JSON.stringify(s.slice(0, 20))} 不认识（要 HH:MM，本地时间），日结按关处理`);
    return null;
  }
  const label = `${pad2(h)}:${pad2(mi)}`;
  if (quietHours && inQuiet(h * 60 + mi, quietHours)) {
    log(`[heartbeat] HEARTBEAT_DIGEST_AT=${label} 落在免打扰时段（${quietHours.label}）里，日结按关处理`);
    return null;
  }
  return { h, m: mi, label };
}

/** 到下一个 HH:MM（本地时间）的毫秒数；正好在点上或已过＝明天（重启不补发）。 */
export function msUntilNext(now, at) {
  const t = toMs(now);
  const d = new Date(t);
  d.setHours(at.h, at.m, 0, 0);
  if (d.getTime() <= t) d.setDate(d.getDate() + 1);
  return d.getTime() - t;
}

/** now 是否落在今天 HH:MM 起的 30 分钟窗口里（窗口外到点＝晚到，不补发）。 */
export function inDigestWindow(now, at) {
  const t = toMs(now);
  const d = new Date(t);
  d.setHours(at.h, at.m, 0, 0);
  return t >= d.getTime() && t < d.getTime() + DIGEST_WINDOW_MS;
}

const bySlugTime = (a, b) => (a.ms - b.ms) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

/**
 * 排一份日结。
 * @param {object} o
 * @param {Array} o.tasks      校验过的台账（loadTasks().tasks：slug、title、status、times、原始时间串）
 * @param {Array} o.changes    history.changes：[{ at, slug, from, to, via }]（桥接自己记的状态变化）
 * @param {object} o.taskState 心跳状态里的 tasks（升级阶梯的 esc）
 * @param {Date} o.now
 * @param {number|null} [o.since] 上一份日结发出（或排队 / 判重 / 判空）的时间（毫秒）：「今天办完 / 今天放弃」只算
 *   since 之后（不含）到 now（含）的变化——日结发完之后的自动关单、没发日结那天的，都进下一份；
 *   没给、不是数字或晚于 now：从今天 0 点（含）算起
 * @param {boolean} o.ladder   升级阶梯开：卡住＝已提醒满 escalateMax 级的；关：卡住＝过了 escalate_after 还在跟进的
 * @param {number} o.escalateMax
 * @param {boolean} o.buttons  撤销提示说「点按钮」还是「在对话里说」
 * @returns {{ empty: boolean, title: string, body: string, undo: string[], journal: string[] }}
 *   undo：带圈号（可撤销）的 slug，按圈号顺序；journal：写进当天 journal 的一段（标题行 + 每栏一行）
 */
export function buildDigest({ tasks = [], changes = [], taskState = {}, now, since = null, ladder = false, escalateMax = 2, buttons = false }) {
  const nowMs = toMs(now);
  const nowD = new Date(nowMs);
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const sinceMs = typeof since === 'number' && Number.isFinite(since) && since <= nowMs ? since : null;
  const inWindow = (ms) => ms <= nowMs && (sinceMs === null ? ms >= midnight.getTime() : ms > sinceMs);
  const tmr = new Date(nowMs);
  tmr.setDate(tmr.getDate() + 1);
  const tomorrow = localDay(tmr);
  const bySlug = new Map(tasks.map((t) => [t.slug, t]));

  // 上一份日结之后每条台账最后一次状态变化；还停在那个状态才算「今天办完 / 今天放弃」
  const last = new Map();
  for (const c of Array.isArray(changes) ? changes : []) {
    if (!c || typeof c.slug !== 'string' || typeof c.to !== 'string') continue;
    const ms = Date.parse(c.at);
    if (!Number.isFinite(ms) || !inWindow(ms)) continue;
    const prev = last.get(c.slug);
    if (!prev || ms >= prev.ms) last.set(c.slug, { ...c, ms });
  }
  const doneAuto = [];
  const doneOther = [];
  const dropped = [];
  for (const [slug, c] of last) {
    const t = bySlug.get(slug);
    if (!t || t.status !== c.to) continue;
    const row = { slug, ms: c.ms, t, via: c.via };
    if (c.to === 'done') (UNDOABLE_VIA.includes(c.via) ? doneAuto : doneOther).push(row);
    else if (c.to === 'dropped') dropped.push(row);
  }
  doneAuto.sort(bySlugTime);
  doneOther.sort(bySlugTime);
  dropped.sort(bySlugTime);
  const method = (via) => METHOD_LABELS[via] ?? '其他';
  const doneItems = [
    ...doneAuto.map((r, i) => `${i < MAX_PER_COLUMN ? circled(i) : ''}${plain(r.t.title)}（${method(r.via)}）`),
    ...doneOther.map((r) => `${plain(r.t.title)}（${method(r.via)}）`),
  ];

  const verifying = tasks.filter((t) => t.status === 'verify').sort((a, b) => (a.slug < b.slug ? -1 : 1));

  const stuck = [];
  const stuckSet = new Set();
  for (const t of tasks) {
    if (!ACTIVE.has(t.status)) continue;
    const ea = t.times?.escalate_after;
    if (!Number.isFinite(ea) || ea > nowMs) continue;
    if (ladder) {
      const esc = taskState?.[t.slug]?.esc;
      if (!esc || esc.for !== t.escalate_after || !(Number(esc.level) >= escalateMax)) continue;
    }
    const days = Math.floor((nowMs - ea) / DAY_MS);
    stuck.push({ slug: t.slug, ms: ea, text: `${plain(t.title)}（过了提醒时间${days >= 1 ? ` ${days} 天` : '不到 1 天'}）` });
    stuckSet.add(t.slug);
  }
  stuck.sort(bySlugTime);

  // 明天到期：next_check_at / due_at / escalate_after 里落在明天的最早一个（已列进「卡住」的不重复列）
  const dueTomorrow = [];
  for (const t of tasks) {
    if (!ACTIVE.has(t.status) || stuckSet.has(t.slug)) continue;
    let best = null;
    for (const f of ['next_check_at', 'due_at', 'escalate_after']) {
      const ms = t.times?.[f];
      if (!Number.isFinite(ms) || localDay(new Date(ms)) !== tomorrow) continue;
      const dayOnly = DAY_ONLY.test(String(t[f] ?? ''));
      if (!best || ms < best.ms) best = { ms, dayOnly };
    }
    if (!best) continue;
    const d = new Date(best.ms);
    const when = best.dayOnly ? '明天' : `明天 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    dueTomorrow.push({ slug: t.slug, ms: best.ms, text: `${plain(t.title)}（${when}）` });
  }
  dueTomorrow.sort(bySlugTime);

  const col = (name, items) => {
    if (!items.length) return null;
    const shown = items.slice(0, MAX_PER_COLUMN);
    const more = items.length - shown.length;
    return { name, n: items.length, list: [...shown, ...(more > 0 ? [`另有 ${more} 条`] : [])].join(' · ') };
  };
  const cols = [
    col('今天办完', doneItems),
    col('今天放弃', dropped.map((r) => plain(r.t.title))),
    col('待你验收', verifying.map((t) => plain(t.title))),
    col('卡住', stuck.map((r) => r.text)),
    col('明天到期', dueTomorrow.map((r) => r.text)),
  ].filter(Boolean);
  const title = `📒 **台账日结（${pad2(nowD.getMonth() + 1)}-${pad2(nowD.getDate())}）**`;
  if (!cols.length) return { empty: true, title, body: '', undo: [], journal: [] };
  const undo = doneAuto.slice(0, MAX_PER_COLUMN).map((r) => r.slug);
  const lines = cols.map((c) => `**${c.name}**（${c.n}）：${c.list}`);
  if (undo.length) lines.push('', buttons ? HINT_BUTTONS : HINT_CHAT);
  return {
    empty: false,
    title,
    body: lines.join('\n'),
    undo,
    journal: [DIGEST_JOURNAL_HEAD, ...cols.map((c) => `- ${c.name}（${c.n}）：${c.list}`)],
  };
}
