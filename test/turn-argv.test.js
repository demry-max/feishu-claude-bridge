// BRIDGE-PRIV-1 T2 / T7：buildClaudeArgs 按 turn 的 argv。
// T2  仓主在群里 / 发往群或别处的定时 / 发往别处的自诊断：采用访客的工作区、工具白名单和 MCP 边界。
//     仓主私聊 / 心跳 / 发往仓主私聊的定时：开关开时在基线夹具上追加 HOME 密钥拒绝规则。
// T7  带工具的 argv 必须包含一份密钥拒绝规则。零工具 argv 与基线夹具逐字相同。
// 全程假 claude CLI、不碰钥匙串、不联网。夹具只读，从不重新生成。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, PROFILES, makeHarness, runMatrix, snapCase } from './fixtures/biz-off-matrix.mjs';
import { ON_NAMES, onCallOf, runOnMatrix } from './fixtures/biz-on-matrix.mjs';
import { resolveTurn } from '../src/turn-context.js';
import { SCHED_DEST_OWNER_P2P } from '../src/biz-wiring.js';
import { stripSnap, hasSecretsDeny, secretsDenyOf, disallowedOf, homeSecretsDeny, SECRETS_DENY_COUNT } from './helpers/strip-secrets-deny.js';

const REPO = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const OFF = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'owner-args-biz-off-419d56f.json'), 'utf8')).profiles;
const ON = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'owner-args-biz-on-3c2d3ae.json'), 'utf8')).profiles;

const h = makeHarness(REPO, 'turn-argv-');
after(() => fs.rmSync(h.p.tmp, { recursive: true, force: true }));

const flag = (args, f) => {
  const i = args.indexOf(f);
  return i < 0 ? null : args[i + 1];
};
const isZeroTool = (args) => flag(args, '--tools') === '';
const withoutPrompt = (args) => {
  const a = [...args];
  const i = a.indexOf('--append-system-prompt');
  return { args: i < 0 ? a : [...a.slice(0, i), ...a.slice(i + 2)], prompt: i < 0 ? null : a[i + 1] };
};

// BRIDGE-SEC-2 停卡授权：分别检查工具放行与配置目录拒读。
function assertNoLarkCliGrant(args, label) {
  for (const [i, arg] of args.entries()) {
    const option = args[i - 1];
    if (option === '--tools' || option === '--allowedTools') {
      assert.ok(!arg.includes('lark-cli'), `${label}：${option} 不得放行 lark-cli`);
    }
    if (option === '--disallowedTools') {
      for (const rule of arg.split(',').filter((r) => r.includes('lark-cli'))) {
        assert.match(rule, /^Read\([^)]+\)$/, `${label}：lark-cli 相关拒绝项必须使用 Read(…)`);
      }
    } else {
      assert.ok(!arg.includes('Bash(lark-cli'), `${label}：拒绝表之外不得出现 Bash(lark-cli`);
    }
  }
}

const GUEST_ENV = { LARK_CLI: 'true' };
const SWITCH = [['关', undefined], ['开', '1']];

/** 一个 claude.js 实例在某档、某开关下的「访客基准」与待测调用。 */
async function loadFor(profile, bms, env = {}) {
  return h.load({ ...GUEST_ENV, ...env, OWNER_TOOL_PROFILE: profile, BMS_TOOL_ENABLED: bms });
}
const snapOf = (m, call) => snapCase(m.buildClaudeArgs(...structuredClone(call)), h.norm);

// 三类非私密调用：每类给「旧式调用」（只靠 opts）与「显式 turn」两种写法，两者必须同形
const OWNER_GROUP_LEGACY = ['oc_group1', true, [], { lane: 'chat', chatType: 'group' }];
const ownerGroupTurn = (profile, bizOn) => resolveTurn({ source: 'chat', isOwner: true, chatType: 'group', chatId: 'oc_group1', senderOpenId: 'ou_owner', profile, bizOn });
const schedOtherTurn = (profile, bizOn, o = {}) => resolveTurn({
  source: 'sched', isOwner: true, chatId: 'sched:daily.json', schedDest: 'other', ownerDmKnown: true, profile, bizOn, ...o,
});
const diagOtherTurn = (profile, bizOn, o = {}) => resolveTurn({
  source: 'sched-diag', isOwner: true, chatId: 'sched-diag:daily.json', schedDest: 'other', ownerDmKnown: true, profile, bizOn, ...o,
});

