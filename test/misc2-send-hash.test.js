// BRIDGE-MISC-2 S09：卡片 / 降级文本的 uuid 要覆盖正文全文，不能只哈希开头一段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendCardWithFallback } from '../src/events.js';

const K = 'a'.repeat(32);
const ok = { data: { message_id: 'om_1' } };
const httpErr = () => Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { code: 230099 } } });
const fake = (impl) => { const reqs = []; return { reqs, create: async (d) => { reqs.push(d); return impl(d, reqs.length); } }; };
const uuids = async (text, failFirstWith400 = false) => {
  const f = fake((d, i) => { if (failFirstWith400 && i === 1) throw httpErr(); return ok; });
  await sendCardWithFallback(f.create, text, { idempotencyKey: K });
  return f.reqs.map((r) => r.uuid);
};
const same = 'x'.repeat(4_999);

test('K1 前 4 999 字相同、第 5 000 字不同 → 卡片 uuid 不同；HTTP 400 降级文本的 uuid 也不同', async () => {
  const [a] = await uuids(`${same}甲`);
  const [b] = await uuids(`${same}乙`);
  assert.ok(a && b);
  assert.notEqual(a, b);
  const [, ta] = await uuids(`${same}甲`, true);
  const [, tb] = await uuids(`${same}乙`, true);
  assert.ok(ta && tb);
  assert.notEqual(ta, tb);
});

test('K1b 只在第 101 字不同 → uuid 不同', async () => {
  const head = 'y'.repeat(100);
  const [a] = await uuids(`${head}甲${'z'.repeat(50)}`);
  const [b] = await uuids(`${head}乙${'z'.repeat(50)}`);
  assert.notEqual(a, b);
  const [, ta] = await uuids(`${head}甲${'z'.repeat(50)}`, true);
  const [, tb] = await uuids(`${head}乙${'z'.repeat(50)}`, true);
  assert.notEqual(ta, tb);
});
