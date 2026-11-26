export const BRAIN_SERVER = 'brain';
export const BRAIN_ENDPOINT = 'https://brain.gdsgroup.tech/mcp';
export const BRAIN_TOOL_NAMES = Object.freeze(['brain_search', 'brain_read', 'brain_list', 'brain_whoami']);
export const BRAIN_ALLOWED_TOOLS = Object.freeze(BRAIN_TOOL_NAMES.map((name) => `mcp__${BRAIN_SERVER}__${name}`));

export const BRAIN_KEYCHAIN = Object.freeze({
  key: Object.freeze({ account: 'private-assistant-owner', service: 'com.demry.brain-bridge.key' }),
  cfId: Object.freeze({ account: 'brain-mac-agents', service: 'com.demry.brain-bridge.cf-client-id' }),
  cfSecret: Object.freeze({ account: 'brain-mac-agents', service: 'com.demry.brain-bridge.cf-client-secret' }),
  unionId: Object.freeze({ account: 'private-assistant-owner', service: 'com.demry.brain-bridge.feishu-union-id' }),
});

export const BRAIN_LIMITS = Object.freeze({
  queryCodePoints: 200,
  callsPerProcess: 30,
  callsPerMinute: 20,
  minuteMs: 60_000,
  timeoutMs: 15_000,
  keychainTimeoutMs: 5_000,
  bodyBytes: 1024 * 1024,
  resultChars: 40_000,
});
