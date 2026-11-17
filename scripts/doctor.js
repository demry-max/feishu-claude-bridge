// 安装体检：npm run doctor
//   --no-network   跳过飞书 scope 探测（唯一联网的一项）
//   --json         机器可读输出：{ exit, counts, items:[{ id, status, title, message, fix }] }
//   --root <dir>   体检指定目录（默认本仓库；测试用）
// 能自动修的直接修（从 data/owner.json 补 OWNER_OPEN_ID、建 workspace 目录），修不了的给出下一步命令。
// 退出码（文本模式，与旧版兼容）：0 = 全部通过（⚠️ 提醒不算失败）；1 = 有 ❌ 或 🙋（需要人）项。
// --json 模式与 npm run setup 一致用三态：0 全绿 / 2 只差需要人的步骤 / 1 有失败项（JSON 里的 exit 字段同值）。
// 依赖（npm ci）没装时也能跑：先报「依赖未安装」，不抛 ERR_MODULE_NOT_FOUND。
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNode, checkNpm, checkEnvFile } from '../src/doctor.js';
import {
  item, defaultRun, checkDeps, checkClaudeCli, checkClaudeAuth, checkRequiredEnv, checkEnvSanity,
  checkShadowed, checkOptionalBins, checkService, findOwnerCandidates, readTail, ownerLogFiles, ownerHint,
  readEnvFile, renderLine, toJson, scrubSecrets, exitCodeFor,
} from './lib/checks.js';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = valueOf('--root') ? path.resolve(valueOf('--root')) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = flag('--json');
const noNetwork = flag('--no-network');

const items = [];
const add = (...xs) => items.push(...xs.flat());

function finish() {
  const { values } = readEnvFile(ROOT);
  const problems = items.filter((i) => i.status === 'fail' || i.status === 'needs_human').length;
  const human = items.filter((i) => i.status === 'needs_human').length;
  const out = json
    ? toJson(items)
    : [
        ...items.map(renderLine),
        problems
          ? `\n${problems} 项需要处理${human ? `（其中 ${human} 项 🙋 需要人操作）` : ''}。`
          : '\n全部通过，npm start 即可。',
      ].join('\n');
  console.log(scrubSecrets(out, values));
  process.exit(json ? exitCodeFor(items) : problems ? 1 : 0);
}

// 1) Node
const node = checkNode();
add(node.ok
  ? item('node', 'ok', `Node ${node.version}`)
  : item('node', 'fail', `Node ${node.version}`, '需要 ≥ 18', `免 sudo 安装：\n${node.fix}`));

// 2) npm
const npmV = defaultRun('npm', ['--version'], { shell: process.platform === 'win32' });
const npm = checkNpm(npmV.ok ? npmV.stdout.trim() : null);
add(item('npm', npm.ok ? 'ok' : 'fail', `npm ${npm.version ?? '未找到'}`, npm.note ?? '', npm.ok ? '' : 'npm 随 Node 一起安装；重新安装 Node'));

// 3) 依赖：没装就到此为止（后面的检查要用到依赖）
const deps = checkDeps(ROOT);
add(deps);
if (deps.status !== 'ok') finish();

// 依赖就绪后再加载 .env（dotenv 17 默认往 stdout 打一行提示，会弄坏 --json，所以 quiet）
const dotenv = await import('dotenv');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
const envFile = readEnvFile(ROOT);

// 4) claude CLI + 登录
const bin = process.env.CLAUDE_BIN || 'claude';
const cliItem = checkClaudeCli({ bin });
add(cliItem);
if (cliItem.status !== 'fail') {
  // 模型 ↔ CLI 最低版本的对应关系在 src/claude.js 里维护
  const { checkCliEnvironment, getRuntimeConfig } = await import('../src/claude.js');
  const cfg = getRuntimeConfig();
  const cli = checkCliEnvironment(cfg.model);
  if (cli.problem) add(item('claude_model', 'fail', `模型 ${cfg.model || 'CLI 默认'}`, cli.problem, '升级 claude（npm install -g @anthropic-ai/claude-code）或在 .env 改 CLAUDE_MODEL'));
  add(checkClaudeAuth({ bin, envFile: envFile.values }));
  if (cfg.execModel) {
    const ce = checkCliEnvironment(cfg.execModel);
    add(item('claude_exec_model', ce.problem ? 'fail' : 'ok', `执行模型 ${cfg.execModel}`, ce.problem ?? `聊天/规划=${cfg.model || 'CLI 默认'}`));
  }
}

