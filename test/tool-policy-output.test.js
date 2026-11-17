// BRIDGE-PERM-2：strict/audit 下写文件落点闸。纯函数 checkOutputTargets/outputTargets 的合成用例、
// 真实目录树里的符号链接逃逸、经审计收集器的 judge 闸（有/无 workspace）、output-guard 钩子子进程、
// 以及词法器改动后分类结果对基线的逐字回归（语料在夹具里，断言从不回显命令本身）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkOutputTargets, outputTargets, classifySegments, classifyCommand } from '../src/tool-policy.js';
import { createToolRecorder } from '../src/tool-audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ---------- 纯词法用例：realpath/readlink 注入 null → 纯词法解析，不碰 fs ----------
const PURE = { cwd: '/ws', workspace: '/ws', tmpDirs: ['/tmp'], realpath: null, readlink: null, home: '/home/u', vars: {} };
const run = (cmd, opts = PURE) => checkOutputTargets(cmd, opts);

test('测PERM2-out1 outputTargets：hasLark 识别与落点抽取', () => {
  assert.equal(outputTargets('lark-cli im +chat-list > a.json').hasLark, true);
  assert.equal(outputTargets('echo hi > a.json').hasLark, false, '非 lark 命令不算 lark');
  assert.deepEqual(outputTargets('lark-cli im +chat-list > a.json').targets.map((t) => t.target), ['a.json']);
  assert.deepEqual(outputTargets('lark-cli im +chat-list --output b.json').targets.map((t) => t.target), ['b.json']);
  assert.deepEqual(outputTargets('cd skills && lark-cli im +chat-list > a').cds.map((c) => c.target), ['skills']);
});

test('测PERM2-out2 lark 读命令：落点在 outbox/临时目录放行，其它一律拒', () => {
  // 放行
  for (const cmd of [
    'lark-cli im +chat-list > outbox/a.json',
    'lark-cli im +chat-list >> outbox/a.json',
    'lark-cli im +chat-list --output outbox/a.json',
    'lark-cli im +chat-list -o outbox/a.json',
    'lark-cli im +chat-list | tee outbox/a.json',
    'lark-cli im +chat-list > /tmp/a.json',
  ]) {
    const r = run(cmd);
    assert.equal(r.ok, true, `应放行：${cmd.replace(/lark-cli.*?list/, 'lark …')}`);
    assert.equal(r.deny.length, 0);
  }
  // 拒绝 + 原因
  const want = [
    ['lark-cli im +chat-list > a.json', 'not-outbox'],
    ['lark-cli im +chat-list > .claude/x', 'protected'],
    ['lark-cli im +chat-list > skills/x', 'protected'],
    ['lark-cli im +chat-list > schedules/x', 'protected'],
    ['lark-cli im +chat-list > tasks/x', 'protected'],
    ['lark-cli im +chat-list > CLAUDE.md', 'protected'],
    ['lark-cli im +chat-list > .mcp.json', 'protected'],
    ['lark-cli im +chat-list -o skills/x', 'protected'],
    ['lark-cli im +chat-list | tee skills/x', 'protected'],
    ['lark-cli im +chat-list > /etc/x', 'outside'],
    ['lark-cli im +chat-list > "$HOME/x"', 'dynamic'],
    ['lark-cli im +chat-list > outbox/../skills/x', 'protected'],
  ];
  for (const [cmd, reason] of want) {
    const r = run(cmd);
    assert.equal(r.ok, false, `应拒绝：落点 ${reason}`);
    assert.ok(r.deny.some((d) => d.reason === reason), `原因含 ${reason}（实得 ${r.deny.map((d) => d.reason).join('/')}）`);
  }
});

test('测PERM2-out3 非 lark 命令：只有写进保护区才拒，写别处不管', () => {
  assert.equal(run('echo hi > a.json').ok, true, '非 lark 写工作区普通文件不限制');
  assert.equal(run('echo hi > /etc/a').ok, true, '非 lark 写区外不限制');
  const prot = run('echo hi > .claude/x');
  assert.equal(prot.ok, false);
  assert.ok(prot.deny.some((d) => d.reason === 'protected'));
});

test('测PERM2-out4 cd 进保护区：相对写一律拒（cwd-protected）', () => {
  const r = run('cd skills && lark-cli im +chat-list > a');
  assert.equal(r.ok, false);
  assert.ok(r.deny.some((d) => d.reason === 'cwd-protected' || d.reason === 'protected'));
});

