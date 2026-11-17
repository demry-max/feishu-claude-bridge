// 安装 / 体检共用的纯逻辑（npm run setup 与 npm run doctor 共用）。
//
// 约束：
// - 只用 Node 内置模块：依赖还没装（没跑 npm ci）时也必须能跑，并把「先装依赖」说清楚，
//   而不是抛一屏 ERR_MODULE_NOT_FOUND。
// - 任何输出（message / fix）都不带密钥值：.env 里的值只报「已填 / 未填 / 格式不对」。
// - 外部命令一律经注入的 run(cmd, args, opts) 调用，便于测试替换；不调模型、不联网。
//
// 每个检查返回一项 { id, status, title, message, fix }：
//   status = ok | warn | fail | needs_human
//   ok          通过
//   warn        不影响启动的提醒（可选功能缺件、拿不准的状态）
//   fail        agent 自己能修、但还没修好（缺依赖、Node 太旧、找不到 claude）
//   needs_human 只能由人完成的步骤（扫码 / 飞书后台操作 / claude 登录 / 告知 owner 身份）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const STATUSES = ['ok', 'warn', 'fail', 'needs_human'];
export const EXIT = { ok: 0, fail: 1, needs_human: 2 };
export const MIN_NODE_MAJOR = 18;
export const REQUIRED_ENV = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'OWNER_OPEN_ID'];

export const item = (id, status, title, message = '', fix = '') => ({ id, status, title, message, fix });

/** 默认的外部命令执行器：失败不抛，返回 { ok, status, stdout, stderr, error } */
export function defaultRun(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000, ...opts });
  return {
    ok: !r.error && r.status === 0,
    status: r.status,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    error: r.error ? (r.error.code || r.error.message) : null,
  };
}

