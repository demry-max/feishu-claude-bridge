// BRIDGE-MISC-2 S10：放行给 claude 子进程的名单里，名字像密钥的只有 CLAUDE_CODE_OAUTH_TOKEN 一个。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSTHROUGH } from '../src/child-env.js';

test('E1 PASSTHROUGH 里名字匹配密钥类正则的恰好是 CLAUDE_CODE_OAUTH_TOKEN', () => {
  const secretLike = Object.keys(PASSTHROUGH).filter((k) => /SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE/i.test(k));
  assert.deepEqual(secretLike, ['CLAUDE_CODE_OAUTH_TOKEN']);
});
