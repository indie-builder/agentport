#!/usr/bin/env node
// 开发完成后的多视口 UI 截图：默认起隔离临时库 + API/Web，登录、可选种子、截图、打开、清理。
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = join(ROOT, '.visual', 'logs');
const API_PORT = 3000;
const WEB_PORT = 5173;
const REDIS_IMAGE =
  'redis:8.10.3-alpine@sha256:21090af93f8324db2f0f0f4f38a7c60369d47d917e000c3423d89d2ae2883537';

const USAGE = `用法: node scripts/visual-shots.mjs --route <path> [options]

把开发完成的路由在多个视口下截图并打开。默认起隔离临时 PG 库、独享 Redis 容器与 API/Web。
Redis 使用已缓存镜像与 loopback 随机端口，API 忽略外部 REDIS_URL；结束仅删除本次容器 ID。

必填:
  --route <path>          要截图的路由，可重复；支持 query，如 /agents?q=x

可选:
  --viewports <WxH,...>   视口列表，默认 1440x900,1200x900
  --out <dir>             输出目录，默认 .visual/<yyyymmdd-hhmmss>
  --seed <mode>           none | minimal | dev-data，默认 minimal
                          minimal：库里没有数据时造 2 个 agent + 1 个频道
                          dev-data：调用 bun run dev:data（重，失败只提示不阻塞）
  --base-url <url>        复用已有栈，不创建或销毁 PG/Redis/应用服务；仍按 --seed 执行，默认 minimal 会在空库写入 agent/频道
  --wait-ms <n>           每页稳定等待毫秒，默认 1200
  --open / --no-open      截图后是否用系统默认程序打开，默认打开
  --full                  截整页长图（按文档实际高度，不被视口截断）
  --keep                  保留环境与服务（调试用），不自动清理
  -h, --help              显示本帮助

示例:
  bun run visual:shots --route /agents --route /channels
  node scripts/visual-shots.mjs --route /agents?q=x --viewports 1440x900,1200x900 --no-open
`;

function fail(message) {
  console.error(`[visual-shots] ${message}`);
  process.exitCode = 1;
  // 消息带前缀，底部 catch 据此避免重复打印。
  throw new Error(`[visual-shots] ${message}`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseArgs(argv) {
  const opts = {
    routes: [],
    viewports: ['1440x900', '1200x900'],
    out: null,
    seed: 'minimal',
    baseUrl: null,
    waitMs: 1200,
    open: true,
    fullPage: false,
    keep: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    if (arg === '--open') {
      opts.open = true;
      continue;
    }
    if (arg === '--no-open') {
      opts.open = false;
      continue;
    }
    if (arg === '--full' || arg === '--full-page') {
      opts.fullPage = true;
      continue;
    }
    if (arg === '--keep') {
      opts.keep = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    const take = () => {
      if (value !== undefined) return value;
      i += 1;
      if (i >= argv.length) fail(`${key} 缺少取值`);
      return argv[i];
    };
    switch (key) {
      case '--route':
        opts.routes.push(take());
        break;
      case '--viewports':
        opts.viewports = take()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        break;
      case '--out':
        opts.out = take();
        break;
      case '--seed':
        opts.seed = take();
        break;
      case '--base-url':
        opts.baseUrl = take().replace(/\/$/, '');
        break;
      case '--wait-ms':
        opts.waitMs = Number(take());
        break;
      default:
        fail(`未知参数 ${arg}，用 --help 查看用法`);
    }
  }

  if (opts.help) return opts;
  if (opts.routes.length === 0) fail('至少需要一个 --route <path>');
  for (const route of opts.routes) {
    if (!route.startsWith('/')) fail(`--route 必须以 / 开头：${route}`);
  }
  if (!['none', 'minimal', 'dev-data'].includes(opts.seed)) {
    fail(`--seed 只支持 none | minimal | dev-data：${opts.seed}`);
  }
  if (!Number.isFinite(opts.waitMs) || opts.waitMs < 0) fail('--wait-ms 需要非负数字');
  opts.parsedViewports = opts.viewports.map((item) => {
    const match = /^(\d+)x(\d+)$/.exec(item);
    if (!match) fail(`--viewports 项格式应为 WxH：${item}`);
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width <= 0 || height <= 0) fail(`--viewports 尺寸必须为正数：${item}`);
    return { width, height };
  });
  if (opts.parsedViewports.length === 0) fail('--viewports 至少需要一个 WxH');
  opts.timestamp = stamp();
  opts.outDir = resolve(process.cwd(), opts.out ?? join('.visual', opts.timestamp));
  return opts;
}

function readDotEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) fail(`缺少 ${path}：需要 ADMIN_USER、ADMIN_PASSWORD，隔离模式还需要 DATABASE_URL`);
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  for (const key of ['ADMIN_USER', 'ADMIN_PASSWORD']) {
    if (process.env[key]) env[key] = process.env[key];
    if (!env[key]) fail(`.env 缺少 ${key}`);
  }
  return env;
}

