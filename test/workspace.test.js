// 首次安装体验（行为断言）——来自 2026-09-13 全新机器安装反馈：
// README 把三层记忆写得很详细，但 workspace/memory/ 与 skills/ 从不被创建，
// CLAUDE.md 里的 @memory/USER.md、@memory/MEMORY.md 两行 @import 一直悬空，
// 机器人第一次落盘就报「目录不存在」。owner 工作区必须像访客工作区一样在启动时建好。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { ensureOwnerWorkspace } = await import('../src/workspace.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));

describe('owner 工作区初始化', () => {
  test('空目录上建出三层记忆所需的全部目录', () => {
    const dir = tmp();
    ensureOwnerWorkspace(dir);
    for (const d of ['memory/journal', 'skills', 'schedules', 'outbox', 'incoming']) {
      assert.ok(fs.statSync(path.join(dir, d)).isDirectory(), `${d}/ 必须存在`);
    }
  });

  test('CLAUDE.md 的两行 @import 不再悬空：USER.md 与 MEMORY.md 有种子文件', () => {
    const dir = tmp();
    ensureOwnerWorkspace(dir);
    const user = fs.readFileSync(path.join(dir, 'memory', 'USER.md'), 'utf8');
    const index = fs.readFileSync(path.join(dir, 'memory', 'MEMORY.md'), 'utf8');
    assert.match(user, /USER\.md/, '种子要说明这是画像层');
    assert.match(index, /MEMORY\.md|记忆索引/, '种子要说明这是索引');
    assert.match(index, /- \[/, '索引要给出条目格式示例，机器人才知道怎么追加');
  });

  test('幂等：已有内容绝不覆盖，反复调用字节不变', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory', 'USER.md'), '# 我的画像\n- 已经写了很多\n');
    fs.writeFileSync(path.join(dir, 'memory', 'MEMORY.md'), '- [x](x.md) — 已有记忆\n');
    ensureOwnerWorkspace(dir);
    ensureOwnerWorkspace(dir);
    assert.equal(fs.readFileSync(path.join(dir, 'memory', 'USER.md'), 'utf8'), '# 我的画像\n- 已经写了很多\n');
    assert.equal(fs.readFileSync(path.join(dir, 'memory', 'MEMORY.md'), 'utf8'), '- [x](x.md) — 已有记忆\n');
  });

  test('目录不可写时返回问题描述而不是抛异常（启动路径上抛会打死进程）', () => {
    const r = ensureOwnerWorkspace('/dev/null/not-a-dir');
    assert.equal(r.ok, false);
    assert.ok(r.problem, '要告诉用户是哪里失败');
  });

  test('桥接启动时对真实 owner 工作区执行了初始化', async () => {
    // claude.js 是启动路径：导入即应建好 owner 工作区（与 ensureGuestWorkspace 同一处）
    const dir = tmp();
    const prev = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = dir;
    try {
      await import(`../src/claude.js?ws=${Math.random()}`);
      assert.ok(fs.existsSync(path.join(dir, 'memory', 'MEMORY.md')));
      assert.ok(fs.existsSync(path.join(dir, 'skills')));
    } finally {
      if (prev === undefined) delete process.env.WORKSPACE_DIR; else process.env.WORKSPACE_DIR = prev;
    }
  });
});
