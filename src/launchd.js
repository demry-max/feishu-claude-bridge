// macOS launchd 开机自启：由脚本生成 plist，不再手改 5 处占位符。
//
// 2026-09-13 安装反馈：examples/launchd.example.plist 的 PATH 硬编码了 Homebrew 路径，
// 对 tarball/nvm 装的 Node 不适用；而 claude.js 里作者自己记录过「升级了 shell 里那份 claude，
// launchd 的 PATH 却把另一份排在前面，每条消息报 400」——已知的坑，模板没消除它。
// 这里把 node 所在目录与 `which claude` 的目录排在 PATH 最前，launchd 用到的与 shell 一致。
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 默认 label：com.<用户名>.feishu-claude-bridge；LAUNCHD_LABEL 可整体覆盖 */
export function defaultLabel(env = process.env) {
  if (env.LAUNCHD_LABEL) return env.LAUNCHD_LABEL;
  const user = String(env.USER || 'user').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
  return `com.${user}.feishu-claude-bridge`;
}

/** 解析 shell 里实际会用到的 claude 所在目录；找不到返回 null */
export function resolveClaudeDir(bin = process.env.CLAUDE_BIN || 'claude') {
  try {
    const r = spawnSync('which', [bin], { encoding: 'utf8', env: process.env });
    const p = String(r.stdout ?? '').trim().split('\n')[0];
    return p ? path.dirname(p) : null;
  } catch {
    return null;
  }
}

/** 纯函数：生成 plist 文本 */
export function buildPlist({ label, node, root, home, claudeDir = null }) {
  const pathParts = [
    path.dirname(node),
    claudeDir,
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ].filter(Boolean);
  const PATH = [...new Set(pathParts)].join(':');
  const log = path.join(home, 'Library', 'Logs', `${label}.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(PATH)}</string>
    <key>HOME</key><string>${esc(home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`;
}

export function plistPath(label, home = process.env.HOME) {
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}
