// BRIDGE-BMS-1：业务系统只读查询工具 biz_get 的目标表，以及路径 / 参数 / 输出的全部判定。
//
// 纯模块：不读环境变量、不碰文件、不联网，加载无副作用。
// 主机、路径前缀、钥匙串条目名、请求方法都是这里的常量——没有任何环境变量能改它们；
// 要接自己的系统，改 TARGETS（测试注入一律走函数参数，不走 env）。

export const BIZ_SERVER = 'biz';
export const BIZ_TOOL_NAME = 'biz_get';
export const BIZ_TOOL = `mcp__${BIZ_SERVER}__${BIZ_TOOL_NAME}`;
export const BIZ_SKILL = 'biz-readonly';

// 业务系统前面有 Cloudflare：没有 UA 或 UA 像脚本时会被挑战页拦下。固定一个普通桌面浏览器 UA。
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const LIMITS = Object.freeze({
  pathLen: 256,          // 路径（含 /api/v1）最多字符数
  queryParams: 30,       // 展开数组后的参数个数上限
  queryValue: 200,       // 单个参数值最多字符数
  resultChars: 40_000,   // 给模型的正文上限（先脱敏再截断）
  bodyBytes: 1024 * 1024, // 响应体读取上限，超过即中止
  errorMessage: 200,     // 错误信息最多字符数
  callsPerProcess: 30,   // 每个 MCP 进程（= 一轮对话）最多发出的请求数
  callsPerMinute: 20,    // 滑动 60 秒内最多发出的请求数
  timeoutMs: 15_000,     // 单次请求（含读响应体）总超时
  keychainTimeoutMs: 5_000,
});

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !(v instanceof RegExp)) deepFreeze(v);
  return Object.freeze(o);
};

// 两个目标都只走 /api/v1。deny 规则对两边都生效（宁可多拦）：
//   FIRST_DENY      第一段命中即拒：密钥管理、认证（只放 bms 的 auth/me）、导出、心跳、AI、MCP 通道
//   ANY_DENY_SUBSTR 任何一段（小写后）含其中任一子串即拒：文件 / 下载 / 凭证 / 导出 / 密钥类
export const TARGETS = deepFreeze({
  bms: {
    id: 'bms',
    name: 'BMS',
    about: '业务管理系统（CRM）：工单、客户、线索、合同、收款、付款申请、提成、经营看板',
    origin: 'https://crm.gdsgroup.tech',
    prefix: '/api/v1',
    allowIndex: false, // 只认 /api/v1/<资源>
    keychain: { service: 'com.demry.bms-agent.readonly', account: 'bms-readonly', label: 'BMS 只读 Key（私人助理桥）' },
    keyFormat: /^bms_sk_[A-Za-z0-9_-]{6,256}$/,
    checkPath: '/api/v1/auth/me',
    limitMax: 100,
    authAllow: ['auth/me'],
    textPaths: [],
    categories: ['auth', 'dashboard', 'tickets', 'items', 'subtasks', 'accounts', 'leads', 'contracts', 'collections',
      'payment-requests', 'commissions', 'rebates', 'admin', 'masterdata', 'exchange-rates', 'lookup'],
  },
  ias: {
    id: 'ias',
    name: 'IAS',
    about: '财务会计系统：经营看板、损益 / 资产负债 / 试算 / 现金流报表、应收应付与账龄、往来明细、收支流水、科目与客户项目',
    origin: 'https://finance.gds.ph',
    prefix: '/api/v1',
    allowIndex: true, // /api/v1 本身是索引（自检用）
    keychain: { service: 'com.demry.ias-agent.readonly', account: 'ias-readonly', label: 'IAS 只读 Key（私人助理桥）' },
    keyFormat: /^acc_[A-Za-z0-9_-]{20,256}$/,
    checkPath: '/api/v1',
    limitMax: 200,
    authAllow: [],
    textPaths: ['/api/v1/guide'], // 接口说明是 markdown，按文本展示（同样脱敏、截断、围栏）
    categories: ['dashboard', 'summary', 'reports', 'ar', 'ap', 'ledger', 'transactions', 'accounts', 'clients',
      'projects', 'categories', 'departments', 'analysis', 'guide'],
  },
});

export const TARGET_IDS = Object.freeze(Object.keys(TARGETS));

const FIRST_DENY = new Set(['api-keys', 'api-key', 'apikeys', 'apikey', 'auth', 'export', 'exports', 'heartbeat', 'ai', 'mcp']);
const ANY_DENY_SUBSTR = Object.freeze(['voucher', 'invoice-file', 'download', 'file', 'files', 'export', 'api-key', 'apikey', 'api_key']);
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const QUERY_KEY = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const PAGE_KEYS = new Set(['limit', 'pageSize', 'page_size', 'perPage', 'per_page']);

