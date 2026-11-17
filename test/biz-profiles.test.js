// BRIDGE-BMS-1：BMS_TOOL_ENABLED 开 / 关时各条路径的 claude CLI 参数。
// 对应卡片测试 11（工具面）、12（.env 拒读与白名单）、13（审计名的一部分）。
// - 关：三档各 17 个用例与基线 419d56f 生成的夹具逐字一致。夹具从不在测试里重新生成，sha256 钉死。
// - 开：只做加法。私聊、发往 owner 私聊的定时、心跳多一个 mcp__biz__biz_get、一组 .env 拒读与 security 拒绝、
//   一份不带任何 env 的 biz MCP 条目（经 /usr/bin/env -u 启动）；群聊（含 owner）、发往群或目的地缺失的定时、
//   sched-diag、验收、交接、访客与关时逐字一致。
// 全程用假 claude CLI；不碰钥匙串、不联网。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, PROFILES, makeHarness, runMatrix, snapCase } from './fixtures/biz-off-matrix.mjs';
import { BIZ_TOOL, BIZ_SERVER, BIZ_SKILL } from '../src/biz-targets.js';
import { BIZ_HEARTBEAT_LINE, SECURITY_DENY, BIZ_ENV_STRIP, ENV_BIN, SCHED_DEST_OWNER_P2P, schedDestOf } from '../src/biz-wiring.js';
import { safeToolName } from '../src/tool-policy.js';

const REPO = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const FIXTURE_FILE = path.join(REPO, 'test', 'fixtures', 'owner-args-biz-off-419d56f.json');
const FIXTURE_SHA256 = 'dc0b8cc693d35593540103079ff6e451f70245e63e781e45a620e37b9bb31995';
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8')).profiles;

// store.js 的 DATA_DIR 在首次加载时就定了：整个文件只用一套临时环境
const h = makeHarness(REPO, 'biz-prof-');
after(() => fs.rmSync(h.p.tmp, { recursive: true, force: true }));

// 开关开时该有 biz_get 的用例 / 永远不该有的用例（两者合起来正好是全部 CASES）。
// CASES 里的三个定时用例不带 schedDest（＝目的地未知），开关开也不给；带上 owner 私聊目的地的版本见 SCHED 与 callOf。
const ELIGIBLE = ['ownerP2p', 'ownerP2pFresh', 'ownerP2pConfirm', 'ownerP2pAllowed', 'ownerP2pNoFeishu', 'ownerP2pFile',
  'ownerExec', 'heartbeat'];
const SCHED = ['sched', 'schedPlain', 'schedNoFeishu'];
const NEVER = ['ownerNoChatType', 'ownerGroup', ...SCHED, 'schedDiag', 'verifier', 'guest', 'guestFile'];

/** CASES 的调用参数；定时用例可指定目的地（dest 为 undefined 时原样）。 */
function callOf(name, dest = SCHED.includes(name) ? SCHED_DEST_OWNER_P2P : undefined) {
  const c = structuredClone(CASES[name].call);
  if (dest === undefined) return c;
  if (c.length < 4) c[3] = {};
  c[3] = { ...c[3], schedDest: dest };
  return c;
}

const RAW_DENY = [`Read(//${REPO.replace(/^\/+/, '')}/.env)`, `Read(//${REPO.replace(/^\/+/, '')}/.env.*)`, 'Bash(security:*)', 'Bash(/usr/bin/security:*)'];
const DENY = ['Read(/<repo>/.env)', 'Read(/<repo>/.env.*)', 'Bash(security:*)', 'Bash(/usr/bin/security:*)']; // 归一化之后（仓库路径换成 <repo>）
const BIZ_ENTRY = { type: 'stdio', command: '/usr/bin/env', args: [...BIZ_ENV_STRIP.flatMap((k) => ['-u', k]), '<node>', '<repo>/src/mcp-biz.js'], env: {} };
const BIZ_ONLY = { text: JSON.stringify({ mcpServers: { [BIZ_SERVER]: BIZ_ENTRY } }), mode: 0o600 };

