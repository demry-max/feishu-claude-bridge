// npm run setup / doctor --json / register 两段式 / install-service ExitTimeOut 的测试。
// 不调真实 claude（用 stub 脚本）、不连飞书（--no-network）、不装服务（HOME 指向临时目录）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseEnvText, checkNodeVersion, checkDeps, checkClaudeCli, checkClaudeAuth, maskEmail, ensureEnvFile,
  checkRequiredEnv, checkEnvSanity, checkShadowed, validOpenId, findOwnerCandidates, withExitTimeout,
  plistExitTimeout, plistEnvPath, checkService, exitCodeFor, toJson, scrubSecrets, renderLine,
  ownerHint, plistWorkingDir, serviceLabelConflict, ownerLogFiles,
} from '../scripts/lib/checks.js';
import {
  parseRegisterArgs, chooseMode, guardExisting, savePending, loadPending, clearPending, pendingPath, classifyPoll,
  consoleUrl, scopeImportJson,
} from '../scripts/lib/register-core.js';
import { buildPlist } from '../src/launchd.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'S3cr3tValueThatMustNeverPrint';
const tmp = (p = 'gh1-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const run = (r) => () => r;

// ---------- checks.js 纯逻辑 ----------

test('parseEnvText: 注释 / 引号 / export / 空值', () => {
  const v = parseEnvText('# c\nA=1\nexport B="x # y"\nC=  z   # tail\nD=\nbad line\nE=\'q\'');
  assert.deepEqual(v, { A: '1', B: 'x # y', C: 'z', D: '', E: 'q' });
});

test('checkNodeVersion: <18 fail 且给修法；≥18 ok', () => {
  const bad = checkNodeVersion('v16.20.0');
  assert.equal(bad.status, 'fail');
  assert.match(bad.fix, /18/);
  assert.equal(checkNodeVersion('v18.0.0').status, 'ok');
  assert.equal(checkNodeVersion('v24.1.0').status, 'ok');
});

test('checkDeps: 缺依赖 fail 并提示 npm ci；齐全 ok', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { a: '1', '@s/b': '1' } }));
  const miss = checkDeps(root);
  assert.equal(miss.status, 'fail');
  assert.match(miss.message, /a、@s\/b/);
  assert.match(miss.fix, /npm ci/);
  for (const d of ['a', '@s/b']) {
    fs.mkdirSync(path.join(root, 'node_modules', d), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', d, 'package.json'), '{}');
  }
  assert.equal(checkDeps(root).status, 'ok');
  assert.equal(checkDeps(tmp()).status, 'fail'); // 没有 package.json
});

test('checkClaudeCli: 找不到 → fail（不倾倒 PATH）；有版本 → ok', () => {
  const nf = checkClaudeCli({ run: run({ ok: false, error: 'ENOENT', stdout: '' }) });
  assert.equal(nf.status, 'fail');
  assert.match(nf.fix, /@anthropic-ai\/claude-code/);
  assert.doesNotMatch(nf.message, /PATH=/);
  const ok = checkClaudeCli({ run: run({ ok: true, stdout: '2.9.1 (Claude Code)\n' }) });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.version, '2.9.1');
  assert.equal(checkClaudeCli({ run: run({ ok: true, stdout: 'weird' }) }).status, 'warn');
});

test('checkClaudeAuth: 已登录 / 未登录 / 未能确认，邮箱打码', () => {
  const r = (stdout) => run({ ok: true, stdout });
  const yes = checkClaudeAuth({ run: r('{"loggedIn":true,"email":"alice@example.com"}'), env: {} });
  assert.equal(yes.status, 'ok');
  assert.doesNotMatch(yes.message, /alice@/);
  assert.match(yes.message, /a\*\*\*@example\.com/);
  const no = checkClaudeAuth({ run: r('{"loggedIn":false}'), env: {} });
  assert.equal(no.status, 'needs_human');
  assert.match(no.fix, /login/);
  const unk = checkClaudeAuth({ run: r('Usage: claude ...'), env: {} });
  assert.equal(unk.status, 'warn');
  assert.match(unk.message, /未能确认/);
  // 用长期令牌时 auth status 可能报未登录：不能断言「没登录」
  const tok = checkClaudeAuth({ run: r('{"loggedIn":false}'), env: {}, envFile: { CLAUDE_CODE_OAUTH_TOKEN: SECRET } });
  assert.equal(tok.status, 'warn');
  assert.doesNotMatch(JSON.stringify(tok), new RegExp(SECRET));
  assert.equal(maskEmail('nope'), '');
});

