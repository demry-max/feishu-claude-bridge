// BRIDGE-PRIV-2：LOW-1 turnOf 守卫的行为断言；LOW-4 目的地未知时的两条提示词。
// 与 turn-argv.test.js 同一套假 claude CLI 夹具：只看 buildClaudeArgs 的 argv，不起进程、不联网、不碰钥匙串。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES, makeHarness, snapCase } from './fixtures/biz-off-matrix.mjs';
import { resolveTurn } from '../src/turn-context.js';
import { SCHED_DEST_OWNER_P2P } from '../src/biz-wiring.js';

const REPO = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const h = makeHarness(REPO, 'priv2-prompts-');
after(() => fs.rmSync(h.p.tmp, { recursive: true, force: true }));

const snapOf = (m, call) => snapCase(m.buildClaudeArgs(...structuredClone(call)), h.norm);
const flag = (args, f) => { const i = args.indexOf(f); return i < 0 ? null : args[i + 1]; };
const promptOf = (args) => flag(args, '--append-system-prompt');
const dmTurn = (profile) => resolveTurn({ source: 'chat', isOwner: true, chatType: 'p2p', chatId: 'oc_ownerdm', senderOpenId: 'ou_owner', profile, bizOn: false });
const schedTurn = (profile, o = {}) => resolveTurn({ source: 'sched', isOwner: true, chatId: 'sched:daily.json', schedDest: 'other', ownerDmKnown: true, profile, bizOn: false, ...o });
const diagTurn = (profile, o = {}) => resolveTurn({ source: 'sched-diag', isOwner: true, chatId: 'sched-diag:daily.json', schedDest: 'other', ownerDmKnown: true, profile, bizOn: false, ...o });

for (const [pname, profile] of Object.entries(PROFILES)) {
  test(`L1 turnOf 守卫：第 3 参不是严格 true 时，带 private:true 的 turn 不被采信，argv 与访客逐项相同（${pname}）`, async () => {
    const m = await h.load({ LARK_CLI: 'true', OWNER_TOOL_PROFILE: profile });
    const turn = dmTurn(profile);
    assert.equal(turn.private, true, '前提：这是一个私密档的 turn');
    const key = 'guest:oc_g:ou_x';
    const guest = snapOf(m, [key, false, [], {}]);
    const owner = snapOf(m, [key, true, [], { turn }]);
    assert.notDeepEqual(owner, guest, '对照：isOwner 严格为 true 时，turn 被采信，argv 是 owner 形状');
    assert.equal(guest.mcp, null);
    for (const bad of [false, undefined, 0, 1, 'true', null, 'yes']) {
      const got = snapOf(m, [key, bad, [], { turn }]);
      assert.deepEqual(got, guest, `isOwner=${JSON.stringify(bad)}：不得因 turn.private 而得到 owner 形状`);
    }
  });
}

const OTHER = '- 本轮是定时任务，结果会发往群或别的会话（不是主人的私聊）：没有私密记忆、没有主人专属工具，只依据任务文字与联网检索作答。';
const UNKNOWN = '- 本轮是定时任务；桥接暂时不知道主人的私聊会话，认不出结果是否发往主人私聊，所以按非私密档运行：没有私密记忆、没有主人专属工具，只依据任务文字与联网检索作答。';
const D_OTHER = '- 失败任务的结果会发往群或别的会话（不是主人的私聊）：本轮不带私密记忆，只按上面给出的文字判断。';
const D_UNKNOWN = '- 桥接暂时不知道主人的私聊会话，认不出失败任务的结果是否发往主人私聊，所以本轮按非私密档运行、不带私密记忆，只按上面给出的文字判断。';

for (const [pname, profile] of Object.entries(PROFILES)) {
  test(`L2 目的地提示词：已知别处 / 私聊 id 未知 / 目的地缺失，定时与自诊断各自一行（${pname}）`, async () => {
    const m = await h.load({ LARK_CLI: 'true', OWNER_TOOL_PROFILE: profile });
    const sched = (turn) => promptOf(snapOf(m, ['sched:daily.json', true, [], { toolProfile: 'sched', turn }]).args);
    const diag = (turn) => promptOf(snapOf(m, ['sched-diag:daily.json', true, [], { model: 'claude-test-diag', effort: 'low', turn }]).args);

    // 已知是别的会话：原话
    const known = sched(schedTurn(profile));
    assert.ok(known.includes(OTHER));
    assert.ok(!known.includes('桥接暂时不知道'));
    // 私聊 id 未知 / 目的地缺失：不再断言「不是主人的私聊」
    for (const [tag, o] of [['私聊 id 未知', { ownerDmKnown: false }], ['目的地缺失', { schedDest: undefined }]]) {
      const unk = sched(schedTurn(profile, o));
      assert.ok(unk.includes(UNKNOWN), tag);
      assert.ok(!unk.includes('（不是主人的私聊）'), tag);
      assert.ok(!unk.includes(OTHER), tag);
    }
    // 自诊断
    const dKnown = diag(diagTurn(profile));
    assert.ok(dKnown.includes(D_OTHER));
    assert.ok(!dKnown.includes('桥接暂时不知道'));
    const dUnk = diag(diagTurn(profile, { ownerDmKnown: false }));
    assert.ok(dUnk.includes(D_UNKNOWN));
    assert.ok(!dUnk.includes('（不是主人的私聊）'));
    assert.ok(!dUnk.includes('联网检索'), '自诊断本轮没有任何工具，提示词里不提联网检索');
    // 发往 owner 私聊的定时 / 自诊断不带这些行
    const priv = sched(schedTurn(profile, { schedDest: SCHED_DEST_OWNER_P2P }));
    for (const line of [OTHER, UNKNOWN]) assert.ok(!priv.includes(line));
  });
}
