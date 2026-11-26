import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLAUDE_URL = new URL('../src/claude.js', import.meta.url).href;
const DENIED = '本地路径受保护，已拒绝\n';
const BLOCKED = 'lark_cli_secret_path_blocked\n';
const STDIN = '8J+ZiQD/AAo=';
const POSIX = { skip: process.platform === 'win32' && '使用 POSIX 可执行桩' };
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";

function fakeBin(root, bin, program) {
  const js = path.join(root, path.basename(bin) + '.cjs');
  fs.writeFileSync(js, program);
  fs.writeFileSync(bin, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(js) + ' "$@"\n', { mode: 0o700 });
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sec2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  const bin = path.join(root, "real bin's path");
  const guest = path.join(root, 'guest');
  for (const dir of [home, cwd, guest, bin, path.join(root, 'tmp')]) fs.mkdirSync(dir);
  const claude = path.join(bin, 'claude');
  fakeBin(root, path.join(bin, 'lark-cli'), [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const stdin = fs.readFileSync(0).toString('base64');",
    "process.stdout.write(JSON.stringify({ args, stdin, cwd: process.cwd() }));",
    "process.stderr.write('fake lark-cli stderr\\n');",
    "process.exitCode = 37;",
  ].join('\n'));
  fakeBin(root, claude, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { spawnSync } = require('node:child_process');",
    "const commands = JSON.parse(fs.readFileSync(0, 'utf8'));",
    "const results = commands.map((args) => {",
    "  const { status, stdout, stderr, error } = spawnSync('lark-cli', args, {",
    "    input: Buffer.from('" + STDIN + "', 'base64'), encoding: 'utf8', timeout: 4000,",
    "  });",
    "  if (error) throw error;",
    "  return { status, stdout, stderr };",
    "});",
    "const PATH = process.env.PATH;",
    "const entries = fs.readdirSync(PATH.split(path.delimiter)[0]);",
    "const result = JSON.stringify({ results, PATH, entries });",
    "process.stdout.write(JSON.stringify({ type: 'result', result }) + '\\n');",
  ].join('\n'));
  const originalPath = [bin, '/usr/bin', '/bin'].join(path.delimiter);
  return {
    home, cwd, root, originalPath,
    run(commands, { profile = 'legacy', isOwner = true, opts = { chatType: 'p2p' }, homeDir = home } = {}) {
      const env = {
        HOME: homeDir, PATH: originalPath, TMPDIR: path.join(root, 'tmp'),
        DATA_DIR: path.join(root, 'data'), WORKSPACE_DIR: cwd, GUEST_WORKSPACE_DIR: guest,
        CLAUDE_BIN: claude, OWNER_TOOL_PROFILE: profile, FEISHU_TOOLS: 'false', LARK_CLI: 'true', OWNER_EXTRA_SKILLS: '',
      };
      const script = [
        "import { runClaude } from " + JSON.stringify(CLAUDE_URL) + ";",
        "const { commands, isOwner, opts } = JSON.parse(process.argv[1]);",
        "const result = await runClaude('sec2-fixture', JSON.stringify(commands), isOwner, [], null, opts);",
        "console.log('FIXTURE_RESULT ' + result);",
      ].join('\n');
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ commands, isOwner, opts })], {
        env, cwd: root, encoding: 'utf8', timeout: 20_000,
      });
      assert.ifError(r.error);
      assert.equal(r.status, 0, r.stderr);
      const line = r.stdout.split('\n').find((value) => value.startsWith('FIXTURE_RESULT '));
      assert.ok(line, r.stdout);
      return { ...JSON.parse(line.slice('FIXTURE_RESULT '.length)), bridgeLog: r.stderr };
    },
  };
}

function assertBlocked(results) {
  for (const result of results) {
    assert.ok(result.status > 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, DENIED);
  }
}