test('ensureEnvFile: 从模板生成（600）且幂等，不覆盖已有 .env', () => {
  const root = tmp();
  assert.equal(ensureEnvFile(root).status, 'fail'); // 模板都没有
  fs.writeFileSync(path.join(root, '.env.example'), 'FEISHU_APP_ID=\n');
  const first = ensureEnvFile(root);
  assert.equal(first.status, 'ok');
  assert.equal(first.created, true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(root, '.env'), 'FEISHU_APP_ID=cli_x\n');
  const second = ensureEnvFile(root);
  assert.equal(second.status, 'ok');
  assert.equal(second.created, undefined);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'FEISHU_APP_ID=cli_x\n');
});

test('checkRequiredEnv: 缺项 needs_human，任何情况下都不回显值', () => {
  const empty = checkRequiredEnv({});
  assert.deepEqual(empty.map((i) => i.status), ['needs_human', 'needs_human']);
  const full = checkRequiredEnv({ FEISHU_APP_ID: 'cli_abc', FEISHU_APP_SECRET: SECRET, OWNER_OPEN_ID: 'ou_abcdef' });
  assert.deepEqual(full.map((i) => i.status), ['ok', 'ok']);
  const half = checkRequiredEnv({ FEISHU_APP_ID: 'cli_abc' });
  assert.match(half[0].message, /FEISHU_APP_SECRET/);
  assert.doesNotMatch(JSON.stringify([...full, ...half]), /S3cr3t|cli_abc|ou_abcdef/);
});

test('checkEnvSanity / checkShadowed / validOpenId', () => {
  const ids = (xs) => xs.map((i) => i.id).sort();
  assert.deepEqual(ids(checkEnvSanity({ FEISHU_APP_ID: 'cli_ok', OWNER_OPEN_ID: 'ou_ok', FEISHU_DOMAIN: 'lark', OWNER_TOOL_PROFILE: 'audit' })), []);
  assert.deepEqual(ids(checkEnvSanity({ FEISHU_APP_ID: 'abc', OWNER_OPEN_ID: 'u1', FEISHU_DOMAIN: 'x', OWNER_TOOL_PROFILE: 'root', ALLOW_OWNER_CLAIM: 'true' })),
    ['env_app_id_format', 'env_domain', 'env_owner_claim', 'env_owner_format', 'env_tool_profile']);
  assert.deepEqual(checkShadowed({ CLAUDE_MODEL: 'a' }, { CLAUDE_MODEL: 'a' }), []);
  const sh = checkShadowed({ CLAUDE_MODEL: 'a', X: SECRET }, { CLAUDE_MODEL: 'b', X: 'other' }, ['CLAUDE_MODEL', 'X']);
  assert.match(sh[0].message, /CLAUDE_MODEL, X/);
  assert.doesNotMatch(JSON.stringify(sh), /S3cr3t|other/);
  assert.equal(validOpenId('ou_1234567'), true);
  assert.equal(validOpenId('ou_1'), false);
  assert.equal(validOpenId('cli_1234567'), false);
  assert.equal(validOpenId('ou_123456; rm -rf'), false);
});

test('findOwnerCandidates: 从日志取 owner 未登记时的私聊者，最近的在前、去重', () => {
  const log = [
    '[owner] owner.json 缺失且未开放认领。当前请求者：ou_first1',
    '[msg] ou_x @ p2p [text]: hi',
    '[owner] 拒绝认领：ou_second2 不在 ALLOW_USERS 名单内',
    '[owner] owner.json 缺失且未开放认领。当前请求者：ou_first1',
    'random 当前请求者：ou_notowner',
  ].join('\n');
  assert.deepEqual(findOwnerCandidates(log), ['ou_first1', 'ou_second2']);
  assert.deepEqual(findOwnerCandidates(''), []);
});

