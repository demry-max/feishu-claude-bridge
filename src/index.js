import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { runClaude, checkCliEnvironment, resetSession, abortRetries, sessionKeysWithPrefix, runningKeysWithPrefix, sessionInfo, WORKSPACE_DIR, GUEST_WORKSPACE_DIR, workspaceFor, outboxDirFor, cancelRun, isRunning, getRuntimeConfig, setRuntimeConfig, MODEL_ALIASES, EFFORT_LEVELS, consumeMemoryNudge, shouldRecycleSession } from './claude.js';
import { buildPrompt, cleanIncoming, describeError } from './messages.js';
import { loadOwner, saveOwner, DATA_DIR } from './store.js';
import { startScheduler } from './scheduler.js';
import { CronExpressionParser } from 'cron-parser';
import { createProgressChannel, flushOutbox, migrateLegacyOutbox, resolveSenderName, redact, sendVoice } from './outbound.js';
import { recallHint } from './memory-recall.js';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;

if (!APP_ID || !APP_SECRET) {
  console.error('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，请检查 .env');
  process.exit(1);
}

// FEISHU_DOMAIN=lark 时接入国际版 Lark（open.larksuite.com）
const DOMAIN = process.env.FEISHU_DOMAIN === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

const client = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET, domain: DOMAIN });

// 长连接终局处理：SDK 的重连预算耗尽（或遇到不可重试的错误码）后会彻底放弃，
// 此时进程还活着、调度器还在跑、launchd 认为一切正常，但机器人对所有消息永久失聪。
// 唯一可靠的信号是主动退出——交给 launchd KeepAlive 拉起，重连即恢复。
const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: DOMAIN,
  loggerLevel: lark.LoggerLevel.info,
  wsConfig: { pingTimeout: Number(process.env.WS_PING_TIMEOUT_SEC) > 0 ? Number(process.env.WS_PING_TIMEOUT_SEC) : 30 },
  onError: (e) => {
    // 加 15 秒阻尼：持续性故障时避免与 launchd 形成高频重启风暴
    bailOut(`长连接进入终止状态，退出交由 launchd 重启: ${e?.message ?? e}`, 15_000);
  },
  onReconnecting: (n) => console.log(`[ws] 重连中（第 ${n ?? '?'} 次）`),
  onReconnected: () => console.log('[ws] 已重连'),
});

// 兜底巡检：万一 SDK 未回调 onError（版本差异），仍能自愈
setInterval(() => {
  try {
    const st = wsClient.getConnectionStatus?.();
    const state = typeof st === 'string' ? st : st?.state; // SDK 返回的是对象，早先直接比字符串是死代码
    if (state === 'failed') {
      bailOut(`巡检发现连接状态=${state}，退出交由 launchd 重启`, 15_000);
    }
  } catch { /* 该 SDK 版本没有此方法则忽略 */ }
}, 60_000).unref();

// 退出前先给正在跑的子进程一点收尾时间，并对连环重启加阻尼：
// 裸 exit(1) 配 launchd ThrottleInterval=10，遇到持续性故障就是每天 8640 次重启
// 外加 8640 条飞书推送——比原来的「静默失聪」更糟。
const BAIL_COUNT_FILE = path.join(DATA_DIR, 'bail-count.json');
const BACKOFF_LADDER = [15_000, 60_000, 300_000, 900_000]; // 15s → 1m → 5m → 15m
const startedAt = Date.now();

// 连续失败次数跨重启累积：固定阻尼挡不住持续性故障，
// 进程一起来就再死会形成稳定的高频重启 + 推送风暴
function readBailCount() {
  try {
    const d = JSON.parse(fs.readFileSync(BAIL_COUNT_FILE, 'utf8'));
    return Number(d?.n) || 0;
  } catch { return 0; }
}
function bumpBailCount() {
  const n = readBailCount() + 1;
  try { fs.writeFileSync(BAIL_COUNT_FILE, JSON.stringify({ n, at: Date.now() })); } catch {}
  return n;
}
// 稳定运行足够久即认为已恢复，清零阶梯
setTimeout(() => {
  try { fs.rmSync(BAIL_COUNT_FILE, { force: true }); } catch {}
}, 5 * 60 * 1000).unref();

