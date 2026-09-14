// .env 回写：claude.js（/model 切换）与 scripts/register.js（扫码注册）共用。
// 此前两处各有一份实现，register 那份既不原子也不保留注释。
import fs from 'node:fs';

/**
 * 只改给定的键，其余内容与注释原样保留；已有键替换值并保留行尾注释，缺失的键追加到末尾。
 * 原子替换：.env 是启动必需文件，写到一半被打断（掉电/拔盘）会截断成半截，
 * 下次启动即 exit(1)，launchd 会陷入每 10 秒拉起-退出的死循环。
 * 返回 true/false，不抛——调用方都在启动或注册路径上。
 */
export function patchEnvFile(envPath, updates) {
  try {
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
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
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, envPath);
    return true;
  } catch (e) {
    console.error('[config] 回写 .env 失败:', e?.message ?? e);
    return false;
  }
}
