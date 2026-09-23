// Claude CLI 登录故障签名夹具。两个仓各存一份，内容必须逐字节相同：
//   ~/claude-login-watchdog/test/fixtures/claude-auth-signatures.js
//   /Volumes/ORICO/Documents/claude code/feishu-claude-bridge/test/fixtures/claude-auth-signatures.js
// 跨仓不共享代码：看门狗的 src/signatures.js 与桥接的 src/outbound.js（classifyClaudeError）
// 各自实现同一套规则，各自用这份夹具钉一遍。改这里就同步改另一份——看门狗仓的
// signatures.test.js 在两份都可读时逐字节比对，不一致即红。
//
// 来源：SURVEY-login-watchdog §5（真实日志行）与 claude 2.1.280 bundle 里尚未在日志出现过的文案。
//
// kind 取值：
//   auth               登录失效，要重新登录（claude auth login）
//   keychain           钥匙串不可写 / 不可用
//   transient_refresh  另一个 claude 进程正在刷新令牌——瞬时状态，不算登录失效
//   network            网络、5xx、过载、超时——探针不可用，不算登录失效
//   none               其它错误，不当作登录问题处理
export const CLAUDE_AUTH_SIGNATURES = [
  // ---- 真实日志 ----
  { kind: 'auth', text: 'Failed to authenticate. API Error: 401 Invalid authentication credentials', source: 'feishu-claude-bridge.log:149（2026-07）' },
  { kind: 'auth', text: 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.', source: 'feishu-claude-bridge.log:157（2026-07）' },
  { kind: 'auth', text: 'Not logged in · Please run /login', source: 'feishu-claude-bridge.log:3832 / :5578 / :5591 / :5597（2026-08-15、2026-09-20~21）' },
  { kind: 'auth', text: 'Failed to authenticate: OAuth session expired and could not be refreshed', source: 'bms-group-bridge.log:549（2026-09-14）' },
  { kind: 'network', text: 'API Error: 529 Overloaded', source: 'bms-group-bridge.log:16' },
  // ---- bundle 文案（尚未在日志出现） ----
  { kind: 'transient_refresh', text: 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh', source: 'claude 2.1.280 bundle（p2e）' },
  { kind: 'auth', text: 'OAuth authentication is currently not allowed for this organization', source: 'claude 2.1.280 bundle' },
  { kind: 'auth', text: 'Invalid API key · Fix external API key', source: 'claude 2.1.280 bundle' },
  { kind: 'auth', text: 'Invalid auth token · Fix external auth token', source: 'claude 2.1.280 bundle' },
  { kind: 'auth', text: 'Not logged in. Run claude auth login to authenticate.', source: 'claude auth status --text' },
  { kind: 'keychain', text: 'macOS Keychain is not writable (-25293)', source: 'claude doctor' },
  // ---- 包装形态（桥接把 stderr 包进 Error；探针把 JSON result 与 stderr 拼在一起） ----
  { kind: 'auth', text: 'claude CLI 失败(code 1): Not logged in · Please run /login', source: 'feishu-claude-bridge src/claude.js 包装' },
  { kind: 'transient_refresh', text: 'claude CLI 失败(code 1): Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh', source: '包装 + 瞬时刷新' },
  { kind: 'network', text: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', source: '5xx' },
  { kind: 'network', text: 'Connection error.', source: '网络' },
  { kind: 'network', text: 'fetch failed: ECONNRESET', source: '网络' },
  { kind: 'network', text: 'claude CLI 超时（120s）', source: 'feishu-claude-bridge src/claude.js 超时' },
  // ---- 反例：不能被误判成登录失效 ----
  { kind: 'none', text: '工单 WO-00401 找不到', source: '旧匹配器 msg.includes(\'401\') 会误判' },
  { kind: 'none', text: '文档里提到 OAuth scopes 的配置方法', source: '只含 OAuth 字样' },
  { kind: 'none', text: 'claude CLI 启动失败: spawn claude ENOENT', source: '可执行文件缺失，不是登录问题' },
  { kind: 'none', text: 'CANCELLED', source: '用户取消' },
];