let exiting = false;
function bailOut(reason, delayMs = 0) {
  if (exiting) return;
  exiting = true;
  // 起来没多久就又要死＝持续故障，按阶梯拉长等待
  const n = Date.now() - startedAt < 5 * 60 * 1000 ? bumpBailCount() : 1;
  const wait = Math.max(delayMs, BACKOFF_LADDER[Math.min(n - 1, BACKOFF_LADDER.length - 1)]);
  console.error(`[exit] ${reason}（第 ${n} 次连续失败，${Math.round(wait / 1000)}s 后退出）`);
  setTimeout(() => process.exit(1), wait).unref();
}

// 进程级兜底：宁可重启，也不要带病静默运行（事件回调里的异常会直冲 uncaughtException）
process.on('uncaughtException', (e) => {
  console.error('[fatal] uncaughtException:', e?.stack ?? e);
  bailOut('uncaughtException', 2000);
});
process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandledRejection:', e?.stack ?? e);
});

// ---- 访问控制：留空=保持原行为（全员可私聊）；配置后仅名单内可用 ----
const parseList = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW_USERS = parseList(process.env.ALLOW_USERS); // open_id 白名单
const ALLOW_CHATS = parseList(process.env.ALLOW_CHATS); // chat_id 白名单（群）
// owner 身份的权威来源：配了它，owner.json 丢失/损坏也能直接恢复，无需认领流程
const OWNER_OPEN_ID = (process.env.OWNER_OPEN_ID ?? '').trim();
const voiceChats = new Set(); // 开启语音回复的会话

function isAllowed(openId, chatId, isP2p) {
  if (isP2p) return ALLOW_USERS.length === 0 || ALLOW_USERS.includes(openId);
  if (ALLOW_CHATS.length && !ALLOW_CHATS.includes(chatId)) return false;
  return ALLOW_USERS.length === 0 || ALLOW_USERS.includes(openId);
}

const HELP_TEXT = [
  '**可用指令**',
  '- `/new` 开启全新会话（忘掉此前上下文）',
  '- `/status` 查看会话、模型、思考深度、可用工具',
  '- `/help` 显示本说明',
  '- `/cancel` 取消正在跑的任务',
  '- `/redirect <新要求>` 中断当前任务并按新要求重来',
  '- `/voice` 切换语音回复（回答附带一条语音）',
  '- `/model [模型] [思考档]` 查看或切换模型，如 `/model fable high`（仅 owner）',
  '- `/tasks` 查看定时任务：上次/下次触发时间（仅 owner）',
  '',
  '**能做什么**',
  '- 直接对话；群里 @我 即可',
  '- 发图片 / 文件 / 语音，我会读内容后回答',
  '- 说「记住…」我会写进长期记忆，跨会话生效',
  '- 说「存成技能」我会把流程固化下来，以后自动遵循',
  '- 说「每天八点提醒我…」我会自己排定时任务',
].join('\n');

// ---- 消息去重（飞书事件可能重投） ----
const seen = new Set();
function isDuplicate(messageId) {
  if (seen.has(messageId)) return true;
  seen.add(messageId);
  if (seen.size > 1000) {
    for (const id of seen) {
      seen.delete(id);
      if (seen.size <= 500) break;
    }
  }
  return false;
}

// ---- 每个会话串行处理，避免并发 resume 冲突 ----
const chatQueues = new Map();
function enqueue(chatId, task) {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(task).catch((e) => console.error('[queue]', e));
  chatQueues.set(chatId, next);
  return next;
}

async function reply(messageId, text) {
  const safe = redact(text);
  const chunks = [];
  for (let i = 0; i < safe.length; i += 20000) chunks.push(safe.slice(i, i + 20000));
  for (const chunk of chunks) {
    try {
      await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify({
            config: { wide_screen_mode: true },
            elements: [{ tag: 'markdown', content: chunk }],
          }),
        },
      });
    } catch (e) {
      // markdown 卡片失败时降级纯文本
      console.error('[reply] card failed, fallback to text:', e?.message ?? e);
      await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text: chunk }) },
      });
    }
  }
}

async function react(messageId, emoji) {
  try {
    await client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    });
  } catch {
    // 无 reaction 权限时静默跳过
  }
}

// ---- 机器人自身 open_id（用于识别群聊 @提及） ----
let botOpenId = null;
async function getBotOpenId() {
  if (botOpenId) return botOpenId;
  try {
    const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    botOpenId = res?.bot?.open_id ?? null;
    if (botOpenId) console.log(`[bot] open_id = ${botOpenId}`);
  } catch (e) {
    console.error('[bot] 获取机器人信息失败:', e?.message ?? e);
  }
  return botOpenId;
}

