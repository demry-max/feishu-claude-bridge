// BRIDGE-SEND-2：回传文件没能发出去时的保留目录（data/outbox-unsent/，0700）与文件名清洗。
// 文件名是不可信文本（模型 / 用户可控），进消息前一律清洗：不带路径、不带控制 / 格式 / 双向覆盖字符，
// 只留字母、数字、组合符、空格和 . _ -，其余换成下划线。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';

export const KEEP_DIR_NAME = 'outbox-unsent';
export const KEEP_MAX_DAYS = 14;
export const KEEP_MAX_ENTRIES = 200;
const KEEP_NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{4}-/;
const DAY_MS = 86_400_000;

export const defaultKeepDir = () => path.join(DATA_DIR, KEEP_DIR_NAME);

export function ensureKeepDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700); // 已存在、权限不对也收紧
}

const cleanName = (raw) => String(raw)
  .normalize('NFC')
  .replace(/\p{C}/gu, '')
  .replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '_');

const clip = (s, max, ellipsis) => {
  const cps = [...s];
  return cps.length > max ? cps.slice(0, ellipsis ? max - 1 : max).join('') + (ellipsis ? '…' : '') : s;
};

/** 进消息的名字（不带路径）。空串返回「（无名文件）」。 */
export function displayName(raw) {
  const s = clip(cleanName(raw).replace(/\s+/g, ' ').trim(), 40, true);
  return s || '（无名文件）';
}

/** 保留目录里的文件名片段：上限 80 码点、空格换下划线、不加省略号。 */
export function fsName(raw) {
  return clip(cleanName(raw).replace(/\s+/g, '_'), 80, false) || 'file';
}

const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** 清掉过期（> 14 天）与超量（≥ 200 份时删到 199 份）的条目；名字不匹配规则的一律不动。 */
export function pruneKeepDir(dir, { now = Date.now() } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const items = [];
  for (const name of names) {
    const m = KEEP_NAME_RE.exec(name);
    if (!m) continue;
    items.push({ name, t: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) });
  }
  items.sort((a, b) => a.t - b.t || (a.name < b.name ? -1 : 1));
  const doomed = new Set(items.filter((i) => now - i.t > KEEP_MAX_DAYS * DAY_MS).map((i) => i.name));
  const left = items.filter((i) => !doomed.has(i.name));
  for (let k = 0; left.length - k >= KEEP_MAX_ENTRIES; k += 1) doomed.add(left[k].name);
  let removed = 0;
  for (const name of doomed) {
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); removed += 1; } catch { /* 删不掉就留着 */ }
  }
  if (removed) console.log(`[outbox] 保留目录清掉 ${removed} 份过期 / 超量的文件`);
  return removed;
}

/**
 * 把没发出去的文件（或子目录）挪进保留目录。成功 true；挪不动（含跨卷 EXDEV、保留目录建不出来）→ 删掉原件、返回 false。
 * 不复制、不跟随符号链接（rename 移动的是链接本身）。
 */
export function keepEntry(src, rawName, { keepDir, now = Date.now() } = {}) {
  try {
    pruneKeepDir(keepDir, { now });
    ensureKeepDir(keepDir);
    const base = `${stampOf(now)}-%s-${fsName(rawName)}`;
    let target;
    do { target = path.join(keepDir, base.replace('%s', crypto.randomBytes(2).toString('hex'))); } while (fs.existsSync(target));
    fs.renameSync(src, target);
    return true;
  } catch {
    try { fs.rmSync(src, { recursive: true, force: true }); } catch { /* 原件也删不掉：交给下一轮 */ }
    return false;
  }
}

/** names 已是 displayName 结果。各项（含符号链接数）都为 0 返回空串。 */
export function unsentNote({ names = [], nested = 0, lost = 0, links = 0, failedTurn = false } = {}) {
  const parts = [];
  if (names.length) {
    const shown = names.slice(0, 10).map((n) => `「${n}」`).join('');
    parts.push(`这些文件没发出去：${shown}${names.length > 10 ? ' 等' : ''}（共 ${names.length} 个；${failedTurn ? '这一轮没有完成，' : ''}已留在桥接本机，没有删除）`);
  }
  if (nested > 0) parts.push(`另有 ${nested} 个放在子目录里的文件没有发送（只发本轮回传目录顶层的文件），也已留存`);
  if (links > 0) parts.push(`另有 ${links} 个符号链接或特殊文件没有上传，已删除（不会跟随链接）`);
  if (lost > 0) parts.push(`其中 ${lost} 个没能留存，已清掉`);
  if (!parts.length) return '';
  return `${failedTurn ? '📎' : '⚠️'} ${parts.join('；')}`;
}
