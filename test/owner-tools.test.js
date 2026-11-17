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
      for (const rule of ['Edit(./memory/**)', 'Edit(./skills/**)', 'Edit(./schedules/**)', 'Edit(./outbox/**)', 'Edit(./tasks/**)']) {
        assert.ok(allowed.includes(rule), `默认工具集缺 ${rule}`);
      }
      assert.ok(!allowed.some((x) => /^Write\(/.test(x)), 'Write(path) 不被文件权限检查匹配，不该出现在默认值里');
      assert.ok(!allowed.includes('Edit') && !allowed.includes('Write'), '写权限必须限定路径，不能整个放开');
    }));

  test('默认写权限只限工作区内的四个目录，不含 CLAUDE.md 与 .claude/', () =>
    withEnv({ ALLOWED_TOOLS: undefined }, (m) => {
      const allowed = (argVal(m.buildClaudeArgs('oc_x', true, []).args, '--allowedTools') ?? '').split(',');
      const writeRules = allowed.filter((x) => /^Edit\(/.test(x));
      for (const r of writeRules) assert.match(r, /^Edit\(\.\/(memory|skills|schedules|outbox|tasks)\/\*\*\)$/, `越界的写规则：${r}`);
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

// ---- BRIDGE-HB-1：心跳工具档（调研 §8.6 测试 10）与普通参数回归（测试 11）----
const { readFileSync } = await import('node:fs');
const list = (args, flag) => (argVal(args, flag) ?? '').split(',').filter(Boolean);

describe('心跳工具档 toolProfile=heartbeat（测试 10）', () => {
  const HB_OPTS = { toolProfile: 'heartbeat', model: 'claude-sonnet-5', effort: 'low' };
  // 故意把 env 开到最宽：放宽的 ALLOWED_TOOLS、LARK_CLI、飞书 MCP（FEISHU_TOOLS 默认开）都不得渗进心跳档
  const WIDE = {
    ALLOWED_TOOLS: 'Read,Grep,Glob,Bash,WebFetch,WebSearch,Edit(./schedules/**),Edit(./skills/**)',
    LARK_CLI: 'true',
    FEISHU_TOOLS: undefined,
  };
  const hb = (m, extra = [], opts = {}) => {
    const r = m.buildClaudeArgs('sched:heartbeat', true, extra, { ...HB_OPTS, ...opts });
    r.cleanup();
    return r;
  };

  test('切断配置来源：--setting-sources 为空 + --strict-mcp-config，不挂任何 MCP', () =>
    withEnv(WIDE, (m) => {
      const { args } = hb(m);
      assert.equal(argVal(args, '--setting-sources'), '', '不加载任何 settings（用户级 allow 规则对 -p 同样生效）');
      assert.ok(args.includes('--strict-mcp-config'), '不加载用户级 MCP');
      assert.ok(!args.includes('--mcp-config'), '心跳不挂飞书 MCP：读工具会带回未围栏的第三方内容，写工具按 §5 禁用');
      assert.equal(argVal(args, '--settings'), JSON.stringify({ autoMemoryEnabled: false }));
    }));

  test('--tools 白名单只有 Read/Grep/Glob/Edit/Write：没有 Bash、WebFetch、WebSearch', () =>
    withEnv(WIDE, (m) => {
      const tools = list(hb(m).args, '--tools');
      assert.deepEqual([...tools].sort(), ['Edit', 'Glob', 'Grep', 'Read', 'Write']);
      for (const x of ['Bash', 'WebFetch', 'WebSearch']) assert.ok(!tools.includes(x), `--tools 不该有 ${x}`);
    }));

  test('allowedTools：无 lark-cli/Bash/飞书工具/Edit(./schedules/**)；写规则只有 tasks 与 journal；Read 限工作区', () =>
    withEnv(WIDE, (m) => {
      const allowed = list(hb(m).args, '--allowedTools');
      assert.ok(!allowed.some((x) => /lark-cli/.test(x)), '不得有 lark-cli');
      assert.ok(!allowed.some((x) => /^Bash/.test(x)), '不得有 Bash');
      assert.ok(!allowed.some((x) => /^mcp__/.test(x)), '不得有飞书 MCP 工具（含 doc_append/bitable_*_record/sheet_write）');
      assert.ok(!allowed.some((x) => /^Web(Fetch|Search)/.test(x)), '不得联网');
      assert.ok(!allowed.includes('Edit(./schedules/**)'), '不得改定时任务');
      const writes = allowed.filter((x) => /^(Edit|Write|NotebookEdit)\b/.test(x));
      assert.deepEqual([...writes].sort(), ['Edit(./memory/journal/**)', 'Edit(./tasks/**)'], `写规则越界：${writes}`);
      assert.deepEqual(allowed.filter((x) => /^Read\b/.test(x)), ['Read(./**)'], 'Read 只预批工作区内');
      assert.ok(!allowed.includes('Grep') && !allowed.includes('Glob'), '裸 Grep/Glob 规则会预批工作区外的检索');
    }));

  test('黑名单兜底：显式拒绝 Bash/WebFetch/WebSearch/飞书 MCP/Edit(./schedules/**)，但不拉黑自己要用的工具', () =>
    withEnv(WIDE, (m) => {
      const denied = list(hb(m).args, '--disallowedTools');
      for (const x of ['Bash', 'WebFetch', 'WebSearch', 'mcp__feishu', 'Edit(./schedules/**)']) {
        assert.ok(denied.includes(x), `--disallowedTools 缺 ${x}`);
      }
      for (const x of ['Read', 'Grep', 'Glob', 'Edit', 'Write']) assert.ok(!denied.includes(x), `不能整个拉黑 ${x}`);
    }));

  test('永不续会话、不吃 extraTools；cwd 为 owner 工作区，模型/思考档取调用方给的值', () =>
    withEnv(WIDE, (m) => {
      const r = hb(m, ['Read(./incoming/**)', 'Bash(curl:*)'], { resumeId: 'sess-1' });
      assert.ok(!r.args.includes('--resume'), '心跳每拍都是全新上下文');
      assert.ok(!r.args.join('\n').includes('curl'), 'extraTools 不得混进心跳档');
      assert.ok(!r.args.join('\n').includes('incoming'), 'extraTools 不得混进心跳档');
      assert.equal(r.cwd, m.WORKSPACE_DIR);
      assert.equal(argVal(r.args, '--model'), 'claude-sonnet-5');
      assert.equal(argVal(r.args, '--effort'), 'low');
    }));

  test('只对 owner 生效：非 owner 带 heartbeat 档时参数与不带时完全一致', () =>
    withEnv(WIDE, (m) => {
      const a = m.buildClaudeArgs('guest:oc:ou', false, [], { toolProfile: 'heartbeat' });
      const b = m.buildClaudeArgs('guest:oc:ou', false, [], {});
      a.cleanup();
      b.cleanup();
      assert.deepEqual(a.args, b.args);
    }));
});

describe('回归：普通 owner 与定时任务参数除新增 Edit(./tasks/**) 外逐字不变（测试 11）', () => {
  // 冻结期望 = 改动前（基线 d58037c）buildClaudeArgs 的真实输出，来源见 fixtures 文件 _source 字段
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/owner-args-baseline.json', import.meta.url), 'utf8'));
  const PINNED = {
    ALLOWED_TOOLS: undefined,
    NON_OWNER_TOOLS: undefined,
    FEISHU_TOOLS: undefined,
    CLAUDE_MODEL: 'claude-opus-5',
    CLAUDE_EFFORT: 'high',
    CLAUDE_EXEC_MODEL: undefined,
    CLAUDE_EXEC_EFFORT: undefined,
    LARK_CLI: undefined,
  };
  const norm = (args) => args.map((x, i) => (args[i - 1] === '--mcp-config' ? '<mcp-config>' : x));
  // 唯一允许的差异：owner 默认工具集在 Edit(./outbox/**) 之后多一条 Edit(./tasks/**)
  const plusTasks = (args) => args.map((x, i) =>
    (args[i - 1] === '--allowedTools' ? x.replace('Edit(./outbox/**)', 'Edit(./outbox/**),Edit(./tasks/**)') : x));
  const CASES = {
    ownerChat: [{}, (m) => m.buildClaudeArgs('oc_x', true, [], { lane: 'chat', resumeId: 'sess-1' })],
    ownerExecLark: [
      { LARK_CLI: 'true', CLAUDE_EXEC_MODEL: 'claude-sonnet-5' },
      (m) => m.buildClaudeArgs('oc_x', true, ['Read(./incoming/**)'], { lane: 'exec', resumeId: 'sess-1' }),
    ],
    schedJob: [{}, (m) => m.buildClaudeArgs('sched:daily.json', true, [], { model: 'haiku', effort: 'low' })],
    schedDiag: [
      {},
      (m) => m.buildClaudeArgs('sched-diag:daily.json', true, [], { model: 'claude-haiku-4-5-20251001', effort: 'low' }),
    ],
  };
  for (const [name, [env, call]] of Object.entries(CASES)) {
    test(`${name}：与基线逐字一致（仅多 Edit(./tasks/**)）`, () =>
      withEnv({ ...PINNED, ...env }, (m) => {
        const r = call(m);
        r.cleanup();
        // BRIDGE-PUB-1：schedJob 用的是 haiku 别名，别名改指 claude-haiku-5-5（夹具里是旧型号）；schedDiag 传的是全名，不受影响
        const want = name === 'schedJob'
          ? plusTasks(baseline[name]).map((x) => x.replaceAll('claude-haiku-4-5-20251001', 'claude-haiku-5-5'))
          : plusTasks(baseline[name]);
        assert.deepEqual(norm(r.args), want);
        assert.equal(r.cwd, m.WORKSPACE_DIR);
      }));
  }

  test('基线自检：允许的差异恰好落在 --allowedTools 一处（防止变换空转）', () => {
    for (const name of Object.keys(CASES)) {
      const after = plusTasks(baseline[name]);
      const changed = baseline[name].filter((x, i) => after[i] !== x);
      assert.equal(changed.length, 1, name);
    }
  });
});

const { existsSync } = await import('node:fs');
const { default: os } = await import('node:os');
const { default: path } = await import('node:path');
const { fileURLToPath } = await import('node:url');

describe('验收工具档 toolProfile=verifier（BRIDGE-VR-1 测试 5）', () => {
  const V_OPTS = { toolProfile: 'verifier', model: 'claude-haiku-5-5', effort: 'low' };
  // env 开到最宽：放宽的 ALLOWED_TOOLS、LARK_CLI、飞书 MCP、strict owner 档都不得渗进验收档
  const WIDE = {
    ALLOWED_TOOLS: 'Read,Grep,Glob,Bash,WebFetch,WebSearch,Edit(./schedules/**),Edit(./skills/**)',
    LARK_CLI: 'true',
    FEISHU_TOOLS: undefined,
    OWNER_TOOL_PROFILE: 'strict',
  };
  const REPO = fileURLToPath(new URL('..', import.meta.url));
  const vr = (m, extra = [], opts = {}) => m.buildClaudeArgs('sched:verify', true, extra, { ...V_OPTS, ...opts });

  test('没有任何工具：--tools 为空串；--setting-sources 为空 + --strict-mcp-config；无 --allowedTools / --mcp-config', () =>
    withEnv(WIDE, (m) => {
      const r = vr(m);
      r.cleanup();
      assert.equal(argVal(r.args, '--tools'), '', '--tools 必须是空串（一个工具都没有）');
      assert.equal(argVal(r.args, '--setting-sources'), '', '不加载任何 settings 来源');
      assert.ok(r.args.includes('--strict-mcp-config'), '不加载用户级 MCP');
      assert.ok(!r.args.includes('--allowedTools'), '验收档不得有 --allowedTools');
      assert.ok(!r.args.includes('--mcp-config'), '验收档不得挂 MCP');
      assert.ok(!r.args.includes('--resume'));
      assert.equal(argVal(r.args, '--settings'), JSON.stringify({ autoMemoryEnabled: false }));
    }));

  test('argv 逐项：-p stream-json --verbose --tools "" --setting-sources "" --strict-mcp-config --settings --model --effort low --append-system-prompt', () =>
    withEnv(WIDE, (m) => {
      const r = vr(m, [], { effort: 'max' });
      r.cleanup();
      assert.equal(r.args[0], '-p');
      assert.deepEqual(r.args.filter((x) => x.startsWith('--')), [
        '--output-format', '--verbose', '--tools', '--setting-sources', '--strict-mcp-config',
        '--settings', '--model', '--effort', '--append-system-prompt',
      ]);
      assert.equal(argVal(r.args, '--output-format'), 'stream-json');
      assert.equal(argVal(r.args, '--model'), 'claude-haiku-5-5');
      assert.equal(argVal(r.args, '--effort'), 'low', '验收档固定 low');
      const sys = argVal(r.args, '--append-system-prompt');
      assert.match(sys, /只输出/);
      assert.match(sys, /JSON/);
      assert.match(sys, /不调用任何工具/);
    }));

  test('cwd 每次新建在 os.tmpdir() 下、不在仓库内、不是工作区；cleanup 后目录消失', () =>
    withEnv(WIDE, (m) => {
      const a = vr(m);
      const b = vr(m);
      try {
        for (const r of [a, b]) {
          assert.ok(r.cwd.startsWith(path.join(os.tmpdir(), 'feishu-verifier-')), `cwd 不在临时目录：${r.cwd}`);
          assert.ok(!r.cwd.startsWith(REPO), 'cwd 不得在仓库内');
          assert.ok(!r.cwd.startsWith(m.WORKSPACE_DIR), 'cwd 不得是 workspace/');
          assert.ok(existsSync(r.cwd), '调用前目录必须存在');
        }
        assert.notEqual(a.cwd, b.cwd, '每次调用都是全新的临时目录');
      } finally {
        a.cleanup();
        b.cleanup();
      }
      assert.ok(!existsSync(a.cwd) && !existsSync(b.cwd), 'cleanup 后临时目录必须删除');
    }));

  test('不吃 extraTools、不续会话；模型取调用方给的值', () =>
    withEnv(WIDE, (m) => {
      const r = vr(m, ['Read(./incoming/**)', 'Bash(curl:*)'], { resumeId: 'sess-1', model: 'claude-sonnet-5-5' });
      r.cleanup();
      const all = r.args.join('\n');
      assert.ok(!all.includes('curl') && !all.includes('incoming'), 'extraTools 不得混进验收档');
      assert.ok(!r.args.includes('--resume'));
      assert.equal(argVal(r.args, '--model'), 'claude-sonnet-5-5');
    }));

  test('只对 owner 生效：非 owner 带 verifier 档时参数与不带时完全一致', () =>
    withEnv(WIDE, (m) => {
      const a = m.buildClaudeArgs('guest:oc:ou', false, [], { toolProfile: 'verifier' });
      const b = m.buildClaudeArgs('guest:oc:ou', false, [], {});
      a.cleanup();
      b.cleanup();
      assert.deepEqual(a.args, b.args);
      assert.equal(a.cwd, b.cwd);
    }));

  // 只用一次性目录（os.tmpdir() 下新建），绝不把仓库 / workspace 交给 cleanup：防护被改坏时也只删到这些临时目录
  test('cleanup 只删自己建的、os.tmpdir() 正下方的 feishu-verifier- 目录：cwd 被改到别处时不删（R1 L3）', () =>
    withEnv(WIDE, (m) => {
      const fs = process.getBuiltinModule('node:fs');
      const r = vr(m);
      const own = r.cwd;
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-l3-'));
      const nested = fs.mkdtempSync(path.join(other, 'feishu-verifier-')); // 名字像，但不在 os.tmpdir() 正下方
      try {
        for (const dir of [nested, other]) {
          r.cwd = dir;
          r.cleanup();
          assert.ok(fs.existsSync(dir), `cwd 被改成 ${dir}：cleanup 不得删`);
        }
        r.cwd = own;
        r.cleanup();
        assert.ok(!fs.existsSync(own), '自己建的临时目录照常删');
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
        fs.rmSync(own, { recursive: true, force: true });
      }
    }));
});

describe('验收工具档：调用方没给模型或给了非法模型名时兜底 claude-haiku-5-5（BRIDGE-VR-1 测试 5 补）', () => {
  test('toolProfile=verifier 不带 model / 空串 / 非法名 → --model claude-haiku-5-5（不回落全局 CLAUDE_MODEL）', () =>
    withEnv({ CLAUDE_MODEL: 'claude-sonnet-5-5', OWNER_TOOL_PROFILE: 'strict' }, (m) => {
      for (const model of [undefined, '', 'bad name;rm']) {
        const r = m.buildClaudeArgs('sched:verify', true, [], { toolProfile: 'verifier', model });
        r.cleanup();
        assert.equal(argVal(r.args, '--model'), 'claude-haiku-5-5', `model=${JSON.stringify(model)}`);
        assert.equal(argVal(r.args, '--tools'), '');
      }
    }));
});