async function handleMessage(data) {
  const message = data.message;
  const senderOpenId = data.sender?.sender_id?.open_id;
  if (!message || !senderOpenId) return;
  if (isDuplicate(message.message_id)) return;

  // 群聊仅在 @机器人 时响应
  if (message.chat_type !== 'p2p') {
    const bot = await getBotOpenId();
    const mentioned = (message.mentions ?? []).some(
      (m) => m?.id?.open_id && m.id.open_id === bot
    );
    if (!mentioned) return;
  }

  if (!isAllowed(senderOpenId, message.chat_id, message.chat_type === 'p2p')) {
    console.log(`[deny] ${senderOpenId} @ ${message.chat_id} 不在白名单`);
    return;
  }

  // ---- owner：首个私聊者自动认领，owner 享有本机工具，其他人仅联网工具 ----
  let owner = OWNER_OPEN_ID || loadOwner();
  if (!owner && message.chat_type === 'p2p') {
    // 收紧自动认领：owner.json 一旦丢失（盘故障、误删、恢复到旧备份），
    // 下一个私聊机器人的人就会继承全量本机工具与全部私有记忆。
    // 配了 ALLOW_USERS 时只认名单内的人；没配则要求显式开启一次性认领。
    // ALLOW_USERS 是「谁能用这个机器人」，不是「谁有资格当 owner」——
    // 两者混用会让名单内的同事在 owner.json 丢失时静默继承全部权限
    if (ALLOW_USERS.length && !ALLOW_USERS.includes(senderOpenId)) {
      console.error(`[owner] 拒绝认领：${senderOpenId} 不在 ALLOW_USERS 名单内`);
      await reply(message.message_id, '本机器人尚未完成初始化，请联系管理员。');
      return;
    }
    // 走到这里说明没配 OWNER_OPEN_ID（配了的话 owner 恒有值，压根进不来）
    if (process.env.ALLOW_OWNER_CLAIM !== 'true') {
      console.error(
        `[owner] owner.json 缺失且未开放认领。若确需重新认领，请在 .env 设 ALLOW_OWNER_CLAIM=true 后重启；` +
          `更稳妥的做法是把 owner 的 open_id 写进 ALLOW_USERS。当前请求者：${senderOpenId}`
      );
      await reply(message.message_id, '⚠️ 机器人的 owner 记录缺失，出于安全未自动认领。请在主机上恢复 `data/owner.json` 或按日志提示配置后重启。');
      return;
    }
    owner = senderOpenId;
    if (!saveOwner(owner)) {
      // 写盘失败却回复「已登记」，会让真正的 owner 在此后每条消息里被降级成访客
      await reply(message.message_id, '⚠️ owner 记录写入失败（磁盘不可写），未完成登记。请检查主机磁盘后重试。');
      return;
    }
    console.log(`[owner] 已锁定 owner open_id = ${owner}`);
    await reply(
      message.message_id,
      `✅ 已将你登记为本机器人 owner（open_id: \`${owner}\`）。\n直接发消息即可对话；发送 **/new** 开启新会话，**/status** 查看会话状态。`
    );
    return;
  }
  const isOwner = senderOpenId === owner;

  // 会话键必须区分身份：群里 owner 与访客共用一个 chat_id，但现在两者的 cwd 不同
  // （workspace vs workspace-guest）。若共用同一个 session，访客一次 --resume 就能
  // 恢复出 owner 那条带私有记忆的会话历史——工作区隔离会被整个绕过。
  const sessionKey = isOwner
    ? message.chat_id
    // 再按发言人细分：同一个群里访客 A 的历史不该出现在访客 B 的上下文里，
    // 也避免任一访客往共用会话里植入长效指令
    : `guest:${message.chat_id}:${senderOpenId}`;

  // ---- 消息 → 提示词（文本/图片/文件/富文本/合并转发/卡片） ----
  // 附件落在各自工作区：非 owner 的文件不该出现在 owner 的工作区里，反之亦然
  const myWorkspace = workspaceFor(isOwner);
  let built;
  try {
    built = await buildPrompt(client, message, myWorkspace, senderOpenId);
  } catch (e) {
    console.error('[buildPrompt]', e);
    // 别把所有失败都说成权限问题：飞书 SDK 的 AxiosError 常常 message 为空，
    // 早先的提示会渲染成「处理该消息失败：」后面一片空白，还附带一句误导性的权限建议
    const d = describeError(e);
    await reply(
      message.message_id,
      `⚠️ 处理该消息失败：${d.text}${d.hint ? `\n${d.hint}` : ''}`
    );
    return;
  }
  if (built.unsupported) {
    await reply(message.message_id, built.unsupported);
    return;
  }
  const text = built.prompt?.trim();
  if (!text) return;

  // ---- 内置命令 ----
  // 会话生命周期类命令会影响整个会话（群里是大家共用的），限 owner 使用，
  // 否则任意群成员都能把 owner 正在跑的任务掐掉、或清空群会话上下文
  const LIFECYCLE_CMDS = ['/new', '/cancel', '取消', '/voice', '/voice on', '/voice off', '/tasks'];
  const isLifecycle = LIFECYCLE_CMDS.includes(text) || text.startsWith('/redirect');
  if (isLifecycle && !isOwner && message.chat_type !== 'p2p') {
    await reply(message.message_id, '群会话里只有 owner 能使用会话控制指令（可以私聊我使用）。');
    return;
  }

  if (text === '/new') {
    resetSession(sessionKey);
    if (isRunning(sessionKey)) { cancelRun(sessionKey); abortRetries(sessionKey); } // 否则旧任务收尾时会把会话写回来
    // 群里 owner 的 /new 一并清掉访客那条共用会话（访客自己在群里无权重置）
    if (isOwner && message.chat_type !== 'p2p') {
      for (const k of sessionKeysWithPrefix(`guest:${message.chat_id}:`)) {
        resetSession(k);
        if (isRunning(k)) cancelRun(k);
      }
    }
    await reply(message.message_id, '🆕 已重置，下一条消息将开启全新 Claude 会话。');
    return;
  }
  if (text === '/tasks') {
    if (!isOwner) {
      await reply(message.message_id, '只有 owner 可以查看定时任务。');
      return;
    }
    await reply(message.message_id, describeTasks());
    return;
  }
  if (text === '/status') {
    await reply(message.message_id, sessionInfo(sessionKey, isOwner));
    return;
  }
  if (text === '/help' || text === '帮助') {
    await reply(message.message_id, HELP_TEXT);
    return;
  }
  if (text === '/model' || text.startsWith('/model ')) {
    if (!isOwner) {
      await reply(message.message_id, '只有 owner 可以切换模型。');
      return;
    }
    const args = text.slice('/model'.length).trim().split(/\s+/).filter(Boolean);
    const cur = getRuntimeConfig();
    if (!args.length) {
      await reply(
        message.message_id,
        [
          `**当前模型**：\`${cur.model || '（CLI 默认）'}\``,
          `**思考深度**：\`${cur.effort || '（CLI 默认）'}\``,
          '',
          `用法：\`/model <模型> [思考档]\`，例如 \`/model fable high\``,
          `可用简称：${Object.keys(MODEL_ALIASES).join(' / ')}（也可写完整模型名）`,
          `思考档：${EFFORT_LEVELS.join(' / ')}`,
        ].join('\n')
      );
      return;
    }
    try {
      // 第一个参数若是思考档，则只改档位
      const first = args[0].toLowerCase();
      if (!EFFORT_LEVELS.includes(first)) {
        // 切换前先确认本机 CLI 跑得动这个模型，否则会切成功、然后每条消息都失败
        const resolved = MODEL_ALIASES[first] ?? args[0];
        const pre = checkCliEnvironment(resolved);
        if (pre.problem) {
          await reply(message.message_id, `⚠️ 未切换：${pre.problem}`);
          return;
        }
      }
      const next = EFFORT_LEVELS.includes(first)
        ? setRuntimeConfig({ effort: first })
        : setRuntimeConfig({ model: args[0], effort: args[1] });
      await reply(
        message.message_id,
        `✅ 已切换：模型 \`${next.model || 'CLI 默认'}\`，思考深度 \`${next.effort || 'CLI 默认'}\`\n下一条消息即生效（无需重启）。`
      );
    } catch (e) {
      await reply(message.message_id, `⚠️ ${e?.message ?? e}`);
    }
    return;
  }
  if (text === '/cancel' || text === '取消') {
    // 群里 owner 还要能停掉访客跑飞的任务（它们注册在 guest: 键下）
    let killed = cancelRun(sessionKey);
    // 退避等待中没有活着的子进程，但重试仍会发生——必须一并叫停
    if (abortRetries(sessionKey)) killed = true;
    if (isOwner && message.chat_type !== 'p2p') {
      for (const k of runningKeysWithPrefix(`guest:${message.chat_id}:`)) {
        killed = cancelRun(k) || killed;
      }
    }
    await reply(message.message_id, killed ? '🛑 已取消当前任务。' : '当前没有正在运行的任务。');
    return;
  }
  if (text === '/voice' || text === '/voice on' || text === '/voice off') {
    // 显式开关不做切换：以前 `/voice on` 在已开启时会把语音关掉，与字面意思相反
    const on =
      text === '/voice on' ? true
      : text === '/voice off' ? false
      : !voiceChats.has(message.chat_id);
    if (on) voiceChats.add(message.chat_id); else voiceChats.delete(message.chat_id);
    await reply(message.message_id, on ? '🔊 已开启语音回复（回答会附一条语音）。发 /voice off 关闭。' : '🔇 已关闭语音回复。');
    return;
  }
  // 任务进行中收到新指令：提示可取消/重定向
  if (isRunning(sessionKey) && !text.startsWith('/redirect')) {
    await reply(message.message_id, '⏳ 上一个任务还在跑。发 **/cancel** 取消，或 **/redirect 你的新要求** 取消并按新要求重来（会话上下文保留）。');
    return;
  }
  // 附件存放于 workspace/incoming/，即使非 owner 也放行该目录的只读访问
  const extraTools = built.attachments.length ? ['Read(./incoming/**)'] : [];
  // 注意：prompt 必须在 /redirect 分支之前声明。此前它声明在分支之后，
  // 导致 /redirect 每次都命中 TDZ（ReferenceError）——而且是在 cancelRun 之后崩，
  // 于是旧任务被杀、新要求从不执行、用户端毫无反馈。该命令自 v1.3.0 起从未成功过。
  let prompt = text;

  if (text.startsWith('/redirect')) {
    const extra = text.replace(/^\/redirect\s*/, '').trim();
    if (!extra) {
      await reply(message.message_id, '用法：/redirect 你的新要求');
      return;
    }
    cancelRun(sessionKey);
    abortRetries(sessionKey); // 退避等待中没有子进程，但重试仍会发生
    prompt = extra; // 会话通过 --resume 保留，直接以新要求继续
  }

  // 群聊带上发言人姓名，机器人才知道是谁在说话。
  // 注意用 prompt 而不是 text——否则 /redirect 刚设好的新要求会被这里覆盖掉
  if (message.chat_type !== 'p2p') {
    const name = await resolveSenderName(client, senderOpenId);
    if (name) prompt = `[群成员 ${name}]：${prompt}`;
  }

  // 记忆自动召回：把可能相关的记忆文件路径提示给模型（只有 owner 有 memory/）
  if (isOwner) {
    const hint = recallHint(WORKSPACE_DIR, text);
    if (hint) prompt += `\n${hint}`;
  }

  // 上一轮已按提醒固化过记忆，这一轮开始前重开会话：
  // 该留的都进了 memory/，继续背着上百万 token 的历史只是在重复付钱
  if (isOwner && shouldRecycleSession(sessionKey)) {
    resetSession(sessionKey);
    console.log(`[context] ${sessionKey} 记忆已固化，重开会话以回收上下文`);
  }

  // 上下文接近压缩点：提醒机器人先固化记忆（仅 owner——只有 owner 有 memory 写权限）
  if (isOwner && consumeMemoryNudge(sessionKey)) {
    prompt +=
      '\n\n（系统提示：本会话上下文接近上限，即将被自动压缩。压缩只影响对话历史，不影响 memory/ 文件。' +
      '请先检查这段对话里有哪些值得长期保留的事实、决定、偏好还没写进 memory/——稳定偏好就地合入 USER.md，长期事实建独立文件并更新 MEMORY.md 索引，过程细节追加进 memory/journal/ 当日文件；' +
      '没有就忽略本提示，正常回答用户的问题。不要因为这条提示改变回答的语气或结构。）';
    console.log(`[context] 已向 ${message.chat_id} 注入固化记忆提醒`);
  }

  enqueue(sessionKey, async () => {
    console.log(`[msg] ${isOwner ? 'owner' : senderOpenId} @ ${message.chat_type} [${message.message_type}]: ${text.slice(0, 80)}`);
    await react(message.message_id, 'OnIt');
    const progress = createProgressChannel(client, message.message_id);
    try {
      const answer = await runClaude(sessionKey, prompt, isOwner, extraTools, progress.update);
      await progress.finish();
      await reply(message.message_id, answer || '（Claude 返回了空回复）');
      // 机器人写进本轮专属 outbox 的图片/文件随本轮一起回传
      await flushOutbox(client, outboxDirFor(sessionKey, isOwner), (data) =>
        client.im.v1.message.reply({ path: { message_id: message.message_id }, data })
      );
      if (voiceChats.has(message.chat_id) && answer) {
        await sendVoice(client, answer, (data) =>
          client.im.v1.message.reply({ path: { message_id: message.message_id }, data })
        );
      }
      await react(message.message_id, 'DONE');
    } catch (e) {
      // 无论取消还是失败，都要把进度卡收尾，否则它永远停在「🔄 处理中」
      await progress.finish(e?.cancelled ? 'cancelled' : 'failed').catch(() => {});
      // 失败轮里模型可能已经写了文件；不清掉会挂到下一次成功回答上一起发出
      await flushOutbox(client, outboxDirFor(sessionKey, isOwner), (data) =>
        client.im.v1.message.reply({ path: { message_id: message.message_id }, data })
      ).catch(() => {});
      if (e?.cancelled) return; // /cancel 主动终止，不报错
      console.error('[claude]', e);
      const msg = String(e.message ?? e);
      if (msg.includes('401') || /re-?authenticate/i.test(msg)) {
        await reply(
          message.message_id,
          '⚠️ Mac 上的 Claude 登录已过期。请在 Mac 终端运行 `claude /login` 重新登录后再试。'
        );
      } else {
        await reply(message.message_id, `⚠️ Claude 调用失败：${msg}`);
      }
    }
  });
}

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': handleMessage,
});

