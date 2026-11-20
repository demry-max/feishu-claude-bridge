// BRIDGE-SEND-2：splitMessage 纯函数——按两次转义后的字节分段，段落 / 表格 / 围栏 / 字素簇边界。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage, segmentCost, SEGMENT_MAX_BYTES, MAX_SEGMENTS } from '../src/split-message.js';

const MAX = SEGMENT_MAX_BYTES;
const cps = (s) => { let n = 0; for (const _ of s) n += 1; return n; };
const covered = (text, ranges) => ranges.reduce((n, [a, b]) => n + cps(text.slice(a, b)), 0);
function assertShape(text, r, max = MAX) {
  assert.equal(r.segments.length, r.ranges.length);
  for (const seg of r.segments) assert.ok(segmentCost(seg) <= max, `段超预算：${segmentCost(seg)} > ${max}`);
  assert.equal(r.ranges[0][0], 0);
  for (let i = 0; i + 1 < r.ranges.length; i += 1) assert.equal(r.ranges[i][1], r.ranges[i + 1][0]);
}
const graphemeStarts = (text) => new Set([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((g) => g.index).concat(text.length));

describe('S 分段（纯函数）', () => {
  test('S1 单段恒等：空串、undefined、短文本', () => {
    const cases = ['', undefined, 'a', 'a'.repeat(19_999), '汉'.repeat(7_999), '汉'.repeat(8_000), '# 标题\n```js\nlet a = 1;\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n👨‍👩‍👧 🇨🇳 é\n'];
    for (const c of cases) {
      const t = String(c ?? '');
      assert.deepEqual(splitMessage(c), { segments: [t], ranges: [[0, t.length]], omittedChars: 0 });
    }
  });

  test('S2 3 万汉字无换行：≥ 4 段、每段不超预算、首尾相接、不切代理对', () => {
    for (const unit of ['汉', '😀', 'a😀汉']) {
      const text = unit.repeat(Math.ceil((3.5 * MAX) / segmentCost(unit)));
      const r = splitMessage(text);
      assert.ok(r.segments.length >= 4);
      assertShape(text, r);
      assert.equal(r.ranges.at(-1)[1], text.length);
      assert.equal(r.omittedChars, 0);
      for (const [, end] of r.ranges.slice(0, -1)) {
        const prev = text.charCodeAt(end - 1); const next = text.charCodeAt(end);
        assert.ok(!(prev >= 0xd800 && prev < 0xdc00), '段以落单高代理结尾');
        assert.ok(!(next >= 0xdc00 && next < 0xe000), '段以落单低代理开头');
      }
      assert.equal(r.segments.join(''), text);
    }
  });

  test('S3 计量是两次转义：1 万个引号（原文 10 KB、请求体 40 KB）', () => {
    const text = '"'.repeat(10_000);
    assert.equal(segmentCost(text), 40_000);
    const r = splitMessage(text);
    assert.ok(r.segments.length >= 2);
    assertShape(text, r);
    assert.equal(segmentCost('\n'), 3);
    assert.equal(segmentCost('汉'), 3);
    assert.equal(segmentCost('\\'), 4);
  });

  test('S4 段落优先：除最后一段外每个切点都紧跟在空行之后', () => {
    const text = `${'汉'.repeat(1_000)}\n\n`.repeat(20);
    const r = splitMessage(text);
    assert.ok(r.segments.length >= 3);
    assertShape(text, r);
    for (const [, end] of r.ranges.slice(0, -1)) assert.equal(text.slice(end - 2, end), '\n\n');
  });

  test('S4b 段落优先（多行段落）：每段 30 行 × 30 汉字、段间空行，除最后一段外切点都紧跟空行', () => {
    const para = `${`${'汉'.repeat(30)}\n`.repeat(30)}\n`; // 每段约 2.8 KB
    const text = para.repeat(30);
    const r = splitMessage(text);
    assert.ok(r.segments.length >= 3);
    assertShape(text, r);
    for (const [, end] of r.ranges.slice(0, -1)) assert.equal(text.slice(end - 2, end), '\n\n', `切点 ${end} 没有紧跟空行`);
  });

  test('S4c 空行太靠前（不到半段）时不切在那里', () => {
    const text = `${'汉'.repeat(100)}\n\n${`${'汉'.repeat(30)}\n`.repeat(2_000)}`;
    const r = splitMessage(text);
    assert.ok(r.segments.length >= 2);
    assertShape(text, r);
    const firstEnd = r.ranges[0][1];
    assert.ok(firstEnd > 102, `第一段在靠前的空行处就切了：${firstEnd}`);
    assert.ok(segmentCost(text.slice(0, firstEnd)) >= MAX / 2);
  });

  for (const [name, marker] of [['```', '```'], ['~~~', '~~~'], ['四个反引号', '````']]) {
    test(`S5 代码块 ${name}：围栏成对、续段重开带语言标记、闭合在段尾、去掉补的行后拼回原文`, () => {
      const open = `${marker}js\n`;
      const text = `前言\n${open}${Array.from({ length: 2_000 }, (_, i) => `const line${i} = ${i}; // 代码行`).join('\n')}\n${marker}\n后记\n`;
      const r = splitMessage(text);
      assert.ok(r.segments.length >= 2);
      assertShape(text, r);
      let rebuilt = '';
      r.segments.forEach((seg, i) => {
        const last = i === r.segments.length - 1;
        let body = seg;
        if (i > 0) { assert.ok(seg.startsWith(open), `第 ${i + 1} 段没有以 ${open.trim()} 开头`); body = seg.slice(open.length); }
        const range = text.slice(...r.ranges[i]);
        if (!last) {
          assert.ok(body.endsWith(marker), `第 ${i + 1} 段没有以闭合行结尾`);
          body = body.slice(0, -marker.length);
          if (!range.endsWith('\n')) body = body.slice(0, -1);
          // 去掉补的行后与原文一致
        }
        assert.equal(body, range);
        rebuilt += range;
        // 围栏行成对
        const fenceLines = seg.split('\n').filter((l) => l.startsWith(marker));
        assert.equal(fenceLines.length % 2, 0, `第 ${i + 1} 段围栏行数 ${fenceLines.length}`);
      });
      assert.equal(rebuilt, text);
    });
  }

  const tableText = (rows, cell = 20) => `| 编号 | 内容 |\n|---|---|\n${Array.from({ length: rows }, (_, i) => `| ${i} | ${'汉'.repeat(cell)} |`).join('\n')}\n`;

  test('S6 表格：每个 | 开头的行完整、续段以表头两行开头', () => {
    const text = `前言\n\n${tableText(1_500)}`;
    const r = splitMessage(text);
    assert.ok(r.segments.length >= 3);
    assertShape(text, r);
    const header = '| 编号 | 内容 |\n|---|---|\n';
    r.segments.forEach((seg, i) => {
      for (const l of seg.split('\n').filter((x) => x.startsWith('|'))) assert.ok(l.endsWith('|'), `不完整的表格行：${l}`);
      if (i > 0) assert.ok(seg.startsWith(header), `第 ${i + 1} 段没有重复表头`);
    });
  });

  test('S6b 前面有足够正文时，放得进一段的表格不被切开', () => {
    const body = Array.from({ length: 5 }, () => '汉'.repeat(1_000)).join('\n'); // 15 KB、无空行
    const table = tableText(150, 20).trimEnd(); // 约 11 KB
    const text = `${body}\n${table}\n`;
    const r = splitMessage(text);
    assert.equal(r.segments.length, 2);
    assert.ok(r.segments[1].startsWith('| 编号 | 内容 |'));
    assert.ok(!r.segments[0].includes('|'));
    assert.equal(r.segments[1], `${table}\n`);
  });

  test('S7 字素：家庭 emoji / 组合符 / 国旗长串，切点都在字素簇边界', () => {
    for (const unit of ['👨‍👩‍👧', 'é', '🇨🇳']) {
      const text = unit.repeat(20_000);
      const starts = graphemeStarts(text);
      const r = splitMessage(text);
      assert.ok(r.segments.length >= 2, unit);
      assertShape(text, r);
      for (const [, end] of r.ranges) assert.ok(starts.has(end), `切点 ${end} 不在字素边界（${unit}）`);
    }
  });

  test('S8 长句：每 50 字一个「。」且无换行，除最后一段外每段以「。」结尾', () => {
    const text = `${'字'.repeat(49)}。`.repeat(1_000);
    const r = splitMessage(text);
    assert.ok(r.segments.length >= 3);
    assertShape(text, r);
    r.segments.slice(0, -1).forEach((seg) => assert.ok(seg.endsWith('。')));
  });

  test('S9 段数上限：40 万汉字 → 恰 10 段、末段注明没发出多少字', () => {
    const text = '汉'.repeat(400_000);
    const r = splitMessage(text);
    assert.equal(r.segments.length, MAX_SEGMENTS);
    assertShape(text, r);
    const n = r.omittedChars;
    assert.ok(n > 0);
    assert.equal(n, 400_000 - covered(text, r.ranges));
    assert.ok(r.segments.at(-1).endsWith(`\n\n（后面还有约 ${n} 字没有发出）`));
    assert.ok(r.segments.slice(0, -1).every((s) => !s.includes('后面还有约')));
  });

  test('S9d omittedChars 按码点计：增补平面字符（😀 / 𠀀）一个算 1 个字', () => {
    for (const unit of ['😀', '𠀀', '汉😀𠀀']) {
      const text = unit.repeat(Math.ceil(400_000 / cps(unit)));
      const r = splitMessage(text);
      assert.equal(r.segments.length, MAX_SEGMENTS, unit);
      assertShape(text, r);
      const n = r.omittedChars;
      assert.ok(n > 0);
      assert.equal(n, cps(text) - covered(text, r.ranges), unit);
      assert.ok(n < text.length - r.ranges.at(-1)[1], '应按码点计，少于 UTF-16 长度');
      assert.ok(r.segments.at(-1).endsWith(`\n\n（后面还有约 ${n} 字没有发出）`));
    }
  });

  test('S9b 在围栏内被截断：闭合行在注记之前', () => {
    const text = `\`\`\`py\n${'print("汉字汉字汉字汉字")\n'.repeat(60_000)}`;
    const r = splitMessage(text);
    assert.equal(r.segments.length, MAX_SEGMENTS);
    assertShape(text, r);
    assert.ok(r.segments.at(-1).endsWith(`\n\`\`\`\n\n（后面还有约 ${r.omittedChars} 字没有发出）`));
    assert.equal(r.omittedChars, cps(text) - covered(text, r.ranges));
  });

  test('S9c 刚好放进最后一段时不加注记', () => {
    const text = '汉'.repeat(MAX_SEGMENTS * 8_000);
    const r = splitMessage(text);
    assert.equal(r.segments.length, MAX_SEGMENTS);
    assert.equal(r.omittedChars, 0);
    assert.equal(r.segments.join(''), text);
  });

  test('S10 选项与参数检查', () => {
    const text = '汉'.repeat(5_000);
    const r = splitMessage(text, { maxBytes: 500, maxSegments: 3 });
    assert.equal(r.segments.length, 3);
    assertShape(text, r, 500);
    assert.ok(r.omittedChars > 0);
    assert.throws(() => splitMessage(text, { maxBytes: 100 }), RangeError);
    assert.throws(() => splitMessage(text, { maxSegments: 0 }), RangeError);
  });

  test('S12 单个字素簇比一段预算还大：退到码点边界切，不产生空段 / 零长度 range / 超预算段 / 落单代理', () => {
    const big = [
      ['e + 3 万个组合符', `e${'\u0301'.repeat(30_000)}`],
      ['a + 3 万个零宽连接符', `a${'\u200d'.repeat(30_000)}`],
      ['3 万个韩文初声', '\u1100'.repeat(30_000)],
      ['中间夹一个 2.6 万字节的簇', `${'正常开头。'.repeat(100)}e${'\u0301'.repeat(13_000)} 结尾`],
    ];
    for (const [name, text] of big) {
      const r = splitMessage(text);
      assertShape(text, r);
      assert.ok(r.segments.length >= 2 && r.segments.length <= MAX_SEGMENTS, name);
      assert.equal(r.omittedChars, 0, name);
      assert.equal(r.ranges.at(-1)[1], text.length, name);
      r.ranges.forEach(([a, b], i) => assert.ok(b > a, `${name}：第 ${i + 1} 段 range 长度为 0`));
      r.segments.forEach((seg, i) => assert.ok(seg.length > 0, `${name}：第 ${i + 1} 段为空`));
      assert.equal(covered(text, r.ranges), cps(text), name);
      assert.equal(r.segments.join(''), text, name);
      for (const [, end] of r.ranges.slice(0, -1)) {
        const prev = text.charCodeAt(end - 1); const next = text.charCodeAt(end);
        assert.ok(!(prev >= 0xd800 && prev < 0xdc00), `${name}：段以落单高代理结尾`);
        assert.ok(!(next >= 0xdc00 && next < 0xe000), `${name}：段以落单低代理开头`);
      }
    }
  });

  test('S12b 超大簇里带增补平面字符：仍不切代理对', () => {
    const text = `a${'\u200d😀'.repeat(15_000)}`; // 一个簇（ZWJ 序列），约 11 万字节
    const r = splitMessage(text);
    assertShape(text, r);
    assert.ok(r.segments.length >= 4);
    assert.equal(r.segments.join(''), text);
    for (const [, end] of r.ranges.slice(0, -1)) {
      assert.ok(!(text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) < 0xdc00));
      assert.ok(!(text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) < 0xe000));
    }
  });

  test('S11 同输入同输出', () => {
    const text = `${'汉'.repeat(500)}\n\`\`\`js\n${'x();\n'.repeat(9_000)}\`\`\`\n${tableTextFor()}`;
    assert.deepEqual(splitMessage(text), splitMessage(text));
  });
});

function tableTextFor() {
  return `| a | b |\n|---|---|\n${'| 1 | 汉汉汉汉汉汉汉汉汉汉 |\n'.repeat(900)}`;
}
