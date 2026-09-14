// App Secret 不得出现在进程命令行（行为断言）。2026-09-13 安装反馈 P2：
// --mcp-config 把凭据 JSON 拼进 argv，`ps aux` 对本机任何进程可见，截屏终端也会泄露。
// 出站脱敏（outbound.js）做得很细，这里却是个缺口。改为写 0600 临时文件，跑完即删。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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

  test('runClaudeOnce 在子进程结束后调用 cleanup（源码断言）', () => {
    const src = fs.readFileSync(new URL('../src/claude.js', import.meta.url), 'utf8');
    assert.match(src, /const \{ args, cwd, effort, cleanup \} = buildClaudeArgs/);
    assert.match(src, /child\.on\('close'[\s\S]{0,120}cleanup\(\)/, "close 回调里要先 cleanup");
    assert.match(src, /child\.on\('error'[\s\S]{0,120}cleanup\(\)/, "启动失败也要清");
  });
});