// 环境里就算有像 Key 的变量，也不许被抄进参数或 mcp.json
const CANARY = {
  BMS_API_KEY: `bms_sk_ZZTESTMARK${'c'.repeat(24)}`,
  IAS_API_KEY: `acc_ZZTESTMARK${'d'.repeat(33)}`,
  BIZ_API_KEY: `bms_sk_ZZTESTMARK${'e'.repeat(24)}`,
};

const flag = (args, f) => {
  const i = args.indexOf(f);
  return i < 0 ? null : args[i + 1];
};
const count = (args, f) => args.filter((a) => a === f).length;

/** 由关时的快照推出开时应有的样子：只在原有参数上做加法。 */
function expectOn(pname, name, off) {
  const s = structuredClone(off);
  const a = s.args;
  const at = (f) => a.indexOf(f);
  const ai = at('--allowedTools');
  a[ai + 1] = [a[ai + 1], BIZ_TOOL].filter(Boolean).join(',');
  const di = at('--disallowedTools');
  if (di >= 0) a[di + 1] = [a[di + 1], ...DENY].join(','); // strict、心跳：原拒绝表末尾追加
  else if (pname === 'legacy') a.splice(ai + 2, 0, '--disallowedTools', DENY.join(',')); // legacy：紧跟 --allowedTools
  else a.splice(at('--strict-mcp-config') + 1, 0, '--disallowedTools', DENY.join(',')); // audit：紧跟 --strict-mcp-config
  if (name === 'heartbeat') {
    a.splice(at('--strict-mcp-config') + 1, 0, '--mcp-config', '<mcp-config>');
    const pi = at('--append-system-prompt');
    a[pi + 1] = `${a[pi + 1]}\n${BIZ_HEARTBEAT_LINE}`;
    s.mcp = BIZ_ONLY;
  } else if (s.mcp) {
    const j = JSON.parse(s.mcp.text);
    j.mcpServers[BIZ_SERVER] = BIZ_ENTRY;
    s.mcp = { ...s.mcp, text: JSON.stringify(j) };
  } else {
    a.push('--mcp-config', '<mcp-config>');
    s.mcp = BIZ_ONLY;
  }
  return s;
}

let onCache = null;
async function onMatrix() {
  if (!onCache) {
    try {
      onCache = await runMatrix(h, { BMS_TOOL_ENABLED: '1', ...CANARY });
    } finally {
      for (const k of Object.keys(CANARY)) delete process.env[k];
    }
  }
  return onCache;
}

test('11 夹具：来自基线 419d56f，内容钉死（测试从不重新生成）；用例集与 CASES 一致，关时没有任何 biz 痕迹', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE_FILE)).digest('hex');
  assert.equal(sha, FIXTURE_SHA256, '夹具被改过：它只能用基线源码重新生成（见 test/fixtures/biz-off-matrix.mjs 顶部）');
  assert.match(JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'))._source, /419d56f/);
  assert.deepEqual(Object.keys(FIXTURE), Object.keys(PROFILES));
  for (const pname of Object.keys(PROFILES)) assert.deepEqual(Object.keys(FIXTURE[pname]), Object.keys(CASES));
  assert.deepEqual([...ELIGIBLE, ...NEVER].sort(), Object.keys(CASES).sort());
  assert.doesNotMatch(JSON.stringify(FIXTURE), /mcp__biz|biz_get|mcp-biz|\.env\)/);
});

test('11 开关关（未设置 / 0）：三档各 17 个用例与基线夹具逐字一致', async () => {
  for (const v of [undefined, '0']) {
    assert.deepEqual(await runMatrix(h, { BMS_TOOL_ENABLED: v }), FIXTURE, `BMS_TOOL_ENABLED=${v}`);
  }
});

