import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BRAIN_ENDPOINT, BRAIN_KEYCHAIN, BRAIN_LIMITS, BRAIN_TOOL_NAMES, BRAIN_USER_AGENT } from './brain-targets.js';
import { fencedMcpResult } from './tool-audit.js';

const INPUTS = {
  brain_search: z.strictObject({
    // JSON Schema 的 maxLength 按码点计，Zod 的字符串长度按 UTF-16 单元计。
    query: z.string().min(1)
      .refine((query) => query.length <= BRAIN_LIMITS.queryCodePoints * 2
        && [...query].length <= BRAIN_LIMITS.queryCodePoints)
      .meta({ maxLength: BRAIN_LIMITS.queryCodePoints }),
    k: z.number().int().min(1).max(10).optional(),
    domain: z.string().min(1).optional(),
    include_raw: z.boolean().optional(),
    include_history: z.boolean().optional(),
  }),
  brain_read: z.strictObject({ id: z.string().min(1), version: z.number().int().positive().optional() }),
  brain_list: z.strictObject({
    domain: z.string().min(1).optional(),
    updated_since: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  brain_whoami: z.strictObject({}),
};

const DESCRIPTIONS = {
  brain_search: '检索公司大脑，返回条目 ID、标题和摘要。可按领域过滤。',
  brain_read: '按条目 ID 读取公司大脑资料，可指定版本。',
  brain_list: '分页列出公司大脑条目，可按领域和更新时间过滤。',
  brain_whoami: '查看公司大脑身份、读取权限与剩余配额。',
};

const UNAVAILABLE = '大脑暂时不可用';
const QUOTA = '大脑额度用完';
const TIMEOUT = Symbol('timeout');
const TOO_LARGE = Symbol('too-large');
const textResult = (text) => ({ content: [{ type: 'text', text }] });
const fenced = fencedMcpResult('公司大脑', textResult);
const failure = (text = UNAVAILABLE, status) => ({ status, result: { ...textResult(text), isError: true } });

function readKeychain(field, spawn, home) {
  const { account, service } = BRAIN_KEYCHAIN[field];
  try {
    const r = spawn('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service, '-w'], {
      timeout: BRAIN_LIMITS.keychainTimeoutMs,
      maxBuffer: 4096,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: home },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!r || r.error || r.status !== 0 || r.signal || typeof r.stdout !== 'string') return null;
    const value = r.stdout.replace(/\n$/, '');
    if (!value || value.length > 4096 || /[^\x21-\x7E]/.test(value)) return null;
    if (field === 'unionId' && (value.length > 200 || /[^A-Za-z0-9_-]/.test(value))) return null;
    return value;
  } catch {
    return null;
  }
}

async function readBody(response, signal) {
  if (Number(response.headers.get('content-length')) > BRAIN_LIMITS.bodyBytes) throw TOO_LARGE;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing response body');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > BRAIN_LIMITS.bodyBytes) throw TOO_LARGE;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

function rpcReply(text, type, id) {
  if (type === 'application/json') return JSON.parse(text);
  if (type === 'text/event-stream') {
    for (const frame of text.split(/\r?\n\r?\n/)) {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      const message = JSON.parse(data);
      if (message?.id === id) return message;
    }
    return null;
  }
  throw new Error('unexpected media type');
}

function whoamiSummary(data, secrets) {
  const { agent_id, read_max_tier, raw_allowed, remaining } = data ?? {};
  if (typeof agent_id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(agent_id)
    || !['L1', 'L2', 'L3'].includes(read_max_tier) || typeof raw_allowed !== 'boolean'
    || !remaining || typeof remaining !== 'object' || Array.isArray(remaining)) return undefined;
  const summary = { agent_id, read_max_tier, raw_allowed, remaining: {} };
  for (const tool of BRAIN_TOOL_NAMES) {
    const name = tool.slice(6);
    const quota = remaining[name];
    if (!quota || typeof quota !== 'object' || Array.isArray(quota)) continue;
    const windows = {};
    for (const window of ['minute', 'hour', 'day']) {
      const count = quota[window];
      if (Number.isSafeInteger(count) && count >= 0) windows[window] = count;
    }
    if (Object.keys(windows).length) summary.remaining[name] = windows;
  }
  const printed = JSON.stringify(summary);
  if (Object.keys(summary.remaining).length && !secrets.some((value) => printed.includes(value))) return summary;
  return undefined;
}

function toolResult(payload, name, secrets, status) {
  const parts = Array.isArray(payload.content) ? payload.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text) : [];
  if (payload.isError === true || (payload.structuredContent == null && parts.some((part) =>
    /^\[brain\] (?:rate_limited|not_available|schema:|error\b)/.test(part)))) {
    return failure(parts.includes('[brain] rate_limited') ? QUOTA : UNAVAILABLE, status);
  }
  if (payload.structuredContent != null) parts.unshift(JSON.stringify(payload.structuredContent));
  if (!parts.length) return failure(UNAVAILABLE, status);
  let text = parts.join('\n');
  for (const value of secrets) {
    const escaped = JSON.stringify(value).slice(1, -1);
    text = text.replaceAll(escaped, '[已移除的凭据]').replaceAll(value, '[已移除的凭据]');
  }
  // 上游的标记也只是资料。保留外层唯一的、由桥生成的围栏。
  text = text.replace(/<<<\s*(?:END_)?BRAIN_DATA[\w-]*|-*BRAIN_DATA_END[\w-]*/gi, '[已移除的伪造标记]');
  const summary = name === 'brain_whoami' ? whoamiSummary(payload.structuredContent, secrets) : undefined;
  return { status, result: fenced(text.slice(0, BRAIN_LIMITS.resultChars)), summary };
}

async function request({ name, input, id, secrets, fetch, timeoutMs, log }) {
  const [key, cfId, cfSecret, unionId] = secrets;
  const controller = new AbortController();
  let timer;
  let response;
  let status;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(TIMEOUT), timeoutMs); });
  try {
    response = await Promise.race([fetch(BRAIN_ENDPOINT, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'CF-Access-Client-Id': cfId,
        'CF-Access-Client-Secret': cfSecret,
        'X-Brain-Channel': 'dm',
        'X-Brain-Asker': JSON.stringify({ kind: 'feishu_union_id', value: unionId }),
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': BRAIN_USER_AGENT,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: name.slice(6), arguments: input } }),
    }), deadline]);
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) {
      status = response.status;
      log(`brain-http-${status}`);
    }
    if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
      log('brain-redirect');
      return failure(UNAVAILABLE, status);
    }
    if (!status || status < 200 || status >= 300) return failure(status === 429 ? QUOTA : UNAVAILABLE, status);
    const text = await Promise.race([readBody(response, controller.signal), deadline]);
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const reply = rpcReply(text, contentType, id);
    if (reply?.jsonrpc !== '2.0' || reply.id !== id || !reply.result || reply.error) return failure(UNAVAILABLE, status);
    return toolResult(reply.result, name, secrets, status);
  } catch (error) {
    log(error === TIMEOUT ? 'brain-timeout' : error === TOO_LARGE ? 'brain-too-large' : 'brain-network');
    return failure(UNAVAILABLE, status);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}