test('withExitTimeout: 插入与替换；plist 解析', () => {
  const xml = buildPlist({ label: 'com.t.fcb', node: '/n/bin/node', root: '/r', home: '/Users/tester', claudeDir: '/c/bin' });
  assert.equal(plistExitTimeout(xml), null);
  const a = withExitTimeout(xml, 130);
  assert.equal(plistExitTimeout(a), 130);
  assert.match(a, /<integer>130<\/integer>\n<\/dict>\n<\/plist>/);
  const b = withExitTimeout(a, 40);
  assert.equal(plistExitTimeout(b), 40);
  assert.equal(b.match(/ExitTimeOut/g).length, 1);
  assert.equal(plistEnvPath(xml), '/n/bin:/c/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
});

test('checkService(darwin): 未装 / 在跑 / PATH 缺 claude / ExitTimeOut 太短', () => {
  const base = { platform: 'darwin', home: '/h', label: 'com.t.fcb', uid: 501, graceSec: 120 };
  const none = checkService({ ...base, exists: () => false });
  assert.deepEqual(none.map((i) => [i.id, i.status]), [['service', 'warn']]);

  const xml = buildPlist({ label: 'com.t.fcb', node: '/n/bin/node', root: '/r', home: '/h', claudeDir: '/c/bin' });
  const exists = (p) => p.endsWith('.plist') || p === '/c/bin/claude';
  const calls = [];
  const running = checkService({
    ...base, exists, readFile: () => withExitTimeout(xml, 130),
    run: (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, stdout: 'state = running\n\tpid = 4242\n' }; },
  });
  assert.deepEqual(running.map((i) => [i.id, i.status]), [['service', 'ok']]);
  assert.deepEqual(calls, [['launchctl', 'print', 'gui/501/com.t.fcb']]); // 只读查询

  const bad = checkService({ ...base, exists: (p) => p.endsWith('.plist'), readFile: () => xml, run: run({ ok: false, stdout: '' }) });
  assert.deepEqual(bad.map((i) => i.id), ['service', 'service_claude_path', 'service_exit_timeout']);
  assert.equal(checkService({ ...base, graceSec: 0, exists, readFile: () => xml, run: run({ ok: true, stdout: 'pid = 1' }) }).length, 1);

  assert.equal(checkService({ platform: 'linux' })[0].status, 'warn');
  assert.equal(checkService({ platform: 'win32', appData: 'C:\\x', exists: () => true })[0].status, 'ok');
});

test('exitCodeFor: 全绿 0 / 只差人 2 / 有失败 1；toJson 只带约定字段', () => {
  const it = (status) => ({ id: status, status, title: 't', message: '', fix: '' });
  assert.equal(exitCodeFor([it('ok'), it('warn')]), 0);
  assert.equal(exitCodeFor([it('ok'), it('needs_human')]), 2);
  assert.equal(exitCodeFor([it('needs_human'), it('fail')]), 1);
  const j = JSON.parse(toJson([{ ...it('ok'), version: '1', created: true }], { next: 'n' }));
  assert.equal(j.exit, 0);
  assert.equal(j.next, 'n');
  assert.deepEqual(Object.keys(j.items[0]).sort(), ['fix', 'id', 'message', 'status', 'title']);
  assert.equal(scrubSecrets(`x ${SECRET} y`, { FEISHU_APP_SECRET: SECRET }), 'x *** y');
  assert.match(renderLine({ ...it('needs_human'), fix: 'do' }), /^🙋 t → do$/);
});

// ---------- register 两段式纯逻辑 ----------

test('register: 参数与模式（无 TTY 默认两段式）', () => {
  assert.deepEqual(parseRegisterArgs(['--resume', '--timeout', '30']), { wait: false, noWait: false, resume: true, force: false, restart: false, timeoutSec: 30 });
  assert.equal(parseRegisterArgs(['--timeout', 'x']).timeoutSec, null);
  assert.equal(parseRegisterArgs(['--timeout', '99999']).timeoutSec, 900);
  assert.equal(chooseMode(parseRegisterArgs([]), { isTTY: true }), 'wait');
  assert.equal(chooseMode(parseRegisterArgs([]), { isTTY: false }), 'start');
  assert.equal(chooseMode(parseRegisterArgs(['--wait']), { isTTY: false }), 'wait');
  assert.equal(chooseMode(parseRegisterArgs(['--no-wait']), { isTTY: true }), 'start');
  assert.equal(chooseMode(parseRegisterArgs(['--resume', '--no-wait']), { isTTY: true }), 'resume');
});

test('register: 已有凭据默认拒绝，--force 放行', () => {
  assert.match(guardExisting({ FEISHU_APP_ID: 'cli_a', FEISHU_APP_SECRET: SECRET }), /--force/);
  assert.doesNotMatch(guardExisting({ FEISHU_APP_ID: 'cli_a', FEISHU_APP_SECRET: SECRET }), /S3cr3t/);
  assert.equal(guardExisting({ FEISHU_APP_ID: 'cli_a', FEISHU_APP_SECRET: SECRET }, { force: true }), null);
  assert.equal(guardExisting({ FEISHU_APP_ID: 'cli_a' }), null);
});

test('register: 待授权记录 600 权限、过期、清理', () => {
  const root = tmp();
  assert.deepEqual(loadPending(root), { error: 'missing' });
  savePending(root, { deviceCode: 'dc', interval: 3, expireIn: 60, url: 'https://x', domain: 'lark' }, 1000);
  if (process.platform !== 'win32') assert.equal(fs.statSync(pendingPath(root)).mode & 0o777, 0o600);
  assert.equal(loadPending(root, 2000).rec.device_code, 'dc');
  assert.equal(loadPending(root, 1000 + 61_000).error, 'expired');
  clearPending(root);
  clearPending(root); // 幂等
  assert.equal(fs.existsSync(pendingPath(root)), false);
});

