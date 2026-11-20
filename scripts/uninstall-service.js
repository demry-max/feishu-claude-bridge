// 卸载 macOS 开机自启：bootout + 删除 plist。
//   npm run uninstall-service              卸载本目录装的服务
//   npm run uninstall-service -- --dry-run 只打印判定（label、plist、判定、原因），不调 launchctl、不删文件
//   npm run uninstall-service -- --force   plist 指向别的目录时也卸载（默认拒绝）
// label 与安装脚本同一算法：.env 里的 LAUNCHD_LABEL 与 shell 环境合并（shell 里显式设置的优先）。
// 只动 ~/Library/LaunchAgents/ 下的 plist，不碰 data/、workspace/。
// 本文件可 import（无副作用）；直接运行时才执行 main()。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultLabel, plistPath } from '../src/launchd.js';
import { readEnvFile, plistWorkingDir } from './lib/checks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** label 来自哪里（只说来源，不打印 .env 里别的值） */
function labelSource(root, env) {
  if (env.LAUNCHD_LABEL) return 'shell 环境变量 LAUNCHD_LABEL';
  if (readEnvFile(root).values.LAUNCHD_LABEL) return '.env 的 LAUNCHD_LABEL';
  return '默认（com.<用户名>.feishu-claude-bridge）';
}

/**
 * 纯判定，不碰 launchctl、不写文件。
 * 返回 { label, source, target, action: 'remove' | 'refuse' | 'absent', reason, dir }
 */
export function planUninstall({
  root = ROOT,
  home = os.homedir(),
  env = process.env,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  exists = (p) => fs.existsSync(p),
  force = false,
} = {}) {
  const label = defaultLabel({ ...readEnvFile(root).values, ...env });
  const source = labelSource(root, env);
  const target = plistPath(label, home);
  if (!exists(target)) {
    return { label, source, target, action: 'absent', dir: null, reason: '未找到，可能未安装或 label 不同' };
  }
  let xml = null;
  try { xml = readFile(target); } catch { /* 读不出按解析不出处理 */ }
  const dir = plistWorkingDir(xml);
  if (force) {
    return { label, source, target, action: 'remove', dir, reason: '带了 --force' };
  }
  if (!dir) {
    return { label, source, target, action: 'refuse', dir: null, reason: '读不出这个 plist 的 WorkingDirectory，无法确认它属于本目录；确实要卸载加 --force' };
  }
  if (path.resolve(dir) !== path.resolve(root)) {
    return { label, source, target, action: 'refuse', dir, reason: `这个 label 属于 ${dir}；确实要卸载加 --force` };
  }
  return { label, source, target, action: 'remove', dir, reason: 'plist 指向本目录' };
}

/** 执行判定；launchctl / unlink / log 可注入。返回退出码 */
export function applyUninstall(plan, { launchctl, unlink, log = console.log, uid = process.getuid?.() } = {}) {
  if (plan.action === 'refuse') {
    log(`⛔ 未卸载 ${plan.label}（${plan.target}）：${plan.reason}`);
    return 1;
  }
  if (plan.action === 'absent') {
    log(`未找到 ${plan.target}，${plan.reason}。算出的 label：${plan.label}（来源：${plan.source}）。`);
    return 0;
  }
  launchctl(['bootout', `gui/${uid}/${plan.label}`]);
  unlink(plan.target);
  log(`✅ 已停止并移除：${plan.label}（${plan.target}）`);
  return 0;
}

function main() {
  if (process.platform !== 'darwin') {
    console.error('本脚本只支持 macOS。Windows 请运行 scripts\\windows\\uninstall-startup.ps1');
    return 1;
  }
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const plan = planUninstall({ force });
  if (dryRun) {
    console.log(`[dry-run] label：${plan.label}（来源：${plan.source}）`);
    console.log(`[dry-run] plist：${plan.target}`);
    console.log(`[dry-run] 判定：${plan.action}`);
    console.log(`[dry-run] 原因：${plan.reason}`);
    return plan.action === 'refuse' ? 1 : 0;
  }
  return applyUninstall(plan, {
    launchctl: (args) => spawnSync('launchctl', args, { stdio: 'ignore' }),
    unlink: (p) => fs.unlinkSync(p),
  });
}

const realOrSelf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = Boolean(process.argv[1]) && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url));
if (isMain) process.exit(main());
