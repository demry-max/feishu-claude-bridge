// App Secret 不得出现在进程命令行（行为断言）。2026-09-13 安装反馈 P2：
// --mcp-config 把凭据 JSON 拼进 argv，`ps aux` 对本机任何进程可见，截屏终端也会泄露。
// 出站脱敏（outbound.js）做得很细，这里却是个缺口。改为写 0600 临时文件，跑完即删。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox, childProcessEnv, runDriver } from './fixtures/run-helpers.mjs';

const CLEANUP_DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cleanup-driver.mjs');
const CLEANUP_PATHS_DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cleanup-driver-paths.mjs');

const argVal = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const SECRET = 'test-app-secret-DO-NOT-LEAK-9f8e7d';

async function withSecret(fn) {
  const saved = { id: process.env.FEISHU_APP_ID, sec: process.env.FEISHU_APP_SECRET, ft: process.env.FEISHU_TOOLS };
  process.env.FEISHU_APP_ID = 'cli_test';
  process.env.FEISHU_APP_SECRET = SECRET;
  delete process.env.FEISHU_TOOLS;
  try {
    return await fn(await import(`../src/claude.js?secret=${Math.random()}`));
  } finally {
    for (const [k, v] of [['FEISHU_APP_ID', saved.id], ['FEISHU_APP_SECRET', saved.sec], ['FEISHU_TOOLS', saved.ft]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

describe('MCP 凭据不进 argv', () => {
  test('owner 的 claude 参数里不含 App Secret，--mcp-config 指向一个文件', () =>
    withSecret((m) => {
      const r = m.buildClaudeArgs('oc_x', true, []);
      try {
        assert.ok(!r.args.join(' ').includes(SECRET), 'argv 里出现了明文 secret');
        const cfgPath = argVal(r.args, '--mcp-config');
        assert.ok(cfgPath && !cfgPath.trim().startsWith('{'), '应传文件路径而不是 JSON 字符串');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.equal(cfg.mcpServers.feishu.env.FEISHU_APP_SECRET, SECRET, 'MCP 服务仍要拿到凭据');
        assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600, '临时文件必须 0600');
      } finally { r.cleanup?.(); }
    }));

  test('cleanup 删除临时文件，且可重复调用', () =>
    withSecret((m) => {
      const r = m.buildClaudeArgs('oc_x', true, []);
      const cfgPath = argVal(r.args, '--mcp-config');
      assert.ok(fs.existsSync(cfgPath));
      r.cleanup();
      assert.ok(!fs.existsSync(cfgPath), '跑完必须删');
      assert.doesNotThrow(() => r.cleanup());
    }));

  test('访客与关闭 FEISHU_TOOLS 时没有 --mcp-config，也不生成文件', async () => {
    await withSecret((m) => {
      const g = m.buildClaudeArgs('guest:oc:ou', false, []);
      assert.equal(argVal(g.args, '--mcp-config'), undefined);
      assert.ok(!g.args.join(' ').includes(SECRET));
      g.cleanup?.();
    });
    const prev = process.env.FEISHU_TOOLS;
    process.env.FEISHU_TOOLS = 'false';
    try {
      const m = await import(`../src/claude.js?nomcp=${Math.random()}`);
      const o = m.buildClaudeArgs('oc_x', true, []);
      assert.equal(argVal(o.args, '--mcp-config'), undefined);
      o.cleanup?.();
    } finally {
      if (prev === undefined) delete process.env.FEISHU_TOOLS; else process.env.FEISHU_TOOLS = prev;
    }
  });

  // BRIDGE-RUN-1：原来是三条源码断言（匹配 child.on('close'…cleanup()）。收尾改成「单点 settle」后
  // 清理不再写在 close 回调里，源码形状断言失去意义，改成行为断言：真跑三种收尾，数临时目录和清理次数。
  test('runClaude 三种收尾（正常 / 错误 result / 启动失败）都清掉临时 MCP 配置目录，且各清一次（行为断言）', { timeout: 60_000 }, async () => {
    const sb = makeSandbox('mcp-cleanup');
    try {
      const init = (sid) => ({ type: 'system', subtype: 'init', session_id: sid });
      sb.plan(
        { events: [init('s-ok'), { type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } }, { type: 'result', subtype: 'success', is_error: false, result: '好', session_id: 's-ok' }] },
        { events: [init('s-err'), { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Execution error', session_id: 's-err' }], exit: 1 },
      );
      const env = childProcessEnv(sb, { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: SECRET, FEISHU_TOOLS: undefined, CLAUDE_MAX_RETRIES: '0' });
      const r = await runDriver(CLEANUP_DRIVER, env, 40_000);
      assert.ok(r.result, `驱动没有给出结果（退出码 ${r.code}）：${r.err.slice(-300)}`);
      assert.equal(r.result.ok.outcome, 'resolved');
      assert.equal(r.result.error.outcome, 'rejected');
      assert.equal(r.result.spawnFail.outcome, 'rejected');
      for (const name of ['ok', 'error', 'spawnFail']) {
        // left 是在 runClaude 的 promise 落定的那一刻数的：目录已经没了，说明清理发生在 resolve / reject 之前
        assert.equal(r.result[name].left, 0, `${name}：promise 落定时临时 MCP 目录还在`);
        assert.equal(r.result[name].leftLater, 0, `${name}：临时 MCP 目录没清掉`);
        // rm 在迟到事件都跑完之后才数：启动失败时旧写法 error / close 各清一次（共 2 次）
        assert.equal(r.result[name].rm, 1, `${name}：应恰好清理一次，实际 ${r.result[name].rm} 次`);
      }
    } finally {
      sb.cleanup();
    }
  });

  // BRIDGE-RUN-2（M1，RUN-1 复审点名补的测试）：上一条只覆盖正常 / 错误 result / 启动失败。
  // 空闲超时、结果宽限到期、取消是「我们主动杀进程」的三条收尾，同样都走 settle()：
  // 临时 MCP 配置目录（含 App Secret 的 0600 文件）要在 promise 落定时就没了，且只清一次。
  test('runClaude 另三种收尾（空闲超时 / 结果宽限到期 / 取消）也清掉临时 MCP 配置目录，且各清一次（行为断言）', { timeout: 60_000 }, async () => {
    const sb = makeSandbox('mcp-cleanup-paths');
    try {
      const env = childProcessEnv(sb, { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: SECRET, FEISHU_TOOLS: undefined, CLAUDE_MAX_RETRIES: '0' });
      const r = await runDriver(CLEANUP_PATHS_DRIVER, env, 40_000);
      assert.ok(r.result, `驱动没有给出结果（退出码 ${r.code}）：${r.err.slice(-300)}`);
      // 三条路径各自的收尾方式：先确认真的走到了想测的那条，再数目录与清理次数
      assert.deepEqual(
        Object.fromEntries(Object.entries(r.result).map(([k, v]) => [k, [v.outcome, v.how]])),
        { idle: ['rejected', 'timeout'], grace: ['resolved', 'result'], cancel: ['rejected', 'cancelled'] },
      );
      assert.equal(r.result.grace.value, '好', '结果宽限到期时应以已收到的结果收尾');
      assert.match(r.out, /结果已到但进程 0\.3 秒未退出，已结束/, '宽限到期那条日志');
      assert.equal(r.result.cancel.cancelReturned, true, '取消应当命中正在跑的那一轮');
      for (const name of ['idle', 'grace', 'cancel']) {
        assert.equal(r.result[name].spawns, 1, `${name}：应只起一个子进程（没有重试 / 重放）`);
        assert.equal(r.result[name].left, 0, `${name}：promise 落定时临时 MCP 目录还在`);
        assert.equal(r.result[name].leftLater, 0, `${name}：临时 MCP 目录没清掉`);
        assert.equal(r.result[name].rm, 1, `${name}：应恰好清理一次，实际 ${r.result[name].rm} 次`);
      }
    } finally {
      sb.cleanup();
    }
  });
});