test('register: 轮询结果分类与辅助输出', () => {
  assert.deepEqual(classifyPoll({ client_id: 'a', client_secret: 'b', user_info: { open_id: 'ou_x' } }), { kind: 'done', appId: 'a', appSecret: 'b', openId: 'ou_x' });
  assert.equal(classifyPoll({ client_id: 'a', client_secret: 'b' }).openId, null);
  assert.equal(classifyPoll({ error: 'authorization_pending' }).kind, 'pending');
  assert.equal(classifyPoll({ error: 'slow_down' }).kind, 'slow_down');
  assert.deepEqual(classifyPoll({ error: 'access_denied', error_description: 'no' }), { kind: 'error', message: 'access_denied no' });
  assert.equal(consoleUrl('lark'), 'https://open.larksuite.com/app');
  assert.equal(consoleUrl(), 'https://open.feishu.cn/app');
  assert.deepEqual(JSON.parse(scopeImportJson(['im:message'])), { scopes: { tenant: ['im:message'], user: [] } });
});

// ---------- 端到端（临时目录 + stub claude） ----------

function makeStub(dir, { auth = '{"loggedIn":true,"email":"alice@example.com"}' } = {}) {
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n  --version) echo "2.9.0 (Claude Code)";;\n  auth) echo '${auth}';;\n  *) echo "stub refuses $*" >&2; exit 3;;\nesac\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function makeRoot({ deps = true } = {}) {
  const root = tmp('gh1-root-');
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'));
  fs.writeFileSync(path.join(root, '.env.example'), '# 模板\nFEISHU_APP_ID=\nFEISHU_APP_SECRET=\nOWNER_OPEN_ID=\n');
  if (deps) fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

function runScript(script, args, { claudeBin, home }) {
  // LARK_CLI_BIN 指向不存在的路径：PATH 里可能有真实 lark-cli，setup 会跑它的 config show
  const env = { PATH: process.env.PATH, HOME: home, USER: 'tester', CLAUDE_BIN: claudeBin, LARK_CLI_BIN: path.join(home, 'no-lark-cli') };
  return spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], { encoding: 'utf8', env, timeout: 60_000 });
}

const skipNoSh = process.platform === 'win32' ? 'stub 是 sh 脚本' : false;

test('setup e2e: 缺依赖 → 退出 1、提示 npm ci、无堆栈', { skip: skipNoSh }, () => {
  const root = makeRoot({ deps: false });
  const home = tmp('gh1-home-');
  const r = runScript('setup.js', ['--json', '--no-network', '--root', root], { claudeBin: makeStub(home), home });
  assert.equal(r.status, 1, r.stderr);
  const j = JSON.parse(r.stdout);
  const deps = j.items.find((i) => i.id === 'deps');
  assert.equal(deps.status, 'fail');
  assert.match(deps.fix, /npm ci/);
  assert.equal(j.items.find((i) => i.id === 'doctor').status, 'warn');
  assert.doesNotMatch(r.stdout + r.stderr, /ERR_MODULE_NOT_FOUND/);
});

test('setup e2e: 新目录 → 生成 .env、只差人（退出 2）、可重复执行', { skip: skipNoSh }, () => {
  const root = makeRoot();
  const home = tmp('gh1-home-');
  const claudeBin = makeStub(home);
  const r1 = runScript('setup.js', ['--json', '--no-network', '--root', root], { claudeBin, home });
  assert.equal(r1.status, 2, r1.stdout + r1.stderr);
  const j1 = JSON.parse(r1.stdout);
  assert.equal(j1.exit, 2);
  for (const i of j1.items) {
    assert.ok(['ok', 'warn', 'fail', 'needs_human'].includes(i.status), i.id);
    assert.equal(typeof i.message, 'string');
    assert.equal(typeof i.fix, 'string');
  }
  const byId = Object.fromEntries(j1.items.map((i) => [i.id, i]));
  assert.equal(byId.env_file.status, 'ok');
  assert.equal(byId.feishu_credentials.status, 'needs_human');
  assert.equal(byId.owner.status, 'needs_human');
  assert.equal(byId.claude_auth.status, 'ok');
  assert.ok(byId.workspace, 'doctor 的结果合并进来');
  assert.equal(j1.items.filter((i) => i.id === 'env_file').length, 1, '同 id 不重复');
  const envText = fs.readFileSync(path.join(root, '.env'), 'utf8');
  const r2 = runScript('setup.js', ['--no-network', '--root', root], { claudeBin, home });
  assert.equal(r2.status, 2);
  assert.match(r2.stdout, /🙋/);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), envText, '第二次不改 .env');
});

