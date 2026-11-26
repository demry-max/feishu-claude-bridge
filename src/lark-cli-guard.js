import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { HOME_SECRET_PATHS, HOME_SESSION_PATHS } from './secret-paths.js';

const GUARD_SCRIPT = fileURLToPath(import.meta.url);
const BLOCKED = 'lark_cli_secret_path_blocked';
const DENIED = '本地路径受保护，已拒绝\n';
const WIN = process.platform === 'win32';
const PATH_CASE = WIN || process.platform === 'darwin' ? 'i' : '';
const ENV_NAME = new RegExp('^\\.env', PATH_CASE);
const CLI_NAMES = WIN ? ['lark-cli.exe', 'lark-cli.cmd', 'lark-cli.bat', 'lark-cli.com'] : ['lark-cli'];
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const shellPath = (s) => WIN ? s.split(path.sep).join('/') : s;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 优先走真实路径，保留符号链接之后的 ..。即使目标还不存在，也检查其物理父目录。
function physicalPath(candidate, hops = 0) {
  try {
    return fs.realpathSync.native(candidate);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return path.normalize(candidate);
  }
  const parent = path.dirname(candidate);
  if (parent === candidate) return candidate;
  if (hops < 40) {
    let link;
    try { link = fs.readlinkSync(candidate); } catch { /* 不是软链 */ }
    if (link) {
      const target = path.isAbsolute(link) ? link : parent + path.sep + link;
      return physicalPath(target, hops + 1);
    }
  }
  return path.join(physicalPath(parent, hops), path.basename(candidate));
}

function protectedPaths(home) {
  const roots = HOME_SECRET_PATHS.flatMap((rule) => {
    const absolute = path.join(home, rule);
    if (!rule.includes('*')) return [absolute, physicalPath(absolute)].map((p) => escapeRe(shellPath(p)));
    const parent = path.dirname(absolute);
    const name = path.basename(absolute).split('*').map(escapeRe).join('[^/]*');
    return [parent, physicalPath(parent)].map((p) => escapeRe(shellPath(p)) + '/' + name);
  });
  const sessions = HOME_SESSION_PATHS.flatMap((rule) => {
    const [prefix, filename] = rule.split('/**/');
    const dir = path.join(home, prefix);
    const name = filename.split('*').map(escapeRe).join('[^/]*');
    return [dir, physicalPath(dir)].map((p) => escapeRe(shellPath(p)) + '/(?:[^/]+/)*' + name);
  });
  return new RegExp(`^(?:(?:${roots.join('|')})(?:/|$)|(?:${sessions.join('|')})$)`, PATH_CASE);
}

function* argumentPaths(args) {
  for (const arg of args) {
    const equals = arg.startsWith('-') ? arg.indexOf('=') : -1;
    const values = [arg.slice(equals + 1)];
    if (arg.length > 2 && arg[0] === '-' && arg[1] !== '-') values.push(arg.slice(2));
    for (const value of values) {
      let start = 0;
      while (start < value.length) {
        const candidate = value.slice(start);
        yield candidate;
        if (candidate.startsWith('@') && candidate.length > 1) yield candidate.slice(1);
        const next = value.indexOf('=', start);
        if (next < 0) break;
        start = next + 1;
      }
    }
  }
}

function localPath(value, home) {
  if (value === '~' || value.startsWith('~/') || (WIN && value.startsWith('~\\'))) return home + value.slice(1);
  if (WIN && /^\/[a-z]\//i.test(value)) return value[1] + ':' + value.slice(2); // Git Bash 的盘符
  if (path.isAbsolute(value)) return value;
  if (/^file:\/\//i.test(value)) {
    try { return fileURLToPath(value); } catch { return null; }
  }
  const scheme = value.match(/^([a-z][a-z\d+.-]*:)\/\//i);
  // URL 不是本地文件。若 cwd 里实际有这个目录，仍按相对路径核对。
  if (scheme && !fs.existsSync(path.join(process.cwd(), scheme[1]))) return null;
  return process.cwd() + path.sep + value;
}

function hasProtectedPath(args, home) {
  const deny = protectedPaths(home);
  const protectedPath = (p) => ENV_NAME.test(path.basename(p)) || deny.test(shellPath(p));
  for (const value of argumentPaths(args)) {
    const candidate = localPath(value, home);
    if (candidate && (protectedPath(path.normalize(candidate)) || protectedPath(physicalPath(candidate)))) return true;
  }
  return false;
}

function findLarkCli(wrapper) {
  const self = fs.realpathSync.native(wrapper);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of CLI_NAMES) {
      const candidate = path.resolve(dir, name);
      try {
        const resolved = fs.realpathSync.native(candidate);
        if (resolved === self || !fs.statSync(resolved).isFile()) continue;
        fs.accessSync(resolved, fs.constants.X_OK);
        return candidate;
      } catch { /* 继续按 PATH 顺序查找 */ }
    }
  }
  return null;
}

function main([wrapper, events, home, ...args]) {
  if (hasProtectedPath(args, home)) {
    try {
      const { O_WRONLY, O_APPEND, O_NOFOLLOW = 0 } = fs.constants;
      // 一字节代表一次拒绝。日志文件不含参数或路径。
      fs.appendFileSync(events, '1', { flag: O_WRONLY | O_APPEND | O_NOFOLLOW });
    } catch { /* 日志不可写时仍拒绝 */ }
    process.stderr.write(DENIED);
    return 1;
  }
  const executable = findLarkCli(wrapper);
  if (!executable) {
    process.stderr.write('找不到 lark-cli\n');
    return 127;
  }
  if (WIN) return spawn.sync(executable, args, { stdio: 'inherit' }).status ?? 1;
  process.stdout.write(executable);
  return 0;
}

if (process.argv[1] === GUARD_SCRIPT) process.exitCode = main(process.argv.slice(2));

/** 为本轮 Claude 注入专用 PATH。工具 stderr 由 Claude 捕获，拒绝事件单独交回桥日志。 */
export function prepareLarkCliGuard(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lark-cli-'));
  const bin = path.join(dir, 'bin');
  const wrapper = path.join(bin, 'lark-cli');
  const events = path.join(dir, 'blocked');
  let eventFd;
  const cleanup = () => {
    if (eventFd !== undefined) {
      try {
        const { size } = fs.fstatSync(eventFd);
        for (let count = 0; count < size; count++) console.error(BLOCKED);
      } catch { /* 清理不能中断 Claude 回合的收尾 */
      } finally {
        try { fs.closeSync(eventFd); } catch { /* 继续删除临时目录 */ }
        eventFd = undefined;
      }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理尽力 */ }
  };
  try {
    if (bin.includes(path.delimiter)) throw new Error('lark-cli 包装目录不能加入 PATH');
    fs.mkdirSync(bin, { mode: 0o700 });
    eventFd = fs.openSync(events, 'wx', 0o600);
    const invoke = [process.execPath, GUARD_SCRIPT, wrapper, events, os.homedir()].map((p) => quote(shellPath(p))).join(' ');
    const body = WIN
      ? `exec ${invoke} "$@"\n`
      : `real=$(NODE_OPTIONS= NODE_PATH= ${invoke} "$@") || exit "$?"\nexec "$real" "$@"\n`;
    fs.writeFileSync(wrapper, '#!/bin/sh\n' + body, { mode: 0o700 });
    const key = WIN ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH' : 'PATH';
    const original = env[key] ?? (WIN ? process.env.PATH ?? '' : '/usr/bin:/bin');
    return { env: { ...env, [key]: bin + path.delimiter + original }, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