// ---- 定时任务：到点跑 Claude，把结果主动发到指定会话 ----
async function sendToChat(chatId, text) {
  const body = (data) =>
    client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, ...data } });
  const chunk = redact(text).slice(0, 20000);
  try {
    await body({
      msg_type: 'interactive',
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        elements: [{ tag: 'markdown', content: chunk }],
      }),
    });
  } catch (e) {
    console.error('[sched] 卡片发送失败，降级纯文本:', e?.message ?? e);
    await body({ msg_type: 'text', content: JSON.stringify({ text: chunk }) });
  }
}

const SCHEDULES_DIR = path.join(WORKSPACE_DIR, 'schedules');
const SCHED_STATE_FILE = path.join(DATA_DIR, 'schedule-state.json');

// 下次触发时间：/help 承诺了「上次/下次」，此前只实现了上次
function nextFireAt(job) {
  if (job.enabled === false) return null;
  const when = String(job.when ?? '').trim();
  if (!when) return null;
  try {
    if (!when.startsWith('@') && !when.includes(' ')) {
      // 纯日期（2026-09-01）会被按 UTC 解析，补上时间部分强制走本地时区
      const norm = /^\d{4}-\d{2}-\d{2}$/.test(when) ? `${when}T00:00` : when;
      const t = new Date(norm); // 一次性任务，本地时区
      return !isNaN(t) && t > new Date() ? t : null;
    }
    return CronExpressionParser.parse(when, { currentDate: new Date() }).next().toDate();
  } catch {
    return null;
  }
}