test('setup e2e: 未登录 → needs_human；--set-owner 校验与写入；日志里找 owner 候选', { skip: skipNoSh }, () => {
  const root = makeRoot();
  const home = tmp('gh1-home-');
  const claudeBin = makeStub(home, { auth: '{"loggedIn":false}' });
  fs.writeFileSync(path.join(root, 'bridge.log'), '[owner] owner.json 缺失且未开放认领。当前请求者：ou_candidate9\n');
  const r = runScript('setup.js', ['--json', '--no-network', '--root', root], { claudeBin, home });
  const j = JSON.parse(r.stdout);
  assert.equal(j.items.find((i) => i.id === 'claude_auth').status, 'needs_human');
  assert.match(j.items.find((i) => i.id === 'owner').fix, /--set-owner ou_candidate9/);

  const bad = runScript('setup.js', ['--json', '--no-network', '--root', root, '--set-owner', 'not-an-id'], { claudeBin, home });
  assert.equal(bad.status, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.env'), 'utf8'), /not-an-id/);

  const good = runScript('setup.js', ['--json', '--no-network', '--root', root, '--set-owner', 'ou_candidate9'], { claudeBin, home });
  const jg = JSON.parse(good.stdout);
  assert.equal(jg.items.find((i) => i.id === 'set_owner').status, 'ok');
  assert.equal(jg.items.find((i) => i.id === 'owner').status, 'ok');
  assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /^OWNER_OPEN_ID=ou_candidate9$/m);
});

test('setup e2e: 必填齐全 → 退出 0，输出里没有 Secret', { skip: skipNoSh }, () => {
  const root = makeRoot();
  const home = tmp('gh1-home-');
  const claudeBin = makeStub(home);
  fs.writeFileSync(path.join(root, '.env'), `FEISHU_APP_ID=cli_testapp\nFEISHU_APP_SECRET=${SECRET}\nOWNER_OPEN_ID=ou_testowner\n`, { mode: 0o600 });
  for (const args of [['--json'], []]) {
    const r = runScript('setup.js', [...args, '--no-network', '--root', root], { claudeBin, home });
    assert.equal(r.status, 0, r.stdout);
    assert.doesNotMatch(r.stdout + r.stderr, /S3cr3t/);
  }
  const d = runScript('doctor.js', ['--json', '--no-network', '--root', root], { claudeBin, home });
  assert.equal(d.status, 0, d.stdout);
  assert.doesNotMatch(d.stdout, /S3cr3t/);
  assert.equal(JSON.parse(d.stdout).exit, 0);
});

test('doctor e2e: 缺依赖时文本模式给出 npm ci 而不是堆栈；退出码保持 0/1', { skip: skipNoSh }, () => {
  const root = makeRoot({ deps: false });
  const home = tmp('gh1-home-');
  const r = runScript('doctor.js', ['--no-network', '--root', root], { claudeBin: makeStub(home), home });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /❌ 依赖：未安装.*npm ci/);
  assert.match(r.stdout, /项需要处理/);
  assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND/);
  const root2 = makeRoot();
  fs.copyFileSync(path.join(root2, '.env.example'), path.join(root2, '.env'));
  const t = runScript('doctor.js', ['--no-network', '--root', root2], { claudeBin: makeStub(home), home });
  assert.equal(t.status, 1); // 有 🙋 项时文本模式仍是 1（兼容旧行为）
  assert.match(t.stdout, /🙋/);
});

test('register e2e: 已有凭据默认拒绝；--resume 没有待授权记录时直接退出（均不联网）', { skip: skipNoSh }, () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.cpSync(path.join(REPO, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'src'), path.join(root, 'src'), 'dir');
  // 把 fetch 换成直接抛错，保证这里任何联网都会让测试失败
  const preload = path.join(root, 'nofetch.mjs');
  fs.writeFileSync(preload, "globalThis.fetch = () => { throw new Error('NETWORK_USED'); };\n");
  const go = (args) => spawnSync(process.execPath, ['--import', preload, path.join(root, 'scripts', 'register.js'), ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root }, timeout: 30_000 });

  fs.writeFileSync(path.join(root, '.env'), `FEISHU_APP_ID=cli_have\nFEISHU_APP_SECRET=${SECRET}\n`);
  const g = go([]);
  assert.equal(g.status, 1);
  assert.match(g.stderr, /--force/);
  assert.doesNotMatch(g.stdout + g.stderr, /S3cr3t|NETWORK_USED/);

  fs.writeFileSync(path.join(root, '.env'), 'FEISHU_APP_ID=\n');
  const r = go(['--resume']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--no-wait/);
  savePending(root, { deviceCode: 'dc', expireIn: 1, url: 'https://x' }, Date.now() - 10_000);
  const e = go(['--resume']);
  assert.equal(e.status, 1);
  assert.match(e.stderr, /过期/);
  assert.doesNotMatch(e.stdout + e.stderr, /NETWORK_USED/);
});

