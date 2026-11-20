// 定时任务：机器人把任务定义写进 workspace/schedules/*.json（白名单写入权），
// 桥接负责到点执行——不给机器人 Bash/launchctl 权限，避免聊天消息能在主机跑任意命令。
//
// 任务文件格式：
// {
//   "name": "晨报",                       // 展示名
//   "when": "0 8 * * 1-5",                // 5 段 cron 表达式（本地时区）；或一次性时间 "2026-07-27T08:00" / "2026-07-27 08:00" / "2026-07-27"
//   "prompt": "汇总今天日程并提醒我",       // 到点后交给 Claude 执行的提示词
//   "chat_id": "oc_xxx",                  // 结果发到哪个会话
//   "enabled": true
// }
//
// BRIDGE-SCHED-1：调度可靠性——
// - 任务之间不互相挡：tick 只扫描、派发，不等任务跑完；并发上限对「所有在跑的任务」跨拍有效
// - 重启时状态里留着 running 的任务：目的地是 owner 私聊的 prompt 型任务补跑一次，其余记 interrupted 并通知 owner
// - 状态写不进去时记进内存表，本进程内不重跑
// - 迟到跳过 / 等位超时 / 被打断 / when 写错 / 任务文件坏了 / 结果发不出去 等问题私聊 owner（同一任务同一原因每个本地日一次）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { OWNER_DM_CHAT_ID_RE } from './owner-dm-store.js'; // BRIDGE-PRIV-1：chat_id 的写法校验与 owner 私聊 id 同一个正则
import { parseTime } from './heartbeat.js';
import { plain } from './digest.js';
import { SCHED_APPROVALS_FILE_NAME, SCHED_APPROVAL_KEY_FILE, createApprovalStore, needsApproval, approvalHash, approvalCode, pendingNoticeText, approvalModeOf } from './sched-approval.js'; // BRIDGE-PRIV-2

const TICK_MS = 30_000;
// 迟到窗口：错过的任务只在这个窗口内补跑。机器休眠一夜后醒来，
// 不该把昨天的晨报、已经过期的模型切换全部倒着补一遍。
const DEFAULT_MAX_LATE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT = 2;
// 一次性 prompt 任务（提醒）超过迟到窗口后仍补发，但有上限：迟到超过这个时长的不再补发。
// 否则「旧代码从没执行过、文件仍 enabled」的几周前任务会在升级那一拍被全部执行。
export const ONE_SHOT_CATCHUP_MAX_MS = 86_400_000;
// 同一拍合并成一条私聊时最多列出的项数
const NOTICE_BATCH_MAX = 10;

// action 型任务只允许这些动作——任务定义由机器人自己写，
// 而机器人可能被聊天内容注入，所以这里按白名单严格枚举，未知 action 一律拒绝执行。
const ALLOWED_ACTIONS = new Set(['set-model']);

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const nameOf = (job) => plain(job?.name ?? job?._file ?? '', 60);
const fmtLocal = (d) => d.toLocaleString('zh-CN');
const isPromptJob = (job) => Boolean(job.prompt) && !job.action;

/** 数值型环境变量：留空按默认（不记日志）；写错 / 越界按默认并记一行（值只回显前 20 个字）。 */
function intSetting(raw, name, def, min, max, log) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const s = String(raw).trim();
  const n = /^\d+$/.test(s) ? Number(s) : NaN; // 只认十进制整数（1e5、0x10 这类写法按写错处理）
  if (!Number.isInteger(n) || n < min || n > max) {
    log(`[sched] ${name}=${JSON.stringify(s.length > 20 ? `${s.slice(0, 20)}…` : s)} 不是 ${min}–${max} 的整数，按默认 ${def}`);
    return def;
  }
  return n;
}

/**
 * when 的写法判定：
 * - { kind: 'once', at: Date }：一次性时间。先用 heartbeat.js 的 parseTime（认 T 或空格、只有日期按本地零点、带 Z / ±HH:MM）；
 *   它不认、但 new Date 认的写法（如 2026/11/21）照旧按 new Date 解析，不让以前能用的写法失效
 * - { kind: 'cron', expr }：5 段 cron 或 @ 宏
 * - { kind: 'bad', reason }：认不出来，或 cron 不是 5 段（6 段会被 cron-parser 当成「带秒」，写错一位就变成每小时 / 每 10 秒触发）
 */
