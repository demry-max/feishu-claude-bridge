// 一键注册飞书应用（移植自 OpenClaw 的设备码注册流程）：
// 扫码授权后，飞书官方接口直接返回 appId + appSecret + 用户 open_id，
// 自动写入 .env 与 data/owner.json —— 无需进开发者后台建应用。
//
//   npm run register                    交互终端：打印二维码并原地等待（最长约 10 分钟）
//   npm run register -- --no-wait       只打印扫码链接、保存设备码后立即退出（退出码 2）
//   npm run register -- --resume [--timeout 秒]
//                                       人扫完码后再跑：取回凭据写入 .env（还没授权则退出码 2，可再跑）
//   npm run register -- --force         .env 已有凭据时仍然新建应用（默认拒绝，避免重复建应用）
// 没有 TTY（AI agent / CI 里运行）且没写 --wait 时，按 --no-wait 处理。
// 退出码：0 成功；2 等人扫码 / 授权；1 失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECOMMENDED_SCOPES } from '../src/feishu-scopes.js';
import { patchEnvFile } from '../src/env-file.js';
import { ensureEnvFile, readEnvFile } from './lib/checks.js';
import {
  parseRegisterArgs, chooseMode, guardExisting, savePending, loadPending, clearPending, classifyPoll,
  consoleUrl, scopeImportJson,
} from './lib/register-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

const opts = parseRegisterArgs(process.argv.slice(2));
const mode = chooseMode(opts, { isTTY: Boolean(process.stdout.isTTY) });
const envValues = readEnvFile(ROOT).values;
// FEISHU_DOMAIN=lark 时走国际版 Lark 注册端点（shell 环境优先，与 dotenv 的规则一致）
const domain = (process.env.FEISHU_DOMAIN ?? envValues.FEISHU_DOMAIN) === 'lark' ? 'lark' : 'feishu';
const REG_URL = domain === 'lark'
  ? 'https://accounts.larksuite.com/oauth/v1/app/registration'
  : 'https://accounts.feishu.cn/oauth/v1/app/registration';