function isPortListening(port) {
  const result = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function runPsql(args) {
  let result = spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    // worktree 的 compose project 可能没落到默认名，回退到主 checkout 起的容器名。
    result = spawnSync('docker', ['exec', 'agentport-postgres-1', 'psql', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  }
  return result;
}

async function startRedis(state) {
  const name = `pace_visual_redis_${randomBytes(8).toString('hex')}`;
  const created = spawnSync(
    'docker',
    [
      'create',
      '--name',
      name,
      '--pull=never',
      '-p',
      '127.0.0.1::6379',
      REDIS_IMAGE,
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'no',
    ],
    { encoding: 'utf8' },
  );
  const id = created.stdout?.trim();
  if (/^[a-f0-9]{64}$/.test(id ?? '')) state.redisId = id;
  if (created.status !== 0 || !state.redisId) {
    fail(`创建独享 Redis 失败：${created.stderr?.trim() || created.error?.message || '未返回容器 ID'}`);
  }
  console.log(`[visual-shots] 独享 Redis：${name}，容器 ID ${state.redisId}`);
  const started = spawnSync('docker', ['start', state.redisId], { encoding: 'utf8' });
  if (started.status !== 0) fail(`启动独享 Redis 失败：${started.stderr?.trim()}`);
  const mapped = spawnSync('docker', ['port', state.redisId, '6379/tcp'], { encoding: 'utf8' });
  const match = /^127\.0\.0\.1:(\d+)$/.exec(mapped.stdout?.trim() ?? '');
  if (mapped.status !== 0 || !match) {
    fail(`读取独享 Redis 端口失败：${mapped.stderr?.trim() || mapped.stdout?.trim()}`);
  }
  state.redisUrl = `redis://127.0.0.1:${match[1]}/0`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = spawnSync('docker', ['exec', state.redisId, 'redis-cli', 'ping'], {
      encoding: 'utf8',
    });
    if (ready.status === 0 && ready.stdout.trim() === 'PONG') {
      console.log(`[visual-shots] 独享 Redis 就绪：${state.redisUrl}`);
      return;
    }
    await sleep(100);
  }
  fail(`独享 Redis 未就绪：${state.redisId}`);
}

function stopRedis(state) {
  if (!state.redisId) return;
  const removed = spawnSync('docker', ['rm', '-f', state.redisId], { encoding: 'utf8' });
  if (removed.status !== 0) {
    console.error(
      `[visual-shots] 独享 Redis 清理失败：${removed.stderr?.trim()}\n手动执行：docker rm -f ${state.redisId}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`[visual-shots] 已删除独享 Redis 容器 ${state.redisId}`);
  }
}

function tailFile(path, lines = 25) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function spawnDetached(command, args, cwd, logPath, env) {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.unref();
  return child;
}

async function waitForHealthy(services) {
  const deadline = Date.now() + 60_000;
  let webError = '尚未连接';
  let apiError = '尚未连接';
  while (Date.now() < deadline) {
    for (const service of services) {
      if (service.child.exitCode !== null) {
        fail(
          `${service.label} 提前退出（code ${service.child.exitCode}），日志 ${service.log}：\n${tailFile(service.log)}`,
        );
      }
    }
    try {
      const res = await fetch(`http://localhost:${WEB_PORT}/`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 200) webError = null;
      else webError = `HTTP ${res.status}`;
    } catch (cause) {
      webError = cause.message;
    }
    try {
      const res = await fetch(`http://localhost:${API_PORT}/api/auth/me`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.status < 500) apiError = null;
      else apiError = `HTTP ${res.status}`;
    } catch (cause) {
      apiError = cause.message;
    }
    if (webError === null && apiError === null) return;
    await sleep(700);
  }
  fail(
    `等待服务就绪超时（60s）：web=${webError ?? 'ok'} api=${apiError ?? 'ok'}\n` +
      `api 日志 ${services[0].log}:\n${tailFile(services[0].log)}\n` +
      `web 日志 ${services[1].log}:\n${tailFile(services[1].log)}`,
  );
}

function buildBrowserProgram({
  baseUrl,
  routes,
  viewports,
  waitMs,
  fullPage,
  outDir,
  env,
  seed,
  spaceName,
}) {
  const firstPath = routes[0].split('?')[0];
  return `
const base = ${JSON.stringify(baseUrl)};
const routes = ${JSON.stringify(routes)};
const viewports = ${JSON.stringify(viewports)};
const waitMs = ${JSON.stringify(waitMs)};
const fullPage = ${JSON.stringify(Boolean(fullPage))};
const outDir = ${JSON.stringify(outDir)};
const adminUser = ${JSON.stringify(env.ADMIN_USER)};
const adminPassword = ${JSON.stringify(env.ADMIN_PASSWORD)};
const seed = ${JSON.stringify(seed)};
const firstPath = ${JSON.stringify(firstPath)};
const warnings = [];
const shots = [];

function slugify(route) {
  const slug = route
    .replace(/^\\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'root';
}

const task = await taskSpace(${JSON.stringify(spaceName)});
try {
  const page = task.page('p1');
  await page.goto(base + '/login?returnTo=' + encodeURIComponent(routes[0]), {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(500);
  const needsLogin = await page.evaluate(
    () => Boolean(document.querySelector('input[name=username]')),
  );
  if (needsLogin) {
    await page.fill('input[name=username]', adminUser);
    await page.fill('input[name=password]', adminPassword);
    await page.click('form button[type=submit]');
    try {
      await page.waitForFunction((expected) => location.pathname === expected, firstPath, {
        timeout: 20_000,
      });
    } catch {
      const state = await page.evaluate(() => ({
        path: location.pathname,
        error: document.querySelector('#login-error')?.textContent?.trim() || '',
      }));
      throw new Error('登录失败（' + state.path + '）：' + (state.error || '等待跳转超时'));
    }
  }

  if (seed === 'minimal') {
    try {
      const headers = { 'content-type': 'application/json' };
      const list = await page.fetch('/api/agents', { method: 'GET' });
      const existing = list.ok ? JSON.parse(list.body) : [];
      if (!Array.isArray(existing) || existing.length === 0) {
        const createAgent = (body) =>
          page.fetch('/api/agents', { method: 'POST', headers, body: JSON.stringify(body) });
        const created = [];
        for (const body of [
          { slug: 'visual-frontend', name: '视觉样例·前端', role: '前端工程师' },
          { slug: 'visual-analyst', name: '视觉样例·分析', role: '数据分析师' },
        ]) {
          const res = await createAgent(body);
          if (res.ok) created.push(JSON.parse(res.body));
          else warnings.push('创建 agent 失败 HTTP ' + res.status + '：' + res.body.slice(0, 200));
        }
        const channelRes = await page.fetch('/api/channels', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: '视觉抽查频道', description: 'visual-check 最小种子' }),
        });
        if (channelRes.ok) {
          const channel = JSON.parse(channelRes.body);
          for (const agent of created) {
            const bindRes = await page.fetch('/api/channels/' + channel.id + '/agents', {
              method: 'POST',
              headers,
              body: JSON.stringify({ agentId: agent.id }),
            });
            if (!bindRes.ok) {
              warnings.push('绑定频道成员失败 HTTP ' + bindRes.status);
            }
          }
        } else {
          warnings.push('创建频道失败 HTTP ' + channelRes.status + '：' + channelRes.body.slice(0, 200));
        }
      }
    } catch (cause) {
      warnings.push('最小种子失败：' + cause.message);
    }
  }

  for (const viewport of viewports) {
    await page.cdp('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const route of routes) {
      await page.goto(base + route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(waitMs);
      if (fullPage) {
        const rawH = await page.evaluate(() => {
          const main = document.getElementById('main-content');
          return Math.max(
            document.documentElement.scrollHeight,
            document.body.scrollHeight,
            main ? main.scrollHeight + Math.round(main.getBoundingClientRect().top) : 0,
            window.innerHeight,
          );
        });
        const h = Math.min(Math.max(rawH | 0, viewport.height), 16000);
        await page.cdp('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: h,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await page.waitForTimeout(150);
        const path = outDir + '/' + slugify(route) + '-' + viewport.width + 'x' + h + '-full.png';
        await page.screenshot({ path });
        shots.push(path);
        await page.cdp('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
      } else {
        const path =
          outDir + '/' + slugify(route) + '-' + viewport.width + 'x' + viewport.height + '.png';
        await page.screenshot({ path });
        shots.push(path);
      }
    }
  }

  console.log('SHOTS_JSON=' + JSON.stringify(shots));
  if (warnings.length > 0) console.log('SEED_WARNINGS=' + JSON.stringify(warnings));
} finally {
  // 无人值守脚本：出错也关闭任务空间，避免遗留浏览器页签。
  try {
    await task.finish({ keep: [] });
  } catch (cause) {
    console.error('关闭浏览器任务空间失败：' + cause.message);
  }
}
`;
}

async function captureShots({ baseUrl, routes, viewports, waitMs, fullPage, outDir, env, seed }) {
  mkdirSync(outDir, { recursive: true });
  const program = buildBrowserProgram({
    baseUrl,
    routes,
    viewports,
    waitMs,
    fullPage,
    outDir,
    env,
    seed,
    spaceName: `visual-${Date.now()}`,
  });
  let run;
  try {
    run = await runForeground('ego-browser', ['nodejs'], { input: program, timeoutMs: 300_000 });
  } catch (cause) {
    fail(`无法运行 ego-browser：${cause.message}`);
  }
  if (run.timedOut) fail('截图超时（300s），已终止 ego-browser。');
  const stdout = run.stdout;
  const stderr = run.stderr;
  // ego-browser 会把脚本输出写到 stderr，两路都解析。
  const output = `${stdout}\n${stderr}`;
  const shotsLine = /^SHOTS_JSON=(.+)$/m.exec(output);
  if (run.status !== 0 || !shotsLine) {
    fail(
      `截图失败（ego-browser exit ${run.status}）。\n--- stdout ---\n${stdout.slice(-4000)}\n--- stderr ---\n${stderr.slice(-4000)}`,
    );
  }
  const warningsLine = /^SEED_WARNINGS=(.+)$/m.exec(output);
  if (warningsLine) {
    for (const warning of JSON.parse(warningsLine[1])) {
      console.error(`[visual-shots] 种子警告：${warning}`);
    }
  }
  const shots = JSON.parse(shotsLine[1]);
  const missing = shots.filter((path) => !existsSync(path));
  if (missing.length > 0) fail(`截图文件未生成：${missing.join(', ')}`);
  return shots;
}

let activeOpts = null;
let activeState = null;
let activeChild = null;
let cleanedUp = false;

/** 终止本工具以 detached 方式启动的进程组；失败退回到直接杀该 pid，忽略 ESRCH。 */
function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch (cause) {
      if (cause.code !== 'ESRCH') {
        console.error(`[visual-shots] 终止进程组 ${pid} 失败：${cause.message}`);
      }
    }
  }
}

