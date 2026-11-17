// BRIDGE-PERM-2 R1：audit/strict 技能同步加固的回归。
//   R1-1 整树重建：.claude/skills 里的存量外来技能 / 软链不再保留，进隔离目录；
//   R1-2 目的地写穿：旧树里的软链不会被跟随写穿（CLAUDE.md 不变）；copySkillTree 目的地已存在即抛错（wx / COPYFILE_EXCL）；
//   R1-3 frontmatter 白名单重建：CLI 可见的 frontmatter 只含 name/description/version/metadata，否则整个技能不拷；
//   R1-4 修法 A：白名单 lark-* 顶层软链按 realpath 解引用（只认两个允许根的直接子目录）；
//   R1-5 .claude 本身是软链 / 文件：只挪链接本身，不跟随，.claude 重建为真目录。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_ENV, seedSkillWorkspace } from './fixtures/perm2-legacy-matrix.mjs';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'perm2-r1-')));
const P = { ws: path.join(TMP, 'ws'), gws: path.join(TMP, 'gws'), data: path.join(TMP, 'data'), home: path.join(TMP, 'home') };
for (const d of [P.ws, P.gws, P.data, P.home]) fs.mkdirSync(d, { recursive: true });
process.env.WORKSPACE_DIR = P.ws;
process.env.GUEST_WORKSPACE_DIR = P.gws;
process.env.DATA_DIR = P.data;
process.env.HOME = P.home;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ } });

// 假 claude CLI：吞掉 stdin，吐出固定的 system-init + result-success
const FAKE = path.join(TMP, 'fake-claude.sh');
fs.writeFileSync(FAKE, '#!/bin/sh\ncat > /dev/null\ncat "$FAKE_STREAM"\n', { mode: 0o755 });
process.env.CLAUDE_BIN = FAKE;
process.env.FAKE_STREAM = path.join(TMP, 'stream.jsonl');
fs.writeFileSync(process.env.FAKE_STREAM, [
  { type: 'system', subtype: 'init', session_id: 's-r1' },
  { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's-r1' },
].map((e) => JSON.stringify(e)).join('\n') + '\n');

let seq = 0;
async function load(env) {
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...env })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const orig = console.error;
  console.error = () => {};
  try { return await import(`../src/claude.js?r1=${++seq}`); } finally { console.error = orig; }
}
async function capturing(fn) {
  const orig = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a.map(String).join(' '));
  try { return { result: await fn(), errs }; } finally { console.error = orig; }
}
const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const lst = (p) => fs.lstatSync(p, { throwIfNoEntry: false });
const CDIR = () => path.join(P.ws, '.claude');
const SDIR = () => path.join(P.ws, '.claude', 'skills');
const QDIR = () => path.join(P.ws, '.claude-quarantine');
const resetRound = () => {
  seedSkillWorkspace(P);
  for (const d of ['.claude-quarantine', '.claude-staging', 'CLAUDE.md', 'outside']) fs.rmSync(path.join(P.ws, d), { recursive: true, force: true });
  fs.rmSync(path.join(TMP, 'outside'), { recursive: true, force: true });
  fs.rmSync(P.data, { recursive: true, force: true });
  fs.mkdirSync(P.data, { recursive: true });
};
// 目录树里所有文件的内容（相对路径 → 内容 / 链接目标）
function snapshot(dir) {
  const out = {};
  const walk = (abs, rel) => {
    const st = lst(abs);
    if (!st) return;
    if (st.isSymbolicLink()) { out[rel] = `-> ${fs.readlinkSync(abs)}`; return; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(abs).sort()) walk(path.join(abs, n), rel ? `${rel}/${n}` : n); return; }
    out[rel] = fs.readFileSync(abs, 'utf8');
  };
  walk(dir, '');
  return out;
}
const CLI_FM = /^---\s*\n([\s\S]*?)---\s*\n?/; // claude CLI 2.1.325 安装包里的 frontmatter 正则（Yx）
const FM_KEY = /^(name|description|version|metadata):(?=[ \t]|$)/;

