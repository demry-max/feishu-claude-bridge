// .env 回写：claude.js（/model 切换）与 scripts/register.js（扫码注册）共用。
// 此前两处各有一份实现，register 那份既不原子也不保留注释。
import fs from 'node:fs';

/**
 * 只改给定的键，其余内容与注释原样保留；已有键替换值并保留行尾注释，缺失的键追加到末尾。
 * 原子替换：.env 是启动必需文件，写到一半被打断（掉电/拔盘）会截断成半截，
 * 下次启动即 exit(1)，launchd 会陷入每 10 秒拉起-退出的死循环。
 * 权限（BRIDGE-PUB-1）：.env 里有 App Secret，回写后只给本人读写——临时文件以 0600 新建（先删残留，确保新建时的权限生效），
 * rename 后再按「原权限 & 0600」收紧（原文件更严时不放宽；没有原文件就是 0600）。Windows 不做 chmod。
 * 返回 true/false，不抛——调用方都在启动或注册路径上。
 */
export function patchEnvFile(envPath, updates, { platform = process.platform } = {}) {
  try {
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    let origMode = null;
    try { origMode = fs.statSync(envPath).mode & 0o777; } catch { origMode = null; }
    const lines = existing.split('\n');
    // 末尾换行会产生一个空尾元素；先摘掉，追加完再统一补回
    const trailingNewline = existing.endsWith('\n') || existing === '';
    if (trailingNewline && lines[lines.length - 1] === '') lines.pop();
    for (const [key, val] of Object.entries(updates)) {
      const i = lines.findIndex((l) => l.startsWith(`${key}=`));
      const comment = i >= 0 ? (lines[i].match(/\s+#.*$/)?.[0] ?? '') : '';
      const line = `${key}=${val}${comment}`;
      if (i >= 0) lines[i] = line;
      else lines.push(line);
    }
    const tmp = `${envPath}.tmp`;
    fs.rmSync(tmp, { force: true }); // 上次中断留下的残留（可能是宽权限或软链）：删掉后独占新建
    fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, envPath);
    if (platform !== 'win32') fs.chmodSync(envPath, origMode === null ? 0o600 : origMode & 0o600);
    return true;
  } catch (e) {
    console.error('[config] 回写 .env 失败:', e?.message ?? e);
    return false;
  }
}
