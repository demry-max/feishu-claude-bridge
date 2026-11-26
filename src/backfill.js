// BRIDGE-STD-1 §3.2 / §3.3（C5 / W7）：过期只消费、启动与重连补拉、低频补漏。
// 断线或重启期间飞书会不会重推事件没有核实，按「不重推」设计：长连接就绪 / 重连后、以及每隔几分钟，按会话拉一次历史消息，
// 和事件走同一个入口（ingest）：太老的只登记、不回答；其余交给处理链。不重答靠处理链第一句的同步判重（同一张落盘去重表）。
// 游标按会话记在 data/inbound-cursor.json。依赖全部可注入。
import nodeFs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './inbound-dedupe.js';
import { tail6 } from './log-safe.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DEFAULT_STALE_MS = 10 * MIN;
const PAGE_SIZE = 50;
const MAX_PAGES = 3;

/** create_time（毫秒数字串）→ 毫秒；缺失 / 认不出来 → null。不能当成 0：当成 0 就永远过期、永远不答 */
export function messageTime(createTime) {
  if (typeof createTime !== 'number' && !(typeof createTime === 'string' && createTime.trim())) return null;
  const ms = Number(createTime);
  return Number.isFinite(ms) ? ms : null;
}

const isStale = (at, now, staleMs) => at !== null && now - at > staleMs;

/** 三个开关。缺省：补拉开、补漏 10 分钟、过期 10 分钟；非法值回落到缺省并记一行（不回显当前值） */
export function backfillConfig(env = process.env, log = console.log) {
  const read = (key, dflt, parse, allowed) => {
    const raw = String(env[key] ?? '').trim();
    if (!raw) return dflt;
    const value = parse(raw);
    if (value !== null) return value;
    log(`[config] ${key} 只认 ${allowed}，当前值无效，按缺省处理`);
    return dflt;
  };
  const onOff = (raw) => (/^on$/i.test(raw) ? true : /^off$/i.test(raw) ? false : null);
  const int = (ok) => (raw) => (/^\d+$/.test(raw) && ok(Number(raw)) ? Number(raw) : null);
  return {
    enabled: read('BRIDGE_BACKFILL', true, onOff, 'on / off'),
    sweepMin: read('BRIDGE_SWEEP_MIN', 10, int((n) => n === 0 || (n >= 5 && n <= 60)), '0 或 5–60'),
    staleMs: read('BRIDGE_STALE_MS', DEFAULT_STALE_MS, int((n) => n >= MIN && n <= 24 * HOUR), '60000–86400000'),
  };
}

/**
 * 事件和补拉的共同入口：过期 → 在去重表里登记成已消费，不进处理链、不回复；否则原样交给 handle。
 * handle 的同步前段（处理链第一句判重）在本函数返回前就跑完了，所以同一条消息两路同时到也只处理一次。
 * onSeen(message, 毫秒|null)：不论答了、过期还是重复都回调（会话登记与游标前移）。
 */
export function createIngest({ dedupe, handle, staleMs = DEFAULT_STALE_MS, now = Date.now, log = console.log, onSeen = () => {} }) {
  const note = (message, at) => { try { onSeen(message, at); } catch { /* 记游标出错不能挡住收消息 */ } };
  return async function ingest(data, src = 'event') {
    const message = data?.message;
    if (!message) return handle(data);
    const id = message.message_id;
    const at = messageTime(message.create_time);
    if (at === null) log(`[stale] id=${tail6(id)} create_time 缺失或无法识别，按不过期处理 src=${src}`);
    if (isStale(at, now(), staleMs)) {
      if (id && !dedupe.checkAndMark(id)) log(`[stale] id=${tail6(id)} age=${Math.round((now() - at) / MIN)}m src=${src}`);
      note(message, at);
      return undefined;
    }
    const pending = handle(data);
    note(message, at);
    return pending;
  };
}