test('T2-1 仓主私聊 / 心跳 / 发往私聊的定时：开关开时 argv 等于基线夹具加 HOME 拒读（legacy / audit / strict）', async () => {
  const got = await runOnMatrix(h);
  assert.deepEqual(Object.keys(got), Object.keys(ON));
  for (const pname of Object.keys(PROFILES)) {
    assert.deepEqual(Object.keys(got[pname]), ON_NAMES, pname);
    for (const name of ON_NAMES) {
      const expected = structuredClone(ON[pname][name]);
      const i = expected.args.indexOf('--disallowedTools');
      expected.args[i + 1] = [expected.args[i + 1], ...homeSecretsDeny('/<home>')].join(',');
      assert.deepEqual(got[pname][name], expected, `${pname}/${name}`);
    }
  }
  // 心跳的密钥拒绝规则只一份，owner 私聊有 biz_get。
  for (const pname of Object.keys(PROFILES)) {
    assert.ok(hasSecretsDeny(got[pname].heartbeat.args), `${pname}/heartbeat`);
    assert.ok(ON[pname].ownerP2p.args.some((a) => a.includes('mcp__biz__biz_get')), pname);
  }
});

for (const [label, bms] of SWITCH) {
  for (const [pname, profile] of Object.entries(PROFILES)) {
    test(`T2-2 仓主在群里（旧式调用 与 显式 turn）：访客形状 + 密钥拒绝规则 + 群聊说明（${pname} / 开关${label}）`, async () => {
      const m = await loadFor(profile, bms);
      const guest = snapOf(m, ['guest:oc_group1:ou_owner', false, [], {}]);
      const viaOpts = snapOf(m, OWNER_GROUP_LEGACY);
      const viaTurn = snapOf(m, ['oc_group1', true, [], { lane: 'chat', turn: ownerGroupTurn(profile, bms === '1') }]);
      assert.deepEqual(viaTurn, viaOpts, '显式 turn 与旧式调用同形');
      const g = withoutPrompt(guest.args);
      const o = withoutPrompt(viaOpts.args);
      assert.deepEqual(o.args, g.args, '除提示词外与访客 argv 逐项相同');
      assert.equal(viaOpts.cwd, guest.cwd);
      assert.equal(flag(viaOpts.args, '--tools'), 'WebSearch');
      assert.ok(!viaOpts.args.includes('--mcp-config') && viaOpts.mcp === null, '不挂任何 MCP');
      assert.ok(viaOpts.args.includes('--strict-mcp-config'));
      assert.equal(flag(viaOpts.args, '--setting-sources'), '');
      assertNoLarkCliGrant(viaOpts.args, '群聊'); // BRIDGE-SEC-2 停卡授权
      assert.ok(!viaOpts.args.join(' ').includes('mcp__'), '无飞书 / biz 工具');
      assert.ok(hasSecretsDeny(viaOpts.args), '密钥拒绝规则齐全');
      assert.ok(o.prompt.startsWith(g.prompt));
      assert.match(o.prompt.slice(g.prompt.length), /^\n- 本轮发言的是机器人的主人，但这里是群聊：按访客权限运行/);
      assert.ok(!/memory|记忆索引|outbox/.test(g.prompt.replace('私密记忆', '')), '访客提示词不讲 outbox / 记忆索引');
    });

    test(`T2-3 发往群 / 别处 / 目的地不明的定时：访客形状 + 密钥拒绝规则 + 一行说明（${pname} / 开关${label}）`, async () => {
      const m = await loadFor(profile, bms);
      const guest = snapOf(m, ['guest:oc_group1:ou_x', false, [], {}]);
      const g = withoutPrompt(guest.args);
      const bizOn = bms === '1';
      const variants = {
        other: schedOtherTurn(profile, bizOn),
        '目的地缺失': schedOtherTurn(profile, bizOn, { schedDest: undefined }),
        '格式不对': schedOtherTurn(profile, bizOn, { schedDest: 'bad' }),
        '私聊 id 未知': schedOtherTurn(profile, bizOn, { schedDest: 'other', ownerDmKnown: false }),
      };
      for (const [tag, turn] of Object.entries(variants)) {
        const s = snapOf(m, ['sched:daily.json', true, [], { toolProfile: 'sched', turn }]);
        const o = withoutPrompt(s.args);
        assert.equal(turn.kind, 'sched-other', tag);
        assert.deepEqual(o.args, g.args, `${tag}：除提示词外与访客 argv 相同`);
        assert.equal(s.cwd, guest.cwd, tag);
        assert.equal(flag(s.args, '--tools'), 'WebSearch', tag);
        assert.ok(s.mcp === null && !s.args.includes('--mcp-config'), tag);
        assert.ok(hasSecretsDeny(s.args), tag);
        assertNoLarkCliGrant(s.args, tag); // BRIDGE-SEC-2 停卡授权
        assert.ok(!s.args.join(' ').includes('mcp__'), tag);
        assert.ok(o.prompt.startsWith(g.prompt), tag);
        assert.match(
          o.prompt.slice(g.prompt.length),
          turn.destUnknown === true ? /^\n- 本轮是定时任务；桥接暂时不知道主人的私聊会话/ : /^\n- 本轮是定时任务，结果会发往群或别的会话/,
          tag,
        );
      }
      // 旧式调用（opts.schedDest 显式写 other）同形
      const legacy = snapOf(m, ['sched:daily.json', true, [], { toolProfile: 'sched', schedDest: 'other' }]);
      assert.deepEqual(legacy, snapOf(m, ['sched:daily.json', true, [], { toolProfile: 'sched', turn: variants.other }]));
    });

    test(`T2-4 发往别处的自诊断：零工具、访客工作区、不挂 MCP；发往私聊的自诊断与基线同工作区（${pname} / 开关${label}）`, async () => {
      const m = await loadFor(profile, bms);
      const bizOn = bms === '1';
      const other = snapOf(m, ['sched-diag:daily.json', true, [], { model: 'claude-test-diag', effort: 'low', turn: diagOtherTurn(profile, bizOn) }]);
      assert.equal(flag(other.args, '--tools'), '', '零工具');
      assert.equal(other.cwd, snapOf(m, ['guest:oc_g:ou_x', false, [], {}]).cwd, '访客工作区');
      assert.ok(other.mcp === null && !other.args.includes('--mcp-config') && !other.args.includes('--allowedTools'));
      assert.ok(other.args.includes('--strict-mcp-config'));
      assert.equal(secretsDenyOf(other.args).length, 0, '零工具档的拒绝表与基线一致');
      assert.match(flag(other.args, '--append-system-prompt'), /结果会发往群或别的会话/);
      // 旧式调用（opts.schedDest 显式写 other）同形
      const legacy = snapOf(m, ['sched-diag:daily.json', true, [], { model: 'claude-test-diag', effort: 'low', schedDest: 'other' }]);
      assert.deepEqual(legacy, other);
      // 发往私聊：不带「别处」那行、工作区仍是 owner 的
      const dm = snapOf(m, ['sched-diag:daily.json', true, [], { model: 'claude-test-diag', effort: 'low', schedDest: SCHED_DEST_OWNER_P2P }]);
      assert.notEqual(dm.cwd, other.cwd);
      assert.ok(!/结果会发往群或别的会话/.test(flag(dm.args, '--append-system-prompt')));
      // 与私聊那份相比，除工作区与那一行外逐项相同（零工具这一档本身没变）
      const a = withoutPrompt(other.args);
      const b = withoutPrompt(dm.args);
      if (isZeroTool(dm.args)) assert.deepEqual(a.args, b.args);
    });
  }
}

