// BRIDGE-SEND-1：飞书发消息的请求级幂等键（im.v1.message.create 请求体 data.uuid）。
// 飞书：同一 uuid 约 1 小时内至多成功发送一条；超过 50 个字符会被拒。
// 键只由哈希构成，不含会话 id、open_id、提示词、文件名原文；日志一律不打印键。
import crypto from 'node:crypto';

export const FEISHU_UUID_MAX_LEN = 50;
const UUID_HEX_LEN = 40;
const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');

/** 一次请求的 uuid：逻辑键 + 段名再哈希，固定 40 个十六进制字符。没有逻辑键返回 undefined。 */
export function feishuUuid(logicalKey, part) {
  if (typeof logicalKey !== 'string' || !logicalKey) return undefined;
  return sha256(`${logicalKey}\n${String(part)}`).slice(0, UUID_HEX_LEN);
}

/** 带键：返回加了 uuid 的新对象（不改入参）；不带键：原样返回同一个对象（请求体逐字不变）。 */
export function withUuid(data, logicalKey, part) {
  const uuid = feishuUuid(logicalKey, part);
  return uuid ? { ...data, uuid } : data;
}

/** 回传文件的段名：文件名 + 文件内容的哈希。 */
export function outboxPart(name, bytes) {
  return `file:${sha256(Buffer.concat([Buffer.from(`${name}\n`, 'utf8'), Buffer.from(bytes)]))}`;
}