/** 前台长任务用异步子进程，保证 SIGINT/SIGTERM 不被 spawnSync 阻塞。 */
function runForeground(command, args, { cwd, env, input, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    // detached 建独立进程组，中断/超时才能连同孙进程一起终止；stdio 仍走管道。
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    activeChild = child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killProcessGroup(child.pid, 'SIGKILL');
        }, timeoutMs)
      : null;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.on('error', () => {
      // 子进程提前退出时写入 stdin 会 EPIPE，结果由 close 处理。
    });
    // 程序走 stdin，避免命令行参数长度限制；没有输入也必须关闭。
    child.stdin.end(input ?? '');
    child.on('error', (cause) => {
      if (timer) clearTimeout(timer);
      if (activeChild === child) activeChild = null;
      rejectPromise(cause);
    });
    child.on('close', (status, signal) => {
      if (timer) clearTimeout(timer);
      if (activeChild === child) activeChild = null;
      resolvePromise({ status, signal, stdout, stderr, timedOut });
    });
  });
}

function stopActiveChild() {
  // 中断时先终止前台子进程整组，截图/造数据卡住也能立即进入清理。
  if (activeChild) killProcessGroup(activeChild.pid, 'SIGTERM');
}

/** 同步清理：信号处理与正常退出共用，避免遗留进程或临时库。 */
function cleanupAll() {
  if (cleanedUp || !activeOpts || !activeState || activeOpts.keep) return;
  cleanedUp = true;
  stopServices(activeState.services);
  stopRedis(activeState);
  if (activeState.dbName) dropDatabase(activeState);
}