// /tasks：直读任务定义与触发状态，让 owner 随时能确认「它到底还在不在替我干活」
function describeTasks() {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(SCHED_STATE_FILE, 'utf8')); } catch { /* 尚未产生状态 */ }
  try {
    const files = fs.existsSync(SCHEDULES_DIR)
      ? fs.readdirSync(SCHEDULES_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('._'))
      : [];
    if (!files.length) return '当前没有定时任务。';
    const lines = ['**定时任务**', ''];
    for (const f of files.sort()) {
      let job;
      try {
        job = JSON.parse(fs.readFileSync(path.join(SCHEDULES_DIR, f), 'utf8'));
      } catch {
        lines.push(`- ⚠️ \`${f}\` 解析失败`);
        continue;
      }
      const rec = state[f];
      const at = typeof rec === 'string' ? rec : rec?.at;
      const st = typeof rec === 'string' ? '' : rec?.status;
      const stLabel = { baseline: '已登记', running: '执行中', done: '已完成', failed: '失败', 'skipped-late': '迟到跳过' }[st] ?? '';
      const last = at ? `${new Date(at).toLocaleString('zh-CN')}${stLabel ? `（${stLabel}）` : ''}` : '（尚未触发）';
      const status = job.enabled === false ? '⏸ 已停用' : '▶️ 启用';
      lines.push(`- ${status} **${job.name ?? f}** — \`${job.when}\``);
      lines.push(`  上次：${last}${job.action ? ` ｜ 动作：${job.action}` : ''}`);
      const next = nextFireAt(job);
      if (next) lines.push(`  下次：${next.toLocaleString('zh-CN')}`);
    }
    return lines.join('\n');
  } catch (e) {
    return `读取定时任务失败：${e?.message ?? e}`;
  }
}

