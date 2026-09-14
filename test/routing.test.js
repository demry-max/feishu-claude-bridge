// 模型分工（行为断言）：聊天/规划走 CLAUDE_MODEL，执行走 CLAUDE_EXEC_MODEL。
// 2026-09-14 需求：平常聊天和规划用 fable 5.1，执行时用 sonnet 5。
// 「执行」的判定必须是确定性的（前缀命令或明确的触发词），不靠模型自己猜——
// 猜错的成本是整轮跑在错误的模型上，且用户无从察觉。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const argVal = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

// 每个 describe 用独立的 env 快照重新 import，避免互相污染
async function freshClaude(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const mod = await import(`../src/claude.js?lane=${Math.random()}`);
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  return { mod, restore };
}

describe('执行触发词判定 routeTurn（纯函数）', () => {
  test('/do 前缀 → 执行车道，前缀被剥掉，正文原样保留', async () => {
    const { mod, restore } = await freshClaude({});
    try {
      const r = mod.routeTurn('/do 把这份表格按月汇总');
      assert.equal(r.lane, 'exec');
      assert.equal(r.prompt, '把这份表格按月汇总');
    } finally { restore(); }
  });

  test('/exec 与 /run 是 /do 的别名', async () => {
    const { mod, restore } = await freshClaude({});
    try {
      assert.equal(mod.routeTurn('/exec x').lane, 'exec');
      assert.equal(mod.routeTurn('/run x').lane, 'exec');
      assert.equal(mod.routeTurn('/RUN x').lane, 'exec', '命令不区分大小写');
    } finally { restore(); }
  });

  test('裸 /do（没有正文）= 执行上面已确认的计划', async () => {
    const { mod, restore } = await freshClaude({});
    try {
      const r = mod.routeTurn('/do');
      assert.equal(r.lane, 'exec');
      assert.match(r.prompt, /计划/, '空正文不能把空串喂给模型');
    } finally { restore(); }
  });

  test('自然语言触发词：「执行」「去做」「go ahead」开头 → 执行车道，正文不动', async () => {
    const { mod, restore } = await freshClaude({});
    try {
      for (const t of ['执行', '执行。', '执行吧', '开始执行', '执行 第二步', '去做吧', '动手', 'go ahead', 'Go', 'do it']) {
        const r = mod.routeTurn(t);
        assert.equal(r.lane, 'exec', `「${t}」应进执行车道`);
        assert.equal(r.prompt, t, '自然语言触发词是正文的一部分，不能剥');
      }
    } finally { restore(); }
  });

  test('触发词只认句首与词边界：谈论「执行力」「google」不算执行', async () => {
    const { mod, restore } = await freshClaude({});
    try {
      for (const t of ['执行力很重要', '执行官是谁', '谈谈执行层面的风险', 'google 一下', 'goal 是什么', '帮我执行', '/donut 好吃吗', '这个 /do 是什么意思']) {
        assert.equal(mod.routeTurn(t).lane, 'chat', `「${t}」不该进执行车道`);
      }
    } finally { restore(); }
  });

  test('普通聊天与规划留在聊天车道，提示词一字不变', async () => {
    const { mod, restore } = await freshClaude({});
    try {
      const r = mod.routeTurn('  帮我规划一下下周的安排  ');
      assert.equal(r.lane, 'chat');
      assert.equal(r.prompt, '帮我规划一下下周的安排');
    } finally { restore(); }
  });

  test('EXEC_TRIGGERS 可整体覆盖默认触发词', async () => {
    const { mod, restore } = await freshClaude({ EXEC_TRIGGERS: '/go,开干' });
    try {
      assert.equal(mod.routeTurn('/go x').lane, 'exec');
      assert.equal(mod.routeTurn('开干').lane, 'exec');
      assert.equal(mod.routeTurn('/do x').lane, 'chat', '覆盖后默认词失效');
      assert.equal(mod.routeTurn('执行').lane, 'chat');
    } finally { restore(); }
  });
});

