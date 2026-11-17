# 建议稿：`workspace/CLAUDE.md` 增补（验收 + 升级阶梯 + 每晚日结）

> 状态：**建议稿，未落地**（BRIDGE-VR-1）。`workspace/CLAUDE.md` 是线上 owner 提示词，本卡不改它，由协调者过审后另行并入。
> 前提是 `docs/heartbeat-prompt-proposal.md`（HB-1）和 `docs/ev-prompt-proposal.md`（EV-1）已经并入。
> 第一至三段给 `workspace/CLAUDE.md`，第四段是心跳每拍提示词的代码改动建议（本卡没改代码，原因见第四段）。
>
> 与代码的对应关系：
>
> - `verify` 状态与 `done_evidence` 校验：`src/heartbeat.js` 中的 `validateTask`。
>   - `kind` 只能是 approval / message / owner / other。
>   - `approval` 的 `ref` 必须是审批实例码，`message` 的 `ref` 必须是 `om_` 消息 ID；`owner` / `other` 不填 `ref`。
>   - `summary` 最多 200 字。
> - 降级：`src/heartbeat.js` 中的 `afterModel`。`HEARTBEAT_VERIFY` 开着时，心跳一拍里新写成 `done` 的台账改成 `verify`。
> - 规则核对与审核提示词：`src/verifier.js`（`ruleCheck` / `buildVerifyPrompt` / `parseVerdict`）。
> - 验收卡片、升级模板、日结撤销的回写：`src/ledger-actions.js` 中的 `applyVerifyAction`。
> - 日结排版：`src/digest.js`。

---

## 一、替换「## 交办台账（tasks/）」里 `status` 那一条（HB-1 建议稿），并在其后加 `done_evidence`

HB-1 建议稿原文为「`status` 只能是以下四个值：open / waiting / done / dropped」，建议改为：

````markdown
- `status` 只能是以下五个值：
  - `open`：待跟进。
  - `waiting`：在等别人。
  - `verify`：**桥接专用**，表示等验收。你不要自己写 `verify`，也不要把 `verify` 改成 `done`。
  - `done`：办完了。
  - `dropped`：不做了。
  - 不要删除台账文件，结束时改 status 即可。
- `done_evidence`（写 `done` 时一起写）：凭什么说办完了。
  - **审批有结果**：`{"kind":"approval","ref":"<审批实例码>","summary":"审批已通过"}`。
    `ref` 必须和这条台账 `watch.instance_code` 一致。
  - **对方回了话**：`{"kind":"message","ref":"om_xxx","summary":"A 公司回复同意周四前报价"}`。
    `ref` 是对方那条消息的 ID，要出现在 `watch.chat_id` 那个会话里；owner 自己发的消息不算。
  - **owner 亲口确认**：`{"kind":"owner","summary":"光总在对话里确认办完"}`。只在和 owner 的对话里、owner 明确说办完了才写，不填 `ref`。
  - **其他**：`{"kind":"other","summary":"…"}`。说清楚依据，不填 `ref`。
  - `summary` 不超过 200 字，只写结论，不抄外部原文。不要编造 `ref`；拿不到确定的 ID 就用 `other`。
````

## 二、追加到「## 心跳轮次（桥接定时唤起）」末尾

```markdown
- 心跳轮里判断一件事办完了：把 `status` 写成 `done`，同时写 `done_evidence`。
  - 桥接会先把它改成 `verify`，再按依据核对：
    - 审批已经走到终态，或者对方真人在 watch 的会话里回了话，桥接就自动改成 `done`；
    - 否则交给验收审核，或者发卡片请光总验收。
  - 所以心跳轮里**不要写 `kind: "owner"`**：光总的确认只认他本人点按钮或引用回复，你写的不算。
- `verify` 状态的条目不会出现在到期列表里，也不要去改它：它在等桥接或光总验收。
```

## 三、追加到「## 交办台账（tasks/）」末尾（普通 owner 会话怎么理解这三类桥接消息）

```markdown
- 桥接会私聊 owner 三类固定格式的消息。这些都不是你写的，按下面理解：
  - 「🔍 **待你验收**」：桥接核对不了或模型判不准，请 owner 验收。
    owner 点按钮或引用回复「验收」「没办完」「不做了」后，桥接直接改台账。
    owner 在普通对话里说结果时，由你改：
    - 验收了 → `done`，并写 `done_evidence` 的 `kind: "owner"`；
    - 没办完 → `open`，`next_check_at` 推到明天；
    - 不做了 → `dropped`。
  - 「⏰『…』过了提醒时间 N 天」：升级提醒，同一件事最多提醒几次，之后只在日结里列为「卡住」。
    owner 说办完了，按上一条写 `done` 和 `kind: "owner"`。
  - 「📒 **台账日结（MM-DD）**」：每晚的五栏汇总。带圈号的是桥接自动判定办完的。
    owner 说「②判错了」之类的话时，把对应台账改回 `open`、`next_check_at` 推到明天，并在 `notes` 里写一句为什么。
- owner 在对话里改的状态，桥接都照单全收，不会再验收。
```

## 四、心跳每拍提示词（`src/heartbeat.js` 的 `buildHeartbeatPrompt` 第 2 条）建议增补（代码改动，本卡未做）

心跳轮以 `--setting-sources ''` 运行，**不保证加载 `CLAUDE.md`**；EV-1 的做法是把心跳要守的规则直接写进每拍提示词。
本卡没改 `buildHeartbeatPrompt`：卡片要求提示词改动只进建议稿，HB-1 / EV-1 的提示词也按原样保留。

后果：并入前，心跳轮写 `done` 时多半不带 `done_evidence`。这不会造成误判办完：
桥接照样改成 `verify`，规则核对得出「台账没写 done_evidence」，然后交给模型审核或发卡片，失败方向是**多问光总**。
只是规则自动通过几乎用不上。

建议在第 2 条末尾追加一句，原文：

```text
写成 `done` 时同时写 `done_evidence`（{"kind":"approval|message|other","ref":"审批实例码或 om_ 消息 ID，other 不填","summary":"不超过 200 字的依据"}）；桥接会改成 `verify` 再核对，`kind` 不要写 `owner`；状态是 `verify` 的条目不要改。
```

## 过审要点（给协调者）

1. **方向**：三段 `CLAUDE.md` 文字都是让模型多交依据、少自称办完。即使模型不照做，桥接也只会多发验收卡片，不会多关单。
2. **`verify` 归桥接**：模型写 `verify` 不会被拒，桥接会照常去核对。建议稿仍然让模型不要写，免得 `HEARTBEAT_VERIFY=off` 时条目一直停在 `verify`。
3. **`kind: "owner"`**：在 owner 对话里写是合法的，那里的 `done` 本来就不验收。在心跳轮里写，桥接一律不算。
4. **第四段**是代码改动，会改心跳每拍的提示词。请单独开卡，或者在本卡过审时一并决定。
