// BRIDGE-PRIV-1 T1：turn-context 表驱动 + 不变量。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTurn, turnFromLegacyCall, guestSessionKey, TURN_KINDS, PRIVATE_KINDS,
} from '../src/turn-context.js';
import { schedDestOf, SCHED_DEST_OWNER_P2P } from '../src/biz-wiring.js';

const DM = 'oc_ownerdm00000000000';
const GROUP = 'oc_group0000000000000';
const OWNER = 'ou_owner';
const PROFILES = ['legacy', 'audit', 'strict'];

test('T1-1 resolveTurn 返回冻结对象且字段齐全', () => {
  const t = resolveTurn({ source: 'chat', isOwner: true, chatType: 'p2p', chatId: DM, senderOpenId: OWNER });
  assert.ok(Object.isFrozen(t));
  for (const k of ['kind', 'isOwner', 'private', 'workspace', 'toolSet', 'biz', 'confirm', 'receipt', 'recall',
    'memoryNudge', 'sessionKey', 'speakerIsOwner', 'destUnknown']) assert.ok(k in t, k);
});

test('T1-2 对话：身份 × chatType × 档 × 开关 表', () => {
  for (const profile of PROFILES) for (const bizOn of [false, true]) {
    const base = { source: 'chat', profile, bizOn, chatId: GROUP, senderOpenId: OWNER };
    const dm = resolveTurn({ ...base, isOwner: true, chatType: 'p2p', chatId: DM });
    assert.equal(dm.kind, 'owner-dm');
    assert.equal(dm.private, true);
    assert.equal(dm.workspace, 'owner');
    assert.equal(dm.toolSet, 'owner');
    assert.equal(dm.biz, bizOn);
    assert.equal(dm.recall, true);
    assert.equal(dm.memoryNudge, true);
    assert.equal(dm.confirm, true);
    assert.equal(dm.receipt, profile !== 'legacy');
    assert.equal(dm.sessionKey, DM, '私聊键不变');
    for (const chatType of ['group', 'topic_group', undefined, null, '']) {
      const g = resolveTurn({ ...base, isOwner: true, chatType });
      assert.equal(g.kind, 'owner-group', `chatType=${String(chatType)}`);
      assert.equal(g.isOwner, true, '身份仍是仓主（只用于命令权限）');
      assert.equal(g.private, false);
      assert.equal(g.workspace, 'guest');
      assert.equal(g.toolSet, 'guest');
      assert.equal(g.biz, false);
      assert.equal(g.recall, false);
      assert.equal(g.memoryNudge, false);
      assert.equal(g.confirm, false);
      assert.equal(g.receipt, false);
      assert.equal(g.speakerIsOwner, true);
      assert.equal(g.sessionKey, `guest:${GROUP}:${OWNER}`);
    }
    for (const chatType of ['p2p', 'group']) {
      const gu = resolveTurn({ ...base, isOwner: false, chatType });
      assert.equal(gu.kind, 'guest');
      assert.equal(gu.private, false);
      assert.equal(gu.workspace, 'guest');
      assert.equal(gu.toolSet, 'guest');
      assert.equal(gu.biz, false);
      assert.equal(gu.speakerIsOwner, false);
      assert.equal(gu.sessionKey, guestSessionKey(GROUP, OWNER));
    }
  }
});

