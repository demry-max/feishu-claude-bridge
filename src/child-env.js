// BRIDGE-RUN-1（H3 / L13）：交给 claude 子进程的环境变量。
//
// 桥接进程的环境里有它自己的配置——飞书 App Secret、owner 的 open_id、白名单、各种功能开关。
// 过去 spawn 时整份 `env: process.env` 递给 claude：子进程以及它起的 Bash / MCP / hook 全都读得到，
// 模型一句 `env` 就能把飞书 App Secret 读出来。App Secret 特意不进 argv、写 0600 临时文件传给 MCP，
// 靠环境继承漏出去等于白做。MCP 要用的飞书凭据由临时 mcp.json 的 env 字段单独交给它，不靠继承。
//
// 做法：黑名单，去掉三类——
//   1. BRIDGE_OWN_KEYS：桥接自己的配置项（模板里的全部键，加上 src/、scripts/ 里读取的环境变量名）；
//   2. 任何以 FEISHU_ 开头的键（以后新增的飞书类配置默认就不外传，不用记得回来补清单）；
//   3. BRIDGE-RUN-2：桥接自己的 .env 文件里写了的键（启动时由 index.js 把键名登记进来，见 registerEnvFileKeys）。
//      清单会漏——有人往 .env 里放了 R2_SECRET_ACCESS_KEY、GITHUB_TOKEN 之类、清单里没有的键，dotenv 会把它们灌进桥接的
//      环境，继承给 claude 就等于交给模型。放行项（PASSTHROUGH：登录令牌、HOME、PATH……）不受这条影响，写在 .env 里也照样传。
//      只取键名：.env 的值读出来就丢，不进日志、不进返回值。没登记过（或登记了空表）时与前两条完全一致。
// 其余原样透传：代理、语言区域、ANTHROPIC_*、CLAUDE_CODE_*、CLAUDE_CONFIG_DIR 等 claude 自己要用的都不动
// （前提是它们不写在桥接的 .env 里——写在 .env 里的一律不外传，要给 claude 用的请设在服务自己的环境里）。
// 不做白名单：claude CLI 认的环境变量很多、随版本增减，白名单漏一个就是登录态 / 代理悄悄失效。
//
// 清单怎么维护：test/child-env.test.js 的防漂移测试会对照模板与 src/、scripts/ 里读取的环境变量名，
// 出现这里没归类的名字就红，并列出名字（只列名字，不含值）。新增配置项时，桥接自己用的加进
// BRIDGE_OWN_KEYS；必须传给子进程的加进 PASSTHROUGH，并写明原因。
//
// 本文件不打印任何值；读的只有 .env 文件（且只留键名）和 DOTENV_CONFIG_PATH（只用来判断路径是不是显式指定的）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';

/** 必须传给子进程的键（桥接或脚本也读它们），每项写原因。与 BRIDGE_OWN_KEYS 互不相交。 */
export const PASSTHROUGH = Object.freeze({
  CLAUDE_CODE_OAUTH_TOKEN: 'claude 自己的长期登录令牌；常驻服务不继承终端环境时靠它登录（见 AGENTS.md 2.3），去掉就等于登出',
  HOME: 'claude 的配置目录、登录态与钥匙串都按 HOME 定位；hook 也读它',
  USER: 'claude CLI 与钥匙串取当前用户名',
  PATH: '找 node / git / rg / 备用 claude；MCP 子进程与 hook 的启动也靠它',
  TMPDIR: '每用户临时目录：临时 mcp.json 与 hook 的落盘位置按它走',
  APPDATA: 'Windows 下 claude 的配置位置',
  NODE_TLS_REJECT_UNAUTHORIZED: '业务系统 MCP（mcp-biz）靠继承读取这个 TLS 开关；去掉会让它悄悄回到严格校验',
});

