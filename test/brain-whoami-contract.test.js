import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createBrainClient } from '../src/mcp-brain.js';
import { runBrainCheck } from '../scripts/brain-check.js';

// The fixture is the third argument to receipt() from .tmp/brief/whoami.ts,
// evaluated with stub access and usage data, including the generated rate keys.
const WHOAMI = JSON.parse(readFileSync(new URL('./fixtures/brain-whoami.json', import.meta.url), 'utf8'));

function stubBrain(result, status = 200) {
  return createBrainClient({
    spawn: () => ({ status: 0, stdout: 'stub-keychain-value\n' }),
    fetch: async (_url, { body }) => Response.json({ jsonrpc: '2.0', id: JSON.parse(body).id, result }, { status }),
    log: () => {},
  });
}

async function check(call) {
  const lines = [];
  const exit = await runBrainCheck({ call, log: (line) => lines.push(line) });
  assert.equal(lines.length, 1);
  return { exit, line: lines[0] };
}

test('producer whoami response succeeds through the tool and brain-check without a person field', async () => {
  const call = stubBrain({ structuredContent: WHOAMI });
  const { result } = await call('brain_whoami');
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /"read_tiers":\["L1"\]/);
  const { exit, line } = await check(call);
  assert.equal(exit, 0);
  assert.deepEqual(JSON.parse(line), {
    agent_id: 'private-assistant-owner', channel: 'dm', read_tiers: ['L1'], raw_allowed: true,
    rate: {
      search_minute_left: 8, search_day_left: 180, read_minute_left: 119, list_minute_left: 60, whoami_minute_left: 29,
    },
    identity_check: '身份由 Asker 头核验',
  });
});

test('missing or malformed whoami fields give the tool and brain-check a field-specific error', async () => {
  for (const [field, structuredContent] of [
    ['structuredContent', undefined],
    ['agent_id', { ...WHOAMI, agent_id: undefined }],
    ['channel', { ...WHOAMI, channel: undefined }],
    ['read_tiers', { ...WHOAMI, read_tiers: undefined }],
    ['raw_allowed', { ...WHOAMI, raw_allowed: undefined }],
    ['rate', { ...WHOAMI, rate: undefined }],
    ['rate.whoami_minute_left', { ...WHOAMI, rate: { ...WHOAMI.rate, whoami_minute_left: undefined } }],
    ['rate.search_day_left', { ...WHOAMI, rate: { ...WHOAMI.rate, search_day_left: -1 } }],
  ]) {
    const call = stubBrain({ structuredContent });
    const { result } = await call('brain_whoami');
    const message = `大脑暂时不可用（brain_whoami_invalid:${field}）`;
    assert.equal(result.isError, true, field);
    assert.equal(result.content[0].text, message);
    assert.deepEqual(await check(call), { exit: 1, line: message });
  }
});

test('brain-check requires the owner agent, DM channel and L1 among the readable tiers', async () => {
  for (const [field, value] of [['agent_id', 'another-agent'], ['channel', 'group'], ['read_tiers', ['L2']]]) {
    const call = stubBrain({ structuredContent: { ...WHOAMI, [field]: value } });
    const { exit, line } = await check(call);
    assert.equal(exit, 1, field);
    assert.match(line, /brain_whoami_unexpected_access/);
  }
  const call = stubBrain({ structuredContent: { ...WHOAMI, read_tiers: ['L2', 'L1'] } });
  assert.equal((await check(call)).exit, 0);
});

test('brain-check uses actual rate-limit failures and accepts the last permitted call', async () => {
  const rate = { ...WHOAMI.rate, whoami_minute_left: 0 };
  assert.equal((await check(stubBrain({ structuredContent: { ...WHOAMI, rate } }))).exit, 0);
  const limited = { isError: true, content: [{ type: 'text', text: '[brain] rate_limited' }] };
  for (const status of [200, 429]) {
    const call = stubBrain(limited, status);
    assert.equal((await call('brain_whoami')).result.content[0].text, '大脑额度用完');
    assert.equal((await check(call)).exit, 1);
  }
});