test('T1-3 定时 / 自诊断：目的地决定档位，目的地不明按非私密', () => {
  const cases = [
    { name: 'DM', dest: schedDestOf(DM, DM), known: true, other: false, unknown: false },
    { name: 'group', dest: schedDestOf(GROUP, DM), known: true, other: true, unknown: false },
    { name: 'owner DM 未知', dest: schedDestOf(DM, ''), known: false, other: true, unknown: true },
    { name: 'owner DM 未知(undefined)', dest: schedDestOf(DM, undefined), known: false, other: true, unknown: true },
    { name: 'chat_id 缺失', dest: schedDestOf(undefined, DM), known: true, other: true, unknown: false },
    { name: '格式怪异的 dest', dest: 'owner-p2p ', known: true, other: true, unknown: true },
    { name: 'dest 缺失', dest: undefined, known: true, other: true, unknown: true },
  ];
  for (const profile of PROFILES) for (const bizOn of [false, true]) for (const c of cases) {
    const sched = resolveTurn({ source: 'sched', isOwner: true, schedDest: c.dest, ownerDmKnown: c.known, profile, bizOn, chatId: 'sched:a.md' });
    const diag = resolveTurn({ source: 'sched-diag', isOwner: true, schedDest: c.dest, ownerDmKnown: c.known, profile, bizOn, chatId: 'sched-diag:a.md' });
    const tag = `${c.name}/${profile}/${bizOn}`;
    if (!c.other) {
      assert.equal(sched.kind, 'sched-owner-dm', tag);
      assert.equal(sched.private, true, tag);
      assert.equal(sched.toolSet, 'owner', tag);
      assert.equal(sched.workspace, 'owner', tag);
      assert.equal(sched.biz, bizOn, tag);
      assert.equal(diag.kind, 'sched-diag-owner-dm', tag);
      assert.equal(diag.private, true, tag);
      assert.equal(diag.toolSet, profile === 'legacy' ? 'owner' : 'sched-diag', tag);
    } else {
      assert.equal(sched.kind, 'sched-other', tag);
      assert.equal(sched.private, false, tag);
      assert.equal(sched.workspace, 'guest', tag);
      assert.equal(sched.toolSet, 'guest', tag);
      assert.equal(sched.biz, false, tag);
      assert.equal(sched.destUnknown, c.unknown, tag);
      assert.equal(diag.kind, 'sched-diag-other', tag);
      assert.equal(diag.private, false, tag);
      assert.equal(diag.workspace, 'guest', tag);
      assert.equal(diag.toolSet, 'sched-diag', tag);
      assert.equal(diag.destUnknown, c.unknown, tag);
    }
    assert.equal(sched.recall, false, tag);
    assert.equal(sched.confirm, false, tag);
  }
});

test('T1-4 心跳 / 交接 / 验收 与非仓主', () => {
  for (const profile of PROFILES) for (const bizOn of [false, true]) {
    const hb = resolveTurn({ source: 'heartbeat', isOwner: true, profile, bizOn, chatId: 'heartbeat' });
    assert.equal(hb.kind, 'heartbeat'); assert.equal(hb.private, true); assert.equal(hb.toolSet, 'heartbeat'); assert.equal(hb.biz, bizOn);
    const ho = resolveTurn({ source: 'handoff', isOwner: true, profile, bizOn, chatId: 'daily:x' });
    assert.equal(ho.kind, 'handoff'); assert.equal(ho.private, true); assert.equal(ho.toolSet, 'handoff'); assert.equal(ho.biz, false);
    const vf = resolveTurn({ source: 'verifier', isOwner: true, profile, bizOn, chatId: 'verify' });
    assert.equal(vf.kind, 'verifier'); assert.equal(vf.private, false); assert.equal(vf.workspace, 'tmp'); assert.equal(vf.toolSet, 'verifier'); assert.equal(vf.biz, false);
    // 非仓主不管带什么来源，都按访客
    for (const source of ['chat', 'heartbeat', 'sched', 'sched-diag', 'handoff', 'verifier']) {
      const g = resolveTurn({ source, isOwner: false, profile, bizOn, schedDest: SCHED_DEST_OWNER_P2P, chatId: 'x' });
      assert.equal(g.kind, 'guest', source);
      assert.equal(g.private, false, source);
      assert.equal(g.toolSet, 'guest', source);
    }
  }
});

test('T1-5 不变量：private===true 只可能是五类；全表扫描', () => {
  const seen = new Set();
  const sources = ['chat', 'heartbeat', 'sched', 'sched-diag', 'handoff', 'verifier'];
  for (const source of sources) for (const isOwner of [true, false])
    for (const chatType of ['p2p', 'group', undefined])
      for (const schedDest of [SCHED_DEST_OWNER_P2P, 'other', undefined])
        for (const ownerDmKnown of [true, false, undefined])
          for (const profile of PROFILES) for (const bizOn of [false, true]) {
            const t = resolveTurn({ source, isOwner, chatType, schedDest, ownerDmKnown, profile, bizOn, chatId: 'c', senderOpenId: 'ou_x' });
            seen.add(t.kind);
            assert.ok(TURN_KINDS.includes(t.kind), t.kind);
            assert.equal(t.private, PRIVATE_KINDS.includes(t.kind), `${t.kind} private 标志`);
            if (!t.private) {
              assert.notEqual(t.workspace, 'owner', `${t.kind} 非私密不能用 owner 工作区`);
              assert.equal(t.recall, false); assert.equal(t.memoryNudge, false);
              assert.equal(t.biz, false, `${t.kind} 非私密不挂 biz`);
            }
            if (t.toolSet === 'owner') assert.equal(t.private, true);
            if (!isOwner) assert.equal(t.kind, 'guest');
          }
  assert.deepEqual([...seen].sort(), [...TURN_KINDS].sort(), '每一种 kind 都被覆盖到');
});

