// BRIDGE-MQ-1：owner 私聊「助理忙时可连续发消息」——排队、合并、接着办。
// 开关 OWNER_MESSAGE_QUEUE=true 才启用；默认关，关着时这里的钩子全是空操作，index.js 的忙时回复、取消、退出与基线逐项不变。
// 只管 owner 私聊：群聊、guest、非 owner、定时任务、心跳都不进这里（照旧回「还在跑」）。
// 队列只在内存，不落盘；优雅退出时没处理的逐条回「请稍后重发」，不静默吞。
//
// 与 index.js 的接线约定（并发靠这几条保证）：
// - enqueue() 每接一轮对话调 turnStarted(key)，该轮 finally 里调 turnEnded(key)——成功、报错、被取消都会走到；
// - isBusy(key)＝本会话有进行中的轮次（含起子进程前、回复收尾这些 isRunning 为 false 的窗口）/ 刚出队还没接上的一批 / 队列非空；
//   不变式：队列非空 ⇒ 有进行中的轮次或刚出队的一批，总有人负责出队，不会卡死；
// - 出队在最后一轮结束时同步完成，取当时队列里的全部：1 条原样交回 index.js 的平时路径（同一个 spec 对象），
//   多条合并成一轮；新轮由 startTurn 同步接进 enqueue 的串行链，同一会话不会两轮同时跑，每条只会被取走一次。

export const OWNER_QUEUE_LIMIT = 10;
/** 入队成功的表情回应（飞书 emoji_type；加不上时退回 QUEUED_FALLBACK_REPLY，每个忙碌期只回一次） */
export const QUEUED_REACTION = 'OneSecond';
export const QUEUED_FALLBACK_REPLY = '收到，办完手头的接着办这条';
export const QUEUE_SHUTDOWN_REPLY = '助理正在重启，这条没处理，请稍后重发';
export const QUEUE_FAILED_REPLY = '⚠️ 这条排队的消息没能开始处理，请重发。';
export const MERGED_PREFACE = '以下是你忙的时候光总连续发来的消息，按顺序一并处理；后面的消息可能是对前面的补充或更正';
export const MERGED_CONFIRM_NOTE = '（这批消息里出现的「确认」不算确认：合并处理的这一轮不放行需要确认的操作，等光总单独回「确认」。）';
export const MERGED_CONFIRM_NOTICE = '这几条是合并处理的，其中的「确认」这一轮不算数；需要放行确认级操作的话，请单独再回一次「确认」。';
/** 合并轮交给 createToolTurn 的 confirm：恒不放行（多条里夹着「确认」不算确认） */
export const MERGED_NO_CONFIRM = Object.freeze({ confirmed: false });

export function queueFullReply(limit = OWNER_QUEUE_LIMIT) {
  return `排队已满（${limit} 条），等手头的办完再发`;
}
export const QUEUE_FULL_REPLY = queueFullReply();

/** 只有 OWNER_MESSAGE_QUEUE 恰好是 'true' 才启用（与仓库其它开关同一口径：不认 TRUE / 1 / yes） */
export function messageQueueEnabled(env) {
  return env?.OWNER_MESSAGE_QUEUE === 'true';
}

