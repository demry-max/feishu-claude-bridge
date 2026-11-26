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
]);