export function parseWhen(when) {
  const w = String(when ?? '').trim();
  if (!w) return { kind: 'bad', reason: 'when 是空的' };
  const ms = parseTime(w);
  if (ms !== null) return { kind: 'once', at: new Date(ms) };
  // cron 宏（@daily/@weekly/@hourly…）不含空格，但绝不是一次性时间
  if (w.startsWith('@')) return { kind: 'cron', expr: w };
  const hasSpace = /\s/.test(w);
  // 不含空白的，以及「年-月-日 …」「年/月/日 …」这类明显是日期的写法，交给 new Date（本地时区）；cron 绝不会以四位年份开头
  if (!hasSpace || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(w)) {
    const t = new Date(w);
    if (!isNaN(t)) return { kind: 'once', at: t };
    return { kind: 'bad', reason: '时间写法认不出来（可写 2026-11-21 09:00、2026-11-21T09:00 或 2026-11-21）' };
  }
  const fields = w.split(/\s+/);
  if (fields.length !== 5) {
    return { kind: 'bad', reason: `cron 表达式要写 5 段（现在是 ${fields.length} 段；6 段会被当成「带秒」，容易变成每小时甚至每 10 秒触发）` };
  }
  return { kind: 'cron', expr: fields.join(' ') };
}

/** 下次触发时间（/tasks 显示用，与调度器同一个写法判定）。不触发 / 认不出来返回 null。 */
export function nextFireAt(job, now = new Date()) {
  if (job.enabled === false) return null;
  const p = parseWhen(job.when);
  try {
    if (p.kind === 'once') return p.at > now ? p.at : null;
    if (p.kind === 'cron') return CronExpressionParser.parse(p.expr, { currentDate: now }).next().toDate();
  } catch { /* 无效 cron */ }
  return null;
}

// 返回 <= now 的最近一次应触发时间。{ due: Date|null, once: boolean, bad: string|null }
function lastDueAt(job, now) {
  const p = parseWhen(job.when);
  if (p.kind === 'bad') return { due: null, once: false, bad: p.reason };
  if (p.kind === 'once') return { due: p.at <= now ? p.at : null, once: true, bad: null };
  try {
    return { due: CronExpressionParser.parse(p.expr, { currentDate: now }).prev().toDate(), once: false, bad: null };
  } catch (e) {
    return { due: null, once: false, bad: `cron 表达式无效（${plain(e?.message ?? e, 80)}）` };
  }
}

/**
 * 读任务文件。report(kind, file, info) 在遇到「该告诉人」的问题时调用：
 * 'json'（文件不是合法 JSON）、'chat-id'（chat_id 写法不对，info.hash 是文件内容的哈希）、'action'（未知 action）。
 */
function readJobs(dir, report = () => {}) {
  if (!fs.existsSync(dir)) return [];
  const jobs = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('._')) continue; // 跳过 exFAT 的 AppleDouble 影子文件
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const parsed = JSON.parse(raw);
      // 下划线开头的键是桥接内部标志（_resumed / _lateOver / _late…），任务文件里写的一律不要，免得影响标题前缀等行为。
      // 读入时新建对象丢掉它们；null / 数组 / 原始值走原路径（后面照旧报错或跳过）
      let job = parsed;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        job = Object.fromEntries(Object.entries(parsed).filter(([k]) => !k.startsWith('_')));
      }
      job._file = f;
      if (job.enabled === false || !job.when) continue;
      // BRIDGE-PRIV-1：chat_id 决定回答发往哪、跑在哪一档。写法不是飞书会话 id（oc_ 开头的小写字母数字）的任务不执行，
      // 免得一个写坏的目的地被当成「别的会话」悄悄发出去；日志只记文件名，不记值。没写 chat_id 的照旧（执行时再报缺）
      if (job.chat_id !== undefined && job.chat_id !== null && job.chat_id !== '' &&
          !(typeof job.chat_id === 'string' && OWNER_DM_CHAT_ID_RE.test(job.chat_id))) {
        report('chat-id', f, { hash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16) });
        continue;
      }
      if (job.action && !ALLOWED_ACTIONS.has(job.action)) {
        report('action', f, { action: job.action });
        continue;
      }
      // prompt 型（跑 Claude）或 action 型（如切模型）任一即可
      if (job.prompt || job.action) jobs.push(job);
    } catch (e) {
      report('json', f, { message: e?.message ?? e });
    }
  }
  return jobs;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * BRIDGE-SEND-1：定时任务一次触发的发送逻辑键（只含哈希）。同一任务文件 + 同一应触发时间 → 同一个键；
 * 因重启补跑是新的执行（结果可能不同），换键。scope 是目的会话与 when 原文：换了写法 / 换了会话就换键。
 */
export function schedSendKey(file, dueIso, resumed = false, scope = '') {
  return `sched:${crypto.createHash('sha256').update(`${file}\n${dueIso}\n${resumed ? 'resumed' : 'first'}\n${scope}`).digest('hex').slice(0, 32)}`;
}

/**
 * 一次 prompt 型任务的编排（依赖全部注入，index.js 的 onFire 只做接线）：
 *   缺 chat_id → 通知 owner、报失败（不调模型）；
 *   调模型（run）失败 → onRunFailure（现有的失败自诊断路径，不变）；
 *   调模型成功 → 发送（结果消息 + 回传文件）最多 3 次（首发 + 2 次重试，间隔 5 秒、30 秒）；
 *   仍发不出去 → 不自诊断（模型没问题），私聊 owner（任务名、目的会话末 6 位、结果正文截 2000 字），报失败。
 * 结果消息已发出后的重试只重发回传文件，不会把结果发两份。
 */
