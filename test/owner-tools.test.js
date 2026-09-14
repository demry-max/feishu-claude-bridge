// owner 默认工具集（行为断言）——2026-09-13 安装反馈：
// workspace/CLAUDE.md 承诺「仅限 memory/ 与 skills/ 的写入权」，README 承诺三层记忆、技能沉淀、
// 定时任务、文件回传；但 ALLOWED_TOOLS 默认值 'Read,Grep,Glob,WebSearch,WebFetch' 没有任何写入工具，
// 开箱状态下这些功能全部无法工作。注意 CLI 的文件权限规则只认 Edit(path)（覆盖 Write 等所有编辑工具），
// Write(path) 写法不会被文件权限检查匹配。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const argVal = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

async function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return await fn(await import(`../src/claude.js?tools=${Math.random()}`));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

describe('owner 默认工具集', () => {
  test('未配 ALLOWED_TOOLS 时，owner 默认能写 memory/ skills/ schedules/ outbox/（Edit 规则）', () =>
    withEnv({ ALLOWED_TOOLS: undefined, LARK_CLI: undefined }, (m) => {
      const allowed = (argVal(m.buildClaudeArgs('oc_x', true, []).args, '--allowedTools') ?? '').split(',');
      for (const rule of ['Edit(./memory/**)', 'Edit(./skills/**)', 'Edit(./schedules/**)', 'Edit(./outbox/**)']) {
        assert.ok(allowed.includes(rule), `默认工具集缺 ${rule}`);
      }
      assert.ok(!allowed.some((x) => /^Write\(/.test(x)), 'Write(path) 不被文件权限检查匹配，不该出现在默认值里');
      assert.ok(!allowed.includes('Edit') && !allowed.includes('Write'), '写权限必须限定路径，不能整个放开');
    }));

  test('默认写权限只限工作区内的四个目录，不含 CLAUDE.md 与 .claude/', () =>
    withEnv({ ALLOWED_TOOLS: undefined }, (m) => {
      const allowed = (argVal(m.buildClaudeArgs('oc_x', true, []).args, '--allowedTools') ?? '').split(',');
      const writeRules = allowed.filter((x) => /^Edit\(/.test(x));
      for (const r of writeRules) assert.match(r, /^Edit\(\.\/(memory|skills|schedules|outbox)\/\*\*\)$/, `越界的写规则：${r}`);
    }));

  test('显式配置 ALLOWED_TOOLS 时完全以配置为准（不做合并，避免暗中扩权）', () =>
    withEnv({ ALLOWED_TOOLS: 'Read,WebSearch' }, (m) => {
      const allowed = (argVal(m.buildClaudeArgs('oc_x', true, []).args, '--allowedTools') ?? '').split(',');
      assert.ok(!allowed.some((x) => x.startsWith('Edit(')), '用户明确收窄了就不该再塞默认写规则');
    }));

  test('访客不受 owner 默认写规则影响', () =>
    withEnv({ ALLOWED_TOOLS: undefined }, (m) => {
      const g = m.buildClaudeArgs('guest:oc:ou', false, []);
      assert.ok(!(argVal(g.args, '--allowedTools') ?? '').includes('Edit('));
      assert.ok(!(argVal(g.args, '--tools') ?? '').split(',').includes('Edit'));
    }));
});

describe('LARK_CLI 开关（飞书官方 lark-cli，用户身份）', () => {
  test('LARK_CLI=true 时 owner 多一条 Bash(lark-cli:*)，且只多这一条 Bash 规则', () =>
    withEnv({ ALLOWED_TOOLS: undefined, LARK_CLI: 'true' }, (m) => {
      const allowed = (argVal(m.buildClaudeArgs('oc_x', true, []).args, '--allowedTools') ?? '').split(',');
      assert.ok(allowed.includes('Bash(lark-cli:*)'));
      assert.deepEqual(allowed.filter((x) => x.startsWith('Bash')), ['Bash(lark-cli:*)'], '不得顺手放开别的 Bash');
    }));

  test('默认关闭；LARK_CLI=yes 之类的非精确值不算开', () =>
    withEnv({ ALLOWED_TOOLS: undefined, LARK_CLI: 'yes' }, (m) => {
      const allowed = (argVal(m.buildClaudeArgs('oc_x', true, []).args, '--allowedTools') ?? '').split(',');
      assert.ok(!allowed.some((x) => x.startsWith('Bash')));
    }));

  test('显式配了 ALLOWED_TOOLS 也能叠加 LARK_CLI（它是独立开关，不是默认值的一部分）', () =>
    withEnv({ ALLOWED_TOOLS: 'Read,WebSearch', LARK_CLI: 'true' }, (m) => {
      const allowed = (argVal(m.buildClaudeArgs('oc_x', true, []).args, '--allowedTools') ?? '').split(',');
      assert.ok(allowed.includes('Bash(lark-cli:*)'));
    }));

  test('访客永远拿不到 lark-cli（它以 owner 的飞书身份读写 IM/邮件/审批）', () =>
    withEnv({ LARK_CLI: 'true' }, (m) => {
      const g = m.buildClaudeArgs('guest:oc:ou', false, []);
      assert.ok(!g.args.join(' ').includes('lark-cli'));
      assert.ok((argVal(g.args, '--disallowedTools') ?? '').split(',').includes('Bash'));
    }));
});