/** 会话游标表（0600，原子写）：每个会话的种类、拉到哪了、最近一次给桥发消息的时刻。超过 cap 个按最久没活跃的淘汰 */
export function createChatBook({ file, fs = nodeFs, now = Date.now, cap = 50, windowMs = 7 * 24 * HOUR, log = console.error }) {
  const chats = new Map();
  const base = path.basename(file);
  let warnedAt = -Infinity;
  const stored = readJsonFile(file, { fs });
  if (stored.status !== 'missing') {
    const doc = stored.value;
    const entries = doc?.v === 1 && doc.chats && typeof doc.chats === 'object' ? Object.entries(doc.chats) : null;
    for (const [id, c] of entries ?? []) {
      if ((c?.kind === 'p2p' || c?.kind === 'group') && Number.isFinite(c.cursorMs) && Number.isFinite(c.lastSeenMs)) {
        chats.set(id, { kind: c.kind, cursorMs: c.cursorMs, lastSeenMs: c.lastSeenMs });
      }
    }
    if (!entries || chats.size < entries.length) log(`[backfill] ${base} 损坏或有认不出的记录，认不出的部分已忽略`);
  }

  function put(chatId, entry) {
    chats.set(chatId, entry);
    while (chats.size > cap) {
      let oldest;
      for (const e of chats) if (!oldest || e[1].lastSeenMs < oldest[1].lastSeenMs) oldest = e;
      chats.delete(oldest[0]);
    }
    try {
      writeJsonAtomic(file, { v: 1, chats: Object.fromEntries(chats) }, { fs });
    } catch (e) {
      if (now() - warnedAt < HOUR) return;
      warnedAt = now();
      log(`[backfill] 写 ${base} 失败（${e?.code ?? e?.name ?? '?'}），内存里照常记`);
    }
  }

  return {
    /** 这个会话给桥发了一条消息 */
    note(chatId, chatType, createMs) {
      if (!chatId) return;
      const cursorMs = Math.max(chats.get(chatId)?.cursorMs ?? 0, createMs ?? 0);
      put(chatId, { kind: chatType === 'p2p' ? 'p2p' : 'group', cursorMs, lastSeenMs: now() });
    },
    /** 补拉看到了更新的位置：只前移游标，不算「发过消息」 */
    advance(chatId, kind, ms) {
      const had = chats.get(chatId);
      if (!(ms > (had?.cursorMs ?? 0))) return;
      put(chatId, { kind, cursorMs: ms, lastSeenMs: had?.lastSeenMs ?? 0 });
    },
    cursor: (chatId) => chats.get(chatId)?.cursorMs ?? 0,
    /** 窗口期（7 天）内给桥发过消息的会话 */
    recent: () => [...chats].filter(([, c]) => now() - c.lastSeenMs <= windowMs).map(([chatId, c]) => ({ chatId, kind: c.kind })),
  };
}

/** 本轮拉哪些会话：owner 私聊、近期发过消息的、ALLOW_CHATS 里的群。同一个会话只列一次，种类以先出现的为准 */
export function mergeKnownChats({ ownerDmChatId, recent = [], allowChats = [] }) {
  const out = new Map();
  const add = (chatId, kind) => { if (chatId && !out.has(chatId)) out.set(chatId, kind); };
  add(ownerDmChatId, 'p2p');
  for (const c of recent) add(c.chatId, c.kind);
  for (const chatId of allowChats) add(chatId, 'group');
  return [...out].map(([chatId, kind]) => ({ chatId, kind }));
}

/** 消息列表接口的一项 → 事件形状（字段按 SDK 里 im.v1.message.list 的类型定义）。撤回、系统消息、应用 / 匿名发送者 → null */
export function toEventShape(item, chatType) {
  if (!item?.message_id || item.deleted === true || item.msg_type === 'system') return null;
  const sender = item.sender;
  if (sender?.sender_type !== 'user' || sender.id_type !== 'open_id' || !sender.id) return null;
  const mention = (m) => ({ key: m.key, id: { open_id: m.id_type === 'open_id' ? m.id : undefined }, name: m.name });
  return {
    sender: { sender_id: { open_id: sender.id }, sender_type: 'user' },
    message: {
      message_id: item.message_id, chat_id: item.chat_id, chat_type: chatType, message_type: item.msg_type,
      content: item.body?.content, create_time: item.create_time, mentions: item.mentions?.length ? item.mentions.map(mention) : undefined,
      parent_id: item.parent_id, root_id: item.root_id, thread_id: item.thread_id,
    },
  };
}