test('测PERM2-out5 真实目录树：符号链接逃逸按物理路径判', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm2-sym-'));
  const ws = path.join(tmp, 'ws');
  for (const d of ['.claude', 'skills', 'outbox']) fs.mkdirSync(path.join(ws, d), { recursive: true });
  fs.symlinkSync(path.join(ws, '.claude'), path.join(ws, 'esc')); // esc → .claude
  fs.symlinkSync(path.join(ws, 'skills'), path.join(ws, 'outbox', 'up')); // outbox/up → skills
  const opts = {
    cwd: ws, workspace: ws, tmpDirs: [os.tmpdir(), '/tmp'],
    realpath: fs.realpathSync, readlink: (p) => { try { return fs.readlinkSync(p); } catch { return null; } },
    home: os.homedir(), vars: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  };
  try {
    assert.equal(checkOutputTargets('lark-cli im +chat-list > outbox/real.json', opts).ok, true, 'outbox 真实文件放行');
    assert.equal(checkOutputTargets('lark-cli im +chat-list > esc/x', opts).ok, false, 'esc→.claude 逃逸拒绝');
    assert.equal(checkOutputTargets('lark-cli im +chat-list > outbox/up/x', opts).ok, false, 'outbox/up→skills 逃逸拒绝');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 经审计收集器走 judge 闸：workspace 非空才过落点闸 ----------
test('测PERM2-out6 judge 闸：有 workspace 时 read 级 lark 写保护区落 deny；无 workspace 时按类放行', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm2-judge-'));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const decisionFor = (workspace) => {
    const file = path.join(tmp, `audit-${workspace ? 'ws' : 'nows'}.jsonl`);
    const rec = createToolRecorder({ kind: 'chat', profile: 'strict', confirm: false, workspace, file, log: { error() {} } });
    rec.assistant({ message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'lark-cli im +chat-list > .claude/x' } }] } });
    rec.flush();
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    return rows[0].decision;
  };
  try {
    assert.equal(decisionFor(ws), 'deny', 'read 级 lark 写 .claude：有 workspace 时被落点闸判 deny');
    assert.equal(decisionFor(null), 'allow', '无 workspace 时不过落点闸，按命令分类放行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- output-guard 钩子子进程：一律 fail closed，绝不 allow ----------
const GUARD = path.join(REPO, 'src', 'hooks', 'output-guard.js');
const runGuard = (argv, input) => spawnSync(process.execPath, [GUARD, ...argv], { input, encoding: 'utf8' });

test('测PERM2-out7 output-guard 钩子：越界写 deny JSON、合规静默、非 Bash 放行', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'perm2-guard-'));
  try {
    const deny = runGuard([ws], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'lark-cli im +chat-list > .claude/x' }, cwd: ws }));
    assert.equal(deny.status, 0);
    const j = JSON.parse(deny.stdout);
    assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /outbox/);

    const ok = runGuard([ws], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'lark-cli im +chat-list > outbox/x.json' }, cwd: ws }));
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout.trim(), '', '合规落点静默放行，不输出 allow');

    const nonbash = runGuard([ws], JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' }, cwd: ws }));
    assert.equal(nonbash.status, 0);
    assert.equal(nonbash.stdout.trim(), '', '非 Bash 放行');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('测PERM2-out8 output-guard 钩子 fail closed：坏输入 / 缺 workspace / 缺 command 都 exit 2', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'perm2-guard2-'));
  try {
    assert.equal(runGuard([ws], 'not json').status, 2, '坏输入 exit 2');
    assert.equal(runGuard([ws], JSON.stringify(['array'])).status, 2, '非对象 exit 2');
    assert.equal(runGuard([], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'x' } })).status, 2, '缺 workspace exit 2');
    assert.equal(runGuard(['relative/path'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'x' } })).status, 2, 'workspace 非绝对 exit 2');
    assert.equal(runGuard([ws], JSON.stringify({ tool_name: 'Bash', tool_input: {} })).status, 2, 'Bash 缺 command exit 2');
    // 绝不输出 allow（无论哪条分支）
    for (const out of [runGuard([ws], 'x').stdout, runGuard([ws], JSON.stringify({ tool_name: 'Bash', tool_input: {} })).stdout]) {
      assert.ok(!/allow/.test(out), '任何分支都不得 allow');
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------- 分类回归：词法器加了重定向记录后，分类结果必须与基线逐字相同 ----------
// 语料在夹具里（可能含攻击形状命令）；断言只比对 JSON 串、失败只报漂移下标，从不回显命令本身。
test('测PERM2-out9 分类回归：classifySegments/classifyCommand 对基线语料逐字不变', () => {
  const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'owner-perm2-legacy-16c0757.json'), 'utf8'));
  assert.ok(Array.isArray(FIXTURE.classify) && FIXTURE.classify.length >= 40, '语料至少 40 条');
  const driftSeg = [];
  const driftCmd = [];
  FIXTURE.classify.forEach((e, i) => {
    if (JSON.stringify(classifySegments(e.cmd)) !== JSON.stringify(e.segments)) driftSeg.push(i);
    if (JSON.stringify(classifyCommand(e.cmd)) !== JSON.stringify(e.command)) driftCmd.push(i);
  });
  assert.deepEqual(driftSeg, [], 'classifySegments 漂移的用例下标');
  assert.deepEqual(driftCmd, [], 'classifyCommand 漂移的用例下标');
});