test('T1-6 turnFromLegacyCall 保持原口径，仅两处收紧', () => {
  const env = { profile: 'legacy', bizOn: true };
  // 非仓主
  assert.equal(turnFromLegacyCall('guest:c:ou_x', false, {}, env).kind, 'guest');
  // 私聊式（没带 chatType）：owner 档，biz 不挂
  const bare = turnFromLegacyCall(DM, true, {}, env);
  assert.equal(bare.kind, 'owner-dm'); assert.equal(bare.biz, false);
  // 显式 p2p：biz 挂
  assert.equal(turnFromLegacyCall(DM, true, { chatType: 'p2p' }, env).biz, true);
  assert.equal(turnFromLegacyCall(DM, true, { chatType: 'p2p' }, { profile: 'legacy', bizOn: false }).biz, false);
  // 收紧一：显式非 p2p
  const grp = turnFromLegacyCall(GROUP, true, { chatType: 'group' }, env);
  assert.equal(grp.kind, 'owner-group'); assert.equal(grp.private, false); assert.equal(grp.biz, false);
  // 其他 toolProfile：不挂 biz
  assert.equal(turnFromLegacyCall(DM, true, { chatType: 'p2p', toolProfile: 'other' }, env).biz, false);
  // 心跳 / 交接 / 验收
  assert.equal(turnFromLegacyCall('heartbeat', true, { toolProfile: 'heartbeat' }, env).kind, 'heartbeat');
  assert.equal(turnFromLegacyCall('heartbeat', true, { toolProfile: 'heartbeat' }, env).biz, true);
  assert.equal(turnFromLegacyCall('heartbeat', true, { toolProfile: 'heartbeat' }, { profile: 'legacy', bizOn: false }).biz, false);
  assert.equal(turnFromLegacyCall('daily:x', true, { toolProfile: 'handoff' }, env).kind, 'handoff');
  assert.equal(turnFromLegacyCall('v', true, { toolProfile: 'verifier' }, env).kind, 'verifier');
  // 定时：没带 schedDest → 保持 owner 档、biz 不挂
  const s0 = turnFromLegacyCall('sched:a.md', true, { toolProfile: 'sched' }, env);
  assert.equal(s0.kind, 'sched-owner-dm'); assert.equal(s0.biz, false);
  assert.equal(turnFromLegacyCall('sched:a.md', true, {}, env).kind, 'sched-owner-dm', '只靠前缀');
  // 显式 owner-p2p：biz 挂；显式 other：收紧二
  assert.equal(turnFromLegacyCall('sched:a.md', true, { toolProfile: 'sched', schedDest: 'owner-p2p' }, env).biz, true);
  const so = turnFromLegacyCall('sched:a.md', true, { toolProfile: 'sched', schedDest: 'other' }, env);
  assert.equal(so.kind, 'sched-other'); assert.equal(so.private, false);
  // 自诊断
  assert.equal(turnFromLegacyCall('sched-diag:a.md', true, {}, env).kind, 'sched-diag-owner-dm');
  assert.equal(turnFromLegacyCall('sched-diag:a.md', true, { schedDest: 'other' }, env).kind, 'sched-diag-other');
});

test('T1-7 sched 与 schedDestOf 同源：本模块不自己判定目的地', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/turn-context.js', import.meta.url), 'utf8');
  assert.equal((src.match(/schedDestOf/g) ?? []).length <= 1, true, '至多在注释里提到');
  assert.doesNotMatch(src, /process\.env/, '纯函数：不读环境变量');
});