export async function fireJob({
  job, run, send, flush, notifyOwner, onRunFailure, isQuiet,
  sleep = defaultSleep, retryDelaysMs = [5000, 30000], log = console.log,
}) {
  const name = nameOf(job);
  const tell = async (text, reason) => {
    if (!notifyOwner) return;
    try { await notifyOwner(text, reason); } catch (e) { console.error('[sched] 通知 owner 失败:', e?.message ?? e); }
  };
  if (!job.chat_id) {
    console.error(`[sched] 任务「${name}」缺 chat_id，跳过`);
    await tell(`⚠️ 定时任务「${name}」缺 chat_id，不知道结果该发给谁，这次没有执行。请在任务文件里补上 chat_id。`, 'nochat');
    throw new Error('缺 chat_id');
  }
  let answer;
  try {
    answer = await run();
  } catch (e) {
    await onRunFailure(e);
    return;
  }
  const late = job._resumed
    ? '（因重启补跑）'
    : job._lateOver
      ? `（迟到 ${Math.floor(job._late / 3_600_000)} 小时 ${Math.floor((job._late % 3_600_000) / 60_000)} 分钟补发）`
      : job._late ? `（迟到补跑 ${Math.round(job._late / 60000)} 分钟）` : '';
  // 无事不报：答案整条就是 HEARTBEAT_OK（或为空）时静默跳过，
  // 让「每天检查一遍，有问题才叫我」这类心跳型任务成为可能
  const body = (answer ?? '').trim();
  const quiet = isQuiet(body);
  if (quiet) log(`[sched] 「${name}」无需汇报，静默跳过`);
  let sent = quiet;
  let lastErr;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (attempt > 0) await sleep(retryDelaysMs[attempt - 1]);
    try {
      if (!sent) {
        await send(`⏰ **${job.name ?? '定时任务'}**${late}\n\n${body}`);
        sent = true;
      }
      // 定时任务写的文件此前从不发送，会滞留到下一条任意消息被顺手发走
      await flush();
      return;
    } catch (e) {
      lastErr = e;
      console.error(`[sched] 「${name}」结果发送失败（第 ${attempt + 1} 次）:`, e?.message ?? e);
    }
  }
  const tail = String(job.chat_id).slice(-6);
  const resultSent = sent && !quiet;
  await tell(
    quiet
      ? `⚠️ 定时任务「${name}」本次无需汇报，但随附的文件发不出去（会话 id 末 6 位 ${tail}；${plain(lastErr?.message ?? lastErr, 80)}）。`
      : resultSent
      ? `⚠️ 定时任务「${name}」的结果已发出，但随附的文件发不出去（会话 id 末 6 位 ${tail}；${plain(lastErr?.message ?? lastErr, 80)}）。`
      : `⚠️ 定时任务「${name}」的结果发不出去（原定发往的会话 id 末 6 位 ${tail}；${plain(lastErr?.message ?? lastErr, 80)}）。结果正文如下：\n\n${body.slice(0, 2000)}`,
    'send',
  );
  throw new Error('结果发送失败');
}

/**
 * 启动调度器。onFire(job, ctx) 由调用方实现（跑 Claude 并把结果发到会话；ctx.notifyOnce(reason, text) 是同一任务同一原因每个本地日一次的 owner 通知）。
 * 触发状态记录在 data/schedule-state.json，重启不会重复触发或漏触发。
 * 可选：turnFor（判定「结果是否发往 owner 私聊」，与 index.js 的 schedTurnFor 同一个）、notifyOwner(text)、
 * maxConcurrent / maxLateMs（不传则读 SCHED_MAX_CONCURRENT / SCHED_MAX_LATE_MS）、oneShotCatchupMaxMs（一次性 prompt 任务迟到补发的上限，默认 24 小时，供测试）。
 * 调度器自己产生的通知（被打断 / 迟到跳过 / 等位超时 / when 写错 / 坏 JSON / chat_id 写法不对）同一拍合并成一条私聊。
 * BRIDGE-PRIV-2：requireApproval 为真时，结果不是发往 owner 私聊的任务要 owner 在私聊确认后才执行（approvalKeyFile 是确认记录的签名密钥，测试用）；不传则行为与以前逐字相同。
 * BRIDGE-PRIV-3：approvalMode（'button' 时发确认卡，其余按 command）与 sendApprovalCard({ file, hash, job, destUnknown }) → Promise<boolean>；requireApproval 为假时两项都不起作用。
 * 返回 { stop, whenIdle, idle, inflightCount, approvalOf, approvalCandidates, approvalStore, approvalMode, resendApprovalCard }。
 */
