// BRIDGE-INBOUND-1（V04）：入口兜底。消息在「进模型之前」出错（命令分支的回复失败、拼这一轮时抛错），
// 过去用户看到的是没反应。兜底层挂在事件注册处：处理函数抛错或被拒时 ①回一句固定的话 ②记一行日志 ③不再往外抛
// （抛给 SDK 会回 500，是否触发重推未核实；吞掉异常，由用户按提示自己重发）。
//
// 不撤去重：这条消息的 id 留在去重表里。理由——SDK 文档（node_modules/@larksuiteoapi/node-sdk/README.zh.md 的长连接一节）
// 写明 3 秒内没处理完会触发超时重推；命令分支是「先执行、后回复」，回复慢失败时命令已经生效，
// 撤去重会让晚到的同 id 重推把命令再执行一遍；普通消息则会变成「用户按提示重发 + 原 id 重推」处理两次。
// 所以同一条消息的重推仍按重复丢弃，只有用户重发（新 id）才会重新处理。
//
// 不变式（调用方 src/index.js 要保持）：「处理函数以抛错结束」⇔「这条消息还没入队、没进模型、命令还没生效」。
//   - 处理函数里交给队列、起这一轮之后，不得再加可能抛错的语句；
//   - 起一轮的函数里，把任务交进串行链必须是最后一句；
//   - 命令分支里「执行已生效、之后才回复」的那次回复发不出去时，只记日志、不抛（index.js 的 replyDone）。
// 已入队 / 已在跑的回合出错走各自原来的报错出口，不经过这里。
// 已知例外：`/session rotate`（DAILY_SESSION=on）在 dailySession.command 里先把交接入队、再返回进度文案，
// 入队之后才回复——这次回复若抛错，兜底那句「请再发一次」不准确（交接还在跑，重发会得到「有任务正在跑」）。
// 所以 index.js 对它也走 replyDone（回复失败只记日志、不抛），例外随之不再发生；其余「先执行、后回复」的命令分支同理。
//
// 本文件不 import 本仓库任何模块。

export const INBOUND_FAILED_REPLY = '这条消息处理失败了，请再发一次';

const tail6 = (id) => (id ? `…${String(id).slice(-6)}` : '?');

/** 错误类别码：e.code，其次飞书接口码（写成 api<码>），再其次 e.name。不取错误原文 */
export function errorKind(e) {
  const code = e?.code ?? e?.errno;
  if (code !== undefined && code !== null && code !== '') return String(code).slice(0, 40);
  const api = e?.response?.data?.code;
  if (api !== undefined && api !== null && api !== '') return `api${String(api).slice(0, 20)}`;
  return String(e?.name || '?').slice(0, 40);
}

/** 尽力而为：调用栈里出现 runTurn 说明是组装这一轮时（还没入队）出的错，否则算命令 / 回复 / 认领等「消息」阶段 */
export function errorStage(e) {
  const stack = typeof e?.stack === 'string' ? e.stack : '';
  if (!stack) return '?';
  return /\brunTurn\b/.test(stack) ? 'turn' : 'message';
}

/** 最多等 p 这么久：p 先落定（成交或失败）就照 p 的结果，超时则返回 'timeout'。p 本身不被取消，后台照常跑完；p 被拒时返回 'rejected' */
export function waitAtMost(p, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); });
  return Promise.race([Promise.resolve(p).then(() => 'done', () => 'rejected'), timeout]).finally(() => clearTimeout(timer));
}

export function createInboundGuard({ reply, log = console.error } = {}) {
  const safeLog = (line) => { try { log(line); } catch { /* 日志出错不影响兜底 */ } };
  return async function guard(data, handle) {
    try {
      return await handle(data);
    } catch (e) {
      const message = data?.message;
      const messageId = message?.message_id;
      let replied = 'no';
      if (messageId) {
        try {
          await reply(messageId, INBOUND_FAILED_REPLY);
          replied = 'yes';
        } catch { /* 回复也失败：只在日志里标 replied=no */ }
      }
      const chat = message?.chat_type === 'p2p' ? 'p2p' : message?.chat_type ? 'group' : '?';
      safeLog(`[inbound] 消息在进模型前出错：stage=${errorStage(e)} kind=${errorKind(e)} chat=${chat} type=${message?.message_type || '?'} replied=${replied} id=${tail6(messageId)}`);
      return undefined;
    }
  };
}
