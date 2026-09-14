// 卸载 macOS 开机自启：bootout + 删除 plist。label 与安装时一致（LAUNCHD_LABEL 可覆盖）。
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { defaultLabel, plistPath } from '../src/launchd.js';

if (process.platform !== 'darwin') {
  console.error('本脚本只支持 macOS。Windows 请运行 scripts\\windows\\uninstall-startup.ps1');
  process.exit(1);
}
const label = defaultLabel();
const target = plistPath(label, os.homedir());
spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' });
if (fs.existsSync(target)) {
  fs.unlinkSync(target);
  console.log(`✅ 已停止并移除：${label}（${target}）`);
} else {
  console.log(`未找到 ${target}，服务可能未安装或用了别的 label（LAUNCHD_LABEL）。`);
}