export class BizInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BizInputError';
  }
}
const bad = (m) => new BizInputError(m);

/** 只认 TARGETS 自己的键（不走原型链）。 */
export function targetOf(id) {
  if (typeof id !== 'string' || !Object.hasOwn(TARGETS, id)) throw bad(`target 只能是 ${TARGET_IDS.join(' / ')}`);
  return TARGETS[id];
}

/**
 * 路径归一化：`/x` 与 `/api/v1/x` 都归成 `/api/v1/x`。只认 ASCII 字母数字与 . _ ~ - /；
 * 拒绝 ? # \ % @ : 空白、控制字符、`//`、绝对 URL、空段、`.` / `..` 段，再按 deny 规则拒。
 * 返回完整路径（含前缀）；不合法抛 BizInputError（信息里不回显原始输入）。
 */
export function normalizeBizPath(target, p) {
  const t = targetOf(target);
  if (typeof p !== 'string' || p.length === 0) throw bad('path 必须是以 / 开头的字符串，例如 /tickets');
  if (p.length > LIMITS.pathLen) throw bad(`path 超过 ${LIMITS.pathLen} 个字符`);
  if (p[0] !== '/') throw bad('path 必须以 / 开头，只写主机之后的部分，例如 /tickets（不能是完整 URL）');
  if (/[^A-Za-z0-9._~/-]/.test(p)) {
    throw bad('path 只能含字母、数字和 . _ ~ - /（查询参数放进 query；不能有 ? # % @ : \\ 空白等字符）');
  }
  if (p.includes('//')) throw bad('path 里不能有 //');
  const segs = p.slice(1).split('/');
  if (segs.some((s) => s === '')) throw bad('path 不能以 / 结尾，也不能有空段');
  if (segs.some((s) => s === '.' || s === '..')) throw bad('path 里不能有 . 或 .. 段');
  if (!segs.every((s) => SEGMENT.test(s))) throw bad('path 段不合法');
  let rest = segs;
  if (segs[0] === 'api') {
    if (segs[1] !== 'v1') throw bad('只支持 /api/v1 下的接口');
    rest = segs.slice(2);
  }
  if (rest.length === 0 && !t.allowIndex) throw bad('path 要写到具体资源，例如 /tickets');
  const full = rest.length ? `${t.prefix}/${rest.join('/')}` : t.prefix;
  if (full.length > LIMITS.pathLen) throw bad(`path 超过 ${LIMITS.pathLen} 个字符`);
  const lower = rest.map((s) => s.toLowerCase());
  const first = lower[0];
  const authOk = first === 'auth' && t.authAllow.includes(lower.join('/'));
  if (first !== undefined && FIRST_DENY.has(first) && !authOk) throw bad('这个接口不开放（密钥 / 认证 / 导出 / AI 等通道不可用）');
  if (lower.some((s) => ANY_DENY_SUBSTR.some((x) => s.includes(x)))) {
    throw bad('这个接口不开放（文件、下载、凭证、导出、密钥类接口不可用）');
  }
  return full;
}

function clampPage(key, s, max) {
  if (!/^\d{1,9}$/.test(s)) throw bad(`参数 ${key} 必须是正整数`);
  const n = Number(s);
  return String(Math.min(Math.max(n, 1), max));
}

/** query → [[k, v], …]：键名白名单格式、值只收字符串 / 数字 / 布尔（或它们的数组，展开成同名多值），分页大小截到上限。 */
export function bizQueryPairs(target, query) {
  const t = targetOf(target);
  if (query === undefined || query === null) return [];
  if (typeof query !== 'object' || Array.isArray(query)) throw bad('query 必须是对象，例如 {"status":"open","limit":20}');
  const out = [];
  for (const [k, raw] of Object.entries(query)) {
    if (!QUERY_KEY.test(k)) throw bad('query 的参数名只能是字母开头的字母、数字、下划线（最多 41 个字符）');
    const vals = Array.isArray(raw) ? raw : [raw];
    for (const v of vals) {
      let s;
      if (typeof v === 'string') s = v;
      else if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
      else if (typeof v === 'boolean') s = String(v);
      else throw bad(`参数 ${k} 的值只能是字符串、数字、布尔，或它们组成的数组`);
      if (s.length > LIMITS.queryValue) throw bad(`参数 ${k} 的值超过 ${LIMITS.queryValue} 个字符`);
      if (/[\u0000-\u001f\u007f]/.test(s)) throw bad(`参数 ${k} 的值含控制字符`);
      if (PAGE_KEYS.has(k)) s = clampPage(k, s, t.limitMax);
      out.push([k, s]);
      if (out.length > LIMITS.queryParams) throw bad(`query 参数超过 ${LIMITS.queryParams} 个`);
    }
  }
  return out;
}

