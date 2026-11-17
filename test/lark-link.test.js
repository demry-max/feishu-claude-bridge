// lark-cli 与桥接共用一个飞书应用：setup 读 lark-cli 的 App ID、--link-lark-cli 把桥接的凭据交给 lark-cli。
// 不调真实 lark-cli（用 stub / 假 run），不联网；断言 App Secret 只经 stdin 传、不进命令行与输出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLarkCliApp, checkLarkCliApp, linkLarkCli, larkBrand } from '../scripts/lib/lark-link.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'S3cr3tValueThatMustNeverPrint';
const tmp = (p = 'gh1-lark-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const CREDS = { FEISHU_APP_ID: 'cli_bridgeapp', FEISHU_APP_SECRET: SECRET };

/** 假 lark-cli：state.appId 是当前配置的应用；记录每次调用（参数与 stdin） */
function fakeRun(state = {}) {
  const calls = [];
  const fn = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input });
    if (state.missing) return { ok: false, status: null, stdout: '', stderr: '', error: 'ENOENT' };
    if (args[0] === 'config' && args[1] === 'show') {
      if (state.raw !== undefined) return { ok: true, status: 0, stdout: state.raw, stderr: '', error: null };
      return state.appId
        ? { ok: true, status: 0, stdout: JSON.stringify({ appId: state.appId, appSecret: '****', brand: 'feishu' }), stderr: '', error: null }
        : { ok: false, status: 1, stdout: '', stderr: 'not configured yet', error: null };
    }
    if (args[0] === 'config' && args[1] === 'init') {
      if (state.initFails) return { ok: false, status: 1, stdout: '', stderr: `invalid app secret ${opts.input}`, error: null };
      const i = args.indexOf('--app-id');
      if (!state.initNoop) state.appId = args[i + 1];
      return { ok: true, status: 0, stdout: `App configured! App ID: ${args[i + 1]}`, stderr: '', error: null };
    }
    return { ok: false, status: 3, stdout: '', stderr: 'unexpected', error: null };
  };
  fn.calls = calls;
  return fn;
}

test('readLarkCliApp: 未安装 / 未配置 / 已配置 / 输出不是 JSON；不返回任何 secret 字段', () => {
  assert.deepEqual(readLarkCliApp({ bin: 'lark-cli', run: fakeRun({ missing: true }) }), { installed: false, appId: null });
  assert.deepEqual(readLarkCliApp({ bin: 'lark-cli', run: fakeRun({}) }), { installed: true, appId: null });
  const got = readLarkCliApp({ bin: 'lark-cli', run: fakeRun({ appId: 'cli_larkapp' }) });
  assert.deepEqual(got, { installed: true, appId: 'cli_larkapp' });
  assert.deepEqual(readLarkCliApp({ bin: 'lark-cli', run: fakeRun({ raw: 'oops' }) }), { installed: true, appId: null });
  assert.deepEqual(readLarkCliApp({ bin: 'lark-cli', run: fakeRun({ raw: '{"appId":"not an id"}' }) }), { installed: true, appId: null });
  const run = fakeRun({ appId: 'cli_larkapp' });
  readLarkCliApp({ bin: '/opt/lark', run });
  assert.deepEqual(run.calls[0], { cmd: '/opt/lark', args: ['config', 'show'], input: undefined });
});

test('larkBrand: FEISHU_DOMAIN=lark → lark，其余 feishu；shell 环境优先', () => {
  assert.equal(larkBrand({}, {}), 'feishu');
  assert.equal(larkBrand({ FEISHU_DOMAIN: 'lark' }, {}), 'lark');
  assert.equal(larkBrand({ FEISHU_DOMAIN: 'lark' }, { FEISHU_DOMAIN: 'feishu' }), 'feishu');
});