// 5) .env
const env = checkEnvFile(ROOT);
if (!envFile.exists) {
  add(item('env_file', 'fail', '.env', '不存在', 'npm run setup（从 .env.example 生成），或 npm run register 扫码新建应用'));
} else {
  const after = readEnvFile(ROOT).values;
  add(item('env_file', 'ok', '.env', env.autofilled ? '已从 data/owner.json 补写 OWNER_OPEN_ID' : env.ok ? '必填项齐全' : '已存在'));
  const required = checkRequiredEnv(after);
  const owner = required.find((r) => r.id === 'owner');
  if (owner?.status === 'needs_human') {
    const label = process.env.LAUNCHD_LABEL || (await import('../src/launchd.js')).defaultLabel();
    const logs = ownerLogFiles({ root: ROOT, home: os.homedir(), label });
    const hint = ownerHint(logs.flatMap((f) => findOwnerCandidates(readTail(f))));
    if (hint) {
      owner.message += hint.message;
      owner.fix = hint.fix;
    }
  }
  add(required.filter((r) => r.status !== 'ok'), checkEnvSanity(after), checkShadowed(after, process.env, ['CLAUDE_MODEL', 'CLAUDE_EFFORT', 'GUEST_TOOLS', 'OWNER_OPEN_ID', 'OWNER_TOOL_PROFILE']));
}

// 6) 可选外部命令
add(checkOptionalBins(envFile.values));

// 7) workspace
const { ensureOwnerWorkspace } = await import('../src/workspace.js');
const ws = ensureOwnerWorkspace(path.join(ROOT, 'workspace'));
add(item('workspace', ws.ok ? 'ok' : 'fail', 'owner 工作区', ws.ok ? 'memory/journal、skills、schedules、outbox、incoming、tasks 就绪' : ws.problem));

// 8) 常驻服务（只读：不安装、不改动）
if (!flag('--no-service')) {
  const { defaultLabel } = await import('../src/launchd.js');
  const { shutdownGraceSec } = await import('../src/shutdown.js');
  add(checkService({
    home: os.homedir(),
    label: defaultLabel(),
    uid: process.getuid?.(),
    graceSec: shutdownGraceSec(process.env, () => {}),
    root: ROOT,
    appData: process.env.APPDATA,
  }));
}

// 9) 飞书 scope（联网）
if (noNetwork) {
  add(item('feishu_scopes', 'warn', '飞书 scope', '已跳过（--no-network）'));
} else if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  add(item('feishu_scopes', 'warn', '飞书 scope', '缺凭据，跳过'));
} else {
  const { fetchGrantedScopes, evaluateScopes, formatScopeReport } = await import('../src/feishu-scopes.js');
  try {
    const granted = await fetchGrantedScopes({
      appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, domain: process.env.FEISHU_DOMAIN,
    });
    const result = evaluateScopes(granted);
    add(result.ok
      ? item('feishu_scopes', 'ok', '飞书 scope', `${result.available.length} 个工具可用`)
      : item('feishu_scopes', 'needs_human', '飞书 scope', `\n${formatScopeReport(result)}`,
          '请人在开发者后台「权限管理」批量导入上面的 scope，并「版本管理与发布」发布一个新版本'));
  } catch (e) {
    add(item('feishu_scopes', 'fail', '飞书 scope', `探测失败：${e?.message ?? e}`,
      'App ID / Secret 不对，或网络 / 代理不通（需要能访问 open.feishu.cn / open.larksuite.com，见 AGENTS.md「常见故障」）'));
  }
}

finish();