/** .env 文本 → { KEY: value }。与 src/doctor.js 的读法一致：去掉行尾「 # 注释」与首尾空白、可选成对引号。 */
export function parseEnvText(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    let v = m[2];
    const q = v.trim().match(/^(['"])(.*)\1/);
    if (q) v = q[2];
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

export function readEnvFile(root) {
  const p = path.join(root, '.env');
  try {
    return { exists: true, values: parseEnvText(fs.readFileSync(p, 'utf8')) };
  } catch {
    return { exists: false, values: {} };
  }
}

/** Node 版本 */
export function checkNodeVersion(version = process.version) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  if (major >= MIN_NODE_MAJOR) return item('node', 'ok', `Node ${version}`);
  return item('node', 'fail', `Node ${version}`, `需要 Node ≥ ${MIN_NODE_MAJOR}（建议当前 LTS）`,
    '安装 Node ≥ 18：https://nodejs.org/（无 sudo 时用官方 tarball 解压到 ~/.local/node，见 AGENTS.md 第 1 步）');
}

/** package.json 的 dependencies 是否都已装进 node_modules（只看目录与 package.json，不跑 npm） */
export function checkDeps(root) {
  let deps = [];
  try {
    deps = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies ?? {});
  } catch {
    return item('deps', 'fail', '依赖', '读不到 package.json（是不是不在仓库根目录？）', 'cd 到克隆下来的仓库根目录再运行');
  }
  const missing = deps.filter((d) => !fs.existsSync(path.join(root, 'node_modules', ...d.split('/'), 'package.json')));
  if (!missing.length) return item('deps', 'ok', '依赖', `${deps.length} 个依赖已安装`);
  return item('deps', 'fail', '依赖', `未安装：${missing.join('、')}`,
    '在仓库根目录运行 npm ci（按 package-lock.json 精确安装；需要联网访问 npm registry）');
}

/** claude CLI 是否存在 + 版本（只跑 --version，不调模型） */
export function checkClaudeCli({ bin = 'claude', run = defaultRun, env = process.env } = {}) {
  const r = run(bin, ['--version'], { env });
  if (r.error || !r.ok) {
    return item('claude_cli', 'fail', 'claude CLI', `找不到或无法运行 ${bin}${r.error ? `（${r.error}）` : ''}`,
      'npm install -g @anthropic-ai/claude-code，装好后 claude --version 应输出版本号；装在非 PATH 位置时在 .env 设 CLAUDE_BIN=<绝对路径>');
  }
  const version = (r.stdout.match(/(\d+\.\d+\.\d+)/) ?? [])[1] ?? null;
  if (!version) return item('claude_cli', 'warn', 'claude CLI', `无法解析版本：${r.stdout.trim().slice(0, 80)}`, '');
  return { ...item('claude_cli', 'ok', `claude CLI ${version}`), version };
}

/** 邮箱只露首字母和域名，避免整串进对话记录 */
export function maskEmail(email) {
  const m = String(email ?? '').match(/^(.)[^@]*(@.+)$/);
  return m ? `${m[1]}***${m[2]}` : '';
}

/**
 * claude 是否已登录。用 `claude auth status`：本地查询登录态，不调模型、不花额度。
 * 解析不了（CLI 太旧没有这个子命令、输出格式变了）一律报「未能确认」，不把它当成「没登录」。
 */
export function checkClaudeAuth({ bin = 'claude', run = defaultRun, env = process.env, envFile = {} } = {}) {
  const hasToken = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN || envFile.CLAUDE_CODE_OAUTH_TOKEN);
  // 子进程只多给它需要的那一项（.env 里的 App Secret 等不进 claude 的环境）
  const extra = envFile.CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: envFile.CLAUDE_CODE_OAUTH_TOKEN } : {};
  const r = run(bin, ['auth', 'status'], { env: { ...extra, ...env } });
  let loggedIn = null;
  let email = null;
  try {
    const j = JSON.parse(r.stdout);
    if (typeof j.loggedIn === 'boolean') loggedIn = j.loggedIn;
    email = j.email ?? null;
  } catch { /* 非 JSON：未能确认 */ }
  if (loggedIn === true) return item('claude_auth', 'ok', 'claude 登录', email ? `已登录（${maskEmail(email)}）` : '已登录');
  if (loggedIn === false && !hasToken) {
    return item('claude_auth', 'needs_human', 'claude 登录', '未登录',
      '请人在这台机器的终端运行 claude，按提示 /login 在浏览器完成授权（订阅账号）；完成后重跑 npm run setup');
  }
  return item('claude_auth', 'warn', 'claude 登录',
    hasToken ? '未能确认（配置了 CLAUDE_CODE_OAUTH_TOKEN，但 claude auth status 没有确认登录）' : '未能确认（claude auth status 输出无法解析，CLI 可能太旧）',
    '请人确认：在终端运行 claude 能正常对话即已登录；或升级 CLI 后重跑 npm run setup');
}

/**
 * .env 不存在时从 .env.example 生成（权限 600）。幂等：已存在时内容一个字节都不动；
 * 但权限对组 / 其他用户开放（别的写入路径留下的 644）时收紧为 600（Windows 不动）。
 */
export function ensureEnvFile(root, { platform = process.platform } = {}) {
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) return tightenEnvMode(envPath, platform);
  const example = path.join(root, '.env.example');
  if (!fs.existsSync(example)) {
    return item('env_file', 'fail', '.env', '.env 与 .env.example 都不存在', '确认在仓库根目录；git checkout -- .env.example 恢复模板后重跑');
  }
  try {
    fs.copyFileSync(example, envPath, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(envPath, 0o600); } catch { /* Windows 无 chmod 语义 */ }
    return { ...item('env_file', 'ok', '.env', '已从 .env.example 生成（权限 600）'), created: true };
  } catch (e) {
    if (e?.code === 'EEXIST') return item('env_file', 'ok', '.env', '已存在（未改动）');
    return item('env_file', 'fail', '.env', `生成失败：${e?.code || e?.message}`, '检查仓库目录是否可写');
  }
}

