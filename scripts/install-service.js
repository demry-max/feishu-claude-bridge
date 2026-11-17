// macOS 开机自启一键安装：生成 plist（用当前 node、本仓库目录、which claude 的目录）并 bootstrap。
//   npm run install-service            安装/更新并立即启动
//   npm run install-service -- --dry-run   只打印 plist，不写文件
//   npm run install-service -- --force     同 label 的 plist 已指向别的目录时，仍改成指向本目录（默认拒绝）
// label 默认 com.<用户名>.feishu-claude-bridge，可用 LAUNCHD_LABEL 覆盖（已有服务的老用户沿用旧 label）。
// Windows 请用 scripts/windows/install-startup.ps1；Linux 参考 examples/feishu-claude-bridge.service（systemd --user）。
// plist 里写 ExitTimeOut = 优雅等待 + 10：launchd 不写时只等 5 秒就强杀，优雅退出（等进行中的对话收尾）等不完；
// 但用户级 LaunchAgent 的 ExitTimeOut 实际最多 60 秒（写多了也按 60），所以 SHUTDOWN_GRACE_SEC 超过 50 时
// 把服务里的 SHUTDOWN_GRACE_SEC 钉成 50（写进 plist 的 EnvironmentVariables，优先于 .env），留 10 秒收尾。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlist, defaultLabel, resolveClaudeDir, plistPath } from '../src/launchd.js';
import { shutdownGraceSec } from '../src/shutdown.js';
import { readEnvFile, withExitTimeout, withPlistEnv, launchdShutdownTiming, serviceLabelConflict, LAUNCHD_EXIT_TIMEOUT_CAP } from './lib/checks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

if (process.platform !== 'darwin') {
  console.error('本脚本只支持 macOS（launchd）。Windows 请运行：powershell -ExecutionPolicy Bypass -File scripts\\windows\\install-startup.ps1；' +
    'Linux 参考 examples/feishu-claude-bridge.service（systemd --user）。');
  process.exit(1);
}

// 服务不继承 shell 环境：LAUNCHD_LABEL / CLAUDE_BIN / SHUTDOWN_GRACE_SEC 以 .env 为准（shell 里显式设置的优先）
const envValues = readEnvFile(ROOT).values;
const merged = { ...envValues, ...process.env };
const label = defaultLabel(merged);
const claudeDir = resolveClaudeDir(merged.CLAUDE_BIN || 'claude');
const grace = shutdownGraceSec(envValues, (m) => console.error(m));
const timing = launchdShutdownTiming(grace);
let xml = withExitTimeout(buildPlist({ label, node: process.execPath, root: ROOT, home: os.homedir(), claudeDir }), timing.exitTimeout);
if (timing.clamped) {
  xml = withPlistEnv(xml, 'SHUTDOWN_GRACE_SEC', String(timing.serviceGrace));
  console.error(`ℹ️ SHUTDOWN_GRACE_SEC=${grace} 超过 launchd 能等的时间（ExitTimeOut 最多 ${LAUNCHD_EXIT_TIMEOUT_CAP} 秒）：` +
    `服务里按 ${timing.serviceGrace} 秒优雅等待，ExitTimeOut=${timing.exitTimeout}（留 ${timing.exitTimeout - timing.serviceGrace} 秒收尾）。`);
}

if (dryRun) {
  process.stdout.write(xml);
  process.exit(0);
}

if (!fs.existsSync(path.join(ROOT, '.env'))) {
  console.error('未找到 .env——先 npm run register（或 cp .env.example .env 并填写）再安装自启。');
  process.exit(1);
}
if (!claudeDir) console.error('⚠️ 未在 PATH 里找到 claude，服务启动后会自检报错；请先 npm i -g @anthropic-ai/claude-code');

const target = plistPath(label, os.homedir());
// 同一用户的默认 label 固定：第二份克隆 / 别的目录装过桥接时，不看就覆盖会把那个服务改成指向这里
let existingXml = null;
try { existingXml = fs.readFileSync(target, 'utf8'); } catch { /* 没装过 */ }
const conflict = serviceLabelConflict({ existingXml, root: ROOT, label, force });
if (conflict) {
  console.error(`⛔ ${conflict}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, xml);

const domain = `gui/${process.getuid()}`;
// 已装过则先卸下，bootstrap 对已加载的服务会报 "service already loaded"
spawnSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
const r = spawnSync('launchctl', ['bootstrap', domain, target], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(`launchctl bootstrap 失败：${(r.stderr || r.stdout || '').trim()}`);
  process.exit(1);
}
console.log(`✅ 已安装并启动：${label}`);
console.log(`   plist：${target}`);
console.log(`   日志：${path.join(os.homedir(), 'Library', 'Logs', `${label}.log`)}`);
console.log(`   node：${process.execPath}${claudeDir ? `\n   claude：${claudeDir}` : ''}`);
console.log('   重启服务：launchctl kickstart -k ' + `${domain}/${label}`);
console.log(`   确认在跑：launchctl print ${domain}/${label} | grep -E "state|pid"`);
console.log(`   确认连上飞书：日志里出现 "ws client ready"（tail -n 50 ${path.join(os.homedir(), 'Library', 'Logs', `${label}.log`)}）`);
console.log('   卸载：npm run uninstall-service');
