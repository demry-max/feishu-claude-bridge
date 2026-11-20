// BRIDGE-INBOUND-1：入口兜底。消息在「进模型之前」出错（命令分支的回复失败、拼这一轮时抛错），
// 过去用户看到的是没反应，去重表里还留着这条消息 id，飞书重推也被当成重复丢掉。
// 兜底层挂在事件注册处：处理函数抛错或被拒时 ①撤掉去重 ②回一句固定的话 ③记一行日志 ④不再往外抛
// （抛给 SDK 会回 500，是否触发重推未核实；吞掉异常再让用户自己重发，不会叠成两次处理）。
//
// 不变式（调用方 src/index.js 要保持）：「处理函数以抛错结束」⇔「这条消息还没入队、没进模型」。
//   - 处理函数里交给队列、起这一轮之后，不得再加可能抛错的语句；
//   - 起一轮的函数里，把任务交进串行链必须是最后一句。
// 已入队 / 已在跑的回合出错走各自原来的报错出口，不经过这里。
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

export function createInboundGuard({ reply, forget, log = console.error } = {}) {
  const safeLog = (line) => { try { log(line); } catch { /* 日志出错不影响兜底 */ } };
  return async function guard(data, handle) {
    try {
      return await handle(data);
    } catch (e) {
      const message = data?.message;
      const messageId = message?.message_id;
      let replied = 'no';
      if (messageId) {
        try { forget?.(messageId); } catch { /* 撤去重出错也吞掉 */ }
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