function tightenEnvMode(envPath, platform) {
  const unchanged = item('env_file', 'ok', '.env', '已存在（未改动）');
  if (platform === 'win32') return unchanged;
  try {
    if ((fs.statSync(envPath).mode & 0o077) === 0) return unchanged;
    fs.chmodSync(envPath, 0o600);
    return item('env_file', 'ok', '.env', '已存在（权限已收紧为 600）');
  } catch (e) {
    return item('env_file', 'warn', '.env', `已存在，但权限没能收紧为 600：${e?.code || e?.message}`, 'chmod 600 .env');
  }
}

/** 必填项：只报已填 / 未填，不回显值 */
export function checkRequiredEnv(values) {
  const out = [];
  const hasId = Boolean(values.FEISHU_APP_ID);
  const hasSecret = Boolean(values.FEISHU_APP_SECRET);
  if (hasId && hasSecret) out.push(item('feishu_credentials', 'ok', '飞书应用凭据', 'FEISHU_APP_ID / FEISHU_APP_SECRET 已填'));
  else {
    out.push(item('feishu_credentials', 'needs_human', '飞书应用凭据',
      `未填：${[!hasId && 'FEISHU_APP_ID', !hasSecret && 'FEISHU_APP_SECRET'].filter(Boolean).join('、')}`,
      '新建应用：npm run register -- --no-wait 打印扫码链接交给人扫码，人扫完后 npm run register -- --resume；' +
      '已有应用：请人把 App ID / App Secret 填进 .env（agent 不要索要、也不要在对话里回显 Secret）'));
  }
  if (values.OWNER_OPEN_ID) out.push(item('owner', 'ok', 'owner 身份', 'OWNER_OPEN_ID 已填'));
  else {
    out.push(item('owner', 'needs_human', 'owner 身份', 'OWNER_OPEN_ID 未填',
      '扫码注册会自动写入；沿用已有应用：先 npm start > bridge.log 2>&1 启动（> 覆盖旧日志，只看本次启动之后的私聊），' +
      '只请 owner 一个人在飞书私聊机器人一句话，再运行 npm run setup，它会从日志里找出这次私聊者的 open_id（AGENTS.md §5）'));
  }
  return out;
}

/** 常见的值写错（只看格式，不回显值） */
export function checkEnvSanity(values) {
  const out = [];
  const warn = (id, title, message, fix) => out.push(item(id, 'warn', title, message, fix));
  if (values.FEISHU_APP_ID && !/^cli_[A-Za-z0-9]+$/.test(values.FEISHU_APP_ID)) {
    warn('env_app_id_format', 'FEISHU_APP_ID 格式', '不像飞书 App ID（应以 cli_ 开头）', '到开发者后台「凭证与基础信息」核对');
  }
  if (values.OWNER_OPEN_ID && !/^ou_[A-Za-z0-9_-]+$/.test(values.OWNER_OPEN_ID)) {
    warn('env_owner_format', 'OWNER_OPEN_ID 格式', '不像飞书 open_id（应以 ou_ 开头）', '重新扫码注册，或用 npm run setup -- --set-owner <open_id> 改正');
  }
  if (values.FEISHU_DOMAIN && !['feishu', 'lark'].includes(values.FEISHU_DOMAIN)) {
    warn('env_domain', 'FEISHU_DOMAIN', '只认 lark（国际版）；其它值一律按飞书（feishu）处理', '国际版写 FEISHU_DOMAIN=lark，飞书留空');
  }
  if (values.OWNER_TOOL_PROFILE && !['legacy', 'audit', 'strict'].includes(values.OWNER_TOOL_PROFILE)) {
    warn('env_tool_profile', 'OWNER_TOOL_PROFILE', '只能是 legacy / audit / strict，当前值会按 legacy 处理', '改成三者之一');
  }
  if (values.ALLOW_OWNER_CLAIM === 'true') {
    warn('env_owner_claim', 'ALLOW_OWNER_CLAIM', '已开启「首个私聊者自动认领 owner」', 'owner 登记完成后删掉这一行或改回空，避免 owner 记录丢失时被别人认领');
  }
  return out;
}

