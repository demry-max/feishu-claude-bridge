// owner 工作区初始化。
//
// 2026-09-13 全新机器安装反馈：仓库只带 workspace/CLAUDE.md，memory/ 与 skills/ 从不被创建，
// CLAUDE.md 里 `@memory/USER.md`、`@memory/MEMORY.md` 两行 @import 一直悬空——
// README 写得再详细，机器人第一次落盘也只会报「目录不存在」。
// 访客工作区早有 ensureGuestWorkspace()，owner 侧却没有对应逻辑，这里补齐。
// 幂等：目录用 recursive mkdir；种子文件只在缺失时写入，已有内容一个字节都不动。
import fs from 'node:fs';
import path from 'node:path';

export const USER_MD_SEED = `# USER.md — 用户画像（每次对话自动加载）

> 这里只放**稳定的**身份、偏好、沟通与判断风格。事实变化时就地改写并标日期，不追加矛盾条目。
> 具体项目、数字、事件属于事实层（memory/<slug>.md）或流水层（memory/journal/），不放这里。

## 身份

（还不了解，对话中主动补全：称呼、角色、公司）

## 沟通偏好

（回复语言、长短、格式偏好——用户一提就写进来）

## 判断与用人风格

（代拟决策建议时要匹配的风格；没有把握就先留空）
`;

export const MEMORY_MD_SEED = `# 记忆索引（事实层）

> 画像层在 USER.md（自动加载）；当日流水在 journal/YYYY-MM-DD.md（Grep 检索）。
> 此处一条长期事实一行，格式：\`- [标题](文件名.md) — 一句话摘要\`。新建事实文件后在这里追加一行。

`;

const DIRS = ['memory/journal', 'skills', 'schedules', 'outbox', 'incoming'];

/**
 * 建出三层记忆所需的目录与种子文件。返回 { ok, problem }，不抛——
 * 这段跑在启动路径上，抛出去会打死整个桥接进程。
 */
export function ensureOwnerWorkspace(dir) {
  try {
    for (const d of DIRS) fs.mkdirSync(path.join(dir, d), { recursive: true });
    const seeds = [
      ['memory/USER.md', USER_MD_SEED],
      ['memory/MEMORY.md', MEMORY_MD_SEED],
    ];
    for (const [rel, body] of seeds) {
      const f = path.join(dir, rel);
      if (!fs.existsSync(f)) fs.writeFileSync(f, body);
    }
    return { ok: true, problem: null };
  } catch (e) {
    return { ok: false, problem: `初始化 owner 工作区 ${dir} 失败：${e?.message ?? e}` };
  }
}