/** 一页历史消息分类（纯函数）：按时间升序；处理过的、群里没 @ 机器人的跳过（后者也不登记）；其余交给入口（过期的打标） */
export function planBackfill({ items = [], cursorMs = 0, now, staleMs, has, botOpenId, chatKind }) {
  const rows = items.map((item) => ({ item, at: messageTime(item?.create_time) }));
  rows.sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER));
  const atBot = (data) => Boolean(botOpenId) && Boolean(data.message.mentions?.some((m) => m.id.open_id === botOpenId));
  const deliver = [];
  const skipped = { dup: 0, noAt: 0, unsupported: 0 };
  let newCursorMs = cursorMs;
  for (const { item, at } of rows) {
    if (at !== null && at > newCursorMs) newCursorMs = at;
    const data = toEventShape(item, chatKind);
    if (!data) skipped.unsupported += 1;
    else if (has(data.message.message_id)) skipped.dup += 1;
    else if (chatKind === 'group' && !atBot(data)) skipped.noAt += 1;
    else deliver.push({ data, stale: isStale(at, now, staleMs) });
  }
  return { deliver, skipped, newCursorMs };
}

/** 拉取起点：游标（但不早于 now - stale）再往前叠 1 秒；游标落后超过 stale 时给出没拉的那段有多长 */
export function backfillWindow({ cursorMs = 0, now, staleMs }) {
  const oldest = now - staleMs;
  return { startSec: Math.floor(Math.max(cursorMs, oldest) / 1000) - 1, truncatedMs: cursorMs > 0 && cursorMs < oldest ? oldest - cursorMs : 0 };
}

/**
 * 运行部分。run(reason) 单飞：正在跑时再触发，只合并出「跑完再补一轮」。游标在触发那一刻取快照：
 * 重连回调先于新连接上的任何事件，之后到达的事件前移游标也不会让本轮跳过断线期间的消息。
 */