/** 桥接自己的配置项：一律不给 claude 子进程。 */
export const BRIDGE_OWN_KEYS = Object.freeze([
  // 飞书应用与工具开关（另有 FEISHU_ 前缀的整体拦截，见 childEnv）
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DOMAIN', 'FEISHU_TOOLS', 'FEISHU_MCP_FENCE',
  // owner 与访问控制
  'OWNER_OPEN_ID', 'OWNER_NAME', 'OWNER_EXTRA_SKILLS', 'OWNER_MESSAGE_QUEUE', 'OWNER_STRICT_DENY_WRITE_DIRS', 'OWNER_TOOL_PROFILE',
  'ALLOW_USERS', 'ALLOW_CHATS', 'ALLOW_OWNER_CLAIM',
  // 工具面
  'ALLOWED_TOOLS', 'NON_OWNER_TOOLS', 'GUEST_TOOLS', 'GUEST_DENIED_TOOLS', 'LARK_CLI', 'LARK_CLI_BIN',
  'BMS_TOOL_ENABLED', 'BRAIN_TOOL_ENABLED', 'TOOL_AUDIT_SUMMARY_AT',
  // 调 claude 本身
  'CLAUDE_BIN', 'CLAUDE_MODEL', 'CLAUDE_EFFORT', 'CLAUDE_EXEC_MODEL', 'CLAUDE_EXEC_EFFORT',
  'CLAUDE_TIMEOUT_MS', 'CLAUDE_IDLE_TIMEOUT_MS', 'CLAUDE_RESULT_GRACE_MS', 'CLAUDE_MAX_RETRIES',
  'CLAUDE_FALLBACK_BIN', 'CLAUDE_FALLBACK_COOLDOWN_MIN',
  'CONTEXT_NUDGE_TOKENS', 'DIAG_MODEL', 'EXEC_TRIGGERS', 'MEMORY_RECALL_MAX', 'PROGRESS_MIN_INTERVAL_MS',
  // 每日新会话
  'DAILY_SESSION', 'DAILY_SESSION_AT', 'DAILY_SESSION_HANDOFF_AT', 'DAILY_SESSION_KEEP_DAYS', 'DAILY_SESSION_ROUNDS',
  // 心跳、台账、验收、升级
  'HEARTBEAT_ENABLED', 'HEARTBEAT_BUTTONS', 'HEARTBEAT_DIGEST_AT', 'HEARTBEAT_EFFORT', 'HEARTBEAT_ESCALATE_LADDER',
  'HEARTBEAT_INTERVAL_MIN', 'HEARTBEAT_MAX_RUNS_PER_DAY', 'HEARTBEAT_MODEL', 'HEARTBEAT_QUIET_HOURS',
  'HEARTBEAT_REPLY_SHORTCUTS', 'HEARTBEAT_UNREAD_PAUSE', 'HEARTBEAT_VERIFY', 'HEARTBEAT_WATCH', 'HEARTBEAT_WATCH_MAX',
  'ESCALATE_MAX', 'VERIFY_MODEL', 'VERIFY_MAX_PER_DAY',
  // 定时任务、目录、杂项
  'SCHED_MAX_CONCURRENT', 'SCHED_MAX_LATE_MS', 'SCHED_APPROVAL_MODE', 'WORKSPACE_DIR', 'GUEST_WORKSPACE_DIR', 'DATA_DIR', 'INCOMING_TTL_MS',
  'SHUTDOWN_GRACE_SEC', 'STARTUP_NOTICE', 'WS_PING_TIMEOUT_SEC', 'LAUNCHD_LABEL',
  'BRIDGE_BACKFILL', 'BRIDGE_SWEEP_MIN', 'BRIDGE_STALE_MS', // BRIDGE-STD-1：补拉与过期（按字符串键名读，防漂移扫描认不出，要手工列在这里）
  'TTS_VOICE', 'TTS_MAX_CHARS', 'FFMPEG_BIN',
  // dotenv 自己的 .env 路径开关（BRIDGE-RUN-2）：不外传也让 claude 起的、会 import 'dotenv/config' 的 MCP 子进程读不到桥接的 .env
  'DOTENV_CONFIG_PATH',
]);

const OWN = new Set(BRIDGE_OWN_KEYS);

// 桥接 .env 文件里写了的键名（BRIDGE-RUN-2）。启动时登记一次；没登记过就是空集，行为与 RUN-1 完全一致。
let fileKeys = new Set();

/**
 * 读 .env 文件里的键名（只要名字：值读出来就丢，不进日志、不进返回值）。
 * 路径开头的 `~` 按 dotenv 的规则展开成用户主目录（dotenv 的 _resolveHome：只看第 1 个字符是不是 `~`）。
 * 文件不存在 → []：路径是显式指定的（等于 DOTENV_CONFIG_PATH，或传了 explicit）时打一行不带任何键值的警告，
 *   没指定（默认的 cwd/.env，没有 .env、全靠服务自己的环境变量是正常配法）不打日志；
 * 读不了（权限、是目录……）→ 打一行带错误码的警告、返回 []，这次只按清单过滤。永不抛。
 * @param {string} file
 * @param {{log?: (msg: string) => void, read?: (file: string, enc: string) => string, explicit?: boolean, home?: string}} [o]
 */
export function readEnvFileKeys(file, { log = console.error, read = fs.readFileSync, explicit, home } = {}) {
  const say = (msg) => { try { log(msg); } catch { /* 日志出错不影响启动 */ } };
  try {
    const envPath = process.env.DOTENV_CONFIG_PATH;
    const isExplicit = explicit ?? (typeof envPath === 'string' && envPath !== '' && envPath === file);
    const target = typeof file === 'string' && file[0] === '~' ? path.join(home ?? os.homedir(), file.slice(1)) : file;
    try {
      return Object.keys(parseDotenv(read(target, 'utf8')));
    } catch (e) {
      if (e?.code === 'ENOENT') {
        if (isExplicit) say('[config] ⚠️ 指定的 .env 读不到，无法按文件剥离键');
        return [];
      }
      say(`[config] ⚠️ 读不了 .env 的键名（${e?.code ?? 'ERR'}），这次只按清单过滤`);
      return [];
    }
  } catch {
    return [];
  }
}

/**
 * 登记「.env 文件里写了的键名」（整体替换上一次登记）：此后 childEnv 去掉这些键，放行项除外。
 * 非数组当空表；只收非空字符串。
 * 返回「只因为这一条才被去掉」的键名（不在 BRIDGE_OWN_KEYS、不以 FEISHU_ 开头、不是放行项），排序后，供启动日志列名字提醒。
 * @param {unknown} names
 * @returns {string[]}
 */
export function registerEnvFileKeys(names) {
  fileKeys = new Set(Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n !== '') : []);
  return [...fileKeys]
    .filter((k) => !OWN.has(k) && !k.startsWith('FEISHU_') && !Object.hasOwn(PASSTHROUGH, k))
    .sort();
}

/**
 * 子进程环境：src 的一份拷贝，去掉桥接自己的键、所有 FEISHU_* 键，以及（登记过的话）桥接 .env 里写了的键（放行项除外）。
 * 返回新对象，不改 src；被去掉的键即使值是空串也不留。
 */
export function childEnv(src = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (OWN.has(k) || k.startsWith('FEISHU_')) continue;
    if (fileKeys.has(k) && !Object.hasOwn(PASSTHROUGH, k)) continue; // BRIDGE-RUN-2：.env 里写了的、清单之外的键
    out[k] = v;
  }
  return out;
}