test('install-service --dry-run: plist 带 ExitTimeOut = SHUTDOWN_GRACE_SEC + 10', { skip: process.platform !== 'darwin' && '只在 macOS 上运行' }, () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'install-service.js'), '--dry-run'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp('gh1-home-'), USER: 'tester' }, timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const t = plistExitTimeout(r.stdout);
  assert.ok(t >= 10 && t <= 3610, `ExitTimeOut=${t}`);
});

// ---------- R2：owner 候选 / 服务目录 / .env 权限 / JSON 输出 ----------

test('findOwnerCandidates: 先后两人私聊 → 后来的在前（顺序要真的反过来）', () => {
  const log = [
    '[owner] owner.json 缺失且未开放认领。当前请求者：ou_aaaaaa1',
    '[owner] owner.json 缺失且未开放认领。当前请求者：ou_bbbbbb2',
  ].join('\n');
  assert.deepEqual(findOwnerCandidates(log), ['ou_bbbbbb2', 'ou_aaaaaa1']);
});

test('ownerHint: 0 个 → null；1 个 → 预填 --set-owner；≥2 个 → 全列出但不预填命令', () => {
  assert.equal(ownerHint([]), null);
  const one = ownerHint(['ou_only111']);
  assert.match(one.message, /ou_only111/);
  assert.match(one.fix, /--set-owner ou_only111/);
  const two = ownerHint(['ou_bbbbbb2', 'ou_aaaaaa1']);
  assert.match(two.message, /ou_bbbbbb2/);
  assert.match(two.message, /ou_aaaaaa1/);
  assert.doesNotMatch(two.fix, /--set-owner\s+ou_/);
  assert.match(two.fix, /不要猜/);
  assert.match(two.fix, /§5/);
});

test('checkRequiredEnv: owner 的 fix 用 > bridge.log（只看本次启动之后），不用 >>', () => {
  const owner = checkRequiredEnv({}).find((i) => i.id === 'owner');
  assert.match(owner.fix, /npm start > bridge\.log 2>&1/);
  assert.doesNotMatch(owner.fix, />>/);
});

test('plistWorkingDir: 取 WorkingDirectory 并反转义；没有则 null', () => {
  const xml = buildPlist({ label: 'com.t.fcb', node: '/n/bin/node', root: '/r/a&b', home: '/h' });
  assert.equal(plistWorkingDir(xml), '/r/a&b');
  assert.equal(plistWorkingDir('<plist><dict></dict></plist>'), null);
  assert.equal(plistWorkingDir(null), null);
});

test('checkService(darwin): label 属于另一个目录 → 只报一条 service warn，跳过 PATH / ExitTimeOut', () => {
  const xml = buildPlist({ label: 'com.t.fcb', node: '/n/bin/node', root: '/other/bridge', home: '/h' });
  const calls = [];
  const out = checkService({
    platform: 'darwin', home: '/h', label: 'com.t.fcb', uid: 501, graceSec: 120, root: '/mine/bridge',
    exists: (p) => p.endsWith('.plist'), readFile: () => xml,
    run: (...a) => { calls.push(a); return { ok: true, stdout: 'pid = 7' }; },
  });
  assert.deepEqual(out.map((i) => [i.id, i.status]), [['service', 'warn']]);
  assert.match(out[0].message, /另一个目录（\/other\/bridge）/);
  assert.match(out[0].fix, /LAUNCHD_LABEL=com\.t\.fcb-2/);
  assert.deepEqual(calls, [], '别的目录的服务不去查运行状态');
  // 同目录照常检查
  const same = checkService({
    platform: 'darwin', home: '/h', label: 'com.t.fcb', uid: 501, graceSec: 120, root: '/other/bridge',
    exists: (p) => p.endsWith('.plist'), readFile: () => xml, run: run({ ok: true, stdout: 'pid = 7' }),
  });
  assert.deepEqual(same.map((i) => i.id), ['service', 'service_claude_path', 'service_exit_timeout']);
});

test('serviceLabelConflict: 已有 plist 指向别的目录且没 --force → 拒绝并给出改 label 的办法', () => {
  const other = buildPlist({ label: 'com.t.fcb', node: '/n', root: '/other/bridge', home: '/h' });
  const mine = buildPlist({ label: 'com.t.fcb', node: '/n', root: '/mine/bridge', home: '/h' });
  const msg = serviceLabelConflict({ existingXml: other, root: '/mine/bridge', label: 'com.t.fcb' });
  assert.match(msg, /com\.t\.fcb/);
  assert.match(msg, /\/other\/bridge/);
  assert.match(msg, /LAUNCHD_LABEL=com\.t\.fcb-2/);
  assert.match(msg, /--force/);
  assert.equal(serviceLabelConflict({ existingXml: other, root: '/mine/bridge', label: 'com.t.fcb', force: true }), null);
  assert.equal(serviceLabelConflict({ existingXml: mine, root: '/mine/bridge', label: 'com.t.fcb' }), null);
  assert.equal(serviceLabelConflict({ existingXml: null, root: '/mine/bridge', label: 'com.t.fcb' }), null);
  assert.equal(serviceLabelConflict({ existingXml: mine, root: '/mine/bridge/', label: 'com.t.fcb' }), null, '尾斜杠不算不同');
});

