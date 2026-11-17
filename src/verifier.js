// 验收（BRIDGE-VR-1）：心跳轮里写的 done 先降级为 verify，桥接按脚本规则核对 done_evidence；
// 规则不通过时（HEARTBEAT_VERIFY=rule+model）交给小模型（默认 claude-haiku-5-5，零工具的 verifier 档）审核；
// 规则 / 模型都没通过就发验收卡片请光总验收。
//
// 这里只放纯函数和只读核对（lark-cli 只走 EV-1 已有的 approvalGet / messageGet 模板）；
// 台账回写、状态、配额、发送都在 heartbeat.js。所有助理写的文字（title / notes / summary）与
// lark-cli 拉回来的原始返回一律进 fenceUntrusted 围栏，桥接自己的核对结论在围栏外。
import crypto from 'node:crypto';
import { fenceUntrusted } from './messages.js';
import { plain } from './digest.js';

// watch-sources.js 静态导入了 heartbeat.js（parseTime），heartbeat.js 又导入本文件：
// fillTemplate 用缓存的动态 import 取，避免三者成环（本文件不静态依赖 watch-sources.js / heartbeat.js）。
let watchMod = null;
const loadWatch = () => (watchMod ??= import('./watch-sources.js'));

export const VERIFY_KEY = 'sched:verify';
export const DEFAULT_VERIFY_MODEL = 'claude-haiku-5-5';
export const VERIFY_MODES = Object.freeze(['off', 'rule', 'rule+model']);
export const EVIDENCE_KINDS = Object.freeze(['approval', 'message', 'owner', 'other']);
export const VERDICTS = Object.freeze(['pass', 'fail', 'unsure']);

const MAX_REASON = 80; // 模型理由最多几个字（超了整条按 unsure）
const MAX_RAW = 2000; // 拉回来的原始返回最多给模型看多少字
// 审批走到终态才算「办完」：通过 / 拒绝 / 撤回 / 删除（拒绝也是结果）；PENDING 等一律不算
const TERMINAL_APPROVAL = new Set(['APPROVED', 'REJECTED', 'CANCELED', 'DELETED']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pad2 = (n) => String(n).padStart(2, '0');

/** HEARTBEAT_VERIFY：off（默认）/ rule / rule+model；别的值按 off 并记日志。 */
export function parseVerifyMode(raw, log = () => {}) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return 'off';
  if (VERIFY_MODES.includes(s)) return s;
  log(`[heartbeat] HEARTBEAT_VERIFY=${JSON.stringify(s.slice(0, 20))} 不认识（只认 off / rule / rule+model），按 off 处理`);
  return 'off';
}

/**
 * 模型回答只认一行严格 JSON：恰好 verdict、reason 两个键；verdict ∈ pass / fail / unsure；reason 是 ≤80 字的字符串。
 * 代码块、多字段、少字段、大小写不对、超长一律按 unsure（malformed）。
 */
export function parseVerdict(text) {
  const bad = { verdict: 'unsure', reason: '', malformed: true };
  if (typeof text !== 'string') return bad;
  let v;
  try {
    v = JSON.parse(text.trim());
  } catch {
    return bad;
  }
  if (!isObj(v)) return bad;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !Object.hasOwn(v, 'verdict') || !Object.hasOwn(v, 'reason')) return bad;
  if (!VERDICTS.includes(v.verdict) || typeof v.reason !== 'string') return bad;
  if (Array.from(v.reason).length > MAX_REASON) return bad;
  return { verdict: v.verdict, reason: v.reason };
}

