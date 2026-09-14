// macOS 开机自启一键安装：生成 plist（用当前 node、本仓库目录、which claude 的目录）并 bootstrap。
//   npm run install-service            安装/更新并立即启动
//   npm run install-service -- --dry-run   只打印 plist，不写文件
// label 默认 com.<用户名>.feishu-claude-bridge，可用 LAUNCHD_LABEL 覆盖（已有服务的老用户沿用旧 label）。
// Windows 请用 scripts/windows/install-startup.ps1。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlist, defaultLabel, resolveClaudeDir, plistPath } from '../src/launchd.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

if (process.platform !== 'darwin') {
  console.error('本脚本只支持 macOS（launchd）。Windows 请运行：powershell -ExecutionPolicy Bypass -File scripts\\windows\\install-startup.ps1');
  process.exit(1);
}

const label = defaultLabel();
const claudeDir = resolveClaudeDir();
const xml = buildPlist({ label, node: process.execPath, root: ROOT, home: os.homedir(), claudeDir });

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
console.log('   卸载：npm run uninstall-service');