test('ownerLogFiles: 只有 plist 的 WorkingDirectory 是本目录时才读 launchd 日志', () => {
  const base = { root: '/mine/bridge', home: '/h', label: 'com.t.fcb', platform: 'darwin' };
  const launchdLog = '/h/Library/Logs/com.t.fcb.log';
  const plistOf = (root) => buildPlist({ label: 'com.t.fcb', node: '/n', root, home: '/h' });
  const mine = ownerLogFiles({ ...base, exists: () => true, readFile: () => plistOf('/mine/bridge'), extra: '/x/extra.log' });
  assert.ok(mine.includes(launchdLog));
  assert.ok(mine.includes('/mine/bridge/bridge.log'));
  assert.ok(mine.includes('/x/extra.log'));
  const other = ownerLogFiles({ ...base, exists: () => true, readFile: () => plistOf('/other/bridge') });
  assert.ok(!other.includes(launchdLog));
  assert.ok(other.includes('/mine/bridge/bridge.log'));
  assert.ok(!ownerLogFiles({ ...base, exists: () => false }).includes(launchdLog));
  assert.deepEqual(ownerLogFiles({ ...base, platform: 'linux' }), ['/mine/bridge/bridge.log']);
});

test('setup e2e: --json 的 stdout 以 { 开头（可直接 JSON.parse）', { skip: skipNoSh }, () => {
  const root = makeRoot();
  const home = tmp('gh1-home-');
  const r = runScript('setup.js', ['--json', '--no-network', '--root', root], { claudeBin: makeStub(home), home });
  assert.equal(r.stdout[0], '{', r.stdout.slice(0, 80));
  const d = runScript('doctor.js', ['--json', '--no-network', '--root', root], { claudeBin: makeStub(home), home });
  assert.equal(d.stdout[0], '{', d.stdout.slice(0, 80));
});

test('setup e2e: 日志里两人私聊过 → 列出两人、不预填 --set-owner', { skip: skipNoSh }, () => {
  const root = makeRoot();
  const home = tmp('gh1-home-');
  fs.writeFileSync(path.join(root, 'bridge.log'),
    '[owner] owner.json 缺失且未开放认领。当前请求者：ou_owner0001\n[owner] owner.json 缺失且未开放认领。当前请求者：ou_intruder2\n');
  for (const script of ['setup.js', 'doctor.js']) {
    const r = runScript(script, ['--json', '--no-network', '--root', root], { claudeBin: makeStub(home), home });
    const owner = JSON.parse(r.stdout).items.find((i) => i.id === 'owner');
    assert.match(owner.message, /ou_owner0001/, script);
    assert.match(owner.message, /ou_intruder2/, script);
    assert.doesNotMatch(owner.fix, /--set-owner\s+ou_/, script);
  }
});

