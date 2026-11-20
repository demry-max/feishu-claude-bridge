// BRIDGE-RUN-1（H3 / L13）：交给 claude 子进程的环境变量。
//
// 桥接进程的环境里有它自己的配置——飞书 App Secret、owner 的 open_id、白名单、各种功能开关。
// 过去 spawn 时整份 `env: process.env` 递给 claude：子进程以及它起的 Bash / MCP / hook 全都读得到，
// 模型一句 `env` 就能把飞书 App Secret 读出来。App Secret 特意不进 argv、写 0600 临时文件传给 MCP，
// 靠环境继承漏出去等于白做。MCP 要用的飞书凭据由临时 mcp.json 的 env 字段单独交给它，不靠继承。
//
// 做法：黑名单，只去掉两类——
//   1. BRIDGE_OWN_KEYS：桥接自己的配置项（模板里的全部键，加上 src/、scripts/ 里读取的环境变量名）；
//   2. 任何以 FEISHU_ 开头的键（以后新增的飞书类配置默认就不外传，不用记得回来补清单）。
// 其余原样透传：代理、语言区域、ANTHROPIC_*、CLAUDE_CODE_*、CLAUDE_CONFIG_DIR 等 claude 自己要用的都不动。
// 不做白名单：claude CLI 认的环境变量很多、随版本增减，白名单漏一个就是登录态 / 代理悄悄失效。
//
// 清单怎么维护：test/child-env.test.js 的防漂移测试会对照模板与 src/、scripts/ 里读取的环境变量名，
// 出现这里没归类的名字就红，并列出名字（只列名字，不含值）。新增配置项时，桥接自己用的加进
// BRIDGE_OWN_KEYS；必须传给子进程的加进 PASSTHROUGH，并写明原因。
//
// 本文件不读任何环境变量，也不打印任何值。

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
  'BMS_TOOL_ENABLED', 'TOOL_AUDIT_SUMMARY_AT',
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
  'SCHED_MAX_CONCURRENT', 'SCHED_MAX_LATE_MS', 'WORKSPACE_DIR', 'GUEST_WORKSPACE_DIR', 'DATA_DIR', 'INCOMING_TTL_MS',
  'SHUTDOWN_GRACE_SEC', 'STARTUP_NOTICE', 'WS_PING_TIMEOUT_SEC', 'LAUNCHD_LABEL',
  'TTS_VOICE', 'TTS_MAX_CHARS', 'FFMPEG_BIN',
]);

const OWN = new Set(BRIDGE_OWN_KEYS);

/**
 * 子进程环境：src 的一份拷贝，去掉桥接自己的键和所有 FEISHU_* 键。
 * 返回新对象，不改 src；被去掉的键即使值是空串也不留。
 */
export function childEnv(src = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (OWN.has(k) || k.startsWith('FEISHU_')) continue;
    out[k] = v;
  }
  return out;
}