describe('车道 → 模型（buildClaudeArgs 行为断言）', () => {
  const ENV = {
    CLAUDE_MODEL: 'claude-fable-5-1',
    CLAUDE_EFFORT: 'high',
    CLAUDE_EXEC_MODEL: 'sonnet',
    CLAUDE_EXEC_EFFORT: '',
  };

  test('聊天车道用 CLAUDE_MODEL，执行车道用 CLAUDE_EXEC_MODEL（别名已解析）', async () => {
    const { mod, restore } = await freshClaude(ENV);
    try {
      const chat = mod.buildClaudeArgs('oc_x', true, [], { lane: 'chat' });
      const exec = mod.buildClaudeArgs('oc_x', true, [], { lane: 'exec' });
      assert.equal(argVal(chat.args, '--model'), 'claude-fable-5-1');
      assert.equal(argVal(exec.args, '--model'), 'claude-sonnet-5');
      assert.equal(chat.lane, 'chat');
      assert.equal(exec.lane, 'exec');
    } finally { restore(); }
  });

  test('执行车道未单独配 effort 时沿用聊天档；配了则用自己的', async () => {
    const a = await freshClaude(ENV);
    try {
      assert.equal(argVal(a.mod.buildClaudeArgs('oc_x', true, [], { lane: 'exec' }).args, '--effort'), 'high');
    } finally { a.restore(); }
    const b = await freshClaude({ ...ENV, CLAUDE_EXEC_EFFORT: 'medium' });
    try {
      assert.equal(argVal(b.mod.buildClaudeArgs('oc_x', true, [], { lane: 'exec' }).args, '--effort'), 'medium');
      assert.equal(argVal(b.mod.buildClaudeArgs('oc_x', true, [], { lane: 'chat' }).args, '--effort'), 'high', '聊天档不受影响');
    } finally { b.restore(); }
  });

  test('未配 CLAUDE_EXEC_MODEL 时执行车道退回 CLAUDE_MODEL（功能默认关闭，行为字节不变）', async () => {
    const { mod, restore } = await freshClaude({ ...ENV, CLAUDE_EXEC_MODEL: '' });
    try {
      const exec = mod.buildClaudeArgs('oc_x', true, [], { lane: 'exec' });
      assert.equal(argVal(exec.args, '--model'), 'claude-fable-5-1');
      assert.equal(exec.lane, 'chat', '没有执行模型就没有执行车道，别在提示词里谎称');
    } finally { restore(); }
  });

  test('定时任务默认走执行车道；任务自带 model 时以任务为准', async () => {
    const { mod, restore } = await freshClaude(ENV);
    try {
      const s = mod.buildClaudeArgs('sched:weekly.json', true, []);
      assert.equal(argVal(s.args, '--model'), 'claude-sonnet-5');
      const own = mod.buildClaudeArgs('sched:weekly.json', true, [], { model: 'haiku' });
      assert.equal(argVal(own.args, '--model'), 'claude-haiku-4-5-20251001');
      // 自诊断任务由调用方显式指定 DIAG_MODEL，不受车道影响
      const diag = mod.buildClaudeArgs('sched-diag:weekly.json', true, [], { model: 'claude-haiku-4-5-20251001' });
      assert.equal(argVal(diag.args, '--model'), 'claude-haiku-4-5-20251001');
    } finally { restore(); }
  });

  test('聊天消息不传 lane 时默认聊天车道', async () => {
    const { mod, restore } = await freshClaude(ENV);
    try {
      assert.equal(argVal(mod.buildClaudeArgs('oc_x', true, []).args, '--model'), 'claude-fable-5-1');
    } finally { restore(); }
  });

  test('执行车道复用同一会话（sonnet 要看得见 fable 做的计划）', async () => {
    const { mod, restore } = await freshClaude(ENV);
    try {
      const r = mod.buildClaudeArgs('oc_x', true, [], { lane: 'exec', resumeId: 'sess-1' });
      assert.equal(argVal(r.args, '--resume'), 'sess-1');
    } finally { restore(); }
  });

  test('系统提示词如实告知本轮车道与两个模型的分工', async () => {
    const { mod, restore } = await freshClaude(ENV);
    try {
      const exec = argVal(mod.buildClaudeArgs('oc_x', true, [], { lane: 'exec' }).args, '--append-system-prompt');
      assert.match(exec, /claude-sonnet-5/);
      assert.match(exec, /执行/);
      const chat = argVal(mod.buildClaudeArgs('oc_x', true, [], { lane: 'chat' }).args, '--append-system-prompt');
      assert.match(chat, /claude-fable-5-1/);
      assert.match(chat, /claude-sonnet-5/, '聊天轮也要知道有执行模型可切，才能引导用户说「执行」');
    } finally { restore(); }
  });
});

describe('运行时切换执行模型', () => {
  test('setRuntimeConfig({execModel}) 立即生效并可读回；off 关闭', async () => {
    const { mod, restore } = await freshClaude({ CLAUDE_MODEL: 'claude-fable-5-1', CLAUDE_EXEC_MODEL: '' });
    try {
      // 不回写 .env（persist=false），避免测试污染真实配置
      const next = mod.setRuntimeConfig({ execModel: 'sonnet' }, { persist: false });
      assert.equal(next.execModel, 'claude-sonnet-5');
      assert.equal(mod.getRuntimeConfig().execModel, 'claude-sonnet-5');
      assert.equal(argVal(mod.buildClaudeArgs('oc_x', true, [], { lane: 'exec' }).args, '--model'), 'claude-sonnet-5');
      const off = mod.setRuntimeConfig({ execModel: 'off' }, { persist: false });
      assert.equal(off.execModel, '');
      assert.equal(argVal(mod.buildClaudeArgs('oc_x', true, [], { lane: 'exec' }).args, '--model'), 'claude-fable-5-1');
    } finally { restore(); }
  });

  test('非法执行模型名被拒绝，不写入', async () => {
    const { mod, restore } = await freshClaude({ CLAUDE_MODEL: 'claude-fable-5-1', CLAUDE_EXEC_MODEL: 'sonnet' });
    try {
      assert.throws(() => mod.setRuntimeConfig({ execModel: 'bad name;rm' }, { persist: false }), /不合法/);
      assert.equal(mod.getRuntimeConfig().execModel, 'claude-sonnet-5');
    } finally { restore(); }
  });
});

describe('index.js 接线（源码断言——只证明写法，不证明行为）', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

  test('聊天路径把车道传给 runClaude，且在 /redirect 之后判定（/redirect 执行 也要生效）', () => {
    const redirectAt = src.indexOf("if (text.startsWith('/redirect'))");
    const routeAt = src.indexOf('routeTurn(prompt)');
    assert.ok(redirectAt > 0 && routeAt > redirectAt, 'routeTurn 必须作用在 /redirect 处理后的 prompt 上');
    assert.match(src, /runClaude\(sessionKey, prompt, isOwner, extraTools, progress\.update, \{ lane: route\.lane \}\)/);
  });

  test('/model 支持查看与切换执行模型；/help 与 /status 提到执行车道', () => {
    assert.match(src, /\/model exec/);
    assert.match(src, /execModel/);
    assert.match(src, /`\/do <任务>`/, '/help 要教用户怎么触发执行');
  });

  test('set-model 定时动作可切换执行模型', () => {
    assert.match(src, /execModel: job\.exec_model/);
  });

  test('启动自检同时检查执行模型的 CLI 版本要求', () => {
    assert.match(src, /checkCliEnvironment\(cfg\.execModel\)/);
  });
});