async function post(body) {
  const res = await fetch(REG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return res.json(); // pending/error 状态也带 JSON body
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const refusal = guardExisting(envValues, { force: opts.force });
if (refusal) {
  console.error(`⛔ ${refusal}`);
  process.exit(1);
}

function onSuccess(p) {
  const openId = p.openId;
  // 先从 .env.example 生成完整模板，再写凭据：否则新机器上得到的是只有 3 行的 .env，
  // 所有可选项的说明都看不到
  ensureEnvFile(ROOT);
  // open_id 同时写进 .env：只写 data/owner.json 的话，盘故障/误删后 owner 身份就丢了，
  // 而多数人不会自己再去把它复制进 OWNER_OPEN_ID
  patchEnvFile(ENV_PATH, {
    FEISHU_APP_ID: p.appId,
    FEISHU_APP_SECRET: p.appSecret,
    ...(openId ? { OWNER_OPEN_ID: openId } : {}),
  });
  if (openId) {
    const ownerPath = path.join(ROOT, 'data', 'owner.json');
    if (!fs.existsSync(ownerPath)) {
      fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
      fs.writeFileSync(ownerPath, JSON.stringify({ open_id: openId }, null, 2));
      console.log(`✅ 已将扫码人设为 owner（${openId}）`);
    }
    console.log(`✅ OWNER_OPEN_ID=${openId} 已写入 .env`);
  }
  clearPending(ROOT);
  console.log(`✅ 应用创建成功：${p.appId}，凭据已写入 .env（App Secret 不在此打印）`);
  // 注册接口创建出来的应用是零权限状态：文档/多维表格/电子表格工具会静默失效，
  // 而这一步只能在开发者后台手工做（接口不提供开通 scope 的能力）
  console.log('\n⚠️ 还差一步（必须手工）：应用目前是零权限，飞书文档/多维表格/电子表格工具用不了。');
  console.log(`   开发者后台 ${consoleUrl(domain)} → 该应用 → 权限管理 → 批量导入，粘贴：`);
  console.log('   ' + scopeImportJson(RECOMMENDED_SCOPES));
  console.log('   然后「创建版本」→ 发布。之后 npm run doctor（或 npm start 的启动日志）会告诉你哪些工具已可用。');
  console.log('\n下一步：npm run setup 复查，然后 npm start 启动机器人，到飞书私聊它发「你好」。');
  // lark-cli 建应用走的是同一个注册接口：再跑 lark-cli config init --new 会多出第二个应用
  console.log('要用飞书官方 lark-cli 时：npm run setup -- --link-lark-cli 让它用这同一个应用（不要再跑 lark-cli config init --new）。');
  process.exit(0);
}

/** 轮询到成功 / 失败 / 截止时间。返回 'timeout' 表示截止时仍未授权。 */
async function pollUntil(deviceCode, interval, deadline) {
  while (Date.now() < deadline) {
    await sleep(Math.min(interval, Math.max(1, (deadline - Date.now()) / 1000)));
    let raw;
    try {
      raw = await post({ action: 'poll', device_code: deviceCode, tp: 'ob_cli_app' });
    } catch {
      continue; // 网络抖动继续轮询
    }
    const r = classifyPoll(raw);
    if (r.kind === 'done') onSuccess(r);
    if (r.kind === 'slow_down') interval += 2;
    if (r.kind === 'error') {
      clearPending(ROOT);
      console.error(`注册失败: ${r.message}`);
      process.exit(1);
    }
  }
  return 'timeout';
}

if (mode === 'resume') {
  const { rec, error } = loadPending(ROOT);
  if (error) {
    console.error(error === 'expired'
      ? '上次的扫码链接已过期：重新运行 npm run register -- --no-wait 获取新链接。'
      : '没有待授权的注册：先运行 npm run register -- --no-wait 获取扫码链接。');
    process.exit(1);
  }
  const deadline = Math.min(rec.expires_at, Date.now() + (opts.timeoutSec ?? 120) * 1000);
  console.log(`等待授权结果（最多 ${Math.round((deadline - Date.now()) / 1000)} 秒）…`);
  await pollUntil(rec.device_code, rec.interval || 5, deadline);
  const left = Math.max(0, Math.round((rec.expires_at - Date.now()) / 1000));
  console.log(`还没有完成授权。人在飞书里扫码并点「同意 / 创建」后，再运行 npm run register -- --resume（链接还剩约 ${left} 秒有效）：\n${rec.url}`);
  process.exit(2);
}

const init = await post({ action: 'init' });
if (!init.supported_auth_methods?.includes('client_secret')) {
  console.error('当前环境不支持 client_secret 注册方式:', JSON.stringify(init).slice(0, 200));
  process.exit(1);
}

const begin = await post({
  action: 'begin',
  archetype: 'PersonalAgent',
  auth_method: 'client_secret',
  request_user_info: 'open_id',
});
if (!begin.device_code) {
  console.error('注册启动失败:', JSON.stringify(begin).slice(0, 300));
  process.exit(1);
}

const qrUrl = begin.verification_uri_complete;
const expireIn = begin.expire_in || 600;

if (mode === 'start') {
  savePending(ROOT, { deviceCode: begin.device_code, interval: begin.interval, expireIn, url: qrUrl, domain });
  console.log('[需要人] 请用飞书 App 扫码或在手机浏览器打开下面的链接，按提示创建应用：');
  console.log(qrUrl);
  console.log(`[Human needed] Open the link above in the Feishu/Lark app (or scan it as a QR code) and approve creating the app.`);
  console.log(`\n链接约 ${Math.round(expireIn / 60)} 分钟内有效。人完成后运行：npm run register -- --resume`);
  process.exit(2);
}

try {
  const qr = await import('qrcode-terminal');
  qr.default.generate(qrUrl, { small: true });
} catch {
  /* 未安装 qrcode-terminal 时仅打印链接 */
}
console.log('\n请用飞书 App 扫上方二维码，或在手机浏览器打开：\n' + qrUrl + '\n');
console.log(`等待授权（${expireIn} 秒内有效）…`);
await pollUntil(begin.device_code, begin.interval || 5, Date.now() + expireIn * 1000);
console.error('授权超时，请重新运行 npm run register');
process.exit(1);