// 启动通知：进程崩溃/重启此前完全静默，owner 无从知道自己发的消息其实没人接
const STARTUP_STAMP = path.join(DATA_DIR, 'last-startup-notice');
let cliProblem = null; // 启动自检发现的 CLI 问题，随启动通知发给 owner

async function announceStartup() {
  const owner = OWNER_OPEN_ID || loadOwner();
  if (!owner || process.env.STARTUP_NOTICE === 'false') return;
  // 连环重启时不要每次都推送：30 分钟内只通知一次
  try {
    const last = Number(fs.readFileSync(STARTUP_STAMP, 'utf8'));
    if (Number.isFinite(last) && Date.now() - last < 30 * 60 * 1000) {
      console.log('[startup-notice] 距上次通知不足 30 分钟，跳过');
      return;
    }
  } catch { /* 首次运行没有该文件 */ }
  try { fs.writeFileSync(STARTUP_STAMP, String(Date.now())); } catch {}
  try {
    await client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: owner,
        msg_type: 'text',
        content: JSON.stringify({
          text:
            `🤖 桥接已启动（${new Date().toLocaleString('zh-CN')}）。若此前发过消息没收到回复，请重发一次。` +
            (cliProblem ? `\n\n⚠️ 启动自检发现问题，现在发消息会失败：\n${cliProblem}` : ''),
        }),
      },
    });
  } catch (e) {
    console.error('[startup-notice]', e?.message ?? e);
  }
}