export function startScheduler({ schedulesDir, stateFile, onFire, turnFor, notifyOwner, maxConcurrent, maxLateMs, oneShotCatchupMaxMs, requireApproval = false, approvalKeyFile, approvalMode, sendApprovalCard }) {
  fs.mkdirSync(schedulesDir, { recursive: true });
  const approvals = requireApproval
    ? createApprovalStore({ file: path.join(path.dirname(stateFile), SCHED_APPROVALS_FILE_NAME), keyFile: approvalKeyFile ?? SCHED_APPROVAL_KEY_FILE })
    : null;
  // BRIDGE-PRIV-3：button 模式（且有发卡函数）时，待确认通知改发确认卡；requireApproval 为假时恒为 command
  const mode = approvals ? approvalModeOf(approvalMode, console.log) : 'command';
  const cardMode = mode === 'button' && typeof sendApprovalCard === 'function';
  const MAX_CARDS_PER_TICK = 5;
  const RESEND_MIN_MS = 120_000;
  let cardsThisTick = 0;
  const MAX_CONCURRENT = maxConcurrent ?? intSetting(process.env.SCHED_MAX_CONCURRENT, 'SCHED_MAX_CONCURRENT', DEFAULT_MAX_CONCURRENT, 1, 10, console.log);
  const MAX_LATE_MS = maxLateMs ?? intSetting(process.env.SCHED_MAX_LATE_MS, 'SCHED_MAX_LATE_MS', DEFAULT_MAX_LATE_MS, 60_000, 86_400_000, console.log);
  const ONE_SHOT_MAX_MS = oneShotCatchupMaxMs ?? ONE_SHOT_CATCHUP_MAX_MS;

  // ---- 状态：盘上 + 本进程内存表（写不进去的记录）----
  const memState = {};
  let stateBroken = false;
  const readDisk = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return {};
    }
  };
  // 内存优先：写不进去的那一次触发，下一拍仍然看得到
  const loadState = () => ({ ...readDisk(), ...memState });
  const saveState = (s) => {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, stateFile);
      return null;
    } catch (e) {
      return e ?? new Error('unknown');
    }
  };
  const flushed = () => {
    for (const k of Object.keys(memState)) delete memState[k];
    stateBroken = false; // 恢复可写：再坏会再通知一次
  };
  const failedWrite = (err) => {
    if (stateBroken) return;
    stateBroken = true;
    console.error('[sched] 状态写入失败:', err?.message ?? err);
    void noticeNow(
      `⚠️ 定时任务状态文件写不进去（${plain(err?.code ?? err?.message ?? 'unknown', 40)}；目录 ${path.dirname(stateFile)}）。` +
      '本进程内不会重跑同一次触发；重启后可能补跑或重跑最近一次。请检查磁盘空间与目录权限。',
    );
  };

  // 每次只改自己那个 key 再落盘，绝不整份覆盖：
  // onFire 是分钟级的，期间别的任务可能已经写过状态，用开局的旧快照全量覆盖会把它们抹掉
  const markFired = (file, iso, extra = {}) => {
    const cur = loadState();
    cur[file] = { at: iso, ...extra };
    const err = saveState(cur);
    if (err) {
      memState[file] = cur[file];
      failedWrite(err);
    } else {
      flushed();
    }
  };
  // 每拍顺手重试一次：盘恢复后内存里的记录写回去
  const flushMemState = () => {
    if (!Object.keys(memState).length) return;
    if (!saveState(loadState())) flushed();
  };

  // ---- 通知与日志去重 ----
  const noticeFile = stateFile.replace(/(\.json)?$/, '-notices.json');
  const notices = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(noticeFile, 'utf8'));
      // 确认记录作废过（密钥重建 / 验签不过）：通知去重记录从空开始，受闸的待确认任务首拍各重新通知一次
      return { days: { ...(j?.days ?? {}) }, files: { ...(j?.files ?? {}) }, approvals: approvals?.invalidated === true ? {} : { ...(j?.approvals ?? {}) } };
    } catch {
      return { days: {}, files: {}, approvals: {} };
    }
  })();
  const saveNotices = () => {
    try {
      const today = localDay();
      for (const k of Object.keys(notices.days)) if (notices.days[k] !== today) delete notices.days[k];
      fs.mkdirSync(path.dirname(noticeFile), { recursive: true });
      const tmp = `${noticeFile}.tmp`;
      // 没有受闸任务时与以前逐字节相同（不写 approvals 键）
      const out = Object.keys(notices.approvals).length ? notices : { days: notices.days, files: notices.files };
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      fs.renameSync(tmp, noticeFile);
    } catch { /* 写不进去：去重记录留在内存里 */ }
  };
  const noticeNow = async (text) => {
    if (!notifyOwner) return;
    try { await notifyOwner(text); } catch (e) { console.error('[sched] 通知 owner 失败:', e?.message ?? e); }
  };
  // 同一任务同一原因每个本地日最多一次（发送失败也算这一天用掉）
  const noticeOnce = async (key, text) => {
    if (!notifyOwner) return false;
    const day = localDay();
    if (notices.days[key] === day) return false;
    notices.days[key] = day;
    saveNotices();
    await noticeNow(text);
    return true;
  };
  // 同一拍里调度器自己产生的通知先收集，拍末合并成一条（去重在入批时判断，进了批就算用掉）
  let batch = [];
  const queueLine = (line) => { if (notifyOwner) batch.push(line); };
  const flushBatch = async () => {
    if (!batch.length) return;
    const items = batch;
    batch = [];
    if (items.length === 1) { await noticeNow(items[0]); return; }
    const shown = items.slice(0, NOTICE_BATCH_MAX).map((x) => `· ${x.replace(/^[⚠️⏰\s]+/u, '')}`);
    const more = items.length > NOTICE_BATCH_MAX ? [`另有 ${items.length - NOTICE_BATCH_MAX} 项`] : [];
    await noticeNow(`⚠️ 定时任务调度器有 ${items.length} 项需要你知道：\n${[...shown, ...more].join('\n')}`);
  };
  // 同一任务同一原因每个本地日最多一次，入本拍的合并批（发送失败也算这一天用掉）
  const batchOnce = (key, text) => {
    if (!notifyOwner) return false;
    const day = localDay();
    if (notices.days[key] === day) return false;
    notices.days[key] = day;
    saveNotices();
    queueLine(text);
    return true;
  };
  const loggedDay = new Map();
  const logOnceDaily = (key, fn) => {
    const day = localDay();
    if (loggedDay.get(key) === day) return;
    loggedDay.set(key, day);
    fn();
  };
  const loggedKeys = new Set();
  const report = (kind, f, info) => {
    if (kind === 'chat-id') {
      const key = `${f}|${info.hash}`;
      if (!loggedKeys.has(key)) {
        loggedKeys.add(key);
        console.error(`[sched] 任务 ${f} 的 chat_id 格式不对，已跳过`);
      }
      // 同一文件同一内容只通知一次（改了内容仍不对再通知一次），记录持久化
      if (notifyOwner && notices.files[f] !== info.hash) {
        notices.files[f] = info.hash;
        saveNotices();
        queueLine(`⚠️ 定时任务文件 ${plain(f, 60)} 的 chat_id 写法不对（要 oc_ 开头的飞书会话 id），这个任务不会执行。改好后自动生效。`);
      }
    } else if (kind === 'json') {
      logOnceDaily(`json|${f}|${info.message}`, () => console.error(`[sched] 任务文件解析失败 ${f}:`, info.message));
      batchOnce(`${f}|json`, `⚠️ 定时任务文件 ${plain(f, 60)} 不是合法的 JSON，这个任务不会执行。`);
    } else if (kind === 'action') {
      logOnceDaily(`action|${f}|${info.action}`, () => console.error(`[sched] 拒绝未知 action「${plain(info.action, 40)}」(${f})，已跳过`));
    }
  };

  // ---- 派发 ----
  const inflight = new Map(); // file → 这次任务的 promise；跨拍有效，到 done / failed 落盘后才删
  const firstPending = []; // 首拍（含启动补跑）派发出去的任务，whenIdle 等它们
  const waits = new Map(); // file → { dueIso, since }：因并发已满没派出去的起点（只在内存）
  const resumeQueue = new Map(); // file → { job, at }：等位中的启动补跑
  let stopped = false;
  let scanning = false;
  let firstDone = false;

  const ownerDm = (job) => {
    try { return turnFor?.('sched', job)?.private === true; } catch { return false; }
  };

  // BRIDGE-PRIV-2：受闸判定。不受闸返回 null（且不碰确认记录）；受闸返回 { state: pending|approved|rejected, at, hash, code, destUnknown }
  const gateOf = (job) => {
    if (!approvals) return null;
    let t = null;
    try { t = turnFor?.('sched', job) ?? null; } catch { t = null; } // 抛错按受闸处理
    if (!needsApproval(job, t?.private === true)) return null;
    const hash = approvalHash(job._file, job);
    const rec = approvals.lookup(job._file, hash);
    return { state: rec?.decision ?? 'pending', at: rec?.at ?? null, hash, code: approvalCode(job._file, hash), destUnknown: t?.destUnknown === true };
  };
  const announcedLog = new Set();
  let invalidatedSaid = false; // 作废提示整个进程只说一次，排在第一条待确认通知之前
  // 同一文件同一内容只通知一次（持久化），并进同一拍的合并通知；先记再发，发送失败也算用掉（/tasks 里仍看得到）
  const announce = (job, g) => {
    const file = job._file;
    const lk = `${file}|${g.hash}`;
    if (!announcedLog.has(lk)) {
      announcedLog.add(lk);
      console.log(`[sched] 「${nameOf(job)}」的结果要发往别处，等 owner 在私聊确认（${file}）`);
    }
    if (!notifyOwner || notices.approvals[file] === g.hash) return;
    if (cardMode && cardsThisTick >= MAX_CARDS_PER_TICK) return; // 本拍发卡已满：不记，留到下一拍
    notices.approvals[file] = g.hash;
    saveNotices();
    if (approvals?.invalidated === true && !invalidatedSaid) {
      invalidatedSaid = true;
      queueLine(mode === 'button'
        ? `⚠️ 定时任务的确认记录有 ${approvals.invalidCount} 条校验不通过（或签名密钥已重建），之前的确认 / 拒绝已作废。需要你重新确认的任务会各发一张确认卡。`
        : `⚠️ 定时任务的确认记录有 ${approvals.invalidCount} 条校验不通过（或签名密钥已重建），之前的确认 / 拒绝已作废。本条里带 ⏸ 的任务需要你重新确认：`);
    }
    if (cardMode) {
      cardsThisTick += 1;
      void issueCard(job, g);
      return;
    }
    queueLine(pendingNoticeText({ job, code: g.code, destUnknown: g.destUnknown }));
  };
  // 发确认卡；发不出去（返回非 true 或抛错）就退回文字通知。永不抛
  const issueCard = async (job, g) => {
    let ok = false;
    try { ok = (await sendApprovalCard({ file: job._file, hash: g.hash, job, destUnknown: g.destUnknown })) === true; } catch { ok = false; }
    if (!ok) await noticeNow(pendingNoticeText({ job, code: g.code, destUnknown: g.destUnknown, fallback: true }));
  };
  const approvalCandidates = () => {
    if (!approvals) return [];
    const out = [];
    for (const job of readJobs(schedulesDir)) {
      const g = gateOf(job);
      if (!g) continue;
      const p = parseWhen(job.when);
      out.push({
        file: job._file, name: job.name ?? job._file, code: g.code, hash: g.hash, state: g.state,
        announced: notices.approvals[job._file] === g.hash, destTail: String(job.chat_id).slice(-4), when: job.when,
        expired: p.kind === 'once' && p.at <= new Date(),
      });
    }
    return out;
  };

  // BRIDGE-PRIV-3：补发确认卡（owner 在 button 模式下发 /tasks approve、或点了失效的旧卡时）。同一文件 2 分钟内最多 1 张。
  // 返回 'sent' | 'recent' | 'gone'（不在 button 模式、任务不存在 / 不受闸 / 已确认）
  const resendLog = new Map(); // file → 上次补发的毫秒时间
  const resendApprovalCard = (fileOrCandidate) => {
    try {
      if (!cardMode) return 'gone';
      const file = typeof fileOrCandidate === 'string' ? fileOrCandidate : fileOrCandidate?.file;
      if (typeof file !== 'string' || !file) return 'gone';
      const job = readJobs(schedulesDir).find((j) => j._file === file);
      const g = job ? gateOf(job) : null;
      if (!job || !g || g.state === 'approved') return 'gone';
      const t = Date.now();
      const last = resendLog.get(file);
      if (last !== undefined && t - last < RESEND_MIN_MS) return 'recent';
      resendLog.set(file, t);
      if (notices.approvals[file] !== g.hash) { notices.approvals[file] = g.hash; saveNotices(); } // 这份内容已有卡，下一拍不再重复发
      void issueCard(job, g);
      return 'sent';
    } catch {
      return 'gone';
    }
  };

  const dispatch = (job, due, { lateMs = 0, lateOver = false, resumed = false } = {}) => {
    const file = job._file;
    const oneShot = parseWhen(job.when).kind === 'once';
    // 先占位防重复触发，跑完再落「已完成」；中途崩溃时留下 running 痕迹，下次启动按「被重启打断」处理
    markFired(file, due.toISOString(), { when: job.when, status: 'running', ...(resumed ? { resumed: true } : {}) });
    const lateNote = lateMs > 5 * 60_000 ? `（迟到补跑 ${Math.round(lateMs / 60000)} 分钟）` : '';
    console.log(`[sched] ${resumed ? '重启后补跑' : '触发'}「${nameOf(job)}」(${fmtLocal(due)})${lateNote}`);
    const payload = {
      ...job,
      _late: lateMs > 5 * 60_000 ? lateMs : 0,
      ...(lateOver ? { _late: lateMs, _lateOver: true } : {}),
      ...(resumed ? { _resumed: true } : {}),
    };
    const ctx = { notifyOnce: (reason, text) => noticeOnce(`${file}|${reason}`, text), sendKey: schedSendKey(file, due.toISOString(), resumed, `${job.chat_id ?? ''}\n${job.when ?? ''}`) };
    const runOne = (async () => {
      let endStatus = 'done';
      try {
        await onFire(payload, ctx);
        markFired(file, due.toISOString(), { when: job.when, status: 'done' });
      } catch (e) {
        endStatus = 'failed';
        console.error(`[sched] 执行失败 ${file}:`, e?.message ?? e);
        markFired(file, due.toISOString(), { when: job.when, status: 'failed' });
      } finally {
        // 一次性任务跑完即停用，避免重复
        if (oneShot) {
          try {
            const fp = path.join(schedulesDir, file);
            const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
            raw.enabled = false;
            raw.last_run = due.toISOString();
            const tmp = `${fp}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
            fs.renameSync(tmp, fp);
          } catch (e) {
            console.error('[sched] 停用一次性任务失败:', e?.message ?? e);
          }
        }
        console.log(`[sched] 「${nameOf(job)}」结束（${endStatus}）`);
        inflight.delete(file); // 最后才减：发送阶段、自诊断、重试等待都算「进行中」
      }
    })();
    inflight.set(file, runOne);
    if (!firstDone) firstPending.push(runOne);
  };

  // ---- 启动：上次被重启打断的 running ----
  const interrupt = (file, rec, job, why) => {
    markFired(file, rec.at, { when: rec.when, status: 'interrupted' });
    const at = new Date(rec.at);
    console.log(`[sched] 「${nameOf(job ?? { _file: file })}」上次执行被重启打断，不补跑：${why}`);
    batchOnce(
      `${file}|interrupted`,
      `⚠️ 定时任务「${nameOf(job ?? { _file: file })}」原定 ${isNaN(at) ? '（时间未知）' : fmtLocal(at)} 的这次执行被桥接重启打断了，没有补跑（${why}）。需要的话请手动再跑一次。`,
    );
  };
  const recover = () => {
    const running = Object.entries(loadState()).filter(([, r]) => r && typeof r === 'object' && r.status === 'running');
    if (!running.length) return;
    const jobs = new Map(readJobs(schedulesDir, report).map((j) => [j._file, j]));
    for (const [file, rec] of running) {
      const job = jobs.get(file);
      const at = new Date(rec.at);
      let why = null;
      if (rec.resumed) why = '补跑时又被打断，只补一次';
      else if (!job) why = '任务文件已不在或已停用';
      else if (rec.when !== job.when) why = '触发时间已改';
      else if (!isPromptJob(job)) why = '不是 prompt 型任务';
      else if (!ownerDm(job)) why = '结果不是发往 owner 私聊，补跑会把结果再发一遍';
      else if (isNaN(at) || Date.now() - at.getTime() > MAX_LATE_MS) why = '已超过补跑窗口';
      if (why) interrupt(file, rec, job, why);
      else resumeQueue.set(file, { job, at });
    }
  };
  const drainResume = () => {
    for (const [file, { job, at }] of [...resumeQueue]) {
      if (stopped) return;
      if (inflight.has(file)) { resumeQueue.delete(file); continue; }
      if (Date.now() - at.getTime() > MAX_LATE_MS) {
        resumeQueue.delete(file);
        interrupt(file, { at: at.toISOString(), when: job.when }, job, '等并发名额等过了补跑窗口');
        continue;
      }
      if (inflight.size >= MAX_CONCURRENT) continue;
      resumeQueue.delete(file);
      dispatch(job, at, { resumed: true });
    }
  };

  // ---- 扫描：只扫描、派发，不等任务跑完 ----
  const tick = () => {
    if (scanning || stopped) return; // 仅防止扫描本身重入；执行是异步的
    cardsThisTick = 0; // BRIDGE-PRIV-3：每拍最多发 5 张确认卡
    scanning = true;
    try {
      flushMemState();
      drainResume();
      const now = new Date();
      const s = loadState();
      for (const job of readJobs(schedulesDir, report)) {
        if (stopped) break;
        const file = job._file;
        if (inflight.has(file)) continue; // 上一轮还没跑完
        const g = gateOf(job);
        if (g && g.state !== 'approved') { if (g.state === 'pending') announce(job, g); continue; }
        const { due, once, bad } = lastDueAt(job, now);
        if (bad) {
          logOnceDaily(`when|${file}|${bad}`, () => console.error(`[sched] 无效的 when（${nameOf(job)}，${file}）：${bad}`));
          batchOnce(`${file}|when`, `⚠️ 定时任务「${nameOf(job)}」的 when 写法有问题：${bad}。这个任务到点不会触发。`);
          continue;
        }
        if (!due) continue;
        // 状态里连 when 一起记：改了触发时间就重新登记基线，
        // 否则编辑任务的那一刻会立刻补跑上一个时间点（"改期即补跑"）
        const rec = s[file];
        const prev = typeof rec === 'string' ? { at: rec, when: job.when } : (rec ?? null);
        const seen = prev !== null && prev.when === job.when;
        const last = seen && prev.at ? new Date(prev.at) : null;

        // cron 任务首次被发现时只记基线、不补跑历史时间点
        // （否则中午建的「每天 9 点」会立刻触发一次）
        if (!seen && !once) {
          markFired(file, due.toISOString(), { when: job.when, status: 'baseline' });
          console.log(`[sched] 已登记「${nameOf(job)}」(${job.when})，下次到点触发`);
          continue;
        }
        if (last && due <= last) continue; // 这一次已经跑过
        if (g && g.at && due < new Date(g.at)) {
          markFired(file, due.toISOString(), { when: job.when, status: once ? 'skipped-pending' : 'baseline' });
          continue;
        }

        // 迟到太久：cron 任务与 action 型任务放弃（关机一夜后醒来不该把昨天的任务、过期的模型切换倒着补一遍）；
        // 一次性 prompt 任务（提醒）补发一次，结果标题注明迟到多久——但迟到超过 ONE_SHOT_MAX_MS 的也放弃
        const lateMs = Date.now() - due.getTime();
        const lateOver = lateMs > MAX_LATE_MS;
        const capped = once && isPromptJob(job) && lateMs > ONE_SHOT_MAX_MS;
        if (lateOver && (!(once && isPromptJob(job)) || capped)) {
          markFired(file, due.toISOString(), { when: job.when, status: 'skipped-late' });
          console.log(
            `[sched] 跳过「${nameOf(job)}」：应于 ${fmtLocal(due)} 触发，已迟到 ${Math.round(lateMs / 60000)} 分钟（超过 ${Math.round(MAX_LATE_MS / 60000)} 分钟窗口）`
          );
          batchOnce(
            `${file}|late`,
            capped
              ? `⏰ 定时任务「${nameOf(job)}」原定 ${fmtLocal(due)} 触发，已迟到超过 ${Math.round(ONE_SHOT_MAX_MS / 3_600_000)} 小时，不再补发，这次已跳过。`
              : `⏰ 定时任务「${nameOf(job)}」原定 ${fmtLocal(due)} 触发，迟到了 ${Math.round(lateMs / 60000)} 分钟，超过 ${Math.round(MAX_LATE_MS / 60000)} 分钟的补跑窗口，这次已跳过。`,
          );
          continue;
        }

        // 并发已满：什么都不写，原样留给下一拍。并发检查必须在占位之前——旧实现先写 running
        // 再检查，被挡下的这次触发在下一拍会因 due <= last 被当成「已经跑过」，永久丢失，
        // 状态还一直停在 running（BRIDGE-HB-1 第 9 项）。
        if (inflight.size >= MAX_CONCURRENT) {
          const dueIso = due.toISOString();
          let w = waits.get(file);
          const startedWaiting = !w || w.dueIso !== dueIso;
          if (startedWaiting) { w = { dueIso, since: Date.now() }; waits.set(file, w); }
          if (Date.now() - w.since > MAX_LATE_MS) {
            waits.delete(file);
            markFired(file, dueIso, { when: job.when, status: 'skipped-busy' });
            console.log(`[sched] 跳过「${nameOf(job)}」：并发已满，等了超过 ${Math.round(MAX_LATE_MS / 60000)} 分钟仍没排上`);
            batchOnce(
              `${file}|busy`,
              `⏰ 定时任务「${nameOf(job)}」原定 ${fmtLocal(due)} 触发，并发名额一直被占着，等了超过 ${Math.round(MAX_LATE_MS / 60000)} 分钟仍没排上，这次已跳过。`,
            );
            continue;
          }
          // 同一次等位只记开始那一拍，免得每 30 秒一行
          if (startedWaiting) console.log(`[sched] 并发已满（${MAX_CONCURRENT}），「${nameOf(job)}」下一轮再试`);
          continue;
        }
        waits.delete(file);
        dispatch(job, due, { lateMs, lateOver });
      }
    } finally {
      scanning = false;
    }
  };

  const safeTick = () => {
    try { tick(); } catch (e) { console.error('[sched]', e); }
    void flushBatch();
  };
  const timer = setInterval(safeTick, TICK_MS);
  // 启动恢复与首拍扫描算同一拍：通知攒到首拍末一起发
  try { recover(); drainResume(); } catch (e) { console.error('[sched]', e); }
  try { tick(); } catch (e) { console.error('[sched]', e); }
  void flushBatch();
  firstDone = true;
  const first = Promise.allSettled(firstPending).then(() => {});
  console.log(`定时任务调度器已启动（每 ${TICK_MS / 1000}s 检查一次）：${schedulesDir}`);
  return {
    // 停定时器并置停止标志：之后不再派发任何任务（含启动补跑与等位中的）；已在跑的不打断
    stop: () => { stopped = true; clearInterval(timer); },
    whenIdle: () => first, // 首拍扫描与首拍（含启动补跑）派发出去的任务都结束
    idle: async () => { while (inflight.size) await Promise.allSettled([...inflight.values()]); }, // 当前所有在跑的任务结束
    inflightCount: () => inflight.size,
    approvalOf: gateOf,
    approvalCandidates,
    approvalStore: approvals,
    approvalMode: mode,
    resendApprovalCard,
  };
}
