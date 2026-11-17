// 桥接与飞书官方 lark-cli 共用一个飞书应用。
//
// 两边建应用走的是同一个飞书注册接口（/oauth/v1/app/registration，archetype=PersonalAgent，扫码授权）：
//   - 桥接：npm run register，凭据写进 .env；
//   - lark-cli：lark-cli config init --new（安装向导 `npx @larksuite/cli install` 在有终端时也会调它），
//     App ID 记在 lark-cli 自己的配置里（`lark-cli config show` 的 JSON 里有 appId），App Secret 存系统钥匙串，
//     lark-cli 没有导出 Secret 的命令。
// 每扫一次码就是一个新应用，两边各扫一次就是两个应用。所以能自动化的方向是「桥接 → lark-cli」：
// 用 `lark-cli config init --app-id <ID> --app-secret-stdin --brand <feishu|lark>` 把 .env 里的凭据交给 lark-cli，
// Secret 只经 stdin 传，不进命令行参数（ps 可见）也不进任何输出。
import { item, defaultRun, scrubSecrets } from './checks.js';

const APP_ID_RE = /^cli_[A-Za-z0-9]+$/;

/** 与 register.js 相同的取法：shell 环境优先，FEISHU_DOMAIN=lark 是国际版 */
export function larkBrand(values = {}, env = process.env) {
  return (env.FEISHU_DOMAIN ?? values.FEISHU_DOMAIN) === 'lark' ? 'lark' : 'feishu';
}

/** lark-cli 当前配置的应用：只取 appId（其余字段一概不读，更不返回） */
export function readLarkCliApp({ bin = 'lark-cli', run = defaultRun, env = process.env } = {}) {
  const r = run(bin, ['config', 'show'], { env, timeout: 10_000 });
  if (r.error === 'ENOENT') return { installed: false, appId: null };
  if (!r.ok) return { installed: true, appId: null };
  let appId = null;
  try {
    const v = JSON.parse(r.stdout).appId;
    if (typeof v === 'string' && APP_ID_RE.test(v)) appId = v;
  } catch { /* 不是 JSON：当作未配置 */ }
  return { installed: true, appId };
}

const LINK = 'npm run setup -- --link-lark-cli';
const AUTH_NEXT = '下一步 [需要人]：lark-cli 的用户身份登录。agent 跑 `lark-cli auth login --recommend --no-wait` 取授权链接转给人，' +
  '人在浏览器同意后跑 `lark-cli auth login --device-code <输出里的 device code>`；或人自己在终端跑 `lark-cli auth login --recommend`';

/** setup 里的只读检查：lark-cli 与桥接是不是同一个应用。没装 lark-cli、两边都没应用时不报。 */
export function checkLarkCliApp(values = {}, { bin = 'lark-cli', run = defaultRun, env = process.env } = {}) {
  const { installed, appId } = readLarkCliApp({ bin, run, env });
  if (!installed) return [];
  const ours = values.FEISHU_APP_ID || '';
  const title = 'lark-cli 应用';
  if (!appId) {
    if (!ours) return [];
    return [item('lark_cli_app', 'warn', title, 'lark-cli 已安装但还没配置应用',
      `让它用桥接同一个应用（不新建）：${LINK}；不要跑 lark-cli config init --new，那会再建一个应用`)];
  }
  if (appId === ours) return [item('lark_cli_app', 'ok', title, `与桥接是同一个应用（${appId}）`)];
  if (!ours) {
    return [item('lark_cli_app', 'warn', title,
      `lark-cli 已配置应用 ${appId}；它的 App Secret 在系统钥匙串里，lark-cli 不提供导出，setup 读不到，没法替你填进 .env`,
      `推荐：npm run register -- --no-wait 扫码给桥接建应用，之后 ${LINK} --force 让 lark-cli 改用同一个（要重新 lark-cli auth login）；` +
      '想沿用 lark-cli 这个应用，就请人把它的 App Secret 填进 .env（AGENTS.md §3B）')];
  }
  return [item('lark_cli_app', 'warn', title,
    `桥接（${ours}）与 lark-cli（${appId}）是两个不同的应用。能用：lark-cli 只以 owner 的用户身份调接口`,
    `想合成一个：人同意后 ${LINK} --force（替换 lark-cli 的应用配置，之后要重新 lark-cli auth login）`)];
}

/** setup --link-lark-cli：把 .env 的 App ID / Secret 交给 lark-cli。另一个应用在用时没 force 不替换。 */
export function linkLarkCli(values = {}, { bin = 'lark-cli', run = defaultRun, env = process.env, force = false } = {}) {
  const title = '让 lark-cli 用桥接的应用';
  const id = values.FEISHU_APP_ID || '';
  const secret = values.FEISHU_APP_SECRET || '';
  if (!id || !secret) {
    return item('link_lark_cli', 'fail', title, '.env 里还没有 FEISHU_APP_ID / FEISHU_APP_SECRET',
      '先让桥接有应用：npm run register -- --no-wait（扫码自动建应用，AGENTS.md §3A）');
  }
  // App ID 会作为 argv 传给 lark-cli：先按格式校验，不让奇怪的值（如以 -- 开头）变成它的参数
  if (!/^cli_[A-Za-z0-9]+$/.test(id)) {
    return item('link_lark_cli', 'fail', title, '.env 里的 FEISHU_APP_ID 不像飞书 App ID（应以 cli_ 开头）',
      '到开发者后台「凭证与基础信息」核对后改正 .env，再重跑');
  }
  const cur = readLarkCliApp({ bin, run, env });
  if (!cur.installed) {
    return item('link_lark_cli', 'fail', title, `找不到 ${bin}`,
      'npm install -g @larksuite/cli 只装命令（不需要跑它的应用配置；不要跑 lark-cli config init --new，那会再建一个应用）；' +
      '不在 PATH 里时在 .env 设 LARK_CLI_BIN');
  }
  if (cur.appId === id) return item('link_lark_cli', 'ok', title, `lark-cli 已经在用桥接的应用（${id}），没有改动`);
  if (cur.appId && !force) {
    return item('link_lark_cli', 'needs_human', title,
      `lark-cli 现在配置的是另一个应用 ${cur.appId}；改过去会替换它的配置，lark-cli 原来的登录要重做`,
      `请人确认后：${LINK} --force；不想动就保持两个应用（也能用）`);
  }
  const r = run(bin, ['config', 'init', '--app-id', id, '--app-secret-stdin', '--brand', larkBrand(values, env)],
    { env, input: secret + '\n', timeout: 60_000 });
  if (!r.ok) {
    const tail = scrubSecrets(`${r.stderr || r.stdout || r.error || ''}`.trim(), values).slice(-300);
    return item('link_lark_cli', 'fail', title, `lark-cli config init 失败（退出码 ${r.status ?? r.error}）：${tail}`,
      '按报错处理；凭据错时先 npm run doctor 看 feishu_scopes 的 token 报错；也可请人在终端自己跑 lark-cli config init');
  }
  const after = readLarkCliApp({ bin, run, env });
  if (after.appId !== id) {
    return item('link_lark_cli', 'fail', title, `config init 返回成功，但 lark-cli config show 里的应用是 ${after.appId ?? '（空）'}`,
      '请人在终端跑 lark-cli config show 看看');
  }
  return item('link_lark_cli', 'ok', title, `lark-cli 已改用桥接的应用（${id}）；App Secret 经 stdin 传入，没有出现在命令行与输出里`, AUTH_NEXT);
}
