// BRIDGE-SEND-2：长消息按「请求体字节」分段（纯函数，不 import 本仓库任何模块）。
//
// 飞书卡片请求体上限约 30 KB——这是按文档推断的数字，没有实测。正文在请求里经过两次 JSON 转义
// （卡片 JSON → content 字符串 → 请求体），换行占 3 字节、引号与反斜杠占 4 字节，所以预算按
// 「两次转义后的字节」计（segmentCost），而不是字符数。冒烟若仍有某段降级成文本，按日志里的段大小调小
// SEGMENT_MAX_BYTES。
//
// 切法：优先在空行（段落）之后切，其次在表格开始之前切，再次在行边界切；单行放不下才在行内按
// 句末 / 空白、再按字素簇边界切。围栏代码块在段尾补闭合、下一段以原开栏行重开；表格在行间切时下一段
// 重复表头两行。最多 MAX_SEGMENTS 段，超出的在最后一段末尾注明还有多少字没有发出。
export const SEGMENT_MAX_BYTES = 24_000;
export const MAX_SEGMENTS = 10;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^`\n]*)$/;
const SEP_ROW = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const SENT_END = /^[。！？；!?;\s]/u;
const MAX_FENCE_LEN = 16; // 再长的围栏标记当普通文字（闭合行会吃掉太多预算）
const NOTE_DIGITS = '123456789';

/** 一段文本放进飞书卡片请求体后占多少字节（不含固定的包装）：两次 JSON 转义后的字节数。逐码点可加。 */
export function segmentCost(text) {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(String(text)))) - 6;
}

const noteText = (n) => `\n\n（后面还有约 ${n} 字没有发出）`;
const withNl = (s) => (s.endsWith('\n') ? s : `${s}\n`);
const countCodePoints = (s) => { let n = 0; for (let i = 0; i < s.length; i += 1) { const cc = s.charCodeAt(i); if (cc >= 0xd800 && cc < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i += 1; n += 1; } return n; };

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/** window 内的字素簇起点（> 0）；whole 为真时再加上 window 末尾。没有 Intl.Segmenter 时退到码点边界。 */
function boundariesOf(window, whole) {
  const out = [];
  if (segmenter) {
    for (const g of segmenter.segment(window)) if (g.index > 0) out.push(g.index);
  } else {
    let i = 0;
    for (const ch of window) { if (i > 0) out.push(i); i += ch.length; }
  }
  if (whole) out.push(window.length);
  return out;
}

function analyze(text) {
  const lines = [];
  for (let i = 0; i < text.length;) {
    let j = text.indexOf('\n', i);
    j = j < 0 ? text.length : j + 1;
    lines.push({ start: i, end: j, cost: null, fenceAfter: null, tableId: -1, role: '', partial: false });
    i = j;
  }
  const content = (ln) => text.slice(ln.start, ln.end).replace(/\r?\n$/, '');
  const tables = [];
  let fence = null;
  let curTable = -1;
  for (let k = 0; k < lines.length; k += 1) {
    const ln = lines[k];
    const body = content(ln);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.ch === '`' ? '`' : '~'}{${fence.len},}\\s*$`);
      if (close.test(body)) fence = null;
      ln.fenceAfter = fence;
      curTable = -1;
      continue;
    }
    const m = FENCE_OPEN.exec(body);
    if (m && m[1].length <= MAX_FENCE_LEN) {
      fence = { ch: m[1][0], len: m[1].length, open: withNl(text.slice(ln.start, ln.end)) };
      ln.fenceAfter = fence;
      curTable = -1;
      continue;
    }
    if (curTable >= 0) {
      if (body.trim().startsWith('|')) { ln.tableId = curTable; continue; }
      curTable = -1;
    }
    if (body.trim().startsWith('|') && k + 1 < lines.length && SEP_ROW.test(content(lines[k + 1]))) {
      const id = tables.length;
      tables.push({ start: k, header: withNl(text.slice(ln.start, lines[k + 1].end)) });
      ln.tableId = id; ln.role = 'h1';
      lines[k + 1].tableId = id; lines[k + 1].role = 'sep';
      curTable = id;
      k += 1;
    }
  }
  return { lines, tables };
}

/**
 * 把 text 切成若干段，每段 segmentCost ≤ maxBytes。
 * 返回 { segments, ranges, omittedChars }：第 i 段 = 可选前缀（续开栏行 / 表头两行）+ text.slice(...ranges[i]) + 可选后缀（闭合行、注记）。
 * 一段放得下时原样返回 { segments: [text], ranges: [[0, text.length]], omittedChars: 0 }。
 */