test('独立参数、等号和 @ 形式命中时不启动真实 CLI，桥日志只记录事件码', POSIX, (t) => {
  const f = setup(t);
  const commands = [
    ['upload', path.join(f.root, '.envrc')],
    ['upload', '--payload=' + path.join(f.home, '.config', 'gh', 'sample')],
    ['upload', '@' + path.join(f.home, '.config', 'feishu-test', 'sample')],
    ['upload', '--payload=@~/Library/Application Support/lark-cli/sample'],
    ['upload', '--', '../home/.claude-b/projects/session.jsonl'],
    ['upload', '--payload', '~/repo/nested/.env.sample'],
    ['upload', '~/repo/.env.with=equals'],
  ];
  const { results, bridgeLog } = f.run(commands);
  assertBlocked(results);
  assert.equal(bridgeLog, BLOCKED.repeat(commands.length));
});

test('软链的真实目标、真实父目录及物理 .. 路径都受保护', POSIX, (t) => {
  const f = setup(t);
  const keyDir = path.join(f.home, '.ssh');
  const nested = path.join(keyDir, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  fs.closeSync(fs.openSync(path.join(keyDir, 'sample'), 'wx'));
  fs.closeSync(fs.openSync(path.join(f.root, '.env.fixture'), 'wx'));
  fs.symlinkSync(path.join(keyDir, 'sample'), path.join(f.cwd, 'neutral.txt'));
  fs.symlinkSync(path.join(f.root, '.env.fixture'), path.join(f.cwd, 'config.txt'));
  fs.symlinkSync(nested, path.join(f.cwd, 'nested'));
  fs.symlinkSync(f.home, path.join(f.root, 'linked-home'));
  fs.mkdirSync(path.join(f.root, 'redirected'));
  fs.closeSync(fs.openSync(path.join(f.root, 'redirected', 'sample'), 'wx'));
  fs.symlinkSync(path.join(f.root, 'redirected'), path.join(f.home, '.docker'));
  const { results, bridgeLog } = f.run([
    ['upload', 'neutral.txt'], ['upload', 'config.txt'],
    ['upload', 'nested/../sample'], ['upload', 'nested/new-output'],
    ['upload', path.join(f.root, 'redirected', 'sample')],
  ], { homeDir: path.join(f.root, 'linked-home') });
  assertBlocked(results);
  assert.equal(bridgeLog, BLOCKED.repeat(results.length));
});

test('owner 三档与定时 owner 回合走同一包装，正常参数、stdin 和退出码透传', POSIX, (t) => {
  const f = setup(t);
  const args = ['upload', '--label=a b=c', 'literal $(a)', '../home/.ssh-backup/report.txt', 'https://example.test/.env'];
  const cases = [
    { profile: 'legacy' }, { profile: 'audit' }, { profile: 'strict' },
    { profile: 'strict', opts: { toolProfile: 'sched', schedDest: 'owner-p2p' } },
  ];
  for (const options of cases) {
    const { PATH, entries, results, bridgeLog } = f.run([args, ['upload', '~/repo/.env']], options);
    const [prefix, ...tail] = PATH.split(path.delimiter);
    assert.equal(tail.join(path.delimiter), f.originalPath);
    assert.deepEqual(entries, ['lark-cli']);
    assert.equal(fs.existsSync(prefix), false, '回合结束后清理包装目录');
    const [accepted, rejected] = results;
    assert.equal(accepted.status, 37);
    assert.equal(accepted.stderr, 'fake lark-cli stderr\n');
    assert.deepEqual(JSON.parse(accepted.stdout), { args, stdin: STDIN, cwd: fs.realpathSync(f.cwd) });
    assertBlocked([rejected]);
    assert.equal(bridgeLog, BLOCKED);
  }
});

test('访客、owner 群聊、发往群的定时都保持原 PATH', POSIX, (t) => {
  const f = setup(t);
  for (const options of [
    { isOwner: false }, { opts: { chatType: 'group' } },
    { profile: 'strict', opts: { toolProfile: 'sched', schedDest: 'other' } },
  ]) {
    const { PATH, bridgeLog } = f.run([['--help']], options);
    assert.equal(PATH, f.originalPath);
    assert.equal(bridgeLog, '');
  }
});