function printKeepHint(state) {
  if (!state.dbName && !state.redisId) return;
  console.log('\n[visual-shots] --keep 已保留环境：');
  for (const service of state.services) {
    console.log(`  ${service.label}: pid ${service.child.pid}, 日志 ${service.log}`);
    console.log(`  手动停止 ${service.label}：kill -- -${service.child.pid}`);
  }
  if (state.redisId) {
    console.log(`  独享 Redis：${state.redisUrl ?? '尚未就绪'}，容器 ID ${state.redisId}`);
    console.log(`  手动删除 Redis：docker rm -f ${state.redisId}`);
  }
  if (state.dbName) {
    console.log(`  临时库：${state.dbName}`);
    console.log(
      `  docker compose exec -T postgres psql -U ${state.dbUser} -d postgres -c 'DROP DATABASE IF EXISTS "${state.dbName}"'`,
    );
  }
}

process.on('SIGINT', () => {
  stopActiveChild();
  cleanupAll();
  if (activeOpts?.keep) printKeepHint(activeState);
  process.exit(130);
});
process.on('SIGTERM', () => {
  stopActiveChild();
  cleanupAll();
  if (activeOpts?.keep) printKeepHint(activeState);
  process.exit(143);
});
// 兜底：未捕获异常导致进程退出时也必须清掉服务与临时库。
process.on('exit', () => cleanupAll());

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const env = readDotEnv();
  const state = { services: [], dbName: null, dbUser: null, redisId: null, redisUrl: null };
  activeOpts = opts;
  activeState = state;

  try {
    await run(opts, env, state);
  } finally {
    if (opts.keep) printKeepHint(state);
    else cleanupAll();
  }
}

