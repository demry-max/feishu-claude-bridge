// 飞书 scope 自检。
//
// 2026-09-13 全新机器安装反馈：`npm run register` 创建出的应用是**零权限**状态，
// 10 个 MCP 工具里 7 个静默失效——扫码一路绿灯、`npm start` 日志全绿，
// 用户对着「多维表格读不了」无从判断是权限问题。
// 与 checkCliEnvironment() 同一个道理：报错发生在用户发消息那一刻，不如启动时就说清。
//
// 实测（2026-09-14）：GET /open-apis/application/v6/scopes 用 tenant_access_token 即可查
// 已开通的 scope（grant_status=1），不需要额外权限；缺 scope 时业务接口返回 99991672
// 并在 msg 里列出所需 scope。这里只读不写：开通 scope 只能在开发者后台手工完成。

// 每个 MCP 工具可接受的 scope（任一开通即可用）。名字取自 mcp-feishu.js 里的工具名。
export const TOOL_REQUIREMENTS = [
  { tool: 'doc_read', anyOf: ['docx:document:readonly', 'docx:document'] },
  { tool: 'doc_append', anyOf: ['docx:document'] },
  { tool: 'wiki 链接解析', anyOf: ['wiki:wiki:readonly', 'wiki:wiki'] },
  { tool: 'bitable_tables', anyOf: ['bitable:app:readonly', 'bitable:app'] },
  { tool: 'bitable_fields', anyOf: ['bitable:app:readonly', 'bitable:app'] },
  { tool: 'bitable_records', anyOf: ['bitable:app:readonly', 'bitable:app'] },
  { tool: 'bitable_create_record', anyOf: ['bitable:app'] },
  { tool: 'bitable_update_record', anyOf: ['bitable:app'] },
  { tool: 'sheet_read', anyOf: ['sheets:spreadsheet:readonly', 'sheets:spreadsheet:read', 'sheets:spreadsheet'] },
  { tool: 'sheet_write', anyOf: ['sheets:spreadsheet:write_only', 'sheets:spreadsheet'] },
];

// 建议一次性导入的 scope 集合（读+写各一条，覆盖全部工具）
export const RECOMMENDED_SCOPES = [
  'docx:document', 'docx:document:readonly',
  'bitable:app', 'bitable:app:readonly',
  'wiki:wiki:readonly',
  'sheets:spreadsheet', 'sheets:spreadsheet:readonly',
];

const baseUrl = (domain) =>
  domain === 'lark' ? 'https://open.larksuite.com/open-apis' : 'https://open.feishu.cn/open-apis';

/**
 * 拉取应用已开通的 scope 名集合。凭据错误/接口报错时抛出（带飞书返回码）——
 * 绝不能把「查不到」当成「零权限」，否则会误导用户去后台白忙一场。
 */
export async function fetchGrantedScopes({ appId, appSecret, domain, fetchImpl = fetch }) {
  const base = baseUrl(domain);
  const tok = await (await fetchImpl(`${base}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })).json();
  if (tok.code !== 0 || !tok.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败（code ${tok.code}）：${tok.msg ?? ''}`);
  }
  const res = await (await fetchImpl(`${base}/application/v6/scopes`, {
    headers: { Authorization: `Bearer ${tok.tenant_access_token}` },
  })).json();
  if (res.code !== 0) throw new Error(`查询应用权限失败（code ${res.code}）：${res.msg ?? ''}`);
  const granted = new Set();
  for (const s of res.data?.scopes ?? []) {
    if (s?.grant_status === 1 && s.scope_name) granted.add(s.scope_name);
  }
  return granted;
}

/** 纯函数：已开通的 scope 集合 → 哪些工具可用/不可用、缺哪些 scope */
export function evaluateScopes(granted) {
  const available = [];
  const unavailable = [];
  for (const req of TOOL_REQUIREMENTS) {
    if (req.anyOf.some((s) => granted.has(s))) available.push(req.tool);
    else unavailable.push({ tool: req.tool, needs: req.anyOf });
  }
  const missingScopes = RECOMMENDED_SCOPES.filter((s) => !granted.has(s));
  return { ok: unavailable.length === 0, available, unavailable, missingScopes };
}

/** 给日志/启动通知/register 用的人话报告。全可用时只有一行，不刷屏。 */
export function formatScopeReport(result) {
  if (result.ok) return `[scope] ✅ 飞书文档/多维表格/电子表格权限齐全（${result.available.length} 个工具可用）`;
  const importJson = JSON.stringify({ scopes: { tenant: RECOMMENDED_SCOPES, user: [] } });
  return [
    `[scope] ⚠️ 以下 ${result.unavailable.length} 个飞书工具不可用（应用未开通对应 scope）：`,
    ...result.unavailable.map((u) => `[scope]   - ${u.tool}（需要 ${u.needs.join(' 或 ')}）`),
    '[scope] 修复：开发者后台 → 该应用 → 权限管理 → 批量导入，粘贴下面这段，然后「创建版本」并发布：',
    `[scope]   ${importJson}`,
    '[scope] 发布后重启桥接即可（本自检只读，无法替你开通）。',
  ].join('\n');
}
