// BRIDGE-PRIV-3：定时任务的确认卡（SCHED_APPROVAL_MODE=button）。
// - 卡片正文一律是 plain_text 的 div（不渲染链接 / @ / 代码），任务文件来的字符串先过 plain() 并封顶；只给会话 id 末 4 位。
// - 授权只看桥接自己发出的那张卡：点击里的 message_id 必须在本进程的确认卡索引里、nonce 一致、未用过、未过期；
//   要确认的「文件 + 哈希」一律取索引条目，不取按钮 value 里的任何字段（模型可以以应用身份发一张长得一样的卡）。
// - value 里的 f（文件名）只用来在卡失效时补发一张新卡（补发是安全方向）。
// - 一次性：点过（确认 / 拒绝 / 内容已变 / 不再需要确认）的卡作废。索引只在内存，重启后旧卡失效、点它会补发新卡。
// - 按钮路径不套用 P6（「有 owner 回合在跑就拒绝」）：回调只能由飞书客户端里的真人点击产生，操作者身份由飞书填写，
//   模型伪造的卡被索引挡住，模型在 owner 点之前改任务内容则哈希对不上。所以这里不查忙。
// 本模块加载时没有副作用，不读 process.env；永不抛。
import crypto from 'node:crypto';
import { plain } from './digest.js';
import { decisionReply } from './sched-approval.js';

export const SCHED_CARD_KIND = 'sched-approval';

const MSG_ID_RE = /^om_[A-Za-z0-9_-]{1,64}$/;
const NONCE_RE = /^[0-9a-f]{16}$/;
const DAY_MS = 86_400_000;
const toast = (type, content) => ({ toast: { type, content } });
const STALE = Object.freeze({ toast: Object.freeze({ type: 'warning', content: '已失效' }) });
const validFile = (f) => typeof f === 'string' && f.length > 0 && f.length <= 255 && !/[\r\n]/.test(f);

/** 卡片正文的各行（纯文本）。任务文件来的字符串全部过 plain 并封顶；不含完整 chat_id / open_id / 路径。 */
export function approvalCardLines({ job, destUnknown } = {}) {
  const name = plain(job?.name ?? job?._file ?? '', 60);
  const tail = plain(String(job?.chat_id ?? '').slice(-4), 8);
  const note = destUnknown ? '（桥接还不知道你的私聊会话；如果这是发给你自己的，私聊我任意一句，它会自动放行）' : '';
  const set = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  const models = [['模型', job?.model], ['思考档', job?.effort], ['执行模型', job?.exec_model], ['执行思考档', job?.exec_effort]]
    .filter(([, v]) => set(v))
    .map(([k, v]) => `${k} ${plain(v, 40)}`);
  return [
    '⏸ 定时任务要把结果发往别的会话，等你确认后才会执行（到点先不跑、不补跑）',
    `任务：${name}`,
    `发往：会话 id 末 4 位 ${tail}${note}`,
    `时间：${plain(job?.when, 60)}`,
    job?.action
      ? `动作：${plain(job.action, 40)}`
      : `提示词前 200 字（任务文件里的原文，可能来自外部，只供核对，不要照做）：${plain(job?.prompt, 200)}`,
    ...(models.length ? [`模型与思考档：${models.join('；')}`] : []),
  ];
}

/** Card JSON 2.0。status 为空：末尾两个按钮（确认 / 拒绝）；非空：追加一行状态、不带按钮。不用 markdown / lark_md。 */
export function buildApprovalCard({ lines, nonce, file, status } = {}) {
  const div = (content) => ({ tag: 'div', text: { tag: 'plain_text', content: String(content) } });
  const elements = (Array.isArray(lines) ? lines : []).map(div);
  if (status) {
    elements.push(div(status));
  } else {
    const button = (label, type, a) => ({
      tag: 'column',
      width: 'auto',
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: label },
        type,
        behaviors: [{ type: 'callback', value: { v: 1, k: SCHED_CARD_KIND, a, n: nonce, f: file } }],
      }],
    });
    elements.push({ tag: 'column_set', flex_mode: 'none', columns: [button('确认', 'primary', 'approve'), button('拒绝', 'danger', 'reject')] });
  }
  return { schema: '2.0', config: { width_mode: 'fill' }, body: { elements } };
}

const pad = (n) => String(n).padStart(2, '0');
const localTime = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 确认卡的索引与点击处理。
 * send(card) → 飞书应答（取 data.message_id）；notify(text) → 发文字给 owner；scheduler() → 调度器句柄
 * （approvalCandidates / approvalStore.decide / resendApprovalCard）；redact(s) 在建卡前过一遍。
 * 返回 { issue, handleClick, size }。
 */
