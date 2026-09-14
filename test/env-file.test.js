// .env 回写（行为断言）。2026-09-13 安装反馈 P1：register.js 拿到了 open_id 却只写 data/owner.json，
// .env 里 OWNER_OPEN_ID 仍是空的——而 .env.example 用加粗字体建议设置它。
// claude.js 与 register.js 原本各有一份写 .env 的实现（一份原子+保留注释，一份都不保留），统一到一处。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { patchEnvFile } = await import('../src/env-file.js');
const tmpEnv = (body) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-')), '.env');
  if (body !== undefined) fs.writeFileSync(f, body);
  return f;
};

describe('patchEnvFile', () => {
  test('文件不存在时创建', () => {
    const f = tmpEnv();
    patchEnvFile(f, { FEISHU_APP_ID: 'cli_x' });
    assert.equal(fs.readFileSync(f, 'utf8').trim(), 'FEISHU_APP_ID=cli_x');
  });

  test('替换已有键并保留其行尾注释；其余行与注释一字不动', () => {
    const f = tmpEnv('# 顶部注释\nOWNER_OPEN_ID=            # 强烈建议设置\nCLAUDE_MODEL=fable\n');
    patchEnvFile(f, { OWNER_OPEN_ID: 'ou_abc' });
    assert.equal(fs.readFileSync(f, 'utf8'), '# 顶部注释\nOWNER_OPEN_ID=ou_abc            # 强烈建议设置\nCLAUDE_MODEL=fable\n');
  });

  test('缺失的键追加到末尾，不破坏末尾换行', () => {
    const f = tmpEnv('A=1\n');
    patchEnvFile(f, { B: '2', C: '' });
    assert.equal(fs.readFileSync(f, 'utf8'), 'A=1\nB=2\nC=\n');
  });

  test('原子写入：不留 .tmp 残骸', () => {
    const f = tmpEnv('A=1\n');
    patchEnvFile(f, { A: '2' });
    assert.ok(!fs.existsSync(`${f}.tmp`));
  });

  test('写失败返回 false 而不是抛（调用方在启动/注册路径上）', () => {
    assert.equal(patchEnvFile('/dev/null/nope/.env', { A: '1' }), false);
  });
});

describe('register.js 接线（源码断言）', () => {
  const src = fs.readFileSync(new URL('../scripts/register.js', import.meta.url), 'utf8');
  test('扫码拿到的 open_id 同时写进 .env 的 OWNER_OPEN_ID', () => {
    assert.match(src, /OWNER_OPEN_ID: openId/);
  });
  test('register.js 用共享的 patchEnvFile，不再自带一份 .env 写法', () => {
    assert.match(src, /from '\.\.\/src\/env-file\.js'/);
    assert.ok(!/function upsertEnv/.test(src));
  });
  test('claude.js 同样用共享实现', () => {
    const c = fs.readFileSync(new URL('../src/claude.js', import.meta.url), 'utf8');
    assert.match(c, /from '\.\/env-file\.js'/);
    assert.ok(!/^function patchEnvFile/m.test(c));
  });
});
