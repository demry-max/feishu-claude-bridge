// BRIDGE-PRIV-1：一轮 claude 调用的「身份 × 场合」上下文（纯函数，不读环境变量、不碰文件）。
//
// 为什么要有它：以前「这一轮带不带仓主私密记忆、用不用仓主工作区与工具」散在 claude.js 各处，
// 各自按 chatId 前缀 / chatType / isOwner 推断；结果仓主在群里发消息、定时任务发往群时，
// 都被当成「仓主私聊」跑（cwd 是 owner 工作区、CLAUDE.md 画像、记忆召回、lark-cli、飞书 MCP 全带）。
// 现在 index.js 在入口算好一个 turn 对象，claude.js 只读它，不再自己猜。
//
// 判定只有一条主线：回答会发给谁。只回仓主私聊（或不外发）的回合才可以 private；
// 发往群、别的会话、目的地不明的回合一律非私密——走访客工作区与访客工具白名单。
import { SCHED_DEST_OWNER_P2P } from './biz-wiring.js';

export const TURN_SOURCES = Object.freeze(['chat', 'heartbeat', 'sched', 'sched-diag', 'handoff', 'verifier']);
export const TURN_KINDS = Object.freeze([
  'owner-dm', 'owner-group', 'guest', 'heartbeat', 'sched-owner-dm', 'sched-other',
  'sched-diag-owner-dm', 'sched-diag-other', 'handoff', 'verifier',
]);
/** private === true 的回合只可能是这几种（结果只回仓主私聊或不外发）。 */
export const PRIVATE_KINDS = Object.freeze(['owner-dm', 'heartbeat', 'sched-owner-dm', 'sched-diag-owner-dm', 'handoff']);

const PROFILES = ['legacy', 'audit', 'strict'];

/** 会话键：仓主在群里与访客同一公式（群里只有一条数据边界）；私聊用会话自己的 id。 */
export function guestSessionKey(chatId, senderOpenId) {
  return `guest:${chatId}:${senderOpenId}`;
}

function make(kind, f) {
  return Object.freeze({
    kind,
    isOwner: f.isOwner === true,
    private: f.private === true,
    workspace: f.workspace,
    toolSet: f.toolSet,
    biz: f.biz === true,
    confirm: f.confirm === true,
    receipt: f.receipt === true,
    recall: f.recall === true,
    memoryNudge: f.memoryNudge === true,
    sessionKey: f.sessionKey ?? null,
    speakerIsOwner: f.speakerIsOwner === true,
    destUnknown: f.destUnknown === true,
    profile: f.profile,
  });
}

const NONE = { confirm: false, receipt: false, recall: false, memoryNudge: false };

/**
 * 解析一轮的上下文。input：
 *   source        'chat' | 'heartbeat' | 'sched' | 'sched-diag' | 'handoff' | 'verifier'
 *   isOwner       发起方是不是仓主（沿用调用方已有的判定，这里不重新判）
 *   chatType      'p2p' | 'group'…（chat 来源用；仓主 + 非 p2p ＝ 群回合，缺省也按群处理）
 *   chatId / senderOpenId   会话键用
 *   schedDest     定时 / 自诊断用，取值沿用 biz-wiring.js 的 schedDestOf：'owner-p2p' 才算发往仓主私聊
 *   ownerDmKnown  定时用：仓主私聊 chat id 是否已知（false 时目的地按「未知」记 destUnknown）
 *   profile       legacy | audit | strict（只影响 receipt 与自诊断工具档）
 *   bizOn         BMS_TOOL_ENABLED 是否开（只影响 biz 字段）
 */