test('checkLarkCliApp: 同一应用 ok；两个应用 / 只有 lark-cli 有应用 → warn 并给出合一的命令', () => {
  assert.deepEqual(checkLarkCliApp(CREDS, { bin: 'lark-cli', run: fakeRun({ missing: true }) }), [], '没装 lark-cli 不报');
  assert.deepEqual(checkLarkCliApp({}, { bin: 'lark-cli', run: fakeRun({}) }), [], '两边都没有应用不报');

  const [same] = checkLarkCliApp(CREDS, { bin: 'lark-cli', run: fakeRun({ appId: 'cli_bridgeapp' }) });
  assert.equal(same.id, 'lark_cli_app');
  assert.equal(same.status, 'ok');

  const [diff] = checkLarkCliApp(CREDS, { bin: 'lark-cli', run: fakeRun({ appId: 'cli_larkapp' }) });
  assert.equal(diff.status, 'warn');
  assert.match(diff.message, /cli_larkapp/);
  assert.match(diff.fix, /--link-lark-cli --force/);

  const [only] = checkLarkCliApp({}, { bin: 'lark-cli', run: fakeRun({ appId: 'cli_larkapp' }) });
  assert.equal(only.status, 'warn');
  assert.match(only.message, /钥匙串/);
  assert.match(only.fix, /npm run register/);

  const [unset] = checkLarkCliApp(CREDS, { bin: 'lark-cli', run: fakeRun({}) });
  assert.equal(unset.status, 'warn');
  assert.match(unset.fix, /--link-lark-cli/);
  assert.doesNotMatch(unset.fix, /--force/);

  for (const it of [same, diff, only, unset]) assert.doesNotMatch(JSON.stringify(it), /S3cr3t/);
});

test('linkLarkCli: 缺凭据 / 未安装 → fail；已是同一应用不再 init；另一个应用无 --force → 等人', () => {
  const r0 = fakeRun({ appId: 'cli_larkapp' });
  assert.equal(linkLarkCli({ FEISHU_APP_ID: 'cli_bridgeapp' }, { bin: 'lark-cli', run: r0 }).status, 'fail');
  assert.equal(r0.calls.length, 0, '缺 Secret 时不碰 lark-cli');

  const miss = linkLarkCli(CREDS, { bin: 'lark-cli', run: fakeRun({ missing: true }) });
  assert.equal(miss.status, 'fail');
  assert.match(miss.fix, /npm install -g @larksuite\/cli/);
  assert.match(miss.fix, /config init --new/, '提醒不要用 --new 再建一个应用');

  const r1 = fakeRun({ appId: 'cli_bridgeapp' });
  assert.equal(linkLarkCli(CREDS, { bin: 'lark-cli', run: r1 }).status, 'ok');
  assert.ok(!r1.calls.some((c) => c.args[1] === 'init'), '同一应用不重复 init');

  const r2 = fakeRun({ appId: 'cli_larkapp' });
  const held = linkLarkCli(CREDS, { bin: 'lark-cli', run: r2 });
  assert.equal(held.status, 'needs_human');
  assert.match(held.fix, /--force/);
  assert.ok(!r2.calls.some((c) => c.args[1] === 'init'), '没 --force 不替换别的应用');
});

test('linkLarkCli: 写入时 Secret 只走 stdin；成功后复读确认；失败输出里的 Secret 被抹掉', () => {
  const st = {};
  const run = fakeRun(st);
  const ok = linkLarkCli({ ...CREDS, FEISHU_DOMAIN: 'lark' }, { bin: 'lark-cli', run });
  assert.equal(ok.status, 'ok', ok.message);
  const init = run.calls.find((c) => c.args[1] === 'init');
  assert.deepEqual(init.args, ['config', 'init', '--app-id', 'cli_bridgeapp', '--app-secret-stdin', '--brand', 'lark']);
  assert.equal(init.input.trim(), SECRET);
  assert.ok(!init.args.join(' ').includes(SECRET));
  assert.equal(st.appId, 'cli_bridgeapp');
  assert.match(ok.fix, /auth login/);
  assert.doesNotMatch(JSON.stringify(ok), /S3cr3t/);

  const forced = fakeRun({ appId: 'cli_larkapp' });
  assert.equal(linkLarkCli(CREDS, { bin: 'lark-cli', run: forced, force: true }).status, 'ok');

  const bad = linkLarkCli(CREDS, { bin: 'lark-cli', run: fakeRun({ initFails: true }) });
  assert.equal(bad.status, 'fail');
  assert.match(bad.message, /invalid app secret/);
  assert.doesNotMatch(JSON.stringify(bad), /S3cr3t/);

  const noop = linkLarkCli(CREDS, { bin: 'lark-cli', run: fakeRun({ initNoop: true }) });
  assert.equal(noop.status, 'fail', 'init 说成功但 config show 不是桥接的应用');
});