/** shell 里 export 过、与 .env 不同的同名变量：dotenv 不覆盖已有环境变量，.env 的值会被静默忽略 */
export function checkShadowed(values, env = process.env, keys = Object.keys(values)) {
  const shadowed = keys.filter((k) => values[k] && env[k] !== undefined && env[k] !== values[k]);
  if (!shadowed.length) return [];
  return [item('env_shadowed', 'warn', '环境变量覆盖', `shell 环境里的同名变量会盖过 .env：${shadowed.join(', ')}`,
    `前台启动前 unset ${shadowed.join(' ')}；常驻服务（launchd）不继承 shell 环境，不受影响`)];
}

/** 可选外部命令（lark-cli / ffmpeg）：只在相关开关打开时检查，缺了只提醒 */
export function checkOptionalBins(values, { run = defaultRun, env = process.env } = {}) {
  const out = [];
  const needsLark = values.LARK_CLI === 'true' || (values.HEARTBEAT_WATCH && values.HEARTBEAT_WATCH !== 'none');
  if (needsLark) {
    const bin = values.LARK_CLI_BIN || 'lark-cli';
    const r = run(bin, ['--version'], { env });
    out.push(r.error
      ? item('lark_cli', 'warn', 'lark-cli', `开了 LARK_CLI / HEARTBEAT_WATCH，但找不到 ${bin}`,
          'npm install -g @larksuite/cli，再 npm run setup -- --link-lark-cli 让它用桥接同一个应用，然后以 owner 身份 lark-cli auth login（要人在浏览器完成，AGENTS.md §3C）；不用这些功能就把开关关掉')
      : item('lark_cli', 'ok', 'lark-cli', '已找到（是否已登录请人确认）'));
  }
  const ff = values.FFMPEG_BIN || 'ffmpeg';
  const r = run(ff, ['-version'], { env });
  out.push(r.error
    ? item('ffmpeg', 'warn', 'ffmpeg（可选）', '未找到：飞书没给转写文本的语音消息无法兜底转写', '需要时 brew install ffmpeg / apt install ffmpeg / winget install ffmpeg')
    : item('ffmpeg', 'ok', 'ffmpeg（可选）', '已找到'));
  return out;
}

/** 写 OWNER_OPEN_ID 前的校验：只接受 ou_ 开头的 open_id */
export function validOpenId(v) {
  return /^ou_[A-Za-z0-9_-]{6,}$/.test(String(v ?? ''));
}

/**
 * 从桥接日志里找「owner 未登记时私聊过机器人的人」。index.js 在 owner 未登记、又没开认领时会记：
 *   [owner] owner.json 缺失且未开放认领。… 当前请求者：ou_xxx
 *   [owner] 拒绝认领：ou_xxx 不在 ALLOW_USERS 名单内
 * 返回去重后的 open_id，最近的在前。
 */
export function findOwnerCandidates(logText) {
  const ids = [];
  for (const m of String(logText ?? '').matchAll(/\[owner\][^\n]*?(?:当前请求者：|拒绝认领：)(ou_[A-Za-z0-9_-]+)/g)) ids.push(m[1]);
  return [...new Set(ids.reverse())];
}

/**
 * owner 候选 → 附加到 owner 项的 { message, fix }（setup 与 doctor 共用）。没有候选返回 null。
 * 恰好 1 个才预填 --set-owner；2 个及以上不能判定谁是 owner（可能有人抢先私聊），只列出、不给可直接执行的命令。
 */
export function ownerHint(ids = []) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) {
    return {
      message: `；日志里有 1 人在 owner 未登记时私聊过机器人：${list[0]}`,
      fix: `确认这是 owner 本人后：npm run setup -- --set-owner ${list[0]}`,
    };
  }
  return {
    message: `；日志里有 ${list.length} 人在 owner 未登记时私聊过机器人：${list.join('、')}`,
    fix: '多人私聊过，不能判定，不要猜：请其他人暂停私聊，按 AGENTS §5 用新日志重做' +
      '（停掉桥接，npm start > bridge.log 2>&1 重新启动，只让 owner 私聊一句，再 npm run setup）',
  };
}