// ---- T7：不变量 ----
const CASE_NAMES = Object.keys(CASES);
const EXTRA = {
  // 新增的非私密形态（CASES 里没有）：显式 turn 的三种
  ownerGroupTurn: (p, b) => ['oc_group1', true, [], { lane: 'chat', turn: ownerGroupTurn(p, b) }],
  schedOtherTurn: (p, b) => ['sched:daily.json', true, [], { toolProfile: 'sched', turn: schedOtherTurn(p, b) }],
  diagOtherTurn: (p, b) => ['sched-diag:daily.json', true, [], { model: 'claude-test-diag', effort: 'low', turn: diagOtherTurn(p, b) }],
};

async function allArgv(bms) {
  const out = [];
  for (const [pname, profile] of Object.entries(PROFILES)) {
    for (const name of CASE_NAMES) {
      const m = await h.load({ ...CASES[name].env, OWNER_TOOL_PROFILE: profile, BMS_TOOL_ENABLED: bms });
      const call = bms === '1' && ON_NAMES.includes(name) ? onCallOf(name) : structuredClone(CASES[name].call);
      out.push({ pname, name, base: true, snap: snapCase(m.buildClaudeArgs(...call), h.norm) });
    }
    const m = await h.load({ ...GUEST_ENV, OWNER_TOOL_PROFILE: profile, BMS_TOOL_ENABLED: bms });
    for (const [name, mk] of Object.entries(EXTRA)) out.push({ pname, name, base: false, snap: snapCase(m.buildClaudeArgs(...mk(profile, bms === '1')), h.norm) });
  }
  return out;
}

