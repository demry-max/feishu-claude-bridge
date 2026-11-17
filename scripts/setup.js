// 一键安装自检：npm run setup（可重复执行，幂等；给人看也给 AI agent 看）
//
// 顺序：Node 版本 → 依赖 → claude CLI 及版本 → 是否已登录 → .env 不存在则从 .env.example 生成
//      → 报告缺的必填项 → 最后跑 doctor（依赖就绪时）并合并结果。
//
//   --json              机器可读：{ exit, counts, items:[{ id, status, title, message, fix }] }
//                       status = ok | warn | fail | needs_human
//   --no-network        透传给 doctor，跳过飞书 scope 探测
//   --set-owner <ou_…>  把 OWNER_OPEN_ID 写进 .env（只接受 ou_ 开头的 open_id）
//   --log <file>        额外指定一份桥接日志，用来找「owner 未登记时私聊过机器人的人」
//   --link-lark-cli     让飞书官方 lark-cli 用 .env 里同一个应用（lark-cli config init --app-id … --app-secret-stdin，
//                       Secret 只走 stdin）；lark-cli 已配置别的应用时要再加 --force 才替换
//   --root <dir>        对指定目录运行（默认本仓库；测试用）
//
// 退出码：0 = 全绿（⚠️ 提醒不算）；2 = 只差需要人做的步骤（🙋）；1 = 有失败项（agent 应该能修）。
// 不在任何输出里打印密钥值；不调模型、不连飞书（scope 探测由 doctor 做，可 --no-network 关掉）。
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patchEnvFile } from '../src/env-file.js';
import {
  item, checkNodeVersion, checkDeps, checkClaudeCli, checkClaudeAuth, ensureEnvFile, readEnvFile,
  checkRequiredEnv, checkEnvSanity, validOpenId, findOwnerCandidates, readTail, exitCodeFor,
  renderLine, toJson, scrubSecrets, summarize,
} from './lib/checks.js';
import { checkLarkCliApp, linkLarkCli } from './lib/lark-link.js';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = valueOf('--root') ? path.resolve(valueOf('--root')) : path.resolve(HERE, '..');
const json = flag('--json');

const items = [];
const add = (...xs) => items.push(...xs.flat());

// 1) Node
add(checkNodeVersion());

// 2) 依赖
const deps = checkDeps(ROOT);
add(deps);

// 3)+4) claude CLI 与登录（只跑 --version / auth status，不调模型）
const before = readEnvFile(ROOT).values;
const bin = process.env.CLAUDE_BIN || before.CLAUDE_BIN || 'claude';
const cli = checkClaudeCli({ bin });
add(cli);
if (cli.status !== 'fail') add(checkClaudeAuth({ bin, envFile: before }));

// 5) .env
const envItem = ensureEnvFile(ROOT);
add(envItem);

// 5b) --set-owner
const setOwner = valueOf('--set-owner');
if (setOwner !== undefined) {
  if (!validOpenId(setOwner)) {
    add(item('set_owner', 'fail', '写入 OWNER_OPEN_ID', '参数不是 open_id（应以 ou_ 开头）', '从 npm run setup 的 owner 提示或日志里复制完整 open_id'));
  } else if (envItem.status !== 'ok') {
    add(item('set_owner', 'fail', '写入 OWNER_OPEN_ID', '.env 不可用，未写入', '先解决 .env 那一项'));
  } else {
    const ok = patchEnvFile(path.join(ROOT, '.env'), { OWNER_OPEN_ID: setOwner });
    add(ok
      ? item('set_owner', 'ok', '写入 OWNER_OPEN_ID', '已写入 .env（重启 bridge 后生效）')
      : item('set_owner', 'fail', '写入 OWNER_OPEN_ID', '写入失败', '检查 .env 是否可写'));
  }
}

// 6) 必填项（不回显值）
const values = readEnvFile(ROOT).values;
const required = checkRequiredEnv(values);
const owner = required.find((r) => r.id === 'owner');
if (owner?.status === 'needs_human') {
  const logs = [path.join(ROOT, 'bridge.log'), valueOf('--log')].filter(Boolean);
  if (process.platform === 'darwin' && process.env.HOME) {
    const user = String(process.env.USER || 'user').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
    const label = values.LAUNCHD_LABEL || process.env.LAUNCHD_LABEL || `com.${user}.feishu-claude-bridge`;
    logs.push(path.join(process.env.HOME, 'Library', 'Logs', `${label}.log`));
  }
  const ids = [...new Set(logs.flatMap((f) => findOwnerCandidates(readTail(f))))];
  if (ids.length) {
    owner.message += `；日志里有 owner 未登记时私聊过机器人的人：${ids.join('、')}（最近的在前）`;
    owner.fix = `请人确认哪个是 owner 后：npm run setup -- --set-owner ${ids[0]}`;
  }
}
add(required, checkEnvSanity(values));

// 6b) lark-cli 与桥接是不是同一个应用（只跑本地的 lark-cli config show；没装就跳过）
const larkBin = process.env.LARK_CLI_BIN || values.LARK_CLI_BIN || 'lark-cli';
add(flag('--link-lark-cli')
  ? linkLarkCli(values, { bin: larkBin, force: flag('--force') })
  : checkLarkCliApp(values, { bin: larkBin }));

// 7) doctor（需要依赖；结果按 id 合并，setup 已有的项不重复）
if (deps.status === 'ok') {
  const args = [path.join(HERE, 'doctor.js'), '--json', '--root', ROOT];
  if (flag('--no-network')) args.push('--no-network');
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env, timeout: 120_000 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 下面报错 */ }
  if (parsed?.items) {
    const seen = new Set(items.map((i) => i.id));
    // doctor 的 .env 项总是晚于 setup 生成 .env，信息以 setup 为准
    add(parsed.items.filter((i) => !seen.has(i.id)));
  } else {
    add(item('doctor', 'fail', 'doctor', `运行失败（退出码 ${r.status ?? r.error?.code}）`, 'npm run doctor 看完整输出'));
  }
} else {
  add(item('doctor', 'warn', 'doctor', '依赖未安装，跳过（装好依赖后重跑 npm run setup）'));
}

// 输出
const exit = exitCodeFor(items);
const next = exit === 0
  ? '全绿。下一步：npm start 前台验证（私聊机器人一句话应有回复），再 npm run install-service 常驻。'
  : exit === 2
    ? '只差 🙋 标记的人工步骤：把对应提示转告给人，完成后重跑 npm run setup。'
    : '有 ❌ 项：按每项的 → 提示修复后重跑 npm run setup。';
const { counts } = summarize(items);
const text = json
  ? toJson(items, { next })
  : [...items.map(renderLine),
      `\n✅ ${counts.ok}  ⚠️ ${counts.warn}  ❌ ${counts.fail}  🙋 ${counts.needs_human}`,
      next].join('\n');
console.log(scrubSecrets(text, readEnvFile(ROOT).values));
process.exitCode = exit;