export function createBackfill({
  listMessages, knownChats, ingest, dedupe, book, getBotOpenId, isDraining = () => false,
  staleMs = DEFAULT_STALE_MS, enabled = true, sweepMin = 10, now = Date.now, timers = globalThis, log = console.log,
}) {
  const failedAt = new Map(); // chat_id → 上次记失败日志的时刻
  const truncatedAt = new Map(); // chat_id → 记过「窗口截到 stale」的游标位置
  let active = null;
  let queued = null;
  let sweeper = null;
  // 只取错误码：错误对象和接口文案里可能带会话 id
  const codeOf = (e) => String(e?.response?.data?.code ?? e?.code ?? e?.name ?? '?').slice(0, 40);

  async function pull({ chatId, kind, cursorMs }, botOpenId, tally) {
    const { startSec, truncatedMs } = backfillWindow({ cursorMs, now: now(), staleMs });
    if (truncatedMs > 0 && truncatedAt.get(chatId) !== cursorMs) {
      truncatedAt.set(chatId, cursorMs);
      log(`[backfill] 窗口截到 stale，约 ${Math.max(1, Math.round(truncatedMs / MIN))} 分钟未拉`);
    }
    let pageToken;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      if (isDraining()) return;
      const res = await listMessages({
        container_id_type: 'chat', container_id: chatId, start_time: String(startSec),
        sort_type: 'ByCreateTimeAsc', page_size: PAGE_SIZE, ...(pageToken ? { page_token: pageToken } : {}),
      });
      if (res?.code) throw Object.assign(new Error('list failed'), { code: res.code });
      const plan = planBackfill({ items: res?.data?.items ?? [], cursorMs, now: now(), staleMs, has: (id) => dedupe.has(id), botOpenId, chatKind: kind });
      for (const { data, stale } of plan.deliver) {
        if (isDraining()) return; // 游标不越过没交付的消息
        await ingest(data, 'backfill');
        tally.delivered += 1;
        if (stale) tally.stale += 1;
      }
      book.advance(chatId, kind, plan.newCursorMs);
      pageToken = res?.data?.has_more ? res.data.page_token : undefined;
      if (!pageToken) return;
    }
    log(`[backfill] 单个会话超过 ${MAX_PAGES} 页，停在第 ${MAX_PAGES} 页，还有未拉的消息`);
  }

  async function round({ reason, chats }) {
    const tally = { delivered: 0, stale: 0, failed: 0 };
    let botOpenId; // 一轮只查一次；undefined＝还没查
    for (const chat of chats) {
      if (isDraining()) return;
      if (chat.kind === 'group') {
        if (botOpenId === undefined) {
          try { botOpenId = (await getBotOpenId()) || null; } catch { botOpenId = null; }
          if (!botOpenId) log('[backfill] 取不到机器人 open_id，本轮跳过群补拉');
        }
        if (!botOpenId) continue;
      }
      try {
        await pull(chat, botOpenId, tally);
        failedAt.delete(chat.chatId);
      } catch (e) {
        tally.failed += 1;
        if (now() - (failedAt.get(chat.chatId) ?? -Infinity) < HOUR) continue;
        failedAt.set(chat.chatId, now());
        log(`[backfill] 拉取失败（${chat.kind}）code=${codeOf(e)}`);
      }
    }
    if (reason !== 'sweep' || tally.delivered > 0) {
      log(`[backfill] reason=${reason} 会话 ${chats.length} 个，交给入口 ${tally.delivered} 条（过期 ${tally.stale}），失败 ${tally.failed} 个`);
    }
  }

  /** 把又一次触发并进排队的那一轮：每个会话保留最早的游标快照 */
  function merge(job, next) {
    if (!job) return next;
    const byId = new Map(job.chats.map((c) => [c.chatId, c]));
    for (const c of next.chats) if (!(byId.get(c.chatId)?.cursorMs <= c.cursorMs)) byId.set(c.chatId, c);
    return { reason: job.reason === 'sweep' ? next.reason : job.reason, chats: [...byId.values()] };
  }

  async function drain(job) {
    try {
      for (let next = job; next; next = queued, queued = null) await round(next);
    } catch (e) {
      log(`[backfill] 本轮异常中止 code=${codeOf(e)}`);
    } finally {
      active = null;
      queued = null;
    }
  }

  /** 触发一轮。永远不 reject */
  function run(reason) {
    if (!enabled) return Promise.resolve();
    let job;
    try {
      job = { reason, chats: knownChats().map((c) => ({ ...c, cursorMs: book.cursor(c.chatId) })) };
    } catch (e) {
      log(`[backfill] 取会话清单失败 code=${codeOf(e)}`);
      return Promise.resolve();
    }
    if (!active) active = drain(job);
    else {
      if (!queued) log('[backfill] 上一轮还在跑，跑完再补一轮');
      queued = merge(queued, job);
    }
    return active;
  }

  return {
    run,
    /** 长连接启动之后调：开低频补漏定时器 */
    start() {
      if (!enabled) { log('[backfill] 已关闭（BRIDGE_BACKFILL=off）'); return; }
      if (sweeper) return;
      if (sweepMin > 0) {
        sweeper = timers.setInterval(() => { run('sweep'); }, sweepMin * MIN);
        sweeper?.unref?.();
      }
      log(`[backfill] 已开启：启动与重连后补拉，${sweepMin > 0 ? `每 ${sweepMin} 分钟补漏一次` : '定时补漏已关'}`);
    },
  };
}
