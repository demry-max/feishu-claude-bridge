// 飞书 scope 自检（行为断言）——2026-09-13 安装反馈 P0：
// npm run register 创建出的应用是零权限状态，10 个 MCP 工具里 7 个静默失效，
// 扫码一路绿灯、npm start 日志全绿，用户对着「多维表格读不了」无从判断是权限问题。
// 实测 GET /open-apis/application/v6/scopes 用 tenant_access_token 即可查已开通的 scope，
// 缺 scope 时业务接口返回 code 99991672 并列出所需 scope。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const {
  evaluateScopes, fetchGrantedScopes, formatScopeReport, RECOMMENDED_SCOPES, TOOL_REQUIREMENTS,
} = await import('../src/feishu-scopes.js');

describe('scope → 工具可用性判定（纯函数）', () => {
  test('全部开通时 10 个工具全可用', () => {
    const r = evaluateScopes(new Set(RECOMMENDED_SCOPES));
    assert.equal(r.unavailable.length, 0);
    assert.equal(r.available.length, TOOL_REQUIREMENTS.length);
    assert.equal(r.ok, true);
  });

  test('只开 docx + wiki 时，bitable 与 sheets 的 7 个工具不可用，并指出缺哪些 scope', () => {
    const r = evaluateScopes(new Set(['docx:document', 'docx:document:readonly', 'wiki:wiki:readonly']));
    assert.equal(r.ok, false);
    const names = r.unavailable.map((u) => u.tool);
    for (const t of ['bitable_tables', 'bitable_fields', 'bitable_records', 'bitable_create_record', 'bitable_update_record', 'sheet_read', 'sheet_write']) {
      assert.ok(names.includes(t), `${t} 应被判为不可用`);
    }
    assert.ok(!names.includes('doc_read') && !names.includes('doc_append'));
    assert.ok(r.missingScopes.includes('bitable:app'));
    assert.ok(r.missingScopes.some((s) => s.startsWith('sheets:spreadsheet')));
  });

  test('只读 scope 让读工具可用、写工具不可用', () => {
    const r = evaluateScopes(new Set(['bitable:app:readonly']));
    const names = r.unavailable.map((u) => u.tool);
    assert.ok(!names.includes('bitable_records'));
    assert.ok(names.includes('bitable_create_record'));
  });

  test('零权限应用：全部不可用，且报告给出可直接粘贴的批量导入 JSON', () => {
    const r = evaluateScopes(new Set());
    assert.equal(r.available.length, 0);
    const report = formatScopeReport(r);
    assert.match(report, /bitable_tables/);
    assert.match(report, /批量导入/);
    assert.match(report, /"scopes"/, '要给出开发者后台「批量导入」能直接吃的 JSON');
    for (const s of RECOMMENDED_SCOPES) assert.ok(report.includes(s), `报告缺 ${s}`);
  });

  test('全部可用时报告只有一行 ✅，不刷屏', () => {
    const report = formatScopeReport(evaluateScopes(new Set(RECOMMENDED_SCOPES)));
    assert.equal(report.split('\n').length, 1);
    assert.match(report, /✅/);
  });
});

describe('拉取已开通 scope（用桩 fetch 断言请求与解析）', () => {
  const okFetch = (scopes) => async (url, init) => {
    if (url.endsWith('/auth/v3/tenant_access_token/internal')) {
      const body = JSON.parse(init.body);
      assert.equal(body.app_id, 'cli_x');
      return { json: async () => ({ code: 0, tenant_access_token: 'T', expire: 7200 }) };
    }
    if (url.endsWith('/application/v6/scopes')) {
      assert.equal(init.headers.Authorization, 'Bearer T');
      return { json: async () => ({ code: 0, data: { scopes: scopes.map((s) => ({ scope_name: s, grant_status: 1, scope_type: 'tenant' })) } }) };
    }
    throw new Error('unexpected url ' + url);
  };

  test('返回已开通 scope 名集合（同名 tenant/user 两条只算一次）', async () => {
    const granted = await fetchGrantedScopes({ appId: 'cli_x', appSecret: 's', fetchImpl: okFetch(['docx:document', 'docx:document']) });
    assert.deepEqual([...granted], ['docx:document']);
  });

  test('grant_status 不为 1 的不算已开通', async () => {
    const f = async (url, init) => {
      if (url.includes('tenant_access_token')) return { json: async () => ({ code: 0, tenant_access_token: 'T' }) };
      return { json: async () => ({ code: 0, data: { scopes: [
        { scope_name: 'bitable:app', grant_status: 0 }, { scope_name: 'docx:document', grant_status: 1 },
      ] } }) };
    };
    const granted = await fetchGrantedScopes({ appId: 'a', appSecret: 'b', fetchImpl: f });
    assert.deepEqual([...granted], ['docx:document']);
  });

  test('凭据错误时抛出带飞书返回码的错误，不当成零权限', async () => {
    const f = async () => ({ json: async () => ({ code: 10003, msg: 'invalid app_secret' }) });
    await assert.rejects(fetchGrantedScopes({ appId: 'a', appSecret: 'bad', fetchImpl: f }), /10003/);
  });

  test('Lark 国际版走 open.larksuite.com', async () => {
    const seen = [];
    const f = async (url) => { seen.push(url); return { json: async () => ({ code: 0, tenant_access_token: 'T', data: { scopes: [] } }) }; };
    await fetchGrantedScopes({ appId: 'a', appSecret: 'b', domain: 'lark', fetchImpl: f });
    assert.ok(seen.every((u) => u.startsWith('https://open.larksuite.com/')), seen.join(','));
  });
});

describe('接线（源码断言——只证明写法）', () => {
  test('桥接启动时做 scope 自检并把结果并入启动通知', () => {
    const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.match(src, /fetchGrantedScopes/);
    assert.match(src, /formatScopeReport/);
    // 启动通知里带的 cliProblem/scope 结果都是自检产物：通知必须在自检之后发出，
    // 否则文案永远是「一切正常」（announceStartup 在 config 块之前调用时正是这样）
    const notice = src.lastIndexOf('announceStartup()');
    assert.ok(notice > src.indexOf('checkCliEnvironment(cfg.model)'), '启动通知要等 CLI 自检之后');
    assert.ok(notice > src.indexOf('fetchGrantedScopes('), '启动通知要等 scope 自检之后');
  });
  test('register.js 成功后打印 scope 清单，明说这一步必须去开发者后台手工做', () => {
    const src = fs.readFileSync(new URL('../scripts/register.js', import.meta.url), 'utf8');
    assert.match(src, /RECOMMENDED_SCOPES|formatScopeReport/);
    assert.match(src, /权限管理|批量导入/);
  });
});