export function splitMessage(input, { maxBytes = SEGMENT_MAX_BYTES, maxSegments = MAX_SEGMENTS } = {}) {
  if (!(maxBytes >= 200) || !(maxSegments >= 1)) throw new RangeError('splitMessage: maxBytes 至少 200、maxSegments 至少 1');
  const text = String(input ?? '');
  if (segmentCost(text) <= maxBytes) return { segments: [text], ranges: [[0, text.length]], omittedChars: 0 };

  const { lines, tables } = analyze(text);
  const affixCap = Math.floor(maxBytes / 4);
  const noteCost = segmentCost(noteText(NOTE_DIGITS));
  const half = maxBytes / 2;
  const costOf = (ln) => { if (ln.cost === null) ln.cost = segmentCost(text.slice(ln.start, ln.end)); return ln.cost; };
  const markerOf = (f) => f.ch.repeat(f.len);
  const closerCostOf = (f) => (f ? segmentCost(`\n${markerOf(f)}`) : 0);
  const isBlank = (ln) => text.slice(ln.start, ln.end).trim() === '';

  // 第 k 行之前切开时，下一段的前缀
  const prefixAt = (k) => {
    if (k === 0) return '';
    const prev = lines[k - 1];
    if (prev.fenceAfter) {
      const open = prev.fenceAfter.open;
      return segmentCost(open) > affixCap ? `${markerOf(prev.fenceAfter)}\n` : open;
    }
    if (prev.tableId >= 0 && !prev.partial && lines[k] && lines[k].tableId === prev.tableId) {
      const h = tables[prev.tableId].header;
      return segmentCost(h) > affixCap ? '' : h;
    }
    return '';
  };
  // 在第 b 行之前切（b ≥ 1）是否会把表头两行拆开
  const splitsHeader = (b) => lines[b - 1].role === 'h1' && lines[b] && lines[b].role === 'sep';

  const segments = [];
  const ranges = [];
  let omittedChars = 0;
  let s = 0;
  for (;;) {
    const isLast = segments.length === maxSegments - 1;
    const prefix = prefixAt(s);
    const prefixCost = prefix ? segmentCost(prefix) : 0;
    const startOff = lines[s].start;

    // 剩下的全部放得下：最后一段，不补闭合、不加注记
    if (prefixCost + segmentCost(text.slice(startOff)) <= maxBytes) {
      segments.push(prefix + text.slice(startOff));
      ranges.push([startOff, text.length]);
      break;
    }

    const reserve = isLast ? noteCost : 0;
    const cum = [0];
    let c = s;
    for (; c < lines.length; c += 1) {
      const ln = lines[c];
      if (prefixCost + cum[cum.length - 1] + costOf(ln) + closerCostOf(ln.fenceAfter) + reserve > maxBytes) break;
      cum.push(cum[cum.length - 1] + costOf(ln));
    }
    // c < lines.length：上面「全部放得下」已排除到头的情况（保守预留只会让 c 更小）
    let b;
    if (c >= lines.length) {
      b = lines.length; // 只差闭合 / 注记的预留，退一行
      b = Math.max(s + 1, b - 1);
    } else if (c === s) {
      // 单独一行就放不下：行内切
      const ln = lines[s];
      const before = s > 0 ? lines[s - 1].fenceAfter : null;
      const budget = maxBytes - prefixCost - closerCostOf(before) - reserve;
      const lt = text.slice(ln.start, ln.end);
      const window = lt.length > budget + 8 ? lt.slice(0, budget + 8) : lt;
      const bounds = boundariesOf(window, window.length === lt.length);
      let acc = 0; let prev = 0; let fit = 0; let sent = 0;
      for (const o of bounds) {
        const piece = window.slice(prev, o);
        const pc = segmentCost(piece);
        if (acc + pc > budget && fit > 0) break;
        acc += pc; prev = o; fit = o;
        // 句末 / 空白之后：看刚放进来的那个字素簇的首个字符
        if (SENT_END.test(piece)) sent = o;
        if (acc > budget) break;
      }
      const cut = sent > 0 ? sent : fit;
      if (cut >= lt.length) {
        b = s + 1;
      } else {
        const first = { start: ln.start, end: ln.start + cut, cost: null, fenceAfter: before, tableId: ln.tableId, role: '', partial: true };
        const rest = { ...ln, start: ln.start + cut, cost: null, role: '' };
        lines.splice(s, 1, first, rest);
        b = s + 1;
      }
    } else {
      b = c;
      // 优先级 a：最后一个空行之后（不在围栏内、不在表格内），且前面的正文至少半段
      let chosen = 0;
      for (let k = c; k > s; k -= 1) {
        if (cum[k - s] < half) break;
        if (isBlank(lines[k - 1]) && !lines[k - 1].fenceAfter && !splitsHeader(k)) { chosen = k; break; }
      }
      // 优先级 b：下一行属于从本段内开始的表格，切在表格开始之前
      if (!chosen && lines[c].tableId >= 0) {
        const t = tables[lines[c].tableId].start;
        if (t > s && (cum[t - s] >= half || splitsHeader(c))) chosen = t;
      }
      b = chosen || c; // 优先级 c：行边界
      if (!chosen && splitsHeader(b)) b = b - 1 > s ? b - 1 : b;
    }

    // 组装并核对预算（保险：超了就往回退行）
    let seg; let endOff;
    for (;;) {
      endOff = lines[b - 1].end;
      seg = prefix + text.slice(startOff, endOff);
      const f = lines[b - 1].fenceAfter;
      if (f) seg += (seg.endsWith('\n') ? '' : '\n') + markerOf(f);
      if (isLast) {
        omittedChars = countCodePoints(text.slice(endOff));
        seg += noteText(omittedChars);
      }
      if (segmentCost(seg) <= maxBytes || b <= s + 1) break;
      b -= 1;
      if (splitsHeader(b) && b > s + 1) b -= 1;
    }
    segments.push(seg);
    ranges.push([startOff, endOff]);
    if (isLast) break;
    s = b;
  }
  return { segments, ranges, omittedChars };
}