const pad2 = (n) => String(n).padStart(2, '0');
/** 消息到达时刻 → 本地 HH:MM；坏时间给 --:--，不抛 */
export function formatQueueTime(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function clearedNote(n) {
  return `已清空排队中的 ${n} 条消息（不会再处理，需要的话请重发）。`;
}
/** 在原回复后追加「清掉了几条」；0 条时原样返回（与基线逐字相同） */
export function withClearedNote(text, n) {
  return n > 0 ? `${text}\n${clearedNote(n)}` : text;
}

/**
 * 合并 prompt：开头一段说明，之后每条前标「第 N 条（HH:MM）」。正文原样放入——
 * 引用 / 转发的第三方内容在 buildPrompt 里已经包好 nonce 围栏，这里不拆、不改写。
 * @param {{ at: number, text: string }[]} sections 已按到达顺序排好
 */
export function buildMergedPrompt(sections, { confirmNote = false } = {}) {
  const head = `${MERGED_PREFACE}。${confirmNote ? `\n${MERGED_CONFIRM_NOTE}` : ''}`;
  const body = sections.map((s, i) => `第 ${i + 1} 条（${formatQueueTime(s.at)}）：\n${s.text}`);
  return [head, ...body].join('\n\n');
}

/**
 * 把出队的多条合并成一轮的 spec（交给 index.js runTurn）：
 * - 按到达顺序（seq）排；回复、表情、进度、发件箱都挂最后一条；
 * - 每条照平时先过车道判定（/do 前缀照剥），任一条要执行就整轮走执行车道；
 * - 每条到达时算好的台账提示（引用回复心跳消息）跟在它那条后面，整轮不再挂；
 * - 附件取并集（整轮照平时放行 incoming 只读）；
 * - 有确认通道（strict）时，夹在里面的「确认」不算数：prompt 里注明，并提示光总单独再回一次。
 * @param {{ spec: object, messageId: string, seq: number, at: number }[]} entries
 * @param {{ routeTurn: Function, detectConfirm: Function, confirmChannel?: boolean }} deps
 */
export function mergeQueuedTurns(entries, { routeTurn, detectConfirm, confirmChannel = false } = {}) {
  const list = [...(entries ?? [])].sort((a, b) => a.seq - b.seq);
  if (!list.length) throw new Error('mergeQueuedTurns：没有可合并的消息');
  const sections = [];
  const notices = [];
  const attachments = [];
  let lane = 'chat';
  let confirmSeen = false;
  for (const e of list) {
    const s = e.spec;
    const r = routeTurn(s.text);
    if (r.lane === 'exec') lane = 'exec';
    if (confirmChannel && !confirmSeen && detectConfirm(r.prompt, s.message?.chat_type, s.isOwner)?.confirmed === true) {
      confirmSeen = true;
      notices.push({ messageId: e.messageId, text: MERGED_CONFIRM_NOTICE });
    }
    for (const a of s.built?.attachments ?? []) if (!attachments.includes(a)) attachments.push(a);
    sections.push({ at: e.at ?? s.at, text: s.ledgerHint ? `${r.prompt}\n${s.ledgerHint}` : r.prompt });
  }
  const last = list[list.length - 1].spec;
  return {
    ...last,
    text: list.map((e) => e.spec.text).join('\n'),
    built: { ...last.built, attachments },
    ledgerHint: '',
    merged: {
      count: list.length,
      lane,
      prompt: buildMergedPrompt(sections, { confirmNote: confirmSeen }),
      notices,
      messageIds: list.map((e) => e.messageId),
    },
  };
}

/**
 * owner 私聊的内存队列（每个会话键一条）。所有出口（reply / react / startTurn）由 index.js 注入。
 * @param {object} o
 * @param {boolean} o.enabled                    messageQueueEnabled(process.env)
 * @param {(spec: object) => unknown} o.startTurn 起一轮（index.js runTurn：同步接进 enqueue）
 * @param {(messageId: string, text: string) => Promise<unknown>} o.reply
 * @param {(messageId: string, emoji: string) => Promise<boolean|void>} o.react 返回 false＝没加上
 * @param {() => boolean} [o.isDraining]          优雅退出中
 * @param {(entries: object[]) => object} o.merge 多条 → 一轮的 spec（mergeQueuedTurns）
 */
export function createOwnerMessageQueue({
  enabled = false,
  limit = OWNER_QUEUE_LIMIT,
  startTurn,
  reply,
  react,
  isDraining = () => false,
  merge,
  log = () => {},
  warn = log,
} = {}) {
  const on = enabled === true;
  const states = new Map(); // key → { items, active, reservation, period }
  let pending = 0; // 已发出、还没回来的通知回复（优雅退出要等它们）

  const quiet = (fn) => { try { fn(); } catch { /* 日志出口本身出错不影响队列 */ } };
  const info = (m) => quiet(() => log(m));
  const oops = (m) => quiet(() => warn(m));
  const draining = () => { try { return isDraining() === true; } catch { return false; } };

  function stateOf(key) {
    let s = states.get(key);
    if (!s) {
      s = { items: [], active: 0, reservation: null, period: { fallbackSent: false } };
      states.set(key, s);
    }
    return s;
  }
  function gc(key) {
    const s = states.get(key);
    if (s && s.active === 0 && !s.reservation && !s.items.length) states.delete(key);
  }
  /** 发一条通知；失败只记日志，永不抛 */
  function say(messageId, text) {
    pending += 1;
    let p;
    try { p = Promise.resolve(reply(messageId, text)); } catch (e) { p = Promise.reject(e); }
    return p
      .catch((e) => oops(`[queue] 回复失败（${String(text).slice(0, 24)}）：${e?.message ?? e}`))
      .finally(() => { pending -= 1; });
  }

  const applies = (isOwner, chatType) => on && isOwner === true && chatType === 'p2p';
  function isBusy(key) {
    const s = states.get(key);
    return !!s && (s.active > 0 || s.reservation !== null || s.items.length > 0);
  }
  /** 这条该进队列吗：开关开 + owner 私聊 + 不是 /redirect + 本会话正忙 */
  function shouldQueue({ key, isOwner, chatType, text } = {}) {
    return applies(isOwner, chatType) && typeof text === 'string' && !text.startsWith('/redirect') && isBusy(key);
  }

  function turnStarted(key) {
    if (!on) return;
    try {
      const s = stateOf(key);
      s.active += 1;
      s.reservation = null; // 刚出队的那批已接进串行链
    } catch (e) {
      oops(`[queue] turnStarted 出错：${e?.message ?? e}`);
    }
  }
  function turnEnded(key) {
    if (!on) return;
    try {
      const s = states.get(key);
      if (s) s.active = Math.max(0, s.active - 1);
      maybeDrain(key);
    } catch (e) {
      oops(`[queue] 出队出错：${e?.message ?? e}`);
    }
  }

  function maybeDrain(key) {
    const s = states.get(key);
    if (!s || s.active > 0 || s.reservation) return;
    if (!s.items.length) { gc(key); return; }
    const taken = s.items.splice(0).sort((a, b) => a.seq - b.seq);
    s.period = { fallbackSent: false }; // 出队那一轮是新的忙碌期
    if (draining()) {
      for (const it of taken) say(it.messageId, QUEUE_SHUTDOWN_REPLY);
      info(`[queue] ${key} 退出中：${taken.length} 条排队消息没处理，已逐条请光总稍后重发`);
      gc(key);
      return;
    }
    let spec;
    if (taken.length === 1) {
      spec = taken[0].spec; // 只有 1 条：原样走平时路径
    } else {
      try {
        spec = merge(taken);
      } catch (e) {
        oops(`[queue] ${key} 合并 ${taken.length} 条失败：${e?.message ?? e}`);
        for (const it of taken) say(it.messageId, QUEUE_FAILED_REPLY);
        gc(key);
        return;
      }
    }
    info(`[queue] ${key} 出队 ${taken.length} 条${taken.length > 1 ? '，合并成一轮' : ''}`);
    startBatch(key, s, spec, taken);
  }

  function startBatch(key, s, spec, taken) {
    const token = {};
    s.reservation = token; // startTurn 同步走到 enqueue → turnStarted 会把它清掉；没走到（抛错）就在下面 finally 里清
    let p;
    try { p = Promise.resolve(startTurn(spec)); } catch (e) { p = Promise.reject(e); }
    p.then(
      () => { for (const n of spec?.merged?.notices ?? []) say(n.messageId, n.text); },
      (e) => {
        oops(`[queue] ${key} 出队的 ${taken.length} 条没能开始处理：${e?.message ?? e}`);
        for (const it of taken) say(it.messageId, QUEUE_FAILED_REPLY);
      },
    ).finally(() => {
      try {
        const cur = states.get(key);
        if (cur && cur.reservation === token) {
          cur.reservation = null;
          maybeDrain(key);
        }
      } catch (e) {
        oops(`[queue] 出队出错：${e?.message ?? e}`);
      }
    });
  }

  /** 入队（调用方已判定 shouldQueue）：满了 / 退出中回一句且不入队；入队成功加表情，加不上时每个忙碌期只回一次短句 */
  async function offer(key, spec) {
    const messageId = spec?.message?.message_id;
    if (!on) return 'off';
    if (draining()) {
      await say(messageId, QUEUE_SHUTDOWN_REPLY);
      return 'draining';
    }
    const s = stateOf(key);
    if (s.items.length >= limit) {
      info(`[queue] ${key} 排队已满（${limit} 条），这条不入队`);
      await say(messageId, queueFullReply(limit));
      return 'full';
    }
    s.items.push({ spec, messageId, seq: Number(spec?.seq) || 0, at: spec?.at });
    const period = s.period;
    info(`[queue] ${key} 入队，排队 ${s.items.length} 条`);
    let ok;
    try { ok = (await react(messageId, QUEUED_REACTION)) !== false; } catch { ok = false; }
    if (!ok && states.get(key)?.period === period && !period.fallbackSent) {
      period.fallbackSent = true;
      await say(messageId, QUEUED_FALLBACK_REPLY);
    }
    return 'queued';
  }

  /** 清空本会话队列（同步），返回清掉的条数；被清掉的不会再处理 */
  function clear(key) {
    const s = states.get(key);
    if (!s || !s.items.length) return 0;
    const n = s.items.splice(0).length;
    s.period = { fallbackSent: false };
    info(`[queue] ${key} 清空排队 ${n} 条`);
    gc(key);
    return n;
  }
  /** 清空并单独回一句清掉了几条（0 条不回）；永不 reject */
  function clearAndTell(key, messageId) {
    const n = clear(key);
    if (n <= 0) return Promise.resolve(0);
    return say(messageId, clearedNote(n)).then(() => n);
  }

  const size = (key) => states.get(key)?.items.length ?? 0;
  /** /status 追加行：只在开关开 + owner 私聊时有，其余为空串（逐字同基线） */
  const statusLine = (key, isOwner, chatType) => (applies(isOwner, chatType) ? `\n- 排队消息: ${size(key)} 条` : '');

  /** 优雅退出（onDrain）：队列里没处理的逐条回「请稍后重发」，返回条数 */
  function flushForShutdown() {
    let total = 0;
    for (const key of [...states.keys()]) {
      const s = states.get(key);
      if (!s?.items.length) continue;
      const taken = s.items.splice(0).sort((a, b) => a.seq - b.seq);
      total += taken.length;
      for (const it of taken) say(it.messageId, QUEUE_SHUTDOWN_REPLY);
      info(`[queue] ${key} 退出：${taken.length} 条排队消息没处理，已逐条请光总稍后重发`);
      gc(key);
    }
    return total;
  }
  /** 优雅退出要等的：还没发完的通知 + 刚出队还没接上的批次 */
  function inflight() {
    let n = pending;
    for (const s of states.values()) if (s.reservation) n += 1;
    return n;
  }

  if (on) info(`[queue] OWNER_MESSAGE_QUEUE=true：owner 私聊忙时排队、轮次结束后合并接着办（上限 ${limit} 条）`);

  return { enabled: on, applies, isBusy, shouldQueue, offer, turnStarted, turnEnded, clear, clearAndTell, size, statusLine, flushForShutdown, inflight };
}