// ---------- 端到端：setup + stub lark-cli（sh 脚本） ----------

function makeLarkStub(dir) {
  const bin = path.join(dir, 'lark-cli');
  fs.writeFileSync(bin, `#!/bin/sh
D="$(dirname "$0")"
echo "$*" >> "$D/args.log"
case "$1 $2" in
  "config show")
    if [ -f "$D/app" ]; then printf '{"appId":"%s","appSecret":"****"}\\n' "$(cat "$D/app")"; else echo "not configured yet" >&2; exit 1; fi;;
  "config init")
    shift 2; id=""
    while [ $# -gt 0 ]; do case "$1" in --app-id) id="$2"; shift;; esac; shift; done
    cat > "$D/stdin.txt"; printf '%s' "$id" > "$D/app"; echo "App configured! App ID: $id";;
  *) echo "stub refuses $*" >&2; exit 3;;
esac
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function makeClaudeStub(dir) {
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\ncase "$1" in\n  --version) echo "2.9.0 (Claude Code)";;\n  auth) echo \'{"loggedIn":true}\';;\n  *) exit 3;;\nesac\n');
  fs.chmodSync(bin, 0o755);
  return bin;
}

const skipNoSh = process.platform === 'win32' ? 'stub 是 sh 脚本' : false;

test('setup e2e: --link-lark-cli 把桥接凭据交给 lark-cli（Secret 只进 stdin），之后 lark_cli_app 为 ok', { skip: skipNoSh }, () => {
  const root = tmp('gh1-lark-root-');
  const home = tmp('gh1-lark-home-');
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'));
  fs.writeFileSync(path.join(root, '.env.example'), 'FEISHU_APP_ID=\nFEISHU_APP_SECRET=\nOWNER_OPEN_ID=\n');
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const envText = `FEISHU_APP_ID=cli_bridgeapp\nFEISHU_APP_SECRET=${SECRET}\nOWNER_OPEN_ID=ou_testowner\n`;
  fs.writeFileSync(path.join(root, '.env'), envText, { mode: 0o600 });
  const larkBin = makeLarkStub(home);
  fs.writeFileSync(path.join(home, 'app'), 'cli_otherapp');
  const env = { PATH: process.env.PATH, HOME: home, USER: 'tester', CLAUDE_BIN: makeClaudeStub(home), LARK_CLI_BIN: larkBin };
  const go = (...args) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'setup.js'), '--json', '--no-network', '--root', root, ...args],
    { encoding: 'utf8', env, timeout: 60_000 });

  const before = JSON.parse(go().stdout);
  assert.equal(before.items.find((i) => i.id === 'lark_cli_app').status, 'warn');

  const held = go('--link-lark-cli');
  assert.equal(held.status, 2, held.stdout);
  assert.equal(JSON.parse(held.stdout).items.find((i) => i.id === 'link_lark_cli').status, 'needs_human');
  assert.equal(fs.readFileSync(path.join(home, 'app'), 'utf8'), 'cli_otherapp', '没 --force 不替换');

  const linked = go('--link-lark-cli', '--force');
  assert.equal(linked.status, 0, linked.stdout);
  const j = JSON.parse(linked.stdout);
  assert.equal(j.items.find((i) => i.id === 'link_lark_cli').status, 'ok');
  assert.equal(fs.readFileSync(path.join(home, 'app'), 'utf8'), 'cli_bridgeapp');
  assert.equal(fs.readFileSync(path.join(home, 'stdin.txt'), 'utf8').trim(), SECRET);
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'args.log'), 'utf8'), /S3cr3t/, 'Secret 不进命令行参数');
  assert.doesNotMatch(linked.stdout + linked.stderr, /S3cr3t/);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), envText, '.env 不被改动');

  const after = JSON.parse(go().stdout);
  assert.equal(after.items.find((i) => i.id === 'lark_cli_app').status, 'ok');
});