for (const [label, bms] of SWITCH) {
  test(`T7 不变量（开关${label}）：带工具的 argv 只带一份密钥拒绝规则，零工具 argv 与基线夹具逐字相同`, async () => {
    const rows = await allArgv(bms);
    assert.equal(rows.length, 3 * (CASE_NAMES.length + Object.keys(EXTRA).length));
    let withTools = 0;
    let zero = 0;
    for (const { pname, name, base, snap } of rows) {
      const tag = `${pname}/${name}`;
      if (isZeroTool(snap.args)) {
        zero += 1;
        assert.equal(secretsDenyOf(snap.args).length, 0, `${tag}：零工具档与基线一致`);
        // 基线里本来就是零工具的用例：argv 与夹具逐字相同（不经任何剥离）
        if (base) {
          assert.deepEqual(snap, OFF[pname][name], `${tag}：零工具 argv 与基线夹具相同`);
        }
      } else {
        withTools += 1;
        assert.ok(hasSecretsDeny(snap.args), `${tag}：带工具的 argv 必须带齐密钥拒绝规则`);
        assert.equal(disallowedOf(snap.args).filter((r) => secretsDenyOf(snap.args).includes(r)).length, SECRETS_DENY_COUNT, `${tag}：不重复`);
      }
    }
    assert.ok(withTools >= 30 && zero >= 6, `两类都要有（${withTools}/${zero}），防止不变量空转`);
  });
}

test('T7 关时「有工具」的 argv 拿掉密钥拒绝规则后与基线夹具逐字相同（旧夹具没有空转）', async () => {
  const m = await runMatrix(h);
  let checked = 0;
  for (const pname of Object.keys(PROFILES)) {
    for (const name of CASE_NAMES) {
      if (name === 'ownerGroup') continue; // 群里的仓主改按访客形状，见 T2-2
      const snap = m[pname][name];
      if (isZeroTool(snap.args)) assert.deepEqual(snap, OFF[pname][name], `${pname}/${name}`);
      else { assert.ok(hasSecretsDeny(snap.args), `${pname}/${name}`); assert.deepEqual(stripSnap(snap), OFF[pname][name], `${pname}/${name}`); checked += 1; }
    }
  }
  assert.ok(checked >= 30);
});