test('11 只有恰好 "1" 才算开：空串 / true / yes / 前后空格 / 01 / on / TRUE / 1.0 都与夹具一致', async () => {
  // env 恰好是 { LARK_CLI: 'true' } 的用例可以共用一个模块实例：owner 私聊（确认 / 附件）、群聊、心跳、访客
  const names = Object.keys(CASES).filter((n) => JSON.stringify(CASES[n].env) === JSON.stringify({ LARK_CLI: 'true' }));
  assert.deepEqual(names, ['ownerP2pConfirm', 'ownerP2pFile', 'ownerGroup', 'heartbeat', 'guest', 'guestFile']);
  for (const v of ['', 'true', 'yes', ' 1', '1 ', '01', 'on', 'TRUE', '1.0']) {
    for (const [pname, profile] of Object.entries(PROFILES)) {
      const m = await h.load({ LARK_CLI: 'true', OWNER_TOOL_PROFILE: profile, BMS_TOOL_ENABLED: v });
      for (const name of names) {
        assert.deepEqual(snapCase(m.buildClaudeArgs(...structuredClone(CASES[name].call)), h.norm), FIXTURE[pname][name],
          `${pname}/${name} BMS_TOOL_ENABLED=${JSON.stringify(v)}`);
      }
    }
  }
});

test('11 开关开：私聊 / 心跳只做加法；群聊（含 owner）、目的地缺失的定时、sched-diag、验收、访客与关时逐字一致；参数与 mcp.json 里没有 Key', async () => {
  const on = await onMatrix();
  for (const pname of Object.keys(PROFILES)) {
    for (const name of ELIGIBLE) assert.deepEqual(on[pname][name], expectOn(pname, name, FIXTURE[pname][name]), `${pname}/${name}`);
    for (const name of NEVER) assert.deepEqual(on[pname][name], FIXTURE[pname][name], `${pname}/${name} 不该有任何变化`);
  }
  assert.doesNotMatch(JSON.stringify(on), /ZZTESTMARK|bms_sk_/);
});

test('11 开关开 + 显式 ALLOWED_TOOLS（生产就是这样配的）：三档私聊照样有 biz_get', async () => {
  const on = await onMatrix();
  for (const pname of Object.keys(PROFILES)) {
    const allowed = flag(on[pname].ownerP2pAllowed.args, '--allowedTools').split(',');
    assert.equal(allowed.at(-1), BIZ_TOOL, pname);
    assert.deepEqual(allowed.slice(0, -1), flag(FIXTURE[pname].ownerP2pAllowed.args, '--allowedTools').split(','), `${pname}：其余与关时一样`);
    // legacy / audit 以 ALLOWED_TOOLS 为准（不并入默认集）；strict 不看 ALLOWED_TOOLS（基线如此）
    assert.equal(allowed.includes('Bash(git status:*)'), pname !== 'strict', pname);
  }
});

