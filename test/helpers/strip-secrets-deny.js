// BRIDGE-PRIV-1：.env 拒读 + security 拒绝这 4 条规则现在对所有「有工具」的档常开。
// 既有的 argv 逐字比对（基线夹具）比的是别的东西，所以比对前先把这 4 条从实际 argv 里拿掉；
// 拿掉后 --disallowedTools 若空了，整对参数也去掉（基线里本来就没有那一对）。
// 「有这 4 条」本身由 hasSecretsDeny / secretsDenyOf 另行断言，不靠这个函数。
export const SECRETS_DENY_RE = [
  /^Read\(\/\/?[^)]*\/\.env\)$/,
  /^Read\(\/\/?[^)]*\/\.env\.\*\)$/,
  /^Bash\(security:\*\)$/,
  /^Bash\(\/usr\/bin\/security:\*\)$/,
];
const isSecret = (r) => SECRETS_DENY_RE.some((re) => re.test(r));

/** args 里 --disallowedTools 的值（逗号分隔）；没有返回 null。 */
export function disallowedOf(args) {
  const i = args.indexOf('--disallowedTools');
  return i >= 0 && i + 1 < args.length ? String(args[i + 1]).split(',').filter(Boolean) : null;
}

/** 这个 argv 里出现的 4 条规则（按出现顺序）。 */
export function secretsDenyOf(args) {
  return (disallowedOf(args) ?? []).filter(isSecret);
}

/** 4 条规则是否齐全。 */
export function hasSecretsDeny(args) {
  return secretsDenyOf(args).length === 4 && new Set(secretsDenyOf(args)).size === 4;
}

/** 返回去掉这 4 条规则的新 argv；不改入参。 */
export function stripSecretsDeny(args) {
  const out = [...args];
  const i = out.indexOf('--disallowedTools');
  if (i < 0 || i + 1 >= out.length) return out;
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
