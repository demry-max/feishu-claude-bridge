// 安装体检：npm run doctor（加 --no-network 跳过飞书 scope 探测）。
// 能自动修的直接修（补 OWNER_OPEN_ID、建 workspace 目录），修不了的给出下一步命令。
import 'dotenv/config';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkNode, checkNpm, checkEnvFile, parseAuthStatus } from '../src/doctor.js';
import { ensureOwnerWorkspace } from '../src/workspace.js';
import { fetchGrantedScopes, evaluateScopes, formatScopeReport } from '../src/feishu-scopes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noNetwork = process.argv.includes('--no-network');
let failed = 0;
const line = (ok, title, detail) => {
  if (ok === false) failed++;
  console.log(`${ok === false ? '❌' : ok === null ? '⚠️' : '✅'} ${title}${detail ? `：${detail}` : ''}`);
};
const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: process.env });
  return r.error ? null : String(r.stdout ?? '').trim();
};

// 1) Node
const node = checkNode();
line(node.ok, `Node ${node.version}`, node.ok ? null : `需要 ≥ 18。免 sudo 安装：\n${node.fix}`);

// 2) npm
const npm = checkNpm(sh('npm', ['--version']));
line(npm.ok, `npm ${npm.version ?? '未找到'}`, npm.note);

// 3) claude CLI + 登录
const { checkCliEnvironment, getRuntimeConfig } = await import('../src/claude.js');
const cfg = getRuntimeConfig();
const cli = checkCliEnvironment(cfg.model);
line(!cli.problem, `claude CLI ${cli.version ?? ''} @ ${cli.bin}`, cli.problem ?? null);
if (cli.version) {
  const auth = parseAuthStatus(sh(cli.bin, ['auth', 'status']) ?? '');
  line(auth.loggedIn === null ? null : auth.loggedIn, `claude 登录`, auth.loggedIn ? auth.email : auth.loggedIn === false ? '未登录：运行 claude /login' : '无法判断（claude auth status 输出无法解析）');
}
if (cfg.execModel) {
  const ce = checkCliEnvironment(cfg.execModel);
  line(!ce.problem, `执行模型 ${cfg.execModel}`, ce.problem ?? `聊天/规划=${cfg.model || 'CLI 默认'}`);
}

// 4) .env
const env = checkEnvFile(ROOT);
line(env.ok, '.env', env.ok ? (env.autofilled ? `已自动补写 OWNER_OPEN_ID=${env.autofilled}` : '必填项齐全') : env.fix);

// 5) workspace
const ws = ensureOwnerWorkspace(path.join(ROOT, 'workspace'));
line(ws.ok, 'owner 工作区', ws.ok ? 'memory/journal、skills、schedules、outbox、incoming 就绪' : ws.problem);

// 6) 飞书 scope
if (noNetwork) {
  line(null, '飞书 scope', '已跳过（--no-network）');
} else if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  line(null, '飞书 scope', '缺凭据，跳过');
} else {
  try {
    const granted = await fetchGrantedScopes({
      appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, domain: process.env.FEISHU_DOMAIN,
    });
    const result = evaluateScopes(granted);
    line(result.ok, '飞书 scope', result.ok ? `${result.available.length} 个工具可用` : `\n${formatScopeReport(result)}`);
  } catch (e) {
    line(false, '飞书 scope', `探测失败：${e?.message ?? e}`);
  }
}

console.log(failed ? `\n${failed} 项需要处理。` : '\n全部通过，npm start 即可。');
process.exit(failed ? 1 : 0);
