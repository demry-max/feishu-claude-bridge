// BRIDGE-PUB-1：附件文件名的两种清洗（文件名由发送方任意指定）。
// - promptFileName：进 prompt 的显示名（放在围栏里）——换行 / 控制字符 / 行段分隔符变空格，零宽等格式字符删掉，空白合并，≤200 字；
// - diskFileName：落盘名——同样去掉控制与格式字符，/ 与 \ 换成 _（不再靠 basename 截掉前半段），. / .. / 空名退回给定名，
//   ≤200 字节并尽量保留扩展名。落盘名会出现在围栏外「已保存为 ./incoming/…」那一行，所以绝不能带换行，
//   否则可以在围栏外伪造「第 N 条」之类的标记。
import path from 'node:path';

const MAX_SHOWN = 200;
const MAX_DISK_BYTES = 200;
const MAX_EXT_BYTES = 20;

const flatten = (s) => String(s ?? '')
  .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
  .replace(/\p{Cf}/gu, '')
  .replace(/\s+/gu, ' ')
  .trim();

const bytes = (s) => Buffer.byteLength(s, 'utf8');

function truncateBytes(s, max) {
  let out = '';
  for (const ch of s) {
    if (bytes(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/** 进 prompt 的显示名：单行、无控制 / 格式字符、≤200 字（按码点，不拆代理对） */
export function promptFileName(name) {
  return [...flatten(name)].slice(0, MAX_SHOWN).join('');
}

function cleanDisk(name) {
  const s = flatten(name).replace(/[/\\]/g, '_');
  return s === '.' || s === '..' ? '' : s;
}

/** 落盘名：单行、不含路径分隔符、不是 . / ..，≤200 字节且尽量保留扩展名；清完为空时用 fallback（同样清洗），再不行用 file.bin */
export function diskFileName(name, fallback = 'file.bin') {
  const s = cleanDisk(name) || cleanDisk(fallback) || 'file.bin';
  if (bytes(s) <= MAX_DISK_BYTES) return s;
  const ext = path.extname(s);
  if (ext && bytes(ext) <= MAX_EXT_BYTES) return truncateBytes(s.slice(0, -ext.length), MAX_DISK_BYTES - bytes(ext)) + ext;
  return truncateBytes(s, MAX_DISK_BYTES);
}
