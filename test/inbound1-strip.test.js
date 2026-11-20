// BRIDGE-INBOUND-1（第 5 项）：回给用户的错误文本去本机路径——stripLocalPaths 的补漏、不该改的不改、
// claudeFailureReply 通用分支、/model 四处回复（切 index.js 真实代码，桩 checkCliEnvironment / setRuntimeConfig）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.CLAUDE_FALLBACK_BIN = '';
const { stripLocalPaths: f } = await import('../src/messages.js');
const { claudeFailureReply } = await import('../src/outbound.js');
const SRC = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const P = '<本机路径>';

describe('S 回给用户的错误去本机路径', () => {
  test('S1 补漏：紧跟中文、「」“” 里带空格、file://、只有开引号、截断的尾段、PATH 列表、CLI 路径', () => {
    assert.equal(f('打开/Users/张三/a.png失败'), `打开${P}`);
    assert.equal(f('见「/Users/a b/c.txt」'), `见「${P}」`);
    assert.equal(f('“/tmp/x y/z”'), `“${P}”`);
    assert.equal(f('file:///Users/a/b.txt 打不开'), `${P} 打不开`);
    assert.equal(f("open '/Users/a/b c"), `open '${P}`);
    assert.equal(f("v/incoming/om_a/fk_a.opus': Invalid data found"), `${P}': Invalid data found`);
    assert.equal(f('找不到可执行的 claude（PATH=/usr/bin:/bin:/Users/x/.local/bin）：spawn claude ENOENT'), `找不到可执行的 claude（PATH=${P}）：spawn claude ENOENT`);
    assert.equal(f('模型 fable 需要 Claude Code ≥ 2.1.0，但 /Users/x/.local/bin/claude 是 2.0.1。'), `模型 fable 需要 Claude Code ≥ 2.1.0，但 ${P} 是 2.0.1。`);
  });

  test('S2 不该改的不改：斜杠命令、单段根目录、相对路径、分数与 a/b、网址、中文/英文；非字符串不抛', () => {
    for (const s of [
      'run /logout and /login for the plan to take effect', '/tmp 不存在', 'tasks/foo.json', '普通文本，没有路径 1/2 a/b',
      'GET https://open.feishu.cn/x 失败', '中文/英文', '请用 /status 看一下', '',
    ]) assert.equal(f(s), s, s);
    assert.doesNotThrow(() => f(null));
    assert.doesNotThrow(() => f(undefined));
    assert.doesNotThrow(() => f(12));
  });

  test('S2b 原有写法仍去掉：绝对路径、带引号带空格的路径、/var 临时路径', () => {
    assert.equal(f('读不了 /Users/x/a/b.txt'), `读不了 ${P}`);
    assert.equal(f("ENOENT: '/Users/a b/c d/e.txt'"), `ENOENT: '${P}'`);
    assert.ok(!f('失败 /var/folders/zz/T/tts-1.opus').includes('/var/'));
  });

  test('S3 claudeFailureReply 通用分支去路径；瞬时刷新 / 登录失效分支不受影响', async () => {
    const r = await claudeFailureReply('spawn /Users/x/.local/bin/claude ENOENT：打不开 /Users/x/proj/data/a.json');
    assert.ok(r.startsWith('⚠️ Claude 调用失败：'));
    assert.ok(!r.includes('/Users/'), r);
    assert.ok(r.includes(P));
    const login = await claudeFailureReply('Invalid API key · Please run /login', { checkKeychain: async () => false });
    assert.ok(login.includes('claude auth login'));
  });

  // ---- /model 四处：切 index.js 真实代码 ----
  const a = SRC.indexOf("if (text === '/model' || text.startsWith('/model ')) {");
  const b = SRC.indexOf("  if (text === '/cancel' || text === '取消') {", a);
  assert.ok(a > 0 && b > a, '找不到 /model 代码块');
  const BLOCK = SRC.slice(a, b);

  async function runModel(text, { problem, throws } = {}) {
    const replies = [];
    const scope = {
      text, isOwner: true, message: { message_id: 'om_1' },
      reply: async (_id, t) => { replies.push(t); },
      getRuntimeConfig: () => ({}), MODEL_ALIASES: { fable: 'claude-fable-5-2' }, EFFORT_LEVELS: ['low', 'high'],
      checkCliEnvironment: () => ({ problem }),
      setRuntimeConfig: () => { if (throws) throw new Error(throws); return { model: 'm', effort: 'high', execModel: 'x', execEffort: '' }; },
      stripLocalPaths: f,
    };
    // eslint-disable-next-line no-new-func
    await new Function('scope', `with (scope) { return (async () => {\n${BLOCK}\n})(); }`)(scope);
    return replies;
  }
  const PROBLEM = '模型 fable 需要 Claude Code ≥ 2.1.0，但 /Users/x/.local/bin/claude 是 2.0.1。';
  const THROWS = '写不进 /Users/x/proj/data/runtime.json';

  test('S4 /model 四处错误回复都不含本机路径，且仍带原来的提示前缀', async () => {
    const r1 = await runModel('/model fable', { problem: PROBLEM });
    const r2 = await runModel('/model exec fable', { problem: PROBLEM });
    const r3 = await runModel('/model fable', { throws: THROWS });
    const r4 = await runModel('/model exec fable', { throws: THROWS });
    for (const r of [r1, r2]) { assert.equal(r.length, 1); assert.ok(r[0].startsWith('⚠️ 未切换：')); }
    for (const r of [r3, r4]) { assert.equal(r.length, 1); assert.ok(r[0].startsWith('⚠️ ')); }
    for (const r of [r1, r2, r3, r4]) { assert.ok(!r[0].includes('/Users/'), r[0]); assert.ok(r[0].includes(P), r[0]); }
  });

  test('S4b /model 正常路径不受影响（无问题时切换成功回复照旧）', async () => {
    const r = await runModel('/model fable');
    assert.match(r[0], /^✅ 已切换/);
  });

  test('S4c 源码：/model 块里没有未包 stripLocalPaths 的 pre.problem / 错误文本直出', () => {
    assert.equal((BLOCK.match(/stripLocalPaths\(/g) || []).length, 4);
    assert.ok(!/\$\{pre\.problem\}/.test(BLOCK));
    assert.ok(!/\$\{e\?\.message \?\? e\}/.test(BLOCK));
  });
});