// ---------- R1：隐式落点（下载类不带 --output 时落在 cwd；--download-resources 落 ./lark-im-resources/） ----------
test('测PERM2-R1-6 隐式落点：不带 --output 的下载 / --download-resources 在工作区根拒；cd 进 outbox 或显式 --output 放行', () => {
  for (const cmd of [
    'lark-cli drive +download --file-token t',
    'lark-cli im +messages-resources-download --message-id m --file-key k --type file',
    'lark-cli im +messages-resource-download --message-id m --file-key k',
    'lark-cli --as user drive +download --file-token t',
    'lark-cli im +chat-messages-list --chat-id oc_1 --download-resources',
    'lark-cli im +messages-mget --message-ids m --download-resources',
    'cd outbox/oc_1; lark-cli drive +download --file-token t', // cd 失败时仍落在工作区根：不认
    'cd outbox/oc_1 || true && lark-cli drive +download --file-token t',
    'echo x && lark-cli drive +download --file-token t',
    'cd outbox/oc_1 && cd ../.. && lark-cli drive +download --file-token t',
  ]) {
    const r = run(cmd);
    assert.equal(r.ok, false, `应拒绝：${cmd.slice(0, 40)}`);
    assert.ok(r.deny.some((d) => d.reason === 'not-outbox'), `原因 not-outbox（实得 ${r.deny.map((d) => d.reason).join('/')}）`);
  }
  assert.ok(outputTargets('lark-cli drive +download --file-token t').targets.some((t) => t.via === 'implicit' && t.target === '.'), '隐式落点 . 入列');
  assert.ok(outputTargets('lark-cli im +chat-messages-list --download-resources').targets.some((t) => t.target === './lark-im-resources/'), '--download-resources 落点入列');
  for (const cmd of [
    'cd outbox/oc_1 && lark-cli drive +download --file-token t',
    'lark-cli drive +download --file-token t --output ./outbox/oc_1/a',
    'lark-cli drive +download --file-token t -o outbox/oc_1/a',
    'lark-cli im +messages-resources-download --message-id m --file-key k --output ./outbox/oc_1/f',
    'cd outbox && cd oc_1 && lark-cli im +chat-messages-list --chat-id oc_1 --download-resources',
  ]) {
    const r = run(cmd);
    assert.equal(r.ok, true, `应放行：${cmd.slice(0, 40)}（实得 ${r.deny.map((d) => d.reason).join('/')}）`);
  }
  // 会话 cwd 已在本轮 outbox 里：不带 --output 也放行；cwd 在工作区根则拒
  assert.equal(run('lark-cli drive +download --file-token t', { ...PURE, cwd: '/ws/outbox/oc_1' }).ok, true, 'cwd 在 outbox 放行');
  assert.equal(run('lark-cli drive +download --file-token t', { ...PURE, cwd: '/ws' }).ok, false, 'cwd 在工作区根拒');
  // 不带 cwd 时按工作区根算
  assert.equal(run('lark-cli drive +download --file-token t', { ...PURE, cwd: null }).ok, false);
  // 非下载类不加隐式落点
  assert.equal(run('lark-cli im +chat-list').ok, true, '普通 read 命令不受影响');
});

test('测PERM2-R1-6b 隐式落点：真实目录树里 outbox/<轮> 是软链指回工作区根也拒', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'perm2-impl-')));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(ws, 'outbox', 'oc_1'), { recursive: true });
  fs.symlinkSync(ws, path.join(ws, 'outbox', 'up'));
  const opts = {
    cwd: ws, workspace: ws, tmpDirs: [os.tmpdir(), '/tmp'],
    realpath: fs.realpathSync, readlink: (p) => { try { return fs.readlinkSync(p); } catch { return null; } },
    home: os.homedir(), vars: {},
  };
  try {
    assert.equal(checkOutputTargets('cd outbox/oc_1 && lark-cli drive +download --file-token t', opts).ok, true);
    assert.equal(checkOutputTargets('cd outbox/up && lark-cli drive +download --file-token t', opts).ok, false, '软链回根拒');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('测PERM2-R1-6c 钩子拒绝文案：提示下载显式写 --output ./outbox/<本轮目录>/文件名', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'perm2-guard3-'));
  try {
    const r = runGuard([ws], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'lark-cli drive +download --file-token t' }, cwd: ws }));
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(j.hookSpecificOutput.permissionDecisionReason.includes('--output ./outbox/<本轮目录>/文件名'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------- R1：钩子模块加载失败 / 未捕获异常也 exit 2（不能 exit 1 fail open） ----------
test('测PERM2-R1-7 output-guard 钩子：拷到没有 ../tool-policy.js 的目录里跑，模块加载失败也 exit 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm2-guard4-'));
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.mkdirSync(ws);
  fs.copyFileSync(GUARD, path.join(dir, 'hooks', 'output-guard.js'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  try {
    const r = spawnSync(process.execPath, [path.join(dir, 'hooks', 'output-guard.js'), ws], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'lark-cli im +chat-list > .claude/x' }, cwd: ws }), encoding: 'utf8',
    });
    assert.equal(r.status, 2, `模块加载失败 exit 2（实得 ${r.status}）`);
    assert.ok(!/allow/.test(r.stdout), '不输出 allow');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- R1：--as= 前置写法在审计判定里判 deny（strict 的规则只生成 --as user / --as bot 前缀） ----------
