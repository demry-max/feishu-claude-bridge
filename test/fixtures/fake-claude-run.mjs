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
// 只把环境变量的「键名」写进 FAKE_LOG，从不写值。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);

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
  if (plan.ignoreTerm) process.on('SIGTERM', () => {});
  setTimeout(() => go(plan), plan.delayMs ?? 0);
}

function writeEvents(events) {
  for (const e of events) {
    process.stdout.write(`${e && typeof e === 'object' && 'raw' in e ? e.raw : JSON.stringify(e)}\n`);
  }
}

function go(plan) {
  if (plan.grandchild) {
    const g = plan.grandchild;
    const gc = spawn(process.execPath, [process.argv[1], '--gc', String(g.sec ?? 30)], {
      stdio: g.stdio === 'inherit' ? 'inherit' : 'ignore',
      detached: Boolean(g.detached),
    });
    gc.unref(); // 孙进程不拖住本进程的事件循环
    if (g.pidfile) fs.writeFileSync(g.pidfile, String(gc.pid));
  }
  writeEvents(plan.events ?? []);
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