startScheduler({
  schedulesDir: SCHEDULES_DIR,
  stateFile: SCHED_STATE_FILE,
  onFire: async (job) => {
    const chatId = job.chat_id;
    // 动作型任务：切换模型/思考档，不走 Claude 调用
    if (job.action === 'set-model') {
      try {
        const next = setRuntimeConfig({ model: job.model, effort: job.effort });
        console.log(`[sched] 已切换模型 → ${next.model} / ${next.effort}`);
        if (chatId) {
          await sendToChat(chatId, `🔀 **${job.name ?? '定时切换'}**：模型 \`${next.model || 'CLI 默认'}\`，思考深度 \`${next.effort || 'CLI 默认'}\``);
        }
      } catch (e) {
        console.error('[sched] 切换模型失败:', e?.message ?? e);
        if (chatId) await sendToChat(chatId, `⚠️ 定时切换模型失败：${e?.message ?? e}`);
      }
      return;
    }
    if (!chatId) {
      console.error(`[sched] 任务「${job.name ?? job._file}」缺 chat_id，跳过`);
      return;
    }
    // 定时任务用独立会话上下文，避免污染用户正在进行的对话
    const schedChatId = `sched:${job._file}`;
    try {
      const answer = await runClaude(
        schedChatId,
        job.prompt,
        true,
        [],
        (p) => sendToChat(chatId, `⏳ ${p}`),
        { model: job.model, effort: job.effort } // 任务可自带档位，未指定则用全局配置
      );
      const late = job._late ? `（迟到补跑 ${Math.round(job._late / 60000)} 分钟）` : '';
      // 无事不报：答案以 HEARTBEAT_OK 开头（或为空）时静默跳过，
      // 让「每天检查一遍，有问题才叫我」这类心跳型任务成为可能
      // 必须整条just是心跳词：前缀匹配会把「HEARTBEAT_OK 但磁盘快满了」这类
      // 带正文的告警整条吞掉
      const body = (answer ?? '').trim();
      const quiet = !body || /^HEARTBEAT_OK[.。!！]?$/i.test(body);
      if (quiet) {
        console.log(`[sched] 「${job.name ?? job._file}」无需汇报，静默跳过`);
      } else {
        await sendToChat(chatId, `⏰ **${job.name ?? '定时任务'}**${late}\n\n${body}`);
      }
      // 定时任务写的文件此前从不发送，会滞留到下一条任意消息被顺手发走
      await flushOutbox(client, outboxDirFor(schedChatId, true), (data) =>
        client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, ...data } })
      );
    } catch (e) {
      // 失败自诊断：让 Claude 判断是什么原因、能否自行修复
      const err = String(e?.message ?? e).slice(0, 800);
      console.error(`[sched] 任务失败，启动自诊断: ${err}`);
      let diag = '';
      try {
        diag = await runClaude(
          `sched-diag:${job._file}`,
          // 自诊断是模板化的短任务，没必要用旗舰模型
          [
            '你是定时任务的诊断助手。以下任务执行失败，请判断原因并给出结论。',
            `任务名：${job.name ?? job._file}`,
            `任务指令：${job.prompt}`,
            `报错：${err}`,
            '',
            '请用三行回答：1) 失败类别（权限/网络/额度/任务本身写错/其他）；2) 根因判断；3) 建议动作（能自行修复就说明怎么改任务定义，需要人工就明确说要做什么）。不要重试该任务。',
          ].join('\n'),
          true,
          [],
          null,
          { model: process.env.DIAG_MODEL || 'claude-haiku-4-5-20251001', effort: 'low' }
        );
      } catch (e2) {
        diag = `（诊断也失败了：${String(e2?.message ?? e2).slice(0, 200)}）`;
      }
      await sendToChat(
        chatId,
        `⚠️ **定时任务失败**：${job.name ?? job._file}\n\n报错：\`${err.slice(0, 300)}\`\n\n**自诊断**\n${diag}`
      );
      // 失败时也要清空本任务的回传目录，否则残留文件会搭下一次报告一起发出
      await flushOutbox(client, outboxDirFor(schedChatId, true), (data) =>
        client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, ...data } })
      ).catch(() => {});
    }
  },
});