test('测PERM2-R1-8 --as=user 前置：judge 判 deny（audit/strict、chat/sched），classifyCommand 的 class 不变', async () => {
  const { usesEqAsPrefix } = await import('../src/tool-policy.js');
  assert.equal(usesEqAsPrefix('lark-cli --as=user im +chat-list'), true);
  assert.equal(usesEqAsPrefix('echo 1 && lark-cli --as=bot im +chat-list'), true);
  assert.equal(usesEqAsPrefix('lark-cli --as user im +chat-list'), false);
  assert.equal(usesEqAsPrefix('lark-cli im +chat-list --as=user'), false, '只看子命令前的前置位');
  assert.equal(usesEqAsPrefix('echo --as=user'), false);
  const eq = 'lark-cli --as=user im +chat-list';
  assert.equal(classifyCommand(eq).class, classifyCommand('lark-cli --as user im +chat-list').class, 'class 不变');
  assert.equal(classifyCommand(eq).class, 'read');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm2-eqas-'));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const decisionFor = (profile, kind, command, workspace) => {
    const file = path.join(tmp, `audit-${profile}-${kind}-${workspace ? 'ws' : 'nows'}.jsonl`);
    fs.rmSync(file, { force: true });
    const rec = createToolRecorder({ kind, profile, confirm: false, workspace, file, log: { error() {} } });
    rec.assistant({ message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] } });
    rec.flush();
    return JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n')[0]).decision;
  };
  try {
    for (const profile of ['audit', 'strict']) {
      for (const kind of ['chat', 'sched']) {
        for (const workspace of [ws, null]) {
          assert.equal(decisionFor(profile, kind, eq, workspace), 'deny', `${profile}/${kind}/${workspace ? 'ws' : 'nows'}：--as= 前置判 deny`);
          assert.equal(decisionFor(profile, kind, 'lark-cli --as user im +chat-list', workspace), 'allow', `${profile}/${kind}：--as user 照旧 allow`);
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- R2：隐式落点所在那一段自己改了目录（env -C / --chdir / 嵌套 sh -c 里的 cd）→ 不按 cd 链判，退回全部 base ----------
test('测PERM2-R2-4 隐式落点：本段用 env -C / --chdir / 嵌套 sh -c 的 cd 改了目录就拒；纯 cd 链进 outbox 照旧放行', () => {
  const OUTBOX = { ...PURE, cwd: '/ws/outbox/oc_1' };
  for (const [label, cmd, opts] of [
    ['cd 链 + env -C ../..', 'cd outbox/oc_1 && env -C ../.. lark-cli drive +download --file-token t', PURE],
    ['cwd 在 outbox + env --chdir=../..', 'env --chdir=../.. lark-cli drive +download --file-token t', OUTBOX],
    ['cwd 在 outbox + env -C ../..（资源下载）', 'env -C ../.. lark-cli im +messages-resources-download --message-id m --file-key f', OUTBOX],
    ['cd 链 + 嵌套 sh -c 里的 cd ../..', "cd outbox/oc_1 && sh -c 'cd ../.. && lark-cli drive +download --file-token t'", PURE],
  ]) {
    const r = run(cmd, opts);
    const got = r.deny.map((d) => `${d.reason}:${d.target}`).join('/');
    assert.equal(r.ok, false, `应拒绝：${label}`);
    assert.ok(r.deny.some((d) => d.target === '.'), `${label}：拒的是隐式落点 . 本身（实得 ${got}）`);
  }
  const keep = run('cd outbox/oc_1 && lark-cli drive +download --file-token t');
  assert.equal(keep.ok, true, `纯 cd 链进 outbox 仍放行（实得 ${keep.deny.map((d) => d.reason).join('/')}）`);
  // 对照：不带 -C / --chdir 的 env 前缀不新增 cd，cwd 已在 outbox 时照旧放行
  assert.equal(run('env FOO=1 lark-cli drive +download --file-token t', OUTBOX).ok, true, 'env 只设变量不改目录：放行');
});