test('测PERM2-R1-1 整树重建：存量 .claude/skills/old（带 allowed-tools）与 old-link（软链）不留，隔离目录有 skills-old.*', async () => {
  for (const profile of ['audit', 'strict']) {
    resetRound();
    assert.ok(lst(path.join(SDIR(), 'old')) && lst(path.join(SDIR(), 'old-link')).isSymbolicLink(), '前提：种子里有存量技能与软链');
    const m = await load({ OWNER_TOOL_PROFILE: profile, OWNER_EXTRA_SKILLS: 'lark-im' });
    const { result } = await capturing(() => m.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat' }));
    assert.equal(result, 'ok', `${profile}：正常返回`);
    assert.ok(!lst(path.join(SDIR(), 'old')), `${profile}：存量 old 不在 .claude/skills`);
    assert.ok(!lst(path.join(SDIR(), 'old-link')), `${profile}：存量软链 old-link 不在 .claude/skills`);
    assert.deepEqual(fs.readdirSync(SDIR()).sort(), ['brief', 'lark-im', 'plain'], `${profile}：只剩本轮预期集合`);
    const q = fs.readdirSync(QDIR());
    assert.ok(q.some((n) => n.startsWith('skills-old.')), `${profile}：隔离目录有 skills-old.*`);
    assert.ok(q.some((n) => n.startsWith('skills-old-link.')), `${profile}：隔离目录有 skills-old-link.*`);
    // 整棵 .claude/skills 里没有任何软链、没有任何能力键
    const snap = snapshot(SDIR());
    for (const [rel, body] of Object.entries(snap)) {
      assert.ok(!body.startsWith('-> '), `${profile}：${rel} 不是软链`);
      if (/(^|\/)skill\.md$/i.test(rel)) {
        const fm = CLI_FM.exec(body)?.[1] ?? '';
        assert.ok(!/allowed|hooks|model|shell/i.test(fm), `${profile}：${rel} 的 CLI 可见 frontmatter 无能力键`);
      }
    }
    // 暂存树与 old- 目录都已清掉
    const staging = path.join(P.ws, '.claude-staging');
    assert.deepEqual(lst(staging) ? fs.readdirSync(staging) : [], [], `${profile}：暂存目录已清空`);
  }
});

test('测PERM2-R1-2 目的地写穿：.claude/skills/brief/run.sh 软链到 CLAUDE.md，跑一轮后 CLAUDE.md 不变', async () => {
  for (const profile of ['audit', 'strict']) {
    resetRound();
    const victim = path.join(P.ws, 'CLAUDE.md');
    fs.writeFileSync(victim, 'ORIGINAL-CLAUDE-MD\n');
    fs.mkdirSync(path.join(SDIR(), 'brief'), { recursive: true });
    fs.symlinkSync(victim, path.join(SDIR(), 'brief', 'run.sh'));
    fs.symlinkSync(victim, path.join(SDIR(), 'brief', 'SKILL.md'));
    const m = await load({ OWNER_TOOL_PROFILE: profile, OWNER_EXTRA_SKILLS: '' });
    const { result } = await capturing(() => m.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat' }));
    assert.equal(result, 'ok', `${profile}：正常返回`);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL-CLAUDE-MD\n', `${profile}：CLAUDE.md 内容不变`);
    const run = lst(path.join(SDIR(), 'brief', 'run.sh'));
    assert.ok(run && run.isFile() && !run.isSymbolicLink(), `${profile}：run.sh 是新写的普通文件`);
    assert.equal(fs.readFileSync(path.join(SDIR(), 'brief', 'run.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
  }
});

test('测PERM2-R1-2b copySkillTree：目的地已存在（含软链）即抛错，不跟随写穿', async () => {
  const m = await load({ OWNER_TOOL_PROFILE: 'strict' });
  const dir = fs.mkdtempSync(path.join(TMP, 'excl-'));
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'VICTIM\n');
  put(path.join(dir, 'src', 'run.sh'), '#!/bin/sh\n');
  put(path.join(dir, 'src', 'SKILL.md'), '---\nname: x\n---\nbody\n');
  for (const f of ['run.sh', 'SKILL.md']) {
    const dest = path.join(dir, `dest-${f}`);
    fs.symlinkSync(victim, dest);
    assert.throws(() => m.copySkillTree(path.join(dir, 'src', f), dest, { strip: true }), /EEXIST/, `${f}：目的地是软链时抛 EEXIST`);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM\n', `${f}：软链目标不被写穿`);
  }
  const existing = path.join(dir, 'dest-existing');
  fs.writeFileSync(existing, 'OLD\n');
  assert.throws(() => m.copySkillTree(path.join(dir, 'src', 'run.sh'), existing), /EEXIST/, '目的地普通文件已存在也抛错');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'OLD\n');
});

// fm-probe.mjs 的 9 种变体 + 真实 lark 形状
const FM_CASES = {
  'fm-open-space': '--- \nname: x\nallowed-tools: Bash(*)\n---\nbody\n',
  'fm-open-tab': '---\t\nname: x\nallowed-tools: Bash(*)\n---\nbody\n',
  'fm-indented': '---\n name: x\n allowed-tools: Bash(*)\n---\nbody\n',
  'fm-flow': '---\n{name: x, allowed-tools: "Bash(*)"}\n---\nbody\n',
  'fm-escaped': '---\nname: x\n"allowed\\x2dtools": Bash(*)\n---\nbody\n',
  'fm-explicit': '---\nname: x\n? allowed-tools\n: Bash(*)\n---\nbody\n',
  'fm-model-shell': '---\nname: x\nmodel: opus\nshell: bash\n---\nbody\n',
  'fm-close-space': '---\nname: x\nallowed-tools: Bash(*)\n--- \nbody\n',
  'fm-plain': '---\nname: x\nallowed-tools: Bash(*)\n---\nbody\n',
};
const LARK_SHAPE = [
  '---',
  'name: lark-im',
  'version: 1.0.0',
  'description: "飞书即时通讯：收发消息和管理群聊。当用户需要发消息、查看或搜索聊天记录时使用。"',
  'metadata:',
  '  requires:',
  '    bins: ["lark-cli"]',
  '  cliHelp: "lark-cli im --help"',
  '---',
  '',
  '# im (v1)',
  '',
  '**CRITICAL — 开始前 MUST 先用 Read 工具读取 [`../lark-shared/SKILL.md`](../lark-shared/SKILL.md)**',
  '',
].join('\n');

test('测PERM2-R1-3 frontmatter 白名单重建：9 种变体要么只剩白名单键、要么不拷；真实 lark 形状原样保留', async () => {
  for (const profile of ['audit', 'strict']) {
    resetRound();
    for (const [name, body] of Object.entries(FM_CASES)) put(path.join(P.ws, 'skills', name, 'SKILL.md'), body);
    put(path.join(P.ws, 'skills', 'fm-lark-shape', 'SKILL.md'), LARK_SHAPE);
    const m = await load({ OWNER_TOOL_PROFILE: profile, OWNER_EXTRA_SKILLS: '' });
    const { result, errs } = await capturing(() => m.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat' }));
    assert.equal(result, 'ok');
    for (const name of Object.keys(FM_CASES)) {
      const file = path.join(SDIR(), name, 'SKILL.md');
      if (!lst(file)) {
        assert.ok(!lst(path.join(SDIR(), name)), `${profile}/${name}：不拷就整个技能都不在`);
        assert.ok(errs.some((l) => l.includes(name)), `${profile}/${name}：不拷要记日志`);
        continue;
      }
      const out = fs.readFileSync(file, 'utf8');
      const fm = CLI_FM.exec(out)?.[1] ?? '';
      for (const line of fm.split('\n')) {
        if (line === '' || line.startsWith(' ')) continue;
        assert.match(line, FM_KEY, `${profile}/${name}：CLI 可见 frontmatter 的顶层行只能是白名单键`);
      }
      assert.ok(!/allowed|model|shell|hooks/i.test(fm), `${profile}/${name}：CLI 可见 frontmatter 不含能力键`);
      assert.ok(out.endsWith('body\n'), `${profile}/${name}：正文不变`);
    }
    // 对照：正常形保留 name、剥 allowed-tools
    assert.equal(fs.readFileSync(path.join(SDIR(), 'fm-plain', 'SKILL.md'), 'utf8'), '---\nname: x\n---\nbody\n', `${profile}：正常形只剩 name`);
    // CLI 一定会认的开头/结尾变体必须不拷
    for (const name of ['fm-open-space', 'fm-open-tab', 'fm-close-space']) {
      assert.ok(!lst(path.join(SDIR(), name)), `${profile}/${name}：分隔行带空白的不拷`);
    }
    assert.equal(fs.readFileSync(path.join(SDIR(), 'fm-lark-shape', 'SKILL.md'), 'utf8'), LARK_SHAPE, `${profile}：真实 lark 形状原样保留`);
  }
});

test('测PERM2-R1-3b frontmatter：BOM、CRLF、无 frontmatter、前导空行', async () => {
  resetRound();
  const cases = {
    'b-bom': ['﻿---\nname: b\nallowed-tools: Bash(*)\n---\nbody\n', '---\nname: b\n---\nbody\n'],
    'b-crlf': ['---\r\nname: c\r\nhooks: {}\r\n---\r\nbody\r\n', '---\nname: c\n---\nbody\r\n'],
    'b-none': ['# 无 frontmatter\nallowed-tools: x\n', '# 无 frontmatter\nallowed-tools: x\n'],
    'b-lead-blank': ['\n---\nname: d\nallowed-tools: x\n---\nbody\n', '\n---\nname: d\nallowed-tools: x\n---\nbody\n'],
    'b-desc-block': ['---\nname: e\ndescription: |\n  第一行\n  第二行\nallowed-tools: x\n  续行也丢\nversion: 2\n---\nbody\n',
      '---\nname: e\ndescription: |\n  第一行\n  第二行\nversion: 2\n---\nbody\n'],
  };
  for (const [name, [body]] of Object.entries(cases)) put(path.join(P.ws, 'skills', name, 'SKILL.md'), body);
  const m = await load({ OWNER_TOOL_PROFILE: 'strict', OWNER_EXTRA_SKILLS: '' });
  await capturing(() => m.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat' }));
  for (const [name, [, want]] of Object.entries(cases)) {
    assert.equal(fs.readFileSync(path.join(SDIR(), name, 'SKILL.md'), 'utf8'), want, name);
  }
  // 前导空行的 CLI 不当 frontmatter（Yx 锚在 ^---），原样拷，CLI 看不到能力键
  assert.equal(CLI_FM.exec(cases['b-lead-blank'][0]), null);
});

// ---------- 修法 A：白名单 lark-* 顶层软链解引用 ----------
function seedHomeA(home) {
  fs.rmSync(home, { recursive: true, force: true });
  const skill = (dir, name) => put(path.join(dir, 'SKILL.md'), `---\nname: ${name}\nallowed-tools: Bash(*)\n---\n# ${name}\n`);
  const agents = path.join(home, '.agents', 'skills');
  const claude = path.join(home, '.claude', 'skills');
  fs.mkdirSync(claude, { recursive: true });
  skill(path.join(agents, 'lark-a'), 'lark-a');
  fs.symlinkSync('../../.agents/skills/lark-a', path.join(claude, 'lark-a')); // 1 直接子目录 → 拷
  skill(path.join(claude, 'lark-target'), 'lark-target');
  fs.symlinkSync('lark-target', path.join(claude, 'lark-b')); // 2 链到 .claude/skills 根下另一个真目录 → 拷
  skill(path.join(home, 'evil', 'lark-c'), 'lark-c');
  fs.symlinkSync('../../evil/lark-c', path.join(claude, 'lark-c')); // 3 逃出两个根 → 拒
  fs.symlinkSync('../../.agents/skills', path.join(claude, 'lark-d')); // 4 链到根本身 → 拒
  skill(path.join(agents, 'nest', 'lark-e'), 'lark-e');
  fs.symlinkSync('../../.agents/skills/nest/lark-e', path.join(claude, 'lark-e')); // 5 更深层级 → 拒
  skill(path.join(agents, 'lark-f'), 'lark-f');
  fs.symlinkSync(path.join(agents, 'lark-f'), path.join(home, 'hop'));
  fs.symlinkSync('../../hop', path.join(claude, 'lark-f')); // 6 两跳，最终落在根内 → 拷
  fs.symlinkSync('../../nowhere/lark-g', path.join(claude, 'lark-g')); // 7 悬空 → 跳过、只警告一次
  skill(path.join(claude, 'lark-r'), 'lark-r'); // 普通真目录 → 照旧拷
}

test('测PERM2-R1-4 修法 A：直接子目录 / 两跳 / 普通目录拷；逃逸 / 根本身 / 更深 / 悬空拒（只警告一次）', async () => {
  const home = path.join(TMP, 'home-a');
  seedHomeA(home);
  const m = await load({ OWNER_TOOL_PROFILE: 'audit' });
  const LIST = 'lark-a,lark-c,lark-d,lark-e,lark-f,lark-g,lark-r';
  const run = () => {
    const dest = fs.mkdtempSync(path.join(TMP, 'dest-a-'));
    return capturing(() => ({ dest, copied: m.syncExtraSkills({ home, workspace: P.ws, list: LIST, dest }) }));
  };
  const first = await run();
  const { dest, copied } = first.result;
  assert.deepEqual(copied.sort(), ['lark-a', 'lark-f', 'lark-r'], '只拷直接子目录、两跳落在根内、普通目录');
  assert.deepEqual(fs.readdirSync(dest).sort(), ['lark-a', 'lark-f', 'lark-r']);
  for (const n of ['lark-a', 'lark-f', 'lark-r']) {
    const st = lst(path.join(dest, n));
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), `${n}：拷成真目录（源用 realpath，不经过链接）`);
    const body = fs.readFileSync(path.join(dest, n, 'SKILL.md'), 'utf8');
    assert.equal(body, `---\nname: ${n}\n---\n# ${n}\n`, `${n}：SKILL.md 同样过白名单重建`);
  }
  for (const n of ['lark-c', 'lark-d', 'lark-e', 'lark-g']) {
    assert.ok(first.errs.some((l) => l.includes(n)), `${n}：拒绝要记日志`);
  }
  assert.ok(!lst(path.join(dest, 'lark-d')), '链到根本身不拷（否则整个技能库被拷进来）');
  // 第二轮：悬空链接不再重复警告
  const second = await run();
  assert.deepEqual(second.result.copied.sort(), ['lark-a', 'lark-f', 'lark-r']);
  const dangling = [...first.errs, ...second.errs].filter((l) => l.includes('lark-g'));
  assert.equal(dangling.length, 1, '悬空链接只警告一次');
});

test('测PERM2-R1-4b 修法 A：链到 .claude/skills 根下另一个真目录 → 拷', {
  skip: '停卡项：与 test/owner-profiles.test.js 测12（lark-link → lark-real 断言不拷）冲突，见 DELIVERY R1 Open questions',
}, async () => {
  const home = path.join(TMP, 'home-a');
  seedHomeA(home);
  const m = await load({ OWNER_TOOL_PROFILE: 'audit' });
  const dest = fs.mkdtempSync(path.join(TMP, 'dest-b-'));
  const { result } = await capturing(() => m.syncExtraSkills({ home, workspace: P.ws, list: 'lark-b', dest }));
  assert.deepEqual(result, ['lark-b']);
});

test('测PERM2-R1-4c 修法 A：允许根本身是软链（.agents/skills -> real-skills）照样能拷', async () => {
  const home = path.join(TMP, 'home-c');
  fs.rmSync(home, { recursive: true, force: true });
  put(path.join(home, 'real-skills', 'lark-h', 'SKILL.md'), '---\nname: lark-h\n---\n# lark-h\n');
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.symlinkSync('../real-skills', path.join(home, '.agents', 'skills'));
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync('../../.agents/skills/lark-h', path.join(home, '.claude', 'skills', 'lark-h'));
  const m = await load({ OWNER_TOOL_PROFILE: 'strict' });
  const dest = fs.mkdtempSync(path.join(TMP, 'dest-c-'));
  const { result } = await capturing(() => m.syncExtraSkills({ home, workspace: P.ws, list: 'lark-h', dest }));
  assert.deepEqual(result, ['lark-h']);
  assert.equal(fs.readFileSync(path.join(dest, 'lark-h', 'SKILL.md'), 'utf8'), '---\nname: lark-h\n---\n# lark-h\n');
});

test('测PERM2-R1-4d 修法 A 经整轮同步：本机布局（~/.claude/skills/lark-im -> ../../.agents/skills/lark-im）在 audit/strict 下拷进来', async () => {
  for (const profile of ['audit', 'strict']) {
    resetRound();
    const claude = path.join(P.home, '.claude', 'skills');
    fs.rmSync(path.join(claude, 'lark-im'), { recursive: true, force: true });
    put(path.join(P.home, '.agents', 'skills', 'lark-im', 'SKILL.md'), LARK_SHAPE);
    fs.symlinkSync('../../.agents/skills/lark-im', path.join(claude, 'lark-im'));
    const m = await load({ OWNER_TOOL_PROFILE: profile, OWNER_EXTRA_SKILLS: 'lark-im' });
    await capturing(() => m.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat' }));
    const st = lst(path.join(SDIR(), 'lark-im'));
    assert.ok(st && st.isDirectory() && !st.isSymbolicLink(), `${profile}：lark-im 拷成真目录`);
    assert.equal(fs.readFileSync(path.join(SDIR(), 'lark-im', 'SKILL.md'), 'utf8'), LARK_SHAPE, `${profile}：lark-im 原样（只有白名单键）`);
    fs.rmSync(path.join(P.home, '.agents'), { recursive: true, force: true });
  }
});

test('测PERM2-R1-5 .claude 本身是软链（指向 outside/）：outside 原样不动，.claude 变真目录，隔离目录里有那条软链', async () => {
  for (const profile of ['audit', 'strict']) {
    resetRound();
    const outside = path.join(TMP, 'outside');
    put(path.join(outside, 'settings.json'), '{"permissions":{"allow":["Bash(*)"]}}\n');
    put(path.join(outside, 'skills', 'x', 'SKILL.md'), '---\nname: x\nallowed-tools: Bash(*)\n---\nx\n');
    const before = snapshot(outside);
    fs.rmSync(CDIR(), { recursive: true, force: true });
    fs.symlinkSync(outside, CDIR());
    const m = await load({ OWNER_TOOL_PROFILE: profile, OWNER_EXTRA_SKILLS: '' });
    const { result } = await capturing(() => m.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat' }));
    assert.equal(result, 'ok', `${profile}：正常返回`);
    assert.deepEqual(snapshot(outside), before, `${profile}：outside/ 原样不动`);
    const st = lst(CDIR());
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), `${profile}：.claude 变成真目录`);
    assert.deepEqual(fs.readdirSync(SDIR()).sort(), ['brief', 'plain'], `${profile}：技能照常重建`);
    const links = fs.readdirSync(QDIR()).filter((n) => n.startsWith('.claude.'));
    assert.equal(links.length, 1, `${profile}：隔离目录里有那条软链`);
    assert.ok(lst(path.join(QDIR(), links[0])).isSymbolicLink(), `${profile}：挪走的是链接本身`);
  }
});

test('测PERM2-R1-5b 隔离目录 / 暂存目录存在但不是真目录：strict 抛「启动失败」，audit 记日志继续', async () => {
  for (const name of ['.claude-quarantine', '.claude-staging']) {
    for (const kind of ['link', 'file']) {
      for (const profile of ['strict', 'audit']) {
        resetRound();
        const target = path.join(TMP, 'outside');
        fs.mkdirSync(target, { recursive: true });
        if (kind === 'link') fs.symlinkSync(target, path.join(P.ws, name));
        else fs.writeFileSync(path.join(P.ws, name), 'x');
        const m = await load({ OWNER_TOOL_PROFILE: profile, OWNER_EXTRA_SKILLS: '' });
        const res = await capturing(async () => {
          try { return await m.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat' }); } catch (e) { return e; }
        });
        if (profile === 'strict') {
          assert.ok(res.result instanceof Error && /启动失败/.test(res.result.message), `${name}/${kind}/strict：抛启动失败`);
          assert.ok(lst(path.join(CDIR(), 'settings.json')), `${name}/${kind}/strict：外来 settings.json 未动，也没跑`);
        } else {
          assert.equal(res.result, 'ok', `${name}/${kind}/audit：继续`);
          assert.ok(res.errs.some((l) => l.includes('[skills-sync]')), `${name}/${kind}/audit：记日志`);
        }
        assert.deepEqual(fs.readdirSync(target), [], `${name}/${kind}/${profile}：不跟随写进链接目标`);
        fs.rmSync(path.join(P.ws, name), { recursive: true, force: true });
      }
    }
  }
});