test('12 开关开：legacy / audit / strict 对话 / strict 定时与心跳都带 .env 拒读与 security 拒绝；白名单与 mcp.json 里没有 Key、没有 security', async () => {
  assert.deepEqual([...SECURITY_DENY], ['Bash(security:*)', 'Bash(/usr/bin/security:*)']);
  for (const [pname, profile] of Object.entries(PROFILES)) {
    const m = await h.load({ LARK_CLI: 'true', OWNER_TOOL_PROFILE: profile, BMS_TOOL_ENABLED: '1' });
    for (const name of ['ownerP2p', 'ownerP2pConfirm', 'sched', 'schedPlain', 'heartbeat']) {
      const tag = `${pname}/${name}`;
      const r = m.buildClaudeArgs(...callOf(name));
      try {
        const a = r.args;
        assert.equal(count(a, '--allowedTools'), 1, tag);
        assert.equal(count(a, '--disallowedTools'), 1, `${tag}：拒绝表只能有一份（多一份可能顶掉 strict 原有的拒绝表）`);
        assert.equal(count(a, '--mcp-config'), 1, tag);
        assert.ok(flag(a, '--allowedTools').split(',').includes(BIZ_TOOL), tag);
        const deny = flag(a, '--disallowedTools').split(',');
        for (const rule of ['Bash(security:*)', 'Bash(/usr/bin/security:*)']) assert.ok(deny.includes(rule), `${tag}：拒绝表缺 ${rule}`);
        if (profile === 'strict' || name === 'heartbeat') assert.deepEqual(deny.slice(-RAW_DENY.length), RAW_DENY, `${tag}：追加在原拒绝表末尾`);
        else assert.deepEqual(deny, RAW_DENY, tag);
        if (name === 'heartbeat') assert.equal(a[a.indexOf('--strict-mcp-config') + 1], '--mcp-config', tag);
        else assert.equal(a.at(-2), '--mcp-config', `${tag}：--mcp-config 仍是最后两个参数`);
        const text = `${a.filter((x, i) => a[i - 1] !== '--disallowedTools').join('\n')}\n${fs.readFileSync(flag(a, '--mcp-config'), 'utf8')}`;
        assert.doesNotMatch(text, /bms_sk_|acc_[A-Za-z0-9]{8}|find-generic-password|\/usr\/bin\/security|Bash\(security/, tag);
      } finally {
        r.cleanup();
      }
    }
  }
});

test('12 开关开 + ALLOWED_TOOLS=Read,Bash：legacy / audit 私聊白名单里有裸 Bash 时，拒绝表里仍有两条 security 拒绝', async () => {
  for (const profile of [undefined, 'audit']) {
    const m = await h.load({ OWNER_TOOL_PROFILE: profile, BMS_TOOL_ENABLED: '1', ALLOWED_TOOLS: 'Read,Bash' });
    const r = m.buildClaudeArgs('oc_x', true, [], { lane: 'chat', chatType: 'p2p' });
    try {
      const allowed = flag(r.args, '--allowedTools').split(',');
      assert.ok(allowed.includes('Bash') && allowed.includes(BIZ_TOOL), `${profile}：${allowed}`);
      assert.equal(count(r.args, '--disallowedTools'), 1, String(profile));
      const deny = flag(r.args, '--disallowedTools').split(',');
      for (const rule of ['Bash(security:*)', 'Bash(/usr/bin/security:*)']) assert.ok(deny.includes(rule), `${profile}：拒绝表缺 ${rule}`);
    } finally {
      r.cleanup();
    }
  }
});

test('11 定时任务按目的地：发往 owner 私聊才有 biz_get（只做加法）；发往群 / 别的会话、目的地缺失或写法不对都与关时逐字一致', async () => {
  assert.equal(schedDestOf('oc_owner', 'oc_owner'), SCHED_DEST_OWNER_P2P);
  for (const [d, o] of [['oc_group', 'oc_owner'], ['oc_owner', null], ['oc_owner', undefined], [undefined, undefined], ['', ''], [null, null]]) {
    assert.equal(schedDestOf(d, o), 'other', `${d} / ${o}`);
  }
  for (const [pname, profile] of Object.entries(PROFILES)) {
    for (const name of SCHED) {
      const m = await h.load({ ...CASES[name].env, OWNER_TOOL_PROFILE: profile, BMS_TOOL_ENABLED: '1' });
      const snap = (dest) => snapCase(m.buildClaudeArgs(...callOf(name, dest)), h.norm);
      assert.deepEqual(snap(SCHED_DEST_OWNER_P2P), expectOn(pname, name, FIXTURE[pname][name]), `${pname}/${name} 发往 owner 私聊`);
      assert.deepEqual(snap(schedDestOf('oc_group', 'oc_owner')), FIXTURE[pname][name], `${pname}/${name} 发往群`);
      assert.deepEqual(snapCase(m.buildClaudeArgs(...structuredClone(CASES[name].call)), h.norm), FIXTURE[pname][name], `${pname}/${name} 目的地缺失`);
      for (const bad of ['p2p', 'owner', 'OWNER-P2P', true, 1]) {
        assert.deepEqual(snap(bad), FIXTURE[pname][name], `${pname}/${name} schedDest=${JSON.stringify(bad)}`);
      }
    }
  }
  // index.js 接线（源码断言，只证明写法）：owner 私聊的 chat_id 只在 owner 私聊消息里记下；定时把它和目的地交给 schedDestOf
  const src = fs.readFileSync(path.join(REPO, 'src', 'index.js'), 'utf8');
  assert.match(src, /\n {2}if \(isOwner && message\.chat_type === 'p2p'\) ownerDmChatId = message\.chat_id;\n/);
  assert.equal(src.match(/ownerDmChatId =/g).length, 2, '只有声明与上面那一处赋值');
  assert.match(src, /\{ \.\.\.schedOpts, schedDest: schedDestOf\(chatId, ownerDmChatId\) \}/);
  assert.equal(src.match(/schedDest:/g).length, 1, 'schedDest 只在定时那一处传');
});

test('12 任何档、开或关：免询问白名单里没有 Bash(security / Bash(env / Bash(printenv / Bash(ps，也没有裸 Bash', async () => {
  const lists = [];
  for (const matrix of [FIXTURE, await onMatrix()]) {
    for (const p of Object.values(matrix)) {
      for (const s of Object.values(p)) {
        const v = flag(s.args, '--allowedTools');
        if (v !== null) lists.push(v);
      }
    }
  }
  assert.ok(lists.length >= 60, `白名单数量不对：${lists.length}`);
  for (const v of lists) {
    for (const bad of ['Bash(security', 'Bash(env', 'Bash(printenv', 'Bash(ps']) assert.ok(!v.includes(bad), `${bad} 出现在白名单里：${v}`);
    assert.ok(!v.split(',').includes('Bash'), `白名单里有裸 Bash：${v}`);
  }
});

test('12 biz 相关源码都不加载 dotenv；接线模块不读环境变量', () => {
  for (const f of ['src/mcp-biz.js', 'src/biz-targets.js', 'src/biz-wiring.js', 'scripts/biz-check.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPO, f), 'utf8'), /dotenv/, f);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, 'src', 'biz-wiring.js'), 'utf8'), /process\.env/);
});

test('11 开关开：心跳与 FEISHU_TOOLS=false 时另写只含 biz 的临时 mcp.json（0600、env 为空）；cleanup 连目录一起删、可重复调用', async () => {
  const MCP_FILE = path.join(REPO, 'src', 'mcp-biz.js');
  for (const [pname, profile] of Object.entries(PROFILES)) {
    for (const name of ['heartbeat', 'ownerP2pNoFeishu', 'schedNoFeishu', 'ownerP2p', 'sched']) {
      const tag = `${pname}/${name}`;
      const m = await h.load({ ...CASES[name].env, OWNER_TOOL_PROFILE: profile, BMS_TOOL_ENABLED: '1' });
      const r = m.buildClaudeArgs(...callOf(name));
      const file = flag(r.args, '--mcp-config');
      const dir = path.dirname(file);
      try {
        const bizOnly = !['ownerP2p', 'sched'].includes(name);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600, tag);
        assert.ok(path.basename(dir).startsWith(bizOnly ? 'feishu-biz-mcp-' : 'feishu-mcp-'), `${tag}：${dir}`);
        const servers = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers;
        assert.deepEqual(Object.keys(servers), bizOnly ? [BIZ_SERVER] : ['feishu', BIZ_SERVER], tag);
        const biz = servers[BIZ_SERVER];
        assert.deepEqual(Object.keys(biz), ['type', 'command', 'args', 'env'], tag);
        assert.equal(biz.type, 'stdio');
        assert.equal(biz.command, ENV_BIN);
        assert.deepEqual(biz.args.slice(0, -2), BIZ_ENV_STRIP.flatMap((k) => ['-u', k]), `${tag}：先去掉那几个变量`);
        assert.equal(biz.args.at(-2), process.execPath);
        assert.equal(fs.realpathSync(biz.args.at(-1)), MCP_FILE);
        assert.deepEqual(biz.env, {}, `${tag}：biz 条目不带任何 env`);
      } finally {
        r.cleanup();
      }
      assert.equal(fs.existsSync(dir), false, `${tag}：cleanup 后临时目录还在`);
      r.cleanup();
    }
  }
});

test('11 交接（handoff）、未知 toolProfile、带 chatType 的验收档：开关开也什么都不加（未知档默认不给）', async () => {
  const calls = {
    handoff: ['oc_x', true, [], { lane: 'chat', toolProfile: 'handoff', chatType: 'p2p', resumeId: 'sess-handoff' }],
    handoffSched: ['sched:daily.json', true, [], { toolProfile: 'handoff', resumeId: 'sess-handoff' }],
    unknownProfile: ['oc_x', true, [], { lane: 'chat', toolProfile: 'bogus', chatType: 'p2p' }],
    verifierP2p: ['verify:task-1', true, [], { toolProfile: 'verifier', chatType: 'p2p' }],
  };
  for (const [pname, profile] of Object.entries(PROFILES)) {
    const off = await h.load({ OWNER_TOOL_PROFILE: profile });
    const on = await h.load({ OWNER_TOOL_PROFILE: profile, BMS_TOOL_ENABLED: '1' });
    for (const [name, call] of Object.entries(calls)) {
      const got = snapCase(on.buildClaudeArgs(...structuredClone(call)), h.norm);
      assert.deepEqual(got, snapCase(off.buildClaudeArgs(...structuredClone(call)), h.norm), `${pname}/${name}`);
      assert.doesNotMatch(JSON.stringify(got), /mcp__biz|mcp-biz|\.env\)/, `${pname}/${name}`);
    }
  }
});

test('11 createToolTurn：开关开、owner 时把 chatType 带进 runClaude；关或非 owner 时就是基线的那一个', async () => {
  const seen = [];
  const spy = async (...a) => { seen.push(a); return 'ok'; };
  const optsOf = async (t) => {
    seen.length = 0;
    await t.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat' }); // index.js 的调用只带 lane
    assert.equal(seen.length, 1);
    return seen[0][5];
  };
  const turn = (m, o) => m.createToolTurn({ profile: m.OWNER_TOOL_PROFILE, isOwner: true, prompt: 'hi', runClaude: spy, ...o });

  // 开、legacy：基线返回原函数，这里多包一层，只加 chatType
  let m = await h.load({ BMS_TOOL_ENABLED: '1' });
  let t = turn(m, { chatType: 'p2p' });
  assert.deepEqual(await optsOf(t), { lane: 'chat', chatType: 'p2p' });
  assert.equal(t.prompt, 'hi');
  assert.equal(t.withReceipt('ans'), 'ans');
  assert.equal(turn(m, { isOwner: false, chatType: 'p2p' }).runClaude, spy, '非 owner 原样');

  // 开、audit、群聊：基线的工具事件与 confirm 照旧，另带 chatType=group
  m = await h.load({ BMS_TOOL_ENABLED: '1', OWNER_TOOL_PROFILE: 'audit' });
  const o = await optsOf(turn(m, { chatType: 'group' }));
  assert.equal(o.chatType, 'group');
  assert.equal(typeof o.onToolEvent, 'function');
  assert.equal(o.confirm, false);

  // 关：legacy 下就是原函数；audit 下是基线包装，不带 chatType
  m = await h.load({});
  assert.equal(turn(m, { chatType: 'p2p' }).runClaude, spy);
  m = await h.load({ OWNER_TOOL_PROFILE: 'audit' });
  const off = await optsOf(turn(m, { chatType: 'p2p' }));
  assert.equal('chatType' in off, false);
  assert.equal(typeof off.onToolEvent, 'function');

  // 串起来：同 index.js 的调用形状，私聊有 biz_get、群聊没有
  for (const [pname, profile] of Object.entries(PROFILES)) {
    m = await h.load({ BMS_TOOL_ENABLED: '1', OWNER_TOOL_PROFILE: profile });
    for (const [chatType, want] of [['p2p', true], ['group', false]]) {
      const tt = m.createToolTurn({
        profile: m.OWNER_TOOL_PROFILE, isOwner: true, chatType, prompt: 'hi',
        runClaude: async (chatId, p, owner, extra, onProgress, opts) => m.buildClaudeArgs(chatId, owner, extra, opts),
      });
      const r = await tt.runClaude('oc_x', 'hi', true, [], null, { lane: 'chat' });
      try {
        assert.equal(flag(r.args, '--allowedTools').split(',').includes(BIZ_TOOL), want, `${pname}/${chatType}`);
        assert.equal(r.args.join('\n').includes('.env)'), want, `${pname}/${chatType}：.env 拒读跟着工具走`);
      } finally {
        r.cleanup();
      }
    }
  }
});

test('13 审计名：safeToolName 原样保留 mcp__biz__biz_get，别的 biz 名字不认', () => {
  assert.equal(BIZ_TOOL, 'mcp__biz__biz_get');
  assert.equal(safeToolName(BIZ_TOOL), BIZ_TOOL);
  const other = safeToolName(42);
  for (const n of ['mcp__biz__biz_post', 'mcp__biz__bms_get', 'mcp__biz']) assert.equal(safeToolName(n), other, n);
});

// 放在最后：runClaude 会往 store 里记会话（这里用单独的 chatId，免得影响上面的快照）
test('11 技能同步：开关开时三档都装上 biz-readonly（legacy 直拷，audit/strict 过白名单重建），同名工作区技能被替换但 workspace/skills 不被写；关时与基线一样', async () => {
  const srcMd = fs.readFileSync(path.join(REPO, 'docs', 'skills', BIZ_SKILL, 'SKILL.md'), 'utf8');
  const userDir = path.join(h.p.ws, 'skills', BIZ_SKILL);
  const userMd = '---\nname: biz-readonly\ndescription: 工作区里同名的自写技能\n---\n用户自己写的\n';
  const installed = path.join(h.p.ws, '.claude', 'skills', BIZ_SKILL, 'SKILL.md');
  for (const [pname, profile] of Object.entries(PROFILES)) {
    for (const seeded of [false, true]) {
      for (const on of [true, false]) {
        const tag = `${pname} seeded=${seeded} on=${on}`;
        for (const d of ['.claude', '.claude-quarantine', '.claude-staging', 'skills']) {
          fs.rmSync(path.join(h.p.ws, d), { recursive: true, force: true });
        }
        if (seeded) {
          fs.mkdirSync(userDir, { recursive: true });
          fs.writeFileSync(path.join(userDir, 'SKILL.md'), userMd);
        }
        const m = await h.load({ OWNER_TOOL_PROFILE: profile, BMS_TOOL_ENABLED: on ? '1' : undefined });
        const logs = [];
        const orig = { e: console.error, l: console.log };
        console.error = (...a) => logs.push(a.map(String).join(' '));
        console.log = (...a) => logs.push(a.map(String).join(' '));
        try {
          await m.runClaude('oc_skill', 'hi', true, [], null, { lane: 'chat', chatType: 'p2p' });
        } finally {
          console.error = orig.e;
          console.log = orig.l;
        }
        assert.ok(!logs.some((l) => l.includes(`同步技能 ${BIZ_SKILL} 出错`)), `${tag}：${logs.join(' | ')}`);
        if (on) assert.equal(fs.readFileSync(installed, 'utf8'), srcMd, tag);
        else if (seeded) assert.equal(fs.readFileSync(installed, 'utf8'), userMd, `${tag}：关时照基线同步工作区技能`);
        else assert.equal(fs.existsSync(path.dirname(installed)), false, tag);
        if (seeded) {
          assert.deepEqual(fs.readdirSync(userDir), ['SKILL.md'], tag);
          assert.equal(fs.readFileSync(path.join(userDir, 'SKILL.md'), 'utf8'), userMd, `${tag}：workspace/skills 不被写`);
        } else {
          // workspace/skills 本身由 ensureOwnerWorkspace 在加载时建好（基线），这里只看 biz-readonly 有没有被写进去
          assert.equal(fs.existsSync(userDir), false, `${tag}：不往 workspace/skills 写`);
        }
      }
    }
  }
});