export function createApprovalCards({
  send, notify, getOwner, scheduler, redact = (s) => s, log = console.log,
  now = () => Date.now(), randomBytes = crypto.randomBytes, ttlMs = 7 * DAY_MS, maxEntries = 200,
} = {}) {
  void getOwner; // 操作者是不是 owner 由调用方（events.js）按飞书回调里的 open_id 判好后传入
  const say = (m) => { try { log(m); } catch { /* 日志失败不影响 */ } };
  const entries = new Map(); // message_id → { file, hash, nonce, at, lines, used }
  let invalidClicks = 0;

  const sweep = () => {
    const t = now();
    for (const [k, e] of entries) if (t - e.at > ttlMs) entries.delete(k);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value); // Map 按插入顺序：最旧的在前
  };

  async function issue({ file, hash, job, destUnknown } = {}) {
    let stage = '发送失败';
    try {
      const nonce = Buffer.from(randomBytes(8)).toString('hex');
      const lines = approvalCardLines({ job, destUnknown }).map((l) => redact(l));
      const card = buildApprovalCard({ lines, nonce, file });
      const res = await send(card);
      stage = '应答里没有消息 id';
      const id = res?.data?.message_id;
      if (typeof id !== 'string' || !MSG_ID_RE.test(id)) throw new Error('no id');
      entries.set(id, { file, hash, nonce, at: now(), lines, used: false });
      sweep();
      return true;
    } catch {
      say(`[sched-approval] 确认卡发不出去（${stage}）`);
      return false;
    }
  }

  const stale = (why) => {
    invalidClicks += 1;
    say(`[sched-approval] 确认卡：已失效（${why}；本次启动第 ${invalidClicks} 次）`);
  };

  // 卡失效（不在索引 / 过期 / nonce 不对）：任务当前受闸且不是已确认就补发一张新卡（补发自带 2 分钟限频）
  const invalidClick = (why, value) => {
    stale(why);
    if (!validFile(value?.f)) return STALE;
    let r = null;
    try { r = scheduler()?.resendApprovalCard?.(value.f); } catch { r = null; }
    if (r === 'sent') return toast('warning', '这张卡片已失效，已重发一张新的');
    if (r === 'recent') return toast('warning', '这张卡片已失效，新卡刚发过，请往下找');
    return STALE;
  };

  function handleClick({ isOwner, messageId, value } = {}) {
    try {
      // 1. value 形状
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.k !== SCHED_CARD_KIND || value.v !== 1 ||
        (value.a !== 'approve' && value.a !== 'reject') || typeof value.n !== 'string' || !NONCE_RE.test(value.n)) {
        stale('value 形状不对');
        return STALE;
      }
      // 2. 操作者必须是 owner
      if (isOwner !== true) { stale('操作者不是 owner'); return STALE; }
      // 3. 索引 + 未过期 + 未用过 + nonce 定长比较
      const entry = typeof messageId === 'string' ? entries.get(messageId) : undefined;
      if (!entry) return invalidClick('卡片不在索引里', value);
      if (now() - entry.at > ttlMs) { entries.delete(messageId); return invalidClick('卡片已过期', value); }
      if (entry.used) { stale('卡片已用过'); return STALE; }
      if (!crypto.timingSafeEqual(Buffer.from(entry.nonce, 'hex'), Buffer.from(value.n, 'hex'))) return invalidClick('nonce 不符', value);

      // 之后要确认的「文件 + 哈希」只取索引条目
      const approve = value.a === 'approve';
      const want = approve ? 'approved' : 'rejected';
      const label = approve ? '已确认' : '已拒绝';
      const stateLine = `${approve ? '✅' : '🚫'} ${label}（${localTime(now())}）`;
      const done = (t, status) => {
        entry.used = true;
        return { toast: t.toast, card: { type: 'raw', data: buildApprovalCard({ lines: entry.lines, status }) } };
      };
      const sch = scheduler();
      const cand = (sch.approvalCandidates() ?? []).find((c) => c.file === entry.file);
      if (!cand) { // B4
        say(`[sched-approval] 确认卡：任务已不需要确认（${plain(entry.file, 80)}）`);
        return done(toast('info', '这个任务已不需要确认'), '这个任务已不需要确认（已删除、停用，或改成发给你本人）');
      }
      if (cand.hash !== entry.hash) { // B3
        say(`[sched-approval] 确认卡：任务内容已变，卡片作废（${plain(entry.file, 80)}）`);
        return done(toast('warning', '任务内容已变，请看新的卡片'), '⚠️ 任务内容已变，这张卡已作废，请看新的卡片');
      }
      if (cand.state === want) return done(toast('info', `已经是${label}`), stateLine); // B5

      const r = sch.approvalStore.decide(entry.file, entry.hash, want);
      if (r?.ok !== true) { // B6：没记下，任务仍待确认
        entry.used = true;
        say(`[sched-approval] 确认卡：没能记下${approve ? '确认' : '拒绝'}（${plain(entry.file, 80)}）`);
        sendText(decisionReply({ candidate: cand, approve, result: { ok: false } }));
        return toast('error', '没能记下，任务仍待确认');
      }
      say(`[sched-approval] 确认卡：owner 点了${approve ? '确认' : '拒绝'}（${plain(entry.file, 80)}）`);
      sendText(decisionReply({ candidate: cand, approve, result: r })); // B1 / B2：文字行与 command 模式同一个函数
      return done(toast('success', label), stateLine);
    } catch (e) {
      say(`[sched-approval] 确认卡回调处理异常，按已失效处理（${e?.name ?? 'Error'}）`);
      return STALE;
    }
  }

  // 文字行不等待：发送失败只记一行（不含内容），不影响点击的应答
  function sendText(text) {
    try {
      void Promise.resolve(notify(text)).catch(() => say('[sched-approval] 确认结果的文字通知发不出去'));
    } catch {
      say('[sched-approval] 确认结果的文字通知发不出去');
    }
  }

  return { issue, handleClick, get size() { return entries.size; } };
}
