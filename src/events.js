// 机器人事件 → 「owner 对心跳消息的操作」信号（BRIDGE-EV-1）。
//
// 表情、已读、撤回三类事件原本到达后被丢掉；卡片按钮回调是新增的。这里全部由桥接按确定规则处理：
// 不调模型、永不抛出；日志只记类型和计数，不记消息内容。缺字段一律当作「不匹配」，不报错。
// - 表情：operator_type 为 user、操作人是 owner、消息在心跳消息索引里，三条都满足才写 reaction 信号；
//   其余（app 回显 / 非 owner / 非心跳消息）只计数
// - 已读：读者是 owner 时，给 message_id_list 里在索引中的消息写 read 信号
// - 撤回：只计数
// - 卡片按钮：校验（owner、消息在索引里、nonce 一致、台账存在且在跟进）不论开关都做；
//   全部通过才排队回写并回「已记下」，否则回「已失效」、不改任何文件。回写异步执行，回调 3 秒内必返回
import { ACTION_BY_PHRASE, actionLabel } from './ledger-actions.js';
import { ownerText, OWNER } from './owner-name.js';
import { withUuid, contentPart } from './send-key.js'; // BRIDGE-SEND-1

const MSG_ID_RE = /^om_[A-Za-z0-9_-]{1,64}$/;
const TOAST_OK = Object.freeze({ toast: Object.freeze({ type: 'success', content: '已记下' }) });
const TOAST_STALE = Object.freeze({ toast: Object.freeze({ type: 'warning', content: '已失效' }) });
// 引用回复短语：去掉首尾空白和结尾标点后逐字比对
const TRAILING_PUNCT = /[。．.!！?？~～…\s]+$/u;

/**
 * 私聊卡片。没有按钮时逐字是原来的 1.0 卡片（与改造前的 sendMarkdown 一致）；
 * 有按钮时用 Card JSON 2.0：按钮放在横排 column_set 里，点击走 callback（回传 action.value）。
 */
export function buildMarkdownCard(chunk, actions) {
  if (!Array.isArray(actions) || !actions.length) {
    return { config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: chunk }] };
  }
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    body: {
      elements: [
        { tag: 'markdown', content: chunk },
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: actions.map((a) => ({
            tag: 'column',
            width: 'auto',
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: a.label },
              type: a.type,
              behaviors: [{ type: 'callback', value: a.value }],
            }],
          })),
        },
      ],
    },
  };
}

/**
 * 发卡片，失败降级纯文本（与原 sendMarkdown 同一套）。create(data) 是 im.v1.message.create 的包装。
 * 返回飞书的 message_id（两条路都取 data.message_id；拿不到返回 undefined，调用方不记索引）。
 */
export async function sendCardWithFallback(create, chunk, opts = {}, onFallback = () => {}) {
  const actions = Array.isArray(opts?.actions) && opts.actions.length ? opts.actions : null;
  const key = opts?.idempotencyKey; // BRIDGE-SEND-1：同一次逻辑发送的每次重试同一个键；不给键时请求体逐字不变
  let res;
  try {
    res = await create(withUuid({ msg_type: 'interactive', content: JSON.stringify(buildMarkdownCard(chunk, actions)) }, key, contentPart('card', chunk)));
  } catch (e) {
    onFallback(e);
    // 飞书给了 HTTP 应答＝卡片确定没发出，文本用自己的键；没有应答（超时 / 连接断）＝卡片可能已送达，沿用卡片的键让飞书去重
    res = await create(withUuid({ msg_type: 'text', content: JSON.stringify({ text: chunk }) }, key, e?.response ? contentPart('text', chunk) : contentPart('card', chunk)));
  }
  const id = res?.data?.message_id;
  return typeof id === 'string' && id ? id : undefined;
}