test('setup e2e: --set-owner 写入后 .env 是 600；已有不同 owner 要 --force；相同值不改；没跟值 fail', { skip: skipNoSh }, () => {
  const root = makeRoot();
  const home = tmp('gh1-home-');
  const claudeBin = makeStub(home);
  const envPath = path.join(root, '.env');
  const go = (...a) => {
    const r = runScript('setup.js', ['--json', '--no-network', '--root', root, ...a], { claudeBin, home });
    return { r, set: JSON.parse(r.stdout).items.find((i) => i.id === 'set_owner') };
  };
  const mode = () => fs.statSync(envPath).mode & 0o777;

  const first = go('--set-owner', 'ou_owner0001');
  assert.equal(first.set.status, 'ok');
  assert.match(fs.readFileSync(envPath, 'utf8'), /^OWNER_OPEN_ID=ou_owner0001$/m);
  assert.equal(mode(), 0o600, '--set-owner 之后 .env 必须仍是 600');

  const other = go('--set-owner', 'ou_intruder2');
  assert.equal(other.set.status, 'fail');
  assert.match(other.set.message, /已有 owner/);
  assert.match(other.set.fix, /--force/);
  assert.equal(other.r.status, 1);
  assert.match(fs.readFileSync(envPath, 'utf8'), /^OWNER_OPEN_ID=ou_owner0001$/m, '没 --force 不覆盖');

  const before = fs.statSync(envPath).mtimeMs;
  const text = fs.readFileSync(envPath, 'utf8');
  const same = go('--set-owner', 'ou_owner0001');
  assert.equal(same.set.status, 'ok');
  assert.equal(fs.readFileSync(envPath, 'utf8'), text);
  assert.equal(fs.statSync(envPath).mtimeMs, before, '相同值不改动 .env');

  fs.chmodSync(envPath, 0o644);
  const forced = go('--set-owner', 'ou_intruder2', '--force');
  assert.equal(forced.set.status, 'ok');
  assert.match(fs.readFileSync(envPath, 'utf8'), /^OWNER_OPEN_ID=ou_intruder2$/m);
  assert.equal(mode(), 0o600);

  // 没跟值：在末尾，或后面紧跟的是另一个参数
  for (const args of [['--no-network', '--set-owner'], ['--set-owner', '--no-network']]) {
    const r = runScript('setup.js', ['--json', '--root', root, ...args], { claudeBin, home });
    const s = JSON.parse(r.stdout).items.find((i) => i.id === 'set_owner');
    assert.equal(s?.status, 'fail', `没跟值：${JSON.stringify(args)}`);
    assert.equal(r.status, 1);
  }
  assert.match(fs.readFileSync(envPath, 'utf8'), /^OWNER_OPEN_ID=ou_intruder2$/m);
});

test('checkClaudeAuth: 子进程只多拿到 CLAUDE_CODE_OAUTH_TOKEN，.env 其它值（App Secret）不进环境', () => {
  let seen = null;
  const spy = (cmd, args, opts) => { seen = opts.env; return { ok: true, stdout: '{"loggedIn":true}' }; };
  checkClaudeAuth({ run: spy, env: { PATH: '/bin' }, envFile: { FEISHU_APP_SECRET: SECRET, CLAUDE_CODE_OAUTH_TOKEN: 'tok_123456' } });
  assert.deepEqual(seen, { CLAUDE_CODE_OAUTH_TOKEN: 'tok_123456', PATH: '/bin' });
  checkClaudeAuth({ run: spy, env: { PATH: '/bin' }, envFile: { FEISHU_APP_SECRET: SECRET } });
  assert.deepEqual(seen, { PATH: '/bin' });
});

test('ensureEnvFile: 已有 .env 是 644 → 收紧为 600；已是 600 → 未改动；win32 不动权限', { skip: process.platform === 'win32' && '没有 POSIX 权限位' }, () => {
  const root = tmp();
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, 'FEISHU_APP_ID=cli_x\n');
  fs.chmodSync(envPath, 0o644);
  const loose = ensureEnvFile(root);
  assert.equal(loose.status, 'ok');
  assert.match(loose.message, /收紧/);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'FEISHU_APP_ID=cli_x\n');
  const tight = ensureEnvFile(root);
  assert.equal(tight.status, 'ok');
  assert.match(tight.message, /未改动/);
  fs.chmodSync(envPath, 0o644);
  const win = ensureEnvFile(root, { platform: 'win32' });
  assert.match(win.message, /未改动/);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o644);
});

test('setup e2e: 已有 .env 是 644 → 跑一次 setup 后是 600', { skip: skipNoSh }, () => {
  const root = makeRoot();
  const home = tmp('gh1-home-');
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, `FEISHU_APP_ID=cli_testapp\nFEISHU_APP_SECRET=${SECRET}\nOWNER_OPEN_ID=ou_testowner\n`);
  fs.chmodSync(envPath, 0o644);
  const r = runScript('setup.js', ['--json', '--no-network', '--root', root], { claudeBin: makeStub(home), home });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  assert.match(JSON.parse(r.stdout).items.find((i) => i.id === 'env_file').message, /收紧/);
  assert.doesNotMatch(r.stdout + r.stderr, /S3cr3t/);
});

test('doctor e2e: 从 data/owner.json 补 OWNER_OPEN_ID 之后 .env 仍是 600', { skip: skipNoSh }, () => {
  const root = makeRoot();
  const home = tmp('gh1-home-');
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, `FEISHU_APP_ID=cli_testapp\nFEISHU_APP_SECRET=${SECRET}\nOWNER_OPEN_ID=\n`, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'owner.json'), JSON.stringify({ open_id: 'ou_fromownerjson' }));
  const d = runScript('doctor.js', ['--json', '--no-network', '--root', root], { claudeBin: makeStub(home), home });
  assert.match(JSON.parse(d.stdout).items.find((i) => i.id === 'env_file').message, /补写 OWNER_OPEN_ID/);
  assert.match(fs.readFileSync(envPath, 'utf8'), /^OWNER_OPEN_ID=ou_fromownerjson$/m);
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
});