// v1.x 遗留在 outbox 根目录的文件：归拢待处理，不会误发给任何人
migrateLegacyOutbox(path.join(WORKSPACE_DIR, 'outbox'));
migrateLegacyOutbox(path.join(GUEST_WORKSPACE_DIR, 'outbox'));

// 附件目录只进不出会一直涨（实测累积到 24MB），启动时与每天各清一次
cleanIncoming(WORKSPACE_DIR);
cleanIncoming(GUEST_WORKSPACE_DIR);
setInterval(() => {
  cleanIncoming(WORKSPACE_DIR);
  cleanIncoming(GUEST_WORKSPACE_DIR);
}, 24 * 3600 * 1000).unref();

console.log('启动飞书长连接…');
wsClient.start({ eventDispatcher });
announceStartup();

// 启动时打印真正生效的配置：dotenv 不会覆盖已存在的环境变量，
// 若在 shell 里 export 过 CLAUDE_MODEL/CLAUDE_EFFORT 再手动启动，.env 会被静默忽略
{
  const cfg = getRuntimeConfig();
  const shadowed = ['CLAUDE_MODEL', 'CLAUDE_EFFORT', 'GUEST_TOOLS', 'OWNER_OPEN_ID']
    .filter((k) => {
      try {
        const line = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8')
          .split('\n').find((l) => l.startsWith(`${k}=`));
        const inFile = line ? line.slice(k.length + 1).replace(/\s+#.*$/, '').trim() : null;
        return inFile && process.env[k] && process.env[k] !== inFile;
      } catch { return false; }
    });
  console.log(`[config] 生效配置：模型=${cfg.model || 'CLI 默认'} 思考档=${cfg.effort || 'CLI 默认'}`);
  // 桥接实际会调用哪个 claude、版本够不够跑当前模型——本机可能装了多份，
  // PATH 里靠前的那份才生效，这正是 2026-09-02 每条消息报 400 的原因
  const cli = checkCliEnvironment(cfg.model);
  console.log(`[config] claude CLI：${cli.bin} (${cli.version ?? '版本未知'})`);
  if (cli.problem) {
    console.error(`[config] ⚠️ ${cli.problem}`);
    cliProblem = cli.problem; // 启动通知里一并告知 owner
  }
  if (shadowed.length) {
    console.error(`[config] ⚠️ 以下变量被 shell 环境覆盖，.env 里的值未生效：${shadowed.join(', ')}`);
  }
}