/** 一份依据的指纹（kind + ref + summary）：依据改了要重新验收；光总判过「没办完」的同一份依据不再自动通过。 */
export function evidenceKey(ev) {
  const e = isObj(ev) ? ev : {};
  const s = JSON.stringify([String(e.kind ?? ''), String(e.ref ?? '').trim(), String(e.summary ?? '').trim()]);
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function parseJson(stdout) {
  try {
    const v = JSON.parse(String(stdout ?? '').trim() || 'null');
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

// 与 watch-sources.js 同口径（那边未导出）：messages 可能在顶层，也可能包在 data 里
function messagesOf(o) {
  for (const c of [o?.messages, o?.data?.messages, o?.data?.items, o?.items]) if (Array.isArray(c)) return c;
  return [];
}

// 与 watch-sources.js 同口径：只认真人（sender_type user；缺省时要求 ou_ 开头且不是机器人）；去掉 system、已撤回、owner 本人
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

// runner 的失败原因是桥接自己写的短语；仍只留安全字符、最多 40 字（它出现在围栏外）
const cleanReason = (r) => String(r ?? '').replace(/[^\p{L}\p{N} _.:/()（）-]/gu, '').slice(0, 40) || '原因不明';

/** 原始返回最多 MAX_RAW 字（不拆代理对），超了注明截断。 */
function clipRaw(s) {
  const str = String(s ?? '');
  if (str.length <= MAX_RAW) return str;
  let cut = str.slice(0, MAX_RAW);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}\n…（后面还有 ${str.length - cut.length} 个字符，已截断）`;
}

async function safeRun(runner, argv) {
  try {
    const r = await runner(argv);
    if (r && r.ok === true) return { ok: true, stdout: String(r.stdout ?? '') };
    return { ok: false, reason: r?.reason };
  } catch {
    return { ok: false, reason: '执行出错' };
  }
}

/**
 * 脚本规则（只读、确定性）。task 是校验过的台账；runner 是 EV-1 的只读 lark runner；owner 是光总的 open_id。
 * - approval：ref 必须等于 watch.instance_code，approvalGet 查到终态才通过
 * - message：messageGet 查到这条 om_，在 watch.chat_id 的会话里，且不是光总本人（也不是机器人 / 系统 / 已撤回）发的
 * - owner：模型写的一律不算（光总的确认只认桥接记下的按钮 / 引用回复，那条路径直接写 done、不经验收）
 * - other：没有可核对的规则
 * 返回 { pass, finding, raw? }：finding 是桥接自己的话（只含校验过的 ID 与状态），raw 是给模型看的原始返回（进围栏）。
 */
export async function ruleCheck({ task, runner, owner } = {}) {
  const ev = isObj(task?.done_evidence) ? task.done_evidence : null;
  if (!ev) return { pass: false, finding: '台账没写 done_evidence（办完的依据）' };
  const ref = String(ev.ref ?? '').trim();
  const w = isObj(task.watch) ? task.watch : {};

  if (ev.kind === 'approval') {
    if (w.type !== 'approval') return { pass: false, finding: '依据是审批，但台账 watch 不是审批' };
    if (!ref || ref !== w.instance_code) return { pass: false, finding: '依据的审批实例码和台账 watch.instance_code 对不上' };
    const { fillTemplate } = await loadWatch();
    const argv = fillTemplate('approvalGet', { params: JSON.stringify({ instance_code: ref }) });
    if (!argv) return { pass: false, finding: '审批实例码不合规，没去查' };
    if (typeof runner !== 'function') return { pass: false, finding: '桥接没有可用的 lark-cli，没去查审批' };
    const r = await safeRun(runner, argv);
    if (!r.ok) return { pass: false, finding: `查审批没成功（${cleanReason(r.reason)}）` };
    const o = parseJson(r.stdout);
    const inst = o && [o, o.data, o.data?.instance, o.instance].find((x) => isObj(x) && typeof x.status === 'string');
    if (!inst) return { pass: false, finding: '查到的审批没有状态字段', raw: clipRaw(r.stdout) };
    const status = String(inst.status).replace(/[^A-Z_]/g, '').slice(0, 20) || 'UNKNOWN';
    if (TERMINAL_APPROVAL.has(status)) return { pass: true, finding: `审批 ${ref} 已是 ${status}` };
    return { pass: false, finding: `审批 ${ref} 还是 ${status}，不是终态`, raw: clipRaw(r.stdout) };
  }

  if (ev.kind === 'message') {
    if (w.type !== 'chat_reply') return { pass: false, finding: '依据是消息，但台账 watch 不是会话回复' };
    const { fillTemplate } = await loadWatch();
    const argv = fillTemplate('messageGet', { message_id: ref });
    if (!argv) return { pass: false, finding: '依据的消息 ID 不合规，没去查' };
    if (typeof runner !== 'function') return { pass: false, finding: '桥接没有可用的 lark-cli，没去查消息' };
    const r = await safeRun(runner, argv);
    if (!r.ok) return { pass: false, finding: `查消息没成功（${cleanReason(r.reason)}）` };
    const raw = clipRaw(r.stdout);
    const m = messagesOf(parseJson(r.stdout)).find((x) => isObj(x) && x.message_id === ref);
    if (!m) return { pass: false, finding: `没查到消息 ${ref}`, raw };
    if (typeof w.chat_id !== 'string' || m.chat_id !== w.chat_id) return { pass: false, finding: `消息 ${ref} 不在台账 watch 的会话里`, raw };
    const own = typeof owner === 'string' ? owner : '';
    if (!own) return { pass: false, finding: '桥接还不知道光总是谁，判断不了是不是对方发的', raw };
    const s = isObj(m.sender) ? m.sender : {};
    if ((s.id ?? s.open_id) === own) return { pass: false, finding: `消息 ${ref} 是光总本人发的，不算对方回复`, raw };
    if (!isOtherHuman(m, own)) return { pass: false, finding: `消息 ${ref} 不是真人发的（机器人 / 系统 / 已撤回）`, raw };
    return { pass: true, finding: `消息 ${ref} 是对方在 watch 的会话里发的` };
  }

  if (ev.kind === 'owner') return { pass: false, finding: '依据 kind=owner 不算：光总的确认只认桥接记下的按钮 / 引用回复' };
  return { pass: false, finding: '依据类型 other：桥接没有可核对的规则' };
}

const fmtNow = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** 依据类型与 ref（kind 只认四种；ref 已按 kind 校验过：审批实例码 / om_ / 空）。 */
function evidenceHead(ev) {
  const kind = EVIDENCE_KINDS.includes(ev?.kind) ? ev.kind : '（没写）';
  const ref = String(ev?.ref ?? '').trim();
  return { kind, ref };
}

/**
 * 给验收模型的提示词。固定说明在前；台账 title / notes、依据 summary、原始返回各进一道围栏；桥接核对结论在围栏外。
 */
export function buildVerifyPrompt({ slug, task, finding, raw, nowMs }) {
  const ev = isObj(task?.done_evidence) ? task.done_evidence : {};
  const { kind, ref } = evidenceHead(ev);
  const lines = [
    '你是台账验收员：判断下面这条台账是不是真的办完了。',
    '只根据下面给出的材料判断，不要假设材料以外的事实；你没有工具，也不需要工具。',
    '依据含糊、只有助理自己的说法、或者和「桥接核对」的结果矛盾时，判 fail 或 unsure，不要判 pass。',
    '只输出一行严格 JSON，不要代码块、不要别的字：{"verdict":"pass 或 fail 或 unsure","reason":"不超过 80 字的理由"}',
    '',
    `台账：tasks/${slug}.json（现在 ${fmtNow(nowMs)}）`,
    fenceUntrusted('台账 title', String(task?.title ?? '')),
    fenceUntrusted('台账 notes（助理写的进展）', String(task?.notes ?? '') || '（无）'),
    `依据类型：${kind}${ref ? `（ref：${ref}）` : ''}`,
    fenceUntrusted('done_evidence.summary（助理写的依据）', String(ev.summary ?? '') || '（无）'),
    `桥接核对：${finding}`,
  ];
  if (raw) lines.push(fenceUntrusted('桥接用 lark-cli 拉回来的原始返回（截断）', raw));
  return lines.join('\n');
}

/**
 * 验收卡片正文（标题「🔍 **待你验收**」由 heartbeat 加）。助理写的 title / notes / summary 与模型理由在一道围栏里、
 * 中和 Markdown 记号；桥接核对、模型审核备注与操作提示在围栏外。
 * verdict：模型给出的合法结论（可选）；note：模型没按格式 / 调用失败时的一句备注（可选）。
 */
export function buildVerifyCard({ slug, task, finding, verdict, note, buttons = false, shortcuts = false }) {
  const ev = isObj(task?.done_evidence) ? task.done_evidence : {};
  const { kind, ref } = evidenceHead(ev);
  const inner = [
    `标题：${plain(task?.title, 60)}`,
    `进展：${plain(task?.notes, 120) || '（无）'}`,
    `依据（${kind}${ref ? ` ${ref}` : ''}）：${plain(ev.summary, 120) || '（无）'}`,
  ];
  if (verdict && VERDICTS.includes(verdict.verdict) && verdict.reason) inner.push(`模型理由（${verdict.verdict}）：${plain(verdict.reason, MAX_REASON)}`);
  let hint;
  if (buttons && shortcuts) hint = '点下面的按钮，或引用这条消息回复「验收」「没办完」「不做了」。';
  else if (buttons) hint = '点下面的按钮：验收 / 没办完 / 不做了。';
  else if (shortcuts) hint = '引用这条消息回复「验收」「没办完」「不做了」。';
  else hint = '你确认后在对话里告诉我结果即可。';
  return [
    `助理说『tasks/${slug}.json』办完了，依据：`,
    fenceUntrusted('台账与助理写的依据', inner.join('\n')),
    `桥接核对：${finding}`,
    ...(note ? [note] : []),
    hint,
  ].join('\n');
}
