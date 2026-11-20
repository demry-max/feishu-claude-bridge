// BRIDGE-RUN-2 / BRIDGE-INBOUND-1：owner 私聊这一轮因为「原会话已失效」换了新会话时，附在答案后面的一句话。
// 文字回复照旧带；语音朗读与每日会话的原话记录不要它——所以常量与「去掉它」的函数放在这个不 import 本仓库任何模块的小文件里，
// claude.js、outbound.js、daily-session.js（它声明不 import claude.js）都从这里取。
export const SESSION_RENEWED_NOTE = '（提示：原来的会话已失效，这一轮是在新会话里回答的，之前聊过的上下文已经不在了；需要的话把要点再说一遍。）';

const SUFFIX = `\n\n${SESSION_RENEWED_NOTE}`;

/** 只去掉末尾恰好是「空一行 + 附注」的那一段；其余原样（非字符串先转成字符串） */
export function stripRenewedNote(text) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  return s.endsWith(SUFFIX) ? s.slice(0, -SUFFIX.length) : s;
}