export function createBrainClient({
  spawn = spawnSync, home = os.homedir(), fetch = globalThis.fetch,
  now = () => performance.now(), timeoutMs = BRAIN_LIMITS.timeoutMs, log = console.error,
} = {}) {
  let count = 0;
  const recent = [];
  return async (name, args = {}) => {
    if (!BRAIN_TOOL_NAMES.includes(name)) return failure('大脑工具不可用');
    const parsed = INPUTS[name].safeParse(args);
    if (!parsed.success) return failure('大脑工具参数不合法');
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return failure();
    const current = now();
    while (recent.length && current - recent[0] >= BRAIN_LIMITS.minuteMs) recent.shift();
    if (count >= BRAIN_LIMITS.callsPerProcess || recent.length >= BRAIN_LIMITS.callsPerMinute) return failure(QUOTA);
    recent.push(current);
    const id = ++count;

    const secrets = [];
    try {
      for (const field of Object.keys(BRAIN_KEYCHAIN)) {
        const value = readKeychain(field, spawn, home);
        if (!value) {
          log('brain_keychain_missing');
          return failure('大脑暂时不可用（本机未配置）');
        }
        secrets.push(value);
      }
      return await request({ name, input: parsed.data, id, secrets, fetch, timeoutMs, log });
    } finally {
      secrets.length = 0;
    }
  };
}

export function createBrainServer(call = createBrainClient()) {
  const server = new Server({ name: 'brain', version: '1.0.0' }, { capabilities: { tools: {} } });
  const tools = BRAIN_TOOL_NAMES.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: z.toJSONSchema(INPUTS[name], { target: 'draft-7' }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  }));
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => (await call(params.name, params.arguments)).result);
  return server;
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  await createBrainServer().connect(new StdioServerTransport());
}