export function resolveTurn(input = {}) {
  const { source, chatType, chatId, senderOpenId, schedDest, ownerDmKnown } = input;
  const isOwner = input.isOwner === true;
  const profile = PROFILES.includes(input.profile) ? input.profile : 'legacy';
  const bizOn = input.bizOn === true;
  const ctx = { isOwner, profile };

  // 非仓主：不管来源，一律访客（心跳 / 交接 / 验收只对仓主生效，非仓主带这些档时当没带）
  if (!isOwner) {
    return make('guest', {
      ...ctx, ...NONE, private: false, workspace: 'guest', toolSet: 'guest',
      sessionKey: guestSessionKey(chatId, senderOpenId), // 缺发言人也不退回裸 chat_id：群的 chat_id 是仓主旧会话键
    });
  }

  switch (source) {
    case 'heartbeat':
      return make('heartbeat', {
        ...ctx, ...NONE, private: true, workspace: 'owner', toolSet: 'heartbeat', biz: bizOn,
        sessionKey: chatId ?? null, speakerIsOwner: true,
      });
    case 'handoff':
      return make('handoff', {
        ...ctx, ...NONE, private: true, workspace: 'owner', toolSet: 'handoff', sessionKey: chatId ?? null, speakerIsOwner: true,
      });
    case 'verifier':
      return make('verifier', {
        ...ctx, ...NONE, private: false, workspace: 'tmp', toolSet: 'verifier', sessionKey: chatId ?? null, speakerIsOwner: true,
      });
    case 'sched': {
      const toDm = schedDest === SCHED_DEST_OWNER_P2P;
      const destUnknown = !toDm && (ownerDmKnown === false || schedDest !== 'other');
      if (toDm) {
        return make('sched-owner-dm', {
          ...ctx, ...NONE, private: true, workspace: 'owner', toolSet: 'owner', biz: bizOn, sessionKey: chatId ?? null, speakerIsOwner: true,
        });
      }
      return make('sched-other', {
        ...ctx, ...NONE, private: false, workspace: 'guest', toolSet: 'guest', sessionKey: chatId ?? null, destUnknown,
      });
    }
    case 'sched-diag': {
      const toDm = schedDest === SCHED_DEST_OWNER_P2P;
      const destUnknown = !toDm && (ownerDmKnown === false || schedDest !== 'other');
      if (toDm) {
        // legacy 的自诊断仍是基线那套（有工具）；audit / strict 是零工具档
        return make('sched-diag-owner-dm', {
          ...ctx, ...NONE, private: true, workspace: 'owner', toolSet: profile === 'legacy' ? 'owner' : 'sched-diag',
          sessionKey: chatId ?? null, speakerIsOwner: true,
        });
      }
      return make('sched-diag-other', {
        ...ctx, ...NONE, private: false, workspace: 'guest', toolSet: 'sched-diag', sessionKey: chatId ?? null, destUnknown,
      });
    }
    case 'chat':
    default: {
      if (chatType === 'p2p') {
        return make('owner-dm', {
          ...ctx, private: true, workspace: 'owner', toolSet: 'owner', biz: bizOn,
          confirm: true, receipt: profile !== 'legacy', recall: true, memoryNudge: true,
          sessionKey: chatId ?? null, speakerIsOwner: true,
        });
      }
      // 仓主在群里：与访客同一个数据边界。身份只用于桥接命令权限与提示词里的称呼
      return make('owner-group', {
        ...ctx, ...NONE, private: false, workspace: 'guest', toolSet: 'guest',
        sessionKey: guestSessionKey(chatId, senderOpenId), speakerIsOwner: true,
      });
    }
  }
}

/**
 * 给没传 opts.turn 的直接调用（heartbeat.js、verifier.js、daily-session-live.js 与既有测试）推出同一个对象。
 * 规则 = 原来 claude.js 里 isEphemeral / ownerToolKind / bizGranted / workspaceFor 的口径，只加两条收紧：
 *   显式 chatType 且不是 p2p 的 owner 调用 → owner-group；
 *   sched: / sched-diag: 且显式带了 schedDest 而不等于 owner-p2p → *-other。
 * 字段缺省（不带 chatType / schedDest）按现状处理：owner 私聊式、biz 不挂。
 * env：{ profile, bizOn }，由 claude.js 传入（本模块不读环境变量）。
 */
export function turnFromLegacyCall(chatId, isOwner, opts = {}, env = {}) {
  const id = String(chatId);
  const tp = opts?.toolProfile;
  const common = { isOwner: isOwner === true, chatId, profile: env.profile, bizOn: false };
  const chatType = opts?.chatType;
  const destGiven = opts?.schedDest !== undefined;

  if (isOwner !== true) return resolveTurn({ ...common, source: 'chat' });
  if (tp === 'heartbeat') return resolveTurn({ ...common, source: 'heartbeat', bizOn: env.bizOn });
  if (tp === 'verifier') return resolveTurn({ ...common, source: 'verifier' });
  if (tp === 'handoff') return resolveTurn({ ...common, source: 'handoff' });
  if (id.startsWith('sched-diag:')) {
    return resolveTurn({ ...common, source: 'sched-diag', schedDest: destGiven ? opts.schedDest : SCHED_DEST_OWNER_P2P, ownerDmKnown: true });
  }
  if (tp === 'sched' || id.startsWith('sched:')) {
    // 没带 schedDest：按原来的口径——owner 档、biz 不挂（biz 只认显式 schedDest）
    return resolveTurn({
      ...common, source: 'sched', schedDest: destGiven ? opts.schedDest : SCHED_DEST_OWNER_P2P, ownerDmKnown: true,
      bizOn: destGiven && env.bizOn === true,
    });
  }
  // 对话：显式 chatType 且不是 p2p → 群回合；没带 chatType 按私聊式处理（biz 只在显式 p2p、且没有别的档标记时挂）
  const explicitGroup = chatType !== undefined && chatType !== null && chatType !== 'p2p';
  return resolveTurn({
    ...common, source: 'chat', chatType: explicitGroup ? chatType : 'p2p',
    bizOn: env.bizOn === true && chatType === 'p2p' && tp == null,
  });
}
