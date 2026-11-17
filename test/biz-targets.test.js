// BRIDGE-BMS-1：biz_get 的目标表与纯判定（路径 / 参数 / URL / 脱敏 / 输出 / 审计字段）。
// 对应卡片测试 2（主机）、3（穿越 / 注入）、4（deny）、5（query）、6（脱敏部分）、8（截断 / 非 JSON 部分）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as T from '../src/biz-targets.js';

const SRC = fs.readFileSync(new URL('../src/biz-targets.js', import.meta.url), 'utf8');
const isInputError = (e) => e instanceof T.BizInputError;
const KEY = 'bms_sk_ZZTESTMARK_0123456789abcdef';
const IAS_KEY = `acc_ZZTESTMARK${'A'.repeat(33)}`;

describe('biz-targets：常量冻结、不读 env', () => {
  test('主机、前缀、钥匙串条目名是常量，改不动', () => {
    assert.equal(T.TARGETS.bms.origin, 'https://crm.gdsgroup.tech');
    assert.equal(T.TARGETS.ias.origin, 'https://finance.gds.ph');
    assert.equal(T.TARGETS.bms.prefix, '/api/v1');
    assert.equal(T.TARGETS.ias.prefix, '/api/v1');
    assert.deepEqual({ ...T.TARGETS.bms.keychain }, { service: 'com.demry.bms-agent.readonly', account: 'bms-readonly', label: 'BMS 只读 Key（私人助理桥）' });
    assert.deepEqual({ ...T.TARGETS.ias.keychain }, { service: 'com.demry.ias-agent.readonly', account: 'ias-readonly', label: 'IAS 只读 Key（私人助理桥）' });
    assert.equal(T.BMS_ORIGIN, 'https://crm.gdsgroup.tech');
    assert.equal(T.KEYCHAIN_SERVICE, 'com.demry.bms-agent.readonly');
    assert.equal(T.KEYCHAIN_ACCOUNT, 'bms-readonly');
    assert.equal(T.BIZ_TOOL, 'mcp__biz__biz_get');
    assert.deepEqual([...T.TARGET_IDS], ['bms', 'ias']);
    for (const o of [T.TARGETS, T.TARGETS.bms, T.TARGETS.ias, T.TARGETS.bms.keychain, T.TARGETS.ias.keychain, T.LIMITS, T.TARGET_IDS]) {
      assert.ok(Object.isFrozen(o));
    }
    assert.throws(() => { T.TARGETS.bms.origin = 'https://evil.example'; }, TypeError);
    assert.throws(() => { T.TARGETS.evil = {}; }, TypeError);
    assert.throws(() => { T.LIMITS.callsPerProcess = 1e9; }, TypeError);
    assert.equal(T.TARGETS.bms.origin, 'https://crm.gdsgroup.tech');
  });

  test('源码不读 process.env、不 import 任何模块（没有 env 能改主机 / 方法 / 条目名）', () => {
    assert.doesNotMatch(SRC, /process\.env/);
    assert.doesNotMatch(SRC, /^\s*import\s/m);
    assert.doesNotMatch(SRC, /\bimport\s*\(/);
    assert.doesNotMatch(SRC, /\brequire\s*\(/);
    assert.doesNotMatch(SRC, /\bfetch\s*\(/);
  });

  test('target 只认表里自己的键（不走原型链）', () => {
    for (const bad of ['evil', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'BMS', ' bms', null, undefined, 1, {}]) {
      assert.throws(() => T.targetOf(bad), isInputError);
      assert.throws(() => T.normalizeBizPath(bad, '/tickets'), isInputError);
    }
  });
});

describe('biz-targets：路径归一化（卡片测试 3 穿越 / 注入）', () => {
  test('/x 与 /api/v1/x 归成同一路径；ias 的 /api/v1 是索引', () => {
    assert.equal(T.normalizeBizPath('bms', '/tickets'), '/api/v1/tickets');
    assert.equal(T.normalizeBizPath('bms', '/api/v1/tickets'), '/api/v1/tickets');
    assert.equal(T.normalizeBmsPath('/tickets'), T.normalizeBmsPath('/api/v1/tickets'));
    assert.equal(T.normalizeBizPath('bms', '/tickets/T-2024.001_a~b/items'), '/api/v1/tickets/T-2024.001_a~b/items');
    assert.equal(T.normalizeBizPath('ias', '/api/v1'), '/api/v1');
    assert.equal(T.normalizeBizPath('ias', '/summary'), '/api/v1/summary');
    assert.equal(T.normalizeBizPath('ias', '/api/v1/guide'), '/api/v1/guide');
    assert.throws(() => T.normalizeBizPath('bms', '/api/v1'), isInputError); // bms 没有索引
  });

  // 卡片点名的 ≥12 个，加上绝对 URL / 协议相对 / userinfo / 端口 / 编码 / 非 ASCII 等
  const REJECT = [
    '/api/v1/../admin', '/tickets/..', '/tickets/./x', '/..', '/.', '/tickets/../../x',
    '/%2e%2e/admin', '/tickets/%2e%2e', '/tickets%2fadmin', '/tickets%2Fx', '/%252e%252e', '/tickets\\x', '\\tickets',
    '/tickets?x=1', '/tickets?', '/tickets#x', '/tickets#',
    '/tickets\nx', '/tickets\r', '/tickets\u0000', '/tickets\t', '/tickets x', ' /tickets', '/tickets ', '/tickets ',
    '/tickets;id', '/$(id)', '/`id`', '/tickets|id', '/tickets&x', '/tickets\'x', '/tickets"x', '/tickets<x>', '/tickets*',
    'https://evil.example/x', 'http://evil.example/x', '//evil.example/x', '///evil.example', 'evil.example/x', 'tickets',
    '/api/v1/@evil.example', '/@evil.example', '/user:pass@evil.example', '/api/v1/x:443', '/x:80', 'javascript:alert(1)',
    'file:///etc/passwd', '/tickets/', '/', '', '/a//b', '/api', '/api/v2/tickets', '/api/v1x/tickets', '/API/v1/tickets?',
    '/tickets/张三', '/ｔickets', '/tickets/​', `/${'a'.repeat(260)}`, `/api/v1/${'a/'.repeat(124)}a`,
  ];
  test(`${REJECT.length} 个穿越 / 注入 / 外部主机写法全部拒绝`, () => {
    assert.ok(REJECT.length >= 12);
    for (const p of REJECT) {
      for (const target of T.TARGET_IDS) {
        assert.throws(() => T.normalizeBizPath(target, p), isInputError, `${target} 应拒绝 ${JSON.stringify(p)}`);
        assert.throws(() => T.buildBizUrl(target, p), isInputError, `${target} 拼 URL 应拒绝 ${JSON.stringify(p)}`);
      }
    }
  });

  test('非字符串 path 拒绝；错误信息不回显输入', () => {
    for (const p of [undefined, null, 1, ['/tickets'], { toString: () => '/tickets' }]) {
      assert.throws(() => T.normalizeBizPath('bms', p), isInputError);
    }
    try {
      T.normalizeBizPath('bms', `/tickets/${KEY}?x`);
      assert.fail('应拒绝');
    } catch (e) {
      assert.ok(isInputError(e));
      assert.doesNotMatch(e.message, /ZZTESTMARK|tickets/);
    }
  });
});

describe('biz-targets：deny（卡片测试 4）', () => {
  const DENY_BMS = [
    '/api-keys', '/api-keys/1', '/API-KEYS', '/apikeys', '/api-key', '/admin/api-keys', '/admin/api_keys', '/users/1/apikey',
    '/auth', '/auth/feishu/login', '/auth/login', '/auth/me/x', '/auth/refresh', '/Auth/feishu',
    '/export/tickets', '/exports', '/tickets/export', '/collections/export-csv',
    '/heartbeat', '/ai/assist', '/ai', '/mcp', '/api/mcp', '/api/v1/mcp',
    '/payment-requests/x/voucher', '/payment-requests/1/vouchers', '/tickets/1/files', '/files/1', '/file',
    '/invoice-file/1', '/tickets/1/invoice-files', '/collections/1/download', '/downloads', '/users/profile',
  ];
  test('BMS：密钥 / 认证（除 auth/me）/ 导出 / 心跳 / AI / MCP / 文件类全部拒绝', () => {
    for (const p of DENY_BMS) assert.throws(() => T.normalizeBizPath('bms', p), isInputError, p);
  });
  test('IAS 同一套 deny；IAS 没有 auth/me 例外', () => {
    for (const p of [...DENY_BMS, '/auth/me', '/api/v1/auth/me']) assert.throws(() => T.normalizeBizPath('ias', p), isInputError, p);
  });
  test('/auth/me 放行（bms 自检），常用资源放行', () => {
    assert.equal(T.normalizeBizPath('bms', '/auth/me'), '/api/v1/auth/me');
    assert.equal(T.normalizeBizPath('bms', '/api/v1/auth/me'), '/api/v1/auth/me');
    for (const p of ['/dashboard', '/dashboard/drilldown', '/tickets/1/derivation', '/accounts/9/follow-ups', '/commissions/3/explanation',
      '/admin/audit-logs', '/payment-requests', '/collections/5/review', '/items/2/subtasks']) {
      assert.equal(T.normalizeBizPath('bms', p), `/api/v1${p}`);
    }
    for (const p of ['/reports/pnl', '/ar/aging', '/ledger', '/transactions', '/guide']) assert.equal(T.normalizeBizPath('ias', p), `/api/v1${p}`);
  });
  test('BMS_PATH_DENY 导出的规则是冻结的', () => {
    assert.ok(Object.isFrozen(T.BMS_PATH_DENY) && Object.isFrozen(T.BMS_PATH_DENY.first) && Object.isFrozen(T.BMS_PATH_DENY.substrings));
    for (const x of ['api-keys', 'auth', 'export', 'heartbeat', 'ai', 'mcp']) assert.ok(T.BMS_PATH_DENY.first.includes(x), x);
    for (const x of ['voucher', 'invoice-file', 'download', 'file', 'files']) assert.ok(T.BMS_PATH_DENY.substrings.includes(x), x);
  });
});

describe('biz-targets：query 与 URL（卡片测试 2 / 5）', () => {
  test('参数名格式不对一律拒绝', () => {
    for (const k of ['', '1a', '_a', 'a-b', 'a b', 'a.b', 'a[b]', 'a[]', 'a=b', '__proto__', 'ä', 'a'.repeat(42)]) {
      assert.throws(() => T.bizQueryPairs('bms', { [k]: 'x' }), isInputError, JSON.stringify(k));
    }
    assert.deepEqual(T.bizQueryPairs('bms', { ['a'.repeat(41)]: 'x' }), [['a'.repeat(41), 'x']]);
  });
  test('值只收字符串 / 有限数字 / 布尔（或其数组），≤200 字、无控制字符', () => {
    for (const v of [null, undefined, {}, [[1]], [{}], NaN, Infinity, () => 1, 'x'.repeat(201), 'a\nb', 'a\u0000', '\u007f']) {
      assert.throws(() => T.bizQueryPairs('bms', { q: v }), isInputError, String(v));
    }
    assert.deepEqual(T.bizQueryPairs('bms', { q: 'x'.repeat(200), n: 3, b: false }), [['q', 'x'.repeat(200)], ['n', '3'], ['b', 'false']]);
    for (const q of ['status=open', ['a'], 1]) assert.throws(() => T.bizQueryPairs('bms', q), isInputError);
    assert.deepEqual(T.bizQueryPairs('bms', undefined), []);
  });
  test('limit 等分页大小截到上限（bms 100 / ias 200），非正整数拒绝', () => {
    assert.deepEqual(T.bizQueryPairs('bms', { limit: 500 }), [['limit', '100']]);
    assert.deepEqual(T.bizQueryPairs('bms', { limit: '500', pageSize: 1000, per_page: 0 }), [['limit', '100'], ['pageSize', '100'], ['per_page', '1']]);
    assert.deepEqual(T.bizQueryPairs('ias', { limit: 500 }), [['limit', '200']]);
    assert.deepEqual(T.bizQueryPairs('bms', { limit: 20, page: 3 }), [['limit', '20'], ['page', '3']]);
    for (const v of ['abc', -5, 1.5, '1e3', ' 10', '']) assert.throws(() => T.bizQueryPairs('bms', { limit: v }), isInputError, String(v));
    assert.equal(T.buildBmsUrl('/tickets', { limit: 500 }).searchParams.get('limit'), '100');
  });
  test('数组展开成同名多值；超过 30 个拒绝', () => {
    assert.deepEqual(T.bizQueryPairs('bms', { status: ['open', 'closed'], line: 'A' }), [['status', 'open'], ['status', 'closed'], ['line', 'A']]);
    assert.equal(T.buildBizUrl('bms', '/tickets', { status: ['open', 'closed'] }).search, '?status=open&status=closed');
    const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));
    assert.equal(T.bizQueryPairs('bms', many(30)).length, 30);
    assert.throws(() => T.bizQueryPairs('bms', many(31)), isInputError);
    assert.throws(() => T.bizQueryPairs('bms', { a: Array(31).fill('v') }), isInputError);
    assert.throws(() => T.bizQueryPairs('bms', { ...many(29), a: ['1', '2'] }), isInputError);
  });
  test('拼出的 URL：固定 origin、pathname 逐字、值被编码、没有 userinfo / hash', () => {
    assert.equal(T.buildBizUrl('bms', '/tickets', { q: 'x' }).href, 'https://crm.gdsgroup.tech/api/v1/tickets?q=x');
    assert.equal(T.buildBizUrl('ias', '/api/v1').href, 'https://finance.gds.ph/api/v1');
    const u = T.buildBizUrl('bms', '/accounts', { q: 'a&b=c#d/../@evil.example:443?x', name: '张三 13800138000' });
    assert.equal(u.origin, 'https://crm.gdsgroup.tech');
    assert.equal(u.pathname, '/api/v1/accounts');
    assert.equal(u.hash, '');
    assert.equal(u.username + u.password, '');
    assert.equal(u.searchParams.get('q'), 'a&b=c#d/../@evil.example:443?x');
    assert.deepEqual([...u.searchParams.keys()], ['q', 'name']);
  });
  test('最后一道断言 urlIsSane：他域 origin、带 userinfo、带 hash、pathname 不等都返回 false；buildBizUrl 用的就是它', () => {
    for (const id of T.TARGET_IDS) {
      const t = T.TARGETS[id];
      const full = `${t.prefix}/tickets`;
      assert.equal(T.urlIsSane(new URL(`${t.origin}${full}?q=1`), t, full), true, id);
      const bad = {
        otherOrigin: new URL(`https://evil.example${full}`),
        otherPort: new URL(`${t.origin}:8443${full}`),
        userinfo: new URL(`${t.origin.replace('https://', 'https://u:p@')}${full}`),
        userOnly: new URL(`${t.origin.replace('https://', 'https://u@')}${full}`),
        hash: new URL(`${t.origin}${full}#frag`),
        pathname: new URL(`${t.origin}${full}/x`),
        pathCase: new URL(`${t.origin}${full.toUpperCase()}`),
      };
      for (const [name, u] of Object.entries(bad)) assert.equal(T.urlIsSane(u, t, full), false, `${id}/${name}`);
    }
    assert.match(SRC, /const sane = \(\) => urlIsSane\(u, t, full\);/);
  });
});

describe('biz-targets：脱敏与输出（卡片测试 6 / 8 的纯函数部分）', () => {
  test('两种 Key 格式、Bearer 头、调用方给的原文都被抹掉', () => {
    assert.equal(T.redactBizText(`x ${KEY} y`), 'x bms_sk_*** y');
    assert.equal(T.redactBmsKey(`k=${KEY}`), 'k=bms_sk_***');
    assert.equal(T.redactBizText(`x ${IAS_KEY} y`), 'x acc_*** y');
    assert.equal(T.redactBizText('Authorization: Bearer abcdefgh12345678'), 'Authorization: Bearer ***');
    assert.equal(T.redactBizText('raw ZZTESTMARKsecret!', ['ZZTESTMARKsecret!']), 'raw ***');
    assert.equal(T.redactBizText('account_number acc_short'), 'account_number acc_short'); // 普通字段名不误伤
  });

  test('成功 JSON 原样（脱敏后）；超过 40000 字截断并附说明', () => {
    assert.equal(T.formatBizResult('bms', { kind: 'json', status: 200, path: '/api/v1/tickets', data: { a: 1, key: KEY } }),
      'BMS GET /api/v1/tickets · HTTP 200\n{"a":1,"key":"bms_sk_***"}');
    const big = T.formatBizResult('ias', { kind: 'json', status: 200, path: '/api/v1/ledger', data: { rows: 'x'.repeat(50_000) } });
    assert.match(big, /\[已截断：结果超过 40000 字符。请加筛选条件或分页（limit \/ page）后再查\]$/);
    assert.ok(big.length < 40_000 + 200);
    const exact = T.clipBizText('y'.repeat(40_000));
    assert.equal(exact, 'y'.repeat(40_000));
  });

  test('非 JSON 只给元数据，不展示正文', () => {
    const out = T.formatBizResult('bms', {
      kind: 'non-json', status: 403, path: '/api/v1/tickets', contentType: 'text/html; charset=UTF-8', bytes: 5120,
      requestId: 'rid-1', text: '<html>Just a moment ZZTESTMARK</html>',
    });
    assert.equal(out, 'BMS GET /api/v1/tickets · HTTP 403 · request-id=rid-1\n返回的不是 JSON（text/html，5120 字节），内容未展示。\n提示：可能是被对方防火墙（如 Cloudflare）拦下，或这把 Key 没有权限');
    assert.match(T.formatBizResult('bms', { kind: 'non-json', status: 200, contentType: 'evil\r\nX-Injected: 1', bytes: 3 }), /（未知类型，3 字节）/);
  });

  test('错误只带状态码、error.code、error.message（≤200 字）、x-request-id', () => {
    const out = T.formatBizResult('bms', {
      kind: 'http-error', status: 401, path: '/api/v1/auth/me', requestId: 'req-42',
      data: { error: { code: 'UNAUTHORIZED', message: `invalid key ${KEY} ${'m'.repeat(400)}`, detail: 'SECRET-DETAIL' }, debug: { headers: 'SECRET-HEADERS' } },
    });
    const [first, hint] = out.split('\n');
    assert.match(first, /^BMS GET \/api\/v1\/auth\/me · HTTP 401 · code=UNAUTHORIZED · invalid key bms_sk_\*\*\* m+ · request-id=req-42$/);
    const msg = first.split(' · ')[3];
    assert.ok(msg.length <= 200, `message ${msg.length} 字`);
    assert.match(hint, /^提示：Key 无效/);
    assert.doesNotMatch(out, /ZZTESTMARK|SECRET-DETAIL|SECRET-HEADERS/);
    // request-id 格式不对就不带；code 含奇怪字符就不带
    const odd = T.formatBizResult('bms', { kind: 'http-error', status: 500, requestId: 'a b\nc', data: { error: { code: 'x y', message: 'boom' } } });
    assert.equal(odd, 'BMS GET /api/v1 · HTTP 500 · boom\n提示：对方服务出错，请稍后再查');
    assert.match(T.formatBizResult('bms', { kind: 'http-error', status: 404, path: '/api/v1/tickets/9', data: null }), /「未找到」可能只是没有权限/);
  });

  test('最后整段再脱敏一遍：error.code、request-id 里像 Key 的也抹掉', () => {
    const body = KEY.slice('bms_sk_'.length);
    const out = T.formatBizResult('bms', {
      kind: 'http-error', status: 400, path: '/api/v1/tickets', requestId: body,
      data: { error: { code: KEY, message: 'bad' } }, secrets: [KEY, body],
    });
    assert.equal(out, 'BMS GET /api/v1/tickets · HTTP 400 · code=*** · bad · request-id=***');
    // 没给 secrets 时靠格式规则兜底
    assert.equal(T.formatBizResult('bms', { kind: 'http-error', status: 400, path: '/api/v1/tickets', data: { code: KEY } }),
      'BMS GET /api/v1/tickets · HTTP 400 · code=bms_sk_***');
    const nj = T.formatBizResult('ias', {
      kind: 'non-json', status: 502, path: '/api/v1', requestId: `rid-${IAS_KEY}`, contentType: 'text/html', bytes: 1,
      secrets: [IAS_KEY, IAS_KEY.slice('acc_'.length)],
    });
    assert.equal(nj, 'IAS GET /api/v1 · HTTP 502 · request-id=rid-***\n返回的不是 JSON（text/html，1 字节），内容未展示。\n提示：对方服务出错，请稍后再查');
  });

  test('重定向 / 超时 / 网络错误 / 过大：固定文案，不带 Location、不带错误原文', () => {
    assert.equal(T.formatBizResult('bms', { kind: 'redirect', status: 302, path: '/api/v1/tickets' }),
      'BMS GET /api/v1/tickets · HTTP 302\n对方要求重定向，已拒绝跟随（只访问固定主机，不跟随任何跳转）。');
    assert.match(T.formatBizResult('bms', { kind: 'timeout', path: '/api/v1/tickets' }), /^BMS GET \/api\/v1\/tickets\n请求超时（15 秒），已中止。/);
    assert.equal(T.formatBizResult('ias', { kind: 'network', path: '/api/v1', reason: 'ECONNRESET' }), 'IAS GET /api/v1\n网络错误（ECONNRESET），请求没有完成。');
    assert.equal(T.formatBizResult('ias', { kind: 'network', path: '/api/v1', reason: `fetch failed ${KEY}` }), 'IAS GET /api/v1\n网络错误，请求没有完成。');
    assert.match(T.formatBizResult('bms', { kind: 'too-large', status: 200, path: '/api/v1/tickets' }), /响应超过 1 MB，已停止读取并丢弃。/);
  });

  test('缺 Key 的固定说明：条目名 + 不含密钥的写入命令模板', () => {
    const b = T.missingKeyText('bms');
    assert.match(b, /^BMS 查询未配置：钥匙串里没有可用的「com\.demry\.bms-agent\.readonly」（账号 bms-readonly），请 owner 写入。/);
    assert.ok(b.includes('security add-generic-password -U -a bms-readonly -s com.demry.bms-agent.readonly -l "BMS 只读 Key（私人助理桥）" -T /usr/bin/security -w'));
    const i = T.missingKeyText('ias');
    assert.ok(i.includes('security add-generic-password -U -a ias-readonly -s com.demry.ias-agent.readonly -l "IAS 只读 Key（私人助理桥）" -T /usr/bin/security -w'));
    assert.doesNotMatch(b + i, /bms_sk_|acc_/);
  });
});

describe('biz-targets：审计字段只记 target / 类别 / get', () => {
  test('不记 query、完整路径与任何内容', () => {
    assert.deepEqual(T.bizAuditFields({ target: 'bms', path: '/tickets/13800138000', query: { q: KEY } }), { domain: 'bms', cmd: 'tickets', method: 'get' });
    assert.deepEqual(T.bizAuditFields({ target: 'bms', path: '/api/v1/Accounts/9' }), { domain: 'bms', cmd: 'accounts', method: 'get' });
    assert.deepEqual(T.bizAuditFields({ target: 'ias', path: '/api/v1' }), { domain: 'ias', cmd: 'index', method: 'get' });
    assert.deepEqual(T.bizAuditFields({ target: 'bms', path: '/zzunknown' }), { domain: 'bms', cmd: 'other', method: 'get' });
    assert.deepEqual(T.bizAuditFields({ target: 'bms', path: `/x?${KEY}` }), { domain: 'bms', cmd: 'invalid', method: 'get' });
    assert.deepEqual(T.bizAuditFields({ target: 'evil', path: '/tickets' }), { domain: null, cmd: null, method: 'get' });
    assert.deepEqual(T.bizAuditFields(undefined), { domain: null, cmd: null, method: 'get' });
    assert.doesNotMatch(JSON.stringify(T.bizAuditFields({ target: 'bms', path: '/auth/me', query: { email: KEY } })), /ZZTESTMARK|email/);
  });
});