/** 拼 URL：new URL 之后再断言 origin 与 pathname 逐字等于预期，不带 userinfo / hash。 */
export function buildBizUrl(target, p, query) {
  const t = targetOf(target);
  const full = normalizeBizPath(target, p);
  const pairs = bizQueryPairs(target, query);
  const u = new URL(full, `${t.origin}/`);
  const sane = () => u.origin === t.origin && u.pathname === full && !u.username && !u.password && !u.hash;
  if (!sane() || u.search) throw bad('path 无法安全拼成 URL');
  for (const [k, v] of pairs) u.searchParams.append(k, v);
  if (!sane()) throw bad('path 无法安全拼成 URL');
  return u;
}

// ---------------- 脱敏与输出 ----------------
const KEY_PATTERNS = [
  [/bms_sk_[A-Za-z0-9_-]{6,}/g, 'bms_sk_***'],
  [/(?<![A-Za-z0-9_-])acc_[A-Za-z0-9_-]{40,}/g, 'acc_***'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
];

/** 抹掉文本里一切像密钥的东西：两种 Key 格式、Bearer 头，以及调用方给的原文（本次读到的 Key）。 */
export function redactBizText(text, secrets = []) {
  let s = String(text ?? '');
  for (const sec of secrets) if (typeof sec === 'string' && sec.length >= 8) s = s.split(sec).join('***');
  for (const [re, to] of KEY_PATTERNS) s = s.replace(re, to);
  return s;
}

/** 先脱敏再截断到 LIMITS.resultChars，截断时附说明。 */
export function clipBizText(text, secrets = []) {
  const s = redactBizText(text, secrets);
  if (s.length <= LIMITS.resultChars) return s;
  return `${s.slice(0, LIMITS.resultChars)}\n[已截断：结果超过 ${LIMITS.resultChars} 字符。请加筛选条件或分页（limit / page）后再查]`;
}

const oneLine = (v, max, secrets) => redactBizText(String(v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim(), secrets).slice(0, max);
const safeMime = (ct) => {
  const m = typeof ct === 'string' ? ct.toLowerCase().match(/^\s*([a-z]+\/[a-z0-9.+-]{1,60})\s*(?:;|$)/) : null;
  return m ? m[1] : '未知类型';
};
const safeRequestId = (v) => (typeof v === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(v) ? v : null);

/** 业务系统的错误信封：{error:{code,message}} / {error:"…"} / {code,message} / {message}。只取 code 与 message。 */
export function bizErrorFields(body) {
  if (!body || typeof body !== 'object') return { code: null, message: null };
  const e = body.error;
  let code = null;
  let message = null;
  if (typeof e === 'string') message = e;
  else if (e && typeof e === 'object') {
    if (typeof e.code === 'string' || typeof e.code === 'number') code = String(e.code);
    if (typeof e.message === 'string') message = e.message;
  }
  if (code === null && (typeof body.code === 'string' || typeof body.code === 'number')) code = String(body.code);
  if (message === null && typeof body.message === 'string') message = body.message;
  if (code !== null && !/^[A-Za-z0-9_.-]{1,64}$/.test(code)) code = null;
  return { code, message };
}

const HINTS = {
  401: (t) => `Key 无效、过期、已吊销，或本机出口 IP 不在 Key 允许的范围内；请 owner 在本机终端检查钥匙串条目 ${t.keychain.service}`,
  403: () => '这把只读 Key 没有这类数据的权限（或被对方防火墙拦下）',
  404: () => '「未找到」可能只是没有权限，不能据此断定数据不存在',
  429: () => '对方限频，请稍后再查',
};
const hintFor = (t, status) => HINTS[status]?.(t) ?? (status >= 500 ? '对方服务出错，请稍后再查' : null);

/**
 * 把一次请求的结果排成给模型看的文本（调用方再包围栏）。r.kind：
 *   json / text  成功且可展示；empty  空响应；non-json  只给元数据；too-large  超 1 MB 已中止；
 *   http-error  4xx/5xx；redirect  3xx；timeout  超时中止；network  网络错误（只带错误码，如 ECONNRESET）
 * 只用到：状态码、错误码、错误信息（≤200 字）、x-request-id、内容类型与字节数——不回显响应头、不回显 query。
 * 排好后整段再脱敏一遍（error.code、request-id 也可能带着 Key 的原文或去掉前缀的部分）。
 */
export function formatBizResult(target, r = {}) {
  return redactBizText(formatRaw(target, r), r.secrets ?? []);
}

function formatRaw(target, r) {
  const t = targetOf(target);
  const secrets = r.secrets ?? [];
  const status = Number.isInteger(r.status) ? r.status : null;
  const head = redactBizText(`${t.name} GET ${r.path ?? t.prefix}${status === null ? '' : ` · HTTP ${status}`}`, secrets);
  const rid = safeRequestId(r.requestId);
  switch (r.kind) {
    case 'json': return `${head}\n${clipBizText(JSON.stringify(r.data ?? null), secrets)}`;
    case 'text': return `${head}\n${clipBizText(r.text ?? '', secrets)}`;
    case 'empty': return `${head}\n（空响应）`;
    case 'too-large':
      return `${head}\n响应超过 ${Math.round(LIMITS.bodyBytes / 1024 / 1024)} MB，已停止读取并丢弃。请加筛选条件或分页（limit / page）后再查。`;
    case 'redirect': return `${head}\n对方要求重定向，已拒绝跟随（只访问固定主机，不跟随任何跳转）。`;
    case 'timeout':
      return `${head}\n请求超时（${(Number.isFinite(r.timeoutMs) ? r.timeoutMs : LIMITS.timeoutMs) / 1000} 秒），已中止。对方可能较慢，请缩小范围（加筛选条件或分页）后再查。`;
    case 'network': {
      const reason = typeof r.reason === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(r.reason) ? r.reason : null;
      return `${head}\n网络错误${reason ? `（${reason}）` : ''}，请求没有完成。`;
    }
    case 'non-json': {
      const hint = r.status === 403 ? '可能是被对方防火墙（如 Cloudflare）拦下，或这把 Key 没有权限' : r.status >= 400 ? hintFor(t, r.status) : null;
      return `${head}${rid ? ` · request-id=${rid}` : ''}\n返回的不是 JSON（${safeMime(r.contentType)}，${Number(r.bytes) || 0} 字节），内容未展示。`
        + (hint ? `\n提示：${hint}` : '');
    }
    case 'http-error': {
      const { code, message } = bizErrorFields(r.data);
      const parts = [head];
      if (code) parts.push(`code=${code}`);
      if (message) parts.push(oneLine(message, LIMITS.errorMessage, secrets));
      if (rid) parts.push(`request-id=${rid}`);
      const hint = hintFor(t, r.status);
      return parts.join(' · ') + (hint ? `\n提示：${hint}` : '');
    }
    default: return `${head}\n结果无法解析。`;
  }
}

/** 钥匙串缺条目时的固定说明（不含任何密钥；三种原因——没有条目、超时、格式不对——给同一段话）。 */
export function missingKeyText(target) {
  const t = targetOf(target);
  const k = t.keychain;
  return [
    `${t.name} 查询未配置：钥匙串里没有可用的「${k.service}」（账号 ${k.account}），请 owner 写入。`,
    `owner 在这台电脑的终端里运行下面这条（会提示输入 Key，输入时不回显；不要把 Key 发到聊天里）：`,
    `security add-generic-password -U -a ${k.account} -s ${k.service} -l "${k.label}" -T /usr/bin/security -w`,
  ].join('\n');
}

/**
 * 审计用的三个安全名：domain = target，cmd = 路径第一段（只认已登记的类别，其余记 other；不合法记 invalid），method = get。
 * 永不返回 query、完整路径或任何内容。
 */
export function bizAuditFields(input) {
  const id = typeof input?.target === 'string' && Object.hasOwn(TARGETS, input.target) ? input.target : null;
  if (!id) return { domain: null, cmd: null, method: 'get' };
  const t = TARGETS[id];
  let cmd;
  try {
    const rest = normalizeBizPath(id, input?.path).slice(t.prefix.length).split('/').filter(Boolean);
    cmd = rest.length === 0 ? 'index' : t.categories.includes(rest[0].toLowerCase()) ? rest[0].toLowerCase() : 'other';
  } catch {
    cmd = 'invalid';
  }
  return { domain: id, cmd, method: 'get' };
}

// ---- 卡片点名的 BMS 别名（与上面同一套实现）----
export const BMS_ORIGIN = TARGETS.bms.origin;
export const KEYCHAIN_SERVICE = TARGETS.bms.keychain.service;
export const KEYCHAIN_ACCOUNT = TARGETS.bms.keychain.account;
export const BMS_PATH_DENY = Object.freeze({ first: Object.freeze([...FIRST_DENY]), substrings: ANY_DENY_SUBSTR });
export const normalizeBmsPath = (p) => normalizeBizPath('bms', p);
export const buildBmsUrl = (p, query) => buildBizUrl('bms', p, query);
export const redactBmsKey = (text) => redactBizText(text);
export const formatBmsResult = (r) => formatBizResult('bms', r);
