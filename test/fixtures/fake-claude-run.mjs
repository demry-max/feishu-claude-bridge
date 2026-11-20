#!/usr/bin/env node
// BRIDGE-RUN-1 测试用假 claude CLI。由 run-helpers.mjs 写的 sh 包装脚本调用（不依赖本文件的可执行位）。
// 不联网、不读任何真实配置。每次启动从 FAKE_PLAN（JSON 数组）取走第一条计划，只剩一条时一直用它。
//
// 计划字段（全部可选）：
//   delayMs     启动后先等这么久再动作
//   ignoreTerm  忽略 SIGTERM（测 SIGTERM 之后升级到 SIGKILL）
//   grandchild  { sec, stdio: 'inherit' | 'ignore', detached, pidfile }：起一个孙进程（本文件的 --gc 模式）
//               stdio:'inherit' 时孙进程握着本进程的 stdout / stderr 管道
//   events      逐行写到 stdout：对象 → JSON 行；{ raw: '…' } → 原样一行（null / 42 / "x" / [] / 乱码）
//   stderr      写到 stderr 的文本
//   lateMs / lateEvents  静默 lateMs 毫秒后再写一批事件，然后才走 hang / exit
//   hang        事件写完后不退出（上限 hangMs，默认 60 秒，防测试漏收尸）
//   exit        退出码（默认 0）
//
// 锚点：环境变量 FAKE_ANCHOR_PID 是测试文件进程的 pid（run-helpers 的 sandboxEnv 设）。本进程每 500 毫秒探一次它，
// 只在报 ESRCH（锚点已不存在）时退出，这样测试被中断 / 被杀后不会留下假 CLI 与孙进程。没有这个变量时不做任何事。
//
// 只把环境变量的「键名」写进 FAKE_LOG，从不写值。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);

const anchor = Number(process.env.FAKE_ANCHOR_PID);
if (Number.isInteger(anchor) && anchor > 1) {
  setInterval(() => {
    try { process.kill(anchor, 0); } catch (e) { if (e?.code === 'ESRCH') process.exit(0); } // EPERM：还活着
  }, 500).unref();
}

if (argv[0] === '--version') {
  console.log('2.1.999 (fake)');
  process.exit(0);
}

if (argv[0] === '--gc') {
  // 孙进程：什么都不做，只占着（可能是继承来的）管道，到点自己退出
  setTimeout(() => process.exit(0), Number(argv[1] || 30) * 1000);
} else {
  run();
}

function takePlan() {
  const plans = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, 'utf8'));
  const plan = plans.length > 1 ? plans.shift() : plans[0];
  fs.writeFileSync(process.env.FAKE_PLAN, JSON.stringify(plans));
  return plan;
}

function run() {
  const plan = takePlan();
  fs.appendFileSync(
    process.env.FAKE_LOG,
    `${JSON.stringify({
      pid: process.pid,
      resume: argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : null,
      envKeys: Object.keys(process.env).sort(), // 只有键名
    })}\n`,
  );
  process.stdin.resume();
  process.stdin.on('data', () => {});
  process.stdin.on('error', () => {});
  if (plan.ignoreTerm) {
    process.on('SIGTERM', () => {});
    // 「杀不动的进程」：读端没了也不该自己死（否则 EPIPE 会让它在 SIGTERM 之后自己退出）
    process.stdout.on('error', () => {});
    process.stderr.on('error', () => {});
  }
  setTimeout(() => go(plan), plan.delayMs ?? 0);
}

function writeEvents(events) {
  for (const e of events) {
    process.stdout.write(`${e && typeof e === 'object' && 'raw' in e ? e.raw : JSON.stringify(e)}\n`);
  }
}

function go(plan) {
  let grandPidfile = null;
  let grandPid = null;
  if (plan.grandchild) {
    const g = plan.grandchild;
    const gc = spawn(process.execPath, [process.argv[1], '--gc', String(g.sec ?? 30)], {
      stdio: g.stdio === 'inherit' ? 'inherit' : 'ignore',
      detached: Boolean(g.detached),
    });
    gc.unref(); // 孙进程不拖住本进程的事件循环
    grandPidfile = g.pidfile;
    grandPid = gc.pid;
  }
  writeEvents(plan.events ?? []);
  // pid 文件最后写：它一出现，事件行就已经进了管道（reap-driver 见到它就打 READY，随后被 SIGKILL）
  if (grandPidfile) fs.writeFileSync(grandPidfile, String(grandPid));
  if (plan.stderr) process.stderr.write(plan.stderr);
  if (plan.lateEvents) {
    // 先静默一阵再补一批事件（测「已发出终止信号、结果却在之后才到」）
    setTimeout(() => { writeEvents(plan.lateEvents); finish(plan); }, plan.lateMs ?? 0);
    return;
  }
  finish(plan);
}

function finish(plan) {
  if (plan.hang) {
    setTimeout(() => process.exit(0), plan.hangMs ?? 60_000);
    return;
  }
  process.exitCode = plan.exit ?? 0;
}
