// 带工具的档常开仓库 .env、security 命令和 HOME 密钥路径的拒绝规则。
// 与基线夹具逐字比对前，先把这组规则从实际 argv 里拿掉；
// 拿掉后 --disallowedTools 若空了，整对参数也去掉（基线里本来就没有那一对）。
// 规则齐全由 hasSecretsDeny / secretsDenyOf 另行断言。
import os from 'node:os';
import path from 'node:path';

export const SECRETS_DENY_RE = [
  /^Read\(\/\/?[^)]*\/\.env\)$/,
  /^Read\(\/\/?[^)]*\/\.env\.\*\)$/,
  /^Bash\(security:\*\)$/,
  /^Bash\(\/usr\/bin\/security:\*\)$/,
];

// 独立的契约期望。直接从生产清单生成会漏掉删路径的回归。
export function homeSecretsDeny(prefix = `//${os.homedir().split(path.sep).join('/').replace(/^\/+|\/+$/g, '')}`) {
  return [
    '.brain-secrets', '.brain-client', '.ssh', '.config/claude-api', '.config/openai-api',
    '.config/claude-b', '.config/deepseek', '.config/bms-ai', '.config/starlight-r2',
    '.cloudflare*', '.codex', '.codex-s', '.codex-api-*', '.claude/.credentials*',
    '.claude-b/.credentials*', '.aws', '.netrc', '.npmrc',
  ].flatMap((p) => [`Read(${prefix}/${p})`, `Read(${prefix}/${p}/**)`]);
}

const normalizedHomeDeny = [homeSecretsDeny('/<home>'), homeSecretsDeny('/<tmp>/home')];
export const SECRETS_DENY_COUNT = SECRETS_DENY_RE.length + normalizedHomeDeny[0].length;

function homeDenySets() {
  return [homeSecretsDeny(), ...normalizedHomeDeny];
}

function secretMatcher() {
  const homeDeny = new Set(homeDenySets().flat());
  return (r) => homeDeny.has(r) || SECRETS_DENY_RE.some((re) => re.test(r));
}

/** args 里 --disallowedTools 的值（逗号分隔）；没有返回 null。 */
export function disallowedOf(args) {
  const i = args.indexOf('--disallowedTools');
  return i >= 0 && i + 1 < args.length ? String(args[i + 1]).split(',').filter(Boolean) : null;
}

/** 这个 argv 里出现的密钥拒绝规则（按出现顺序）。 */
export function secretsDenyOf(args) {
  return (disallowedOf(args) ?? []).filter(secretMatcher());
}

/** 原规则与一种 HOME 形式的规则是否各出现一次。 */
export function hasSecretsDeny(args) {
  const rules = secretsDenyOf(args);
  return rules.length === SECRETS_DENY_COUNT
    && SECRETS_DENY_RE.every((re) => rules.filter((r) => re.test(r)).length === 1)
    && homeDenySets().some((expected) => expected.every((rule) => rules.includes(rule)));
}

/** 返回去掉这组规则的新 argv；不改入参。 */
export function stripSecretsDeny(args) {
  const out = [...args];
  const i = out.indexOf('--disallowedTools');
  if (i < 0 || i + 1 >= out.length) return out;
  const isSecret = secretMatcher();
  const rest = String(out[i + 1]).split(',').filter((r) => r && !isSecret(r));
  if (rest.length) out[i + 1] = rest.join(',');
  else out.splice(i, 2);
  return out;
}

/** 快照对象 { args, … } 版：只换 args。 */
export function stripSnap(snap) {
  return { ...snap, args: stripSecretsDeny(snap.args) };
}

/** 整张矩阵 { profile: { case: snap } } 版。 */
export function stripMatrix(m) {
  return Object.fromEntries(Object.entries(m).map(([p, cases]) =>
    [p, Object.fromEntries(Object.entries(cases).map(([n, s]) => [n, stripSnap(s)]))]));
}