const asMs = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{10,13}$/.test(v.trim()) ? Number(v.trim()) : NaN);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
};
const parseValue = (v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/**
 * 事件处理函数。heartbeat 可以是心跳对象或返回它的函数（index.js 里心跳在注册事件之后才创建）。
 * 返回 { reaction, read, recalled, cardAction }，分别注册到对应事件上。
 */
export function createEventHandlers({ getOwner = () => '', heartbeat, schedApproval, log = console.log } = {}) {
  const hb = () => {
    try {
      return (typeof heartbeat === 'function' ? heartbeat() : heartbeat) ?? null;
    } catch {
      return null;
    }
  };
  const owner = () => {
    try {
      const o = getOwner();
      return typeof o === 'string' ? o : '';
    } catch {
      return '';
    }
  };
  const count = (h, name) => {
    try {
      return h?.countEvent?.(name) ?? 0;
    } catch {
      return 0;
    }
  };
  const safeLog = (line) => {
    try {
      log(line);
    } catch { /* 日志失败不影响事件处理 */ }
  };
  const indexed = (h, mid) => {
    try {
      return typeof mid === 'string' && MSG_ID_RE.test(mid) && Boolean(h.indexEntry(mid));
    } catch {
      return false;
    }
  };

  async function reaction(data) {
    try {
      const h = hb();
      if (!h) return;
      const own = owner();
      const kind = data?.operator_type !== 'user' ? 'reaction_app'
        : (!own || data?.user_id?.open_id !== own) ? 'reaction_not_owner'
          : !indexed(h, data?.message_id) ? 'reaction_not_heartbeat' : 'reaction_owner';
      if (kind === 'reaction_owner') {
        const at = asMs(data?.action_time);
        h.recordSignal({ type: 'reaction', message_id: data.message_id, at: new Date(at ?? Date.now()).toISOString() });
      }
      const n = count(h, kind);
      safeLog(`[events] 表情事件：${{ reaction_owner: 'owner 对心跳消息，记信号', reaction_app: 'app 回显，忽略', reaction_not_owner: '非 owner，忽略', reaction_not_heartbeat: '非心跳消息，忽略' }[kind]}（今日第 ${n} 次）`);
    } catch (e) {
      safeLog(`[events] 表情事件处理异常，已忽略（${e?.name ?? 'Error'}）`);
    }
  }

  async function read(data) {
    try {
      const h = hb();
      if (!h) return;
      const own = owner();
      const reader = data?.reader?.reader_id?.open_id;
      if (!own || reader !== own) {
        count(h, 'read_other');
        return; // 别人读的不记日志：私聊里读者恒为 owner，这里只会是群消息
      }
      const ids = Array.isArray(data?.message_id_list) ? data.message_id_list.filter((m) => indexed(h, m)) : [];
      if (!ids.length) {
        count(h, 'read_not_heartbeat');
        return; // owner 读普通回复很频繁，只计数不记日志
      }
      const at = new Date(asMs(data?.reader?.read_time) ?? Date.now()).toISOString();
      for (const mid of ids) h.recordSignal({ type: 'read', message_id: mid, at });
      const n = count(h, 'read_owner');
      safeLog(`[events] 已读事件：owner 读了 ${ids.length} 条心跳消息，记信号（今日第 ${n} 次）`);
    } catch (e) {
      safeLog(`[events] 已读事件处理异常，已忽略（${e?.name ?? 'Error'}）`);
    }
  }

  async function recalled() {
    try {
      const h = hb();
      if (!h) return;
      const n = count(h, 'recalled');
      safeLog(`[events] 撤回事件：只计数（今日第 ${n} 次）`);
    } catch (e) {
      safeLog(`[events] 撤回事件处理异常，已忽略（${e?.name ?? 'Error'}）`);
    }
  }

  // 卡片回调：同步校验后立即返回 toast；回写交给心跳的动作队列（心跳 inflight 时排到这一拍结束后）
  let invalidClicks = 0;
  async function cardAction(data) {
    try {
      const own = owner();
      const op = data?.operator?.open_id ?? (typeof data?.operator_id === 'string' ? data.operator_id : data?.operator_id?.open_id);
      const isOwner = Boolean(own) && op === own;
      const mid = data?.context?.open_message_id ?? data?.open_message_id ?? data?.message_id;
      const value = parseValue(data?.action?.value ?? data?.action_value);
      // BRIDGE-PRIV-3：定时任务确认卡的按钮交给确认卡模块（只认桥接自己发的卡）；其余回调一字不改走心跳
      if (value && typeof value === 'object' && value.k === 'sched-approval') {
        const sa = typeof schedApproval === 'function' ? schedApproval() : schedApproval;
        return (sa ? sa.handleClick({ isOwner, messageId: mid, value }) : null) ?? TOAST_STALE;
      }
      const h = hb();
      if (!h) return TOAST_STALE;
      const r = h.validateCardAction({ isOwner, messageId: mid, value });
      if (!r?.ok) {
        // 「已失效」不改任何文件（卡片原文）：连计数也不落盘，只记进程内次数
        invalidClicks += 1;
        safeLog(`[events] 卡片按钮：已失效（${String(r?.reason ?? '校验未通过').slice(0, 60)}；本次启动第 ${invalidClicks} 次）`);
        return TOAST_STALE;
      }
      h.submitAction({ slug: r.slug, action: r.action, messageId: mid, source: 'button' });
      const n = count(h, 'card_ok');
      safeLog(ownerText`[events] 卡片按钮：${OWNER}点了『${actionLabel(r.action) ?? r.action}』（tasks/${r.slug}.json），已排队回写（今日第 ${n} 次）`);
      return TOAST_OK;
    } catch (e) {
      safeLog(`[events] 卡片回调处理异常，按已失效处理（${e?.name ?? 'Error'}）`);
      return TOAST_STALE;
    }
  }

  return { reaction, read, recalled, cardAction };
}

/** 引用回复的正文：只认纯文本消息，去掉首尾空白和结尾标点。拿不到返回 ''。 */
export function shortcutPhrase(message) {
  if (message?.message_type !== 'text') return '';
  let text;
  try {
    text = JSON.parse(message.content ?? '')?.text;
  } catch {
    return '';
  }
  return typeof text === 'string' ? text.trim().replace(TRAILING_PUNCT, '').trim() : '';
}

/**
 * owner 私聊里引用回复心跳消息（HEARTBEAT_REPLY_SHORTCUTS=true 才生效，关时恒返回 null＝逐字走原流程）：
 * - 正文恰好是「知道了」「推迟一天」「不做了」且那条消息只涉及一条台账 → 桥接确定性回写，返回 { reply }（不调模型）
 *   （BRIDGE-VR-1：验收卡片是「验收」「没办完」「不做了」，升级阶梯消息多一个「办完了」；日结不认短语）
 * - 其余 → 返回 { hint }，照常进 owner 对话，提示词末尾加一行「（你在回复关于 tasks/<slug>.json 的心跳消息）」
 * 永不抛出。
 */
export async function heartbeatReplyShortcut({ message, isOwner, heartbeat }) {
  try {
    const h = typeof heartbeat === 'function' ? heartbeat() : heartbeat;
    if (!h || h.config?.replyShortcuts !== true) return null;
    if (isOwner !== true || message?.chat_type !== 'p2p') return null;
    const pid = message?.parent_id;
    if (typeof pid !== 'string' || !MSG_ID_RE.test(pid)) return null;
    const entry = h.indexEntry(pid);
    const slugs = Array.isArray(entry?.slugs) ? entry.slugs.filter((s) => typeof s === 'string') : [];
    if (!slugs.length) return null;
    const hint = `（你在回复关于 ${slugs.map((s) => `tasks/${s}.json`).join('、')} 的心跳消息）`;
    const phrase = shortcutPhrase(message);
    // BRIDGE-VR-1：验收卡片认「验收 / 没办完 / 不做了」，升级阶梯消息多认「办完了」，日结的撤销只认按钮（见 heartbeat.phraseAction）
    const action = typeof h.phraseAction === 'function'
      ? h.phraseAction(entry, phrase)
      : (Object.hasOwn(ACTION_BY_PHRASE, phrase) ? ACTION_BY_PHRASE[phrase] : null);
    if (!action || slugs.length !== 1) return { hint };
    const slug = slugs[0];
    if (entry.acted?.[action]) return { reply: `这条心跳消息已经按『${phrase}』处理过了，不重复执行。` };
    const r = h.checkLedgerAction({ isOwner: true, messageId: pid, slug, action, viaButton: false });
    if (!r?.ok) return { reply: `没有按『${phrase}』处理 tasks/${slug}.json：${String(r?.reason ?? '校验未通过').slice(0, 80)}。台账没有改动。` };
    const { queued } = h.submitAction({ slug, action, messageId: pid, source: 'reply' }) ?? {};
    return { reply: `已记下：『${phrase}』 tasks/${slug}.json${queued ? '（心跳这一拍正在跑，结束后再写回）' : ''}` };
  } catch {
    return null;
  }
}