/** 日志只读末尾一段，避免大日志整读 */
export function readTail(file, bytes = 512 * 1024) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(bytes, st.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** plist 里 EnvironmentVariables.PATH 的值（不解析整个 plist，只取 PATH 那一项） */
export function plistEnvPath(xml) {
  const m = String(xml ?? '').match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

const unescapeXml = (v) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** plist 里的 WorkingDirectory（这个 label 的服务跑的是哪份仓库）；没有返回 null */
export function plistWorkingDir(xml) {
  const m = String(xml ?? '').match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
  return m ? unescapeXml(m[1]) : null;
}

const sameDir = (a, b) => path.resolve(a) === path.resolve(b);

/**
 * install-service 覆盖前的守卫：同一用户的默认 label 是固定的，第二份克隆 / 重装到别的目录时，
 * 直接覆盖会把已有的服务改成指向新目录。已有 plist 指向别的目录、又没加 --force → 返回拒绝说明；否则 null。
 */
export function serviceLabelConflict({ existingXml, root, label, force = false }) {
  if (force || !existingXml) return null;
  const dir = plistWorkingDir(existingXml);
  if (!dir || sameDir(dir, root)) return null;
  return `label ${label} 已被 ${dir} 的桥接占用：在 .env 设 LAUNCHD_LABEL=${label}-2 后重跑；确实要改指向本目录加 --force`;
}

/**
 * 找 owner 候选时要读的日志：本目录的 bridge.log、--log 指定的文件；macOS 上再加 launchd 日志，
 * 但只在这个 label 的 plist 指向本目录时（否则读到的是别的桥接的私聊者）。
 */
export function ownerLogFiles({ root, home, label, extra, platform = process.platform, exists = fs.existsSync, readFile = (p) => fs.readFileSync(p, 'utf8') }) {
  const list = [path.join(root, 'bridge.log')];
  if (extra) list.push(extra);
  if (platform === 'darwin' && home && label) {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    let dir = null;
    try { if (exists(plist)) dir = plistWorkingDir(readFile(plist)); } catch { /* 读不了就不读它的日志 */ }
    if (dir && sameDir(dir, root)) list.push(path.join(home, 'Library', 'Logs', `${label}.log`));
  }
  return list;
}

export function plistExitTimeout(xml) {
  const m = String(xml ?? '').match(/<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/);
  return m ? Number(m[1]) : null;
}

/** 在 plist 的顶层 dict 末尾补 ExitTimeOut（已有则替换）。launchd 默认约 20 秒就强杀，优雅退出等不完。 */
export function withExitTimeout(xml, seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (/<key>ExitTimeOut<\/key>/.test(xml)) {
    return xml.replace(/(<key>ExitTimeOut<\/key>\s*<integer>)\d+(<\/integer>)/, `$1${s}$2`);
  }
  const i = xml.lastIndexOf('</dict>');
  if (i < 0) return xml;
  return `${xml.slice(0, i)}  <key>ExitTimeOut</key><integer>${s}</integer>\n${xml.slice(i)}`;
}

/**
 * macOS 常驻服务检查（只读：读 plist、launchctl print；不装不改）。
 * 其它平台只给提示：Windows 看启动项快捷方式；Linux 没有内置安装脚本。
 */
export function checkService({ platform = process.platform, home, label, uid, graceSec = 120, root, run = defaultRun, exists = fs.existsSync, readFile = (p) => fs.readFileSync(p, 'utf8'), appData } = {}) {
  if (platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    if (!exists(plist)) {
      return [item('service', 'warn', '常驻服务（launchd）', `未安装（${label}）`, '验证前台 npm start 能通之后：npm run install-service')];
    }
    const out = [];
    const xml = readFile(plist);
    // 同 label 的服务跑的是别的目录：它的运行状态、PATH、ExitTimeOut 都和本目录无关，不能报成本目录「运行中」
    const dir = plistWorkingDir(xml);
    if (root && dir && !sameDir(dir, root)) {
      return [item('service', 'warn', '常驻服务（launchd）', `这个 label 属于另一个目录（${dir}）`,
        `本目录要装常驻服务：在 .env 设 LAUNCHD_LABEL=${label}-2 后 npm run install-service；不要覆盖那个服务`)];
    }
    const r = run('launchctl', ['print', `gui/${uid}/${label}`]);
    const pid = (r.stdout.match(/\bpid = (\d+)/) ?? [])[1];
    out.push(r.ok
      ? item('service', pid ? 'ok' : 'warn', '常驻服务（launchd）', pid ? `已加载，运行中（pid ${pid}）` : '已加载，但当前没有进程（可能在 ThrottleInterval 等待重启）',
          pid ? '' : `看日志 ~/Library/Logs/${label}.log 末尾找退出原因`)
      : item('service', 'warn', '常驻服务（launchd）', 'plist 在，但服务未加载', 'npm run install-service 重新加载'));
    const pathValue = plistEnvPath(xml) ?? '';
    const dirs = pathValue.split(':').filter(Boolean);
    if (!dirs.some((d) => exists(path.join(d, 'claude')))) {
      out.push(item('service_claude_path', 'warn', '服务 PATH 里的 claude', 'plist 的 PATH 里找不到 claude：服务启动后每条消息都会失败',
        '确认 which claude 有输出后重跑 npm run install-service（它会把 claude 所在目录写进 PATH）'));
    }
    const exitTimeout = plistExitTimeout(xml);
    if (graceSec > 0 && (exitTimeout === null || exitTimeout < graceSec + 10)) {
      out.push(item('service_exit_timeout', 'warn', '服务 ExitTimeOut',
        `${exitTimeout === null ? '未设置（launchd 默认约 20 秒）' : `${exitTimeout} 秒`}，小于 SHUTDOWN_GRACE_SEC+10=${graceSec + 10}：重启时进行中的对话会被强杀`,
        '重跑 npm run install-service（新版会写入 ExitTimeOut）'));
    }
    return out;
  }
  if (platform === 'win32') {
    const lnk = appData ? path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'feishu-claude-bridge.lnk') : null;
    return [lnk && exists(lnk)
      ? item('service', 'ok', '登录自启（Windows）', '启动项快捷方式已存在（进程崩溃后不会自动拉起，见 AGENTS.md）')
      : item('service', 'warn', '登录自启（Windows）', '未安装', 'powershell -ExecutionPolicy Bypass -File scripts\\windows\\install-startup.ps1')];
  }
  return [item('service', 'warn', '常驻服务（Linux）', '本仓库不自动安装 systemd 服务', '参考 examples/feishu-claude-bridge.service（systemd --user），见 AGENTS.md')];
}

/** 汇总：有 fail → 1；否则有 needs_human → 2；否则 0（warn 不影响） */
export function exitCodeFor(items) {
  if (items.some((i) => i.status === 'fail')) return EXIT.fail;
  if (items.some((i) => i.status === 'needs_human')) return EXIT.needs_human;
  return EXIT.ok;
}

export function summarize(items) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]));
  return { exit: exitCodeFor(items), counts };
}

const ICON = { ok: '✅', warn: '⚠️', fail: '❌', needs_human: '🙋' };

export function renderLine(it) {
  return `${ICON[it.status] ?? '•'} ${it.title}${it.message ? `：${it.message}` : ''}${it.fix ? ` → ${it.fix}` : ''}`;
}

/** 机器可读输出：只保留约定字段，防止调用方顺手塞进去的内部字段（如版本、路径）外溢 */
export function toJson(items, extra = {}) {
  return JSON.stringify({
    ...summarize(items),
    ...extra,
    items: items.map(({ id, status, title, message, fix }) => ({ id, status, title, message, fix })),
  }, null, 2);
}

/** 最终兜底：输出前把已知密钥值替换掉（万一某条 message 意外带上了） */
export function scrubSecrets(text, values = {}) {
  let s = String(text);
  for (const k of ['FEISHU_APP_SECRET', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const v = values[k];
    if (v && v.length >= 6) s = s.split(v).join('***');
  }
  return s;
}
