// 以运行账户的 HOME 为根。保留 * 以匹配同一工具的多份凭据文件或配置目录。
export const HOME_SECRET_PATHS = Object.freeze([
  '.brain-secrets',          // 公司大脑的 API 密钥与 Access 令牌
  '.brain-client',           // 公司大脑客户端的认证配置
  '.ssh',                    // SSH 身份密钥与配置
  '.config/claude-api',      // Claude API 凭据与配置
  '.config/openai-api',      // OpenAI API 凭据与配置
  '.config/claude-b',        // Claude 备用账号的配置
  '.config/deepseek',        // DeepSeek API 凭据与配置
  '.config/bms-ai',          // BMS AI 凭据与配置
  '.config/starlight-r2',    // Starlight R2 对象存储凭据
  '.cloudflare*',            // Cloudflare 登录凭据及配置
  '.codex',                  // Codex 主账号状态与登录凭据
  '.codex-s',                // Codex 备用账号状态与登录凭据
  '.codex-api-*',            // 各套 Codex API 账号状态与凭据
  '.claude/.credentials*',   // Claude Code 主账号的登录凭据文件
  '.claude-b/.credentials*', // Claude Code 备用账号的登录凭据文件
  '.aws',                    // AWS 访问凭据与配置
  '.netrc',                  // 网络客户端的账号和密码
  '.npmrc',                  // npm registry 配置与令牌
  '.config/gh',              // GitHub CLI 主机配置与登录令牌
  '.git-credentials',        // Git credential-store 的明文凭据
  '.docker',                 // Docker registry 登录和客户端配置
  '.kube',                   // Kubernetes 集群配置和认证材料
  '.gnupg',                  // GnuPG 密钥和信任库
  '.config/feishu-*',        // 飞书桥接与工具的本机配置
  '.lark-cli',               // lark-cli 本机配置和用户状态
  '.config/lark-cli',        // lark-cli 的 HOME 内 XDG 配置位置
  'Library/Application Support/lark-cli', // macOS 上 lark-cli 的本机支持目录
]);

// 只保护主备账号的会话记录，保留项目自动记忆的访问。
export const HOME_SESSION_PATHS = Object.freeze([
  '.claude/projects/**/*.jsonl',
  '.claude-b/projects/**/*.jsonl',
]);

export const HOME_ENV_PATHS = Object.freeze([
  '**/.env',                 // HOME 内任意深度的项目环境文件
  '**/.env.*',               // 同一项目的环境文件变体
]);