async function run(opts, env, state) {
  if (!opts.baseUrl) {
    for (const port of [API_PORT, WEB_PORT]) {
      if (isPortListening(port)) {
        fail(
          `端口 ${port} 已被占用；先停掉现有栈，或改用 --base-url http://localhost:5173 复用。` +
            '（不会杀别人的进程）',
        );
      }
    }

    if (!env.DATABASE_URL) fail('.env 缺少 DATABASE_URL');
    const baseDbUrl = new URL(env.DATABASE_URL);
    state.dbUser = decodeURIComponent(baseDbUrl.username);
    await startRedis(state);
    // 随机后缀避免同秒并发跑出同名库。
    const dbName = `pace_visual_${opts.timestamp.replace(/-/g, '')}_${randomBytes(3).toString('hex')}`;
    if (!/^[a-z0-9_]+$/.test(dbName)) fail(`生成的库名不合法：${dbName}`);

    const create = runPsql(['-U', state.dbUser, '-d', 'postgres', '-c', `CREATE DATABASE "${dbName}"`]);
    if (create.status !== 0) {
      fail(
        `创建临时库失败：${dbName}\n${create.stderr?.trim() || create.stdout?.trim()}` +
          '\n确认 PostgreSQL 在运行：bun run infra:up 或 docker compose ps',
      );
    }
    // 只有 CREATE 成功后才登记待删库名，避免失败时误删别人的库。
    state.dbName = dbName;

    const tempUrl = new URL(baseDbUrl);
    tempUrl.pathname = '/' + state.dbName;
    const migrate = spawnSync('bun', ['run', '--filter', '@agentport/db', 'migrate'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: tempUrl.toString() },
      encoding: 'utf8',
    });
    if (migrate.status !== 0) {
      fail(
        `迁移临时库失败：\n${(migrate.stdout || '').slice(-3000)}\n${(migrate.stderr || '').slice(-3000)}` +
          '\n首次运行先构建依赖：bun run --filter @agentport/shared --filter @agentport/db --filter @agentport/core build',
      );
    }

    mkdirSync(LOG_DIR, { recursive: true });
    const apiLog = join(LOG_DIR, 'api.log');
    const webLog = join(LOG_DIR, 'web.log');
    const apiChild = spawnDetached(
      'bun',
      ['run', '--filter', '@agentport/api', 'dev'],
      ROOT,
      apiLog,
      { ...process.env, DATABASE_URL: tempUrl.toString(), REDIS_URL: state.redisUrl },
    );
    const webChild = spawnDetached(
      'bun',
      ['run', 'vite', '--port', String(WEB_PORT), '--host', '127.0.0.1'],
      join(ROOT, 'packages/web'),
      webLog,
      process.env,
    );
    state.services = [
      { label: 'api', child: apiChild, log: apiLog, port: API_PORT },
      { label: 'web', child: webChild, log: webLog, port: WEB_PORT },
    ];
    await waitForHealthy(state.services);
  }

  // CORS 白名单是 localhost，不是 127.0.0.1；浏览器统一走 localhost。
  const baseUrl = opts.baseUrl ?? `http://localhost:${WEB_PORT}`;

  if (opts.seed === 'dev-data') {
    // dev:data 通过已起实例的 UI 写数据，必须显式指向本次栈；失败只提示，不阻塞截图。
    const devDataEnv = {
      ...process.env,
      E2E_APP_URL: baseUrl,
      E2E_ADMIN_USER: env.ADMIN_USER,
      E2E_ADMIN_PASSWORD: env.ADMIN_PASSWORD,
    };
    if (state.dbName) {
      const url = new URL(env.DATABASE_URL);
      url.pathname = '/' + state.dbName;
      devDataEnv.DATABASE_URL = url.toString();
    }
    if (state.redisUrl) devDataEnv.REDIS_URL = state.redisUrl;
    let devData;
    try {
      devData = await runForeground('bun', ['run', 'dev:data'], {
        cwd: ROOT,
        env: devDataEnv,
        timeoutMs: 600_000,
      });
    } catch (cause) {
      devData = { status: -1, stdout: '', stderr: cause.message };
    }
    if (devData.status !== 0) {
      console.error(
        '[visual-shots] dev:data 失败，继续截图（数据可能不完整）：\n' +
          `${(devData.stdout || '').slice(-1500)}\n${(devData.stderr || '').slice(-1500)}`,
      );
    }
  }

  const shots = await captureShots({
    baseUrl,
    routes: opts.routes,
    viewports: opts.parsedViewports,
    waitMs: opts.waitMs,
    fullPage: opts.fullPage,
    outDir: opts.outDir,
    env,
    seed: opts.seed,
  });

  console.log(`[visual-shots] ${shots.length} 张截图：${opts.outDir}`);
  for (const shot of shots) console.log(`  ${shot}`);

  if (opts.open) {
    if (process.platform === 'darwin') {
      const opened = spawnSync('open', shots, { encoding: 'utf8' });
      if (opened.status !== 0) console.error(`[visual-shots] 打开截图失败：${opened.stderr?.trim()}`);
    } else {
      console.log('[visual-shots] 非 macOS，未自动打开；请手动查看上面的路径。');
    }
  }
}

