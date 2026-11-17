// BRIDGE-PERM-2：owner strict 档的 PreToolUse(Bash) 输出路径闸。桥接用 --settings 内联注册，只挂 Bash。
// 只读 stdin 上的一段 JSON；落点越界时往 stdout 写一行 deny JSON（exit 0）；落点合规则静默 exit 0，交回正常权限流。
// 这是安全闸，一律 fail closed：缺 workspace 参数 / 坏输入 / 判定异常 / 读 stdin 超时都 exit 2（挡下这次调用），绝不 allow。
// 判定逻辑全在纯函数 checkOutputTargets 里；本文件只注入真实 fs，不联网、不起子进程、不落盘、不回显命令内容。
// R1：静态 import 只留 node:*——判定模块在读完 stdin 后动态加载，加载失败照样 exit 2；未捕获异常也 exit 2（node 默认 exit 1 会被 CLI 当成放行）。
process.on('uncaughtException', () => process.exit(2));
process.on('unhandledRejection', () => process.exit(2)); // end 回调是 async：里面漏抛的异常走这条
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// fail closed：写一行 stderr（给模型看原因），exit 2 挡下这次 Bash
function die(msg) {
  try { process.stderr.write(`[output-guard] ${msg}\n`); } catch { /* stderr 不可写也要退出 */ }
  process.exit(2);
}

const workspace = process.argv[2];
if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
  die('缺少 workspace 参数（argv[2] 必须是绝对路径），拒绝放行');
}

// stdin 迟迟不结束：fail closed（CLI 侧超时 5 秒，这里 1.5 秒先兜底）
const timer = setTimeout(() => die('读取 stdin 超时'), 1500);
timer.unref?.();

const readlink = (p) => {
  try { return fs.readlinkSync(p); } catch { return null; }
};

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('error', () => die('读取 stdin 出错'));
process.stdin.on('end', async () => {
  clearTimeout(timer);
  let j;
  try { j = JSON.parse(buf); } catch { return die('输入不是合法 JSON'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return die('输入不是对象');
  // 只管 Bash；其余工具放行（由 --allowedTools / --disallowedTools 决定，本闸不干预）
  if (j.tool_name !== 'Bash') process.exit(0);
  const command = j.tool_input?.command;
  if (typeof command !== 'string') return die('Bash 调用缺少 command');
  // claude 会在 PreToolUse 输入里带本会话 cwd；缺失或非绝对时退回 workspace
  const cwd = typeof j.cwd === 'string' && path.isAbsolute(j.cwd) ? j.cwd : workspace;
  let checkOutputTargets;
  try {
    ({ checkOutputTargets } = await import('../tool-policy.js'));
  } catch {
    return die('加载输出路径判定模块失败'); // 模块缺失 / 语法错误也 fail closed
  }
  let res;
  try {
    res = checkOutputTargets(command, {
      cwd,
      workspace,
      tmpDirs: [os.tmpdir(), '/tmp'],
      realpath: fs.realpathSync,
      readlink,
      home: os.homedir(),
      vars: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    });
  } catch {
    return die('输出路径判定异常'); // 判定本身出错也 fail closed
  }
  if (res.ok) process.exit(0); // 落点合规：静默放行，不输出 allow（仍由正常权限流再审一遍）
  const reason = res.deny[0]?.reason ?? 'unknown';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `strict 档：这条命令要把文件写到允许范围之外（原因：${reason}）。`
        + '只能写入 workspace 的 ./outbox/ 或系统临时目录；.claude、CLAUDE.md、skills、schedules、tasks 不可作为输出落点。'
        + '要回传文件就写进本轮 outbox 目录；下载请显式写 `--output ./outbox/<本轮目录>/文件名`。',
    },
  }));
  process.exit(0);
});