/** 只终止本工具记录的 detached 进程组；绝不按端口杀未知进程。 */
function stopServices(services) {
  for (const service of services) {
    if (service.child) killProcessGroup(service.child.pid, 'SIGTERM');
  }
  // 给 bun run/tsx/vite 一点时间自行退出，再对仍占口的自家进程组补 SIGKILL。
  const waitUntil = Date.now() + 2000;
  while (Date.now() < waitUntil && services.some((service) => isPortListening(service.port))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  for (const service of services) {
    if (service.child && isPortListening(service.port)) {
      killProcessGroup(service.child.pid, 'SIGKILL');
    }
  }
  // 端口仍被占用说明是别的进程或尚未释放，只告警，绝不 kill 未知进程。
  for (const service of services) {
    if (isPortListening(service.port)) {
      console.warn(
        `[visual-shots] 端口 ${service.port} 仍被占用，但不是本工具启动的进程，未终止；请手动检查。`,
      );
    }
  }
}

function dropDatabase(state) {
  const result = runPsql([
    '-U',
    state.dbUser,
    '-d',
    'postgres',
    '-c',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${state.dbName}' AND pid <> pg_backend_pid()`,
    '-c',
    `DROP DATABASE IF EXISTS "${state.dbName}"`,
  ]);
  if (result.status !== 0) {
    console.error(
      `[visual-shots] 临时库清理失败：${state.dbName}\n${result.stderr?.trim() || result.stdout?.trim()}` +
        `\n手动执行：docker compose exec -T postgres psql -U ${state.dbUser} -d postgres -c 'DROP DATABASE IF EXISTS "${state.dbName}"'`,
    );
    process.exitCode = 1;
  } else {
    console.log(`[visual-shots] 已删除临时库 ${state.dbName}`);
  }
}

main().catch((cause) => {
  if (cause instanceof Error && !String(cause.message).startsWith('[visual-shots]')) {
    console.error(`[visual-shots] ${cause.message}`);
  }
  process.exitCode = 1;
});
