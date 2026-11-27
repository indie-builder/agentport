import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'check-project-contract.mjs');
const REPO_ROOT = join(import.meta.dir, '..');

const validCss = `@custom-variant dark (&:where(.dark, .dark *));

:root {
  --radius-tag: 0.5rem;
  --radius-4xl: var(--radius-tag);
  --shadow-overlay: 0 20px 40px rgb(0 0 0 / 0.1);
  --shadow-md: var(--shadow-overlay);
  --shadow-lg: var(--shadow-overlay);
  --color-muted: var(--color-neutral-100);
  --color-muted-foreground: var(--color-neutral-500);
}
`;

const validRootPackageJson = JSON.stringify(
  {
    engines: { node: '>=24.22.2 <25' },
    workspaces: { catalog: { '@types/node': '24.19.2' } },
    devDependencies: { '@types/node': 'catalog:' },
  },
  null,
  2,
);

const validDockerfile = 'FROM node:24-alpine AS base\n';

const baseFiles: Record<string, string> = {
  'package.json': validRootPackageJson,
  Dockerfile: validDockerfile,
  'packages/web/src/styles.css': validCss,
  'packages/api/src/index.ts': '',
  'packages/worker/src/index.ts': '',
  'packages/shared/src/index.ts': '',
  'packages/contract/src/index.ts': '',
  'packages/db/src/index.ts': '',
  'packages/db/src/schema/index.ts': '',
  'packages/core/src/index.ts': '',
  'packages/core/src/workspace.ts': '',
  'packages/core/src/plugin-display.ts': '',
  'packages/core/src/record.ts': '',
};

const tempDirs: string[] = [];

function makeRepo(overrides: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'contract-guard-')));
  tempDirs.push(dir);
  for (const [path, content] of Object.entries({ ...baseFiles, ...overrides })) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function runContract(cwd: string): { code: number | null; output: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
  };
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const errorImports =
  "import { AppError, fail, notFound } from '@agentport/core'; import { z } from 'zod';";

const fixtures = [
  {
    name: 'web 引 @radix-ui',
    rule: 'web-banned-primitive',
    files: {
      'packages/web/src/components/dialog.tsx':
        "import * as Dialog from '@radix-ui/react-dialog';\n",
    },
    expected: ['改用 @ui-sdk/react 或 packages/web/src/components/ui/'],
  },
  {
    name: 'web 引 @base-ui',
    rule: 'web-banned-primitive',
    files: {
      'packages/web/src/components/dialog.tsx': "import { Dialog } from '@base-ui/react';\n",
    },
    expected: ['改用 @ui-sdk/react 或 packages/web/src/components/ui/'],
  },
  {
    name: 'web 引服务端包',
    rule: 'web-server-import',
    files: { 'packages/web/src/lib/agents.ts': "import { repo } from '@agentport/db';\n" },
    expected: ['web 禁止引入 @agentport/db', '只允许 @agentport/core/workspace'],
  },
  {
    name: 'web 引 @agentport/core 根入口',
    rule: 'web-server-import',
    files: { 'packages/web/src/lib/agents.ts': "import { AppError } from '@agentport/core';\n" },
    expected: ['web 禁止引入 @agentport/core', '只允许 @agentport/core/workspace'],
  },
  {
    name: 'shared 跨层 import',
    rule: 'shared-import',
    files: { 'packages/shared/src/fs.ts': "import { readFileSync } from 'node:fs';\n" },
    expected: ['shared 禁止引入 node:fs', 'packages/shared 只允许依赖 zod 与包内相对路径'],
  },
  {
    name: 'contract 跨层 import',
    rule: 'contract-import',
    files: { 'packages/contract/src/agent.ts': "import { repo } from '@agentport/db';\n" },
    expected: [
      'contract 禁止引入 @agentport/db',
      'packages/contract 只允许依赖 @agentport/shared、zod 与 @orpc/contract',
    ],
  },
  {
    name: 'db 跨层 import',
    rule: 'db-import',
    files: { 'packages/db/src/repo/agent.ts': "import { Hono } from 'hono';\n" },
    expected: ['db 禁止引入 hono', 'db 模块边界只使用 drizzle-orm/bun-sql'],
  },
  {
    name: 'router 内 input.*.safeParse',
    rule: 'router-safe-parse',
    files: {
      'packages/api/src/modules/chat/router.ts':
        'export const handler = (input: { body: { safeParse: (v: unknown) => v } }, raw: unknown) => input.body.safeParse(raw);\n',
    },
    expected: [
      'router 内对 input.body 使用 safeParse',
      '校验只在 @agentport/contract 的 input schema 完成',
    ],
  },
  {
    name: '直接 import pino',
    rule: 'pino-static',
    files: { 'packages/api/src/lib/log.ts': "import pino from 'pino';\n" },
    expected: ['直接引入 pino 值', '改用 @agentport/core/logger'],
  },
  {
    name: '动态 import pino',
    rule: 'pino-dynamic',
    files: { 'packages/api/src/lib/log.ts': "export const load = () => import('pino');\n" },
    expected: ['动态引入 pino', '改用 @agentport/core/logger'],
  },
  {
    name: 'lucide 图标逐个传 strokeWidth/size',
    rule: 'lucide-icon-size',
    files: {
      'packages/web/src/components/search.tsx':
        "import { Search } from 'lucide-react';\nexport const Icon = () => <Search size={16} />;\n",
    },
    expected: ['lucide 图标 Search 逐个传 strokeWidth/size'],
  },
  {
    name: '硬编码 hex',
    rule: 'web-hardcoded-hex',
    files: { 'packages/web/src/components/panel.tsx': "export const color = '#FAFAFA';\n" },
    expected: ['硬编码色值 #FAFAFA（用 @theme token）'],
  },
  {
    name: '拼接 buttonVariants 类名',
    rule: 'button-variants-concat',
    files: {
      'packages/web/src/components/action.tsx':
        "import { buttonVariants } from './ui/button';\nexport const cls = 'px-4 ' + buttonVariants({ size: 'sm' });\n",
    },
    expected: ['拼接 buttonVariants 类名', '改用 cn(buttonVariants(...), ...)'],
  },
  {
    name: 'db 直接调用 like/ilike',
    rule: 'db-like-call',
    files: {
      'packages/db/src/repo/agent.ts':
        "import { ilike } from 'drizzle-orm';\nexport const q = (column: unknown, pattern: string) => ilike(column, pattern);\n",
    },
    expected: ['直接调用 ilike', '改用 packages/db/src/repo/like.ts'],
  },
  {
    name: 'db sql 模板未转义 LIKE',
    rule: 'db-like-sql',
    files: {
      'packages/db/src/repo/agent.ts':
        'import { sql } from "drizzle-orm";\nexport const q = (name: unknown, pattern: string) => sql`' +
        '$' +
        '{name} ilike ' +
        '$' +
        '{pattern}`;\n',
    },
    expected: ['sql 模板中未转义的 LIKE/ILIKE', '改用 packages/db/src/repo/like.ts'],
  },
  {
    name: 'DB check 硬编码枚举',
    rule: 'db-enum-check',
    files: {
      'packages/db/src/schema/chat.ts':
        "import { sql } from 'drizzle-orm';\nimport { check } from 'drizzle-orm/pg-core';\nexport const constraint = check('chat_status_check', sql`status in ('queued', 'running')`);\n",
    },
    expected: [
      "DB check 'chat_status_check' 未从 @agentport/shared 的 *.options 派生",
      `改用 \${schema}.options 派生枚举`,
    ],
  },
  {
    name: '直接访问 localStorage',
    rule: 'web-localstorage',
    files: {
      'packages/web/src/lib/session.ts':
        "export const save = (value: string) => localStorage.setItem('token', value);\n",
    },
    expected: [
      '直接访问 localStorage（改用 packages/web/src/lib/storage.ts 的 readStorage / writeStorage）',
    ],
  },
  {
    name: 'core 浏览器子路径引 node:',
    rule: 'core-browser-node',
    files: { 'packages/core/src/workspace.ts': "import { readFileSync } from 'node:fs';\n" },
    expected: ['浏览器可达子路径禁引 Node 内建或 Buffer（node:fs）'],
  },
  {
    name: 'core 浏览器子路径使用 Buffer',
    rule: 'core-browser-node',
    files: { 'packages/core/src/workspace.ts': "export const buf = Buffer.from('x');\n" },
    expected: ['浏览器可达子路径禁引 Node 内建或 Buffer'],
  },
  {
    name: 'styles.css 缺 dark variant',
    rule: 'styles-dark-variant',
    files: {
      'packages/web/src/styles.css': validCss.replace('@custom-variant dark', '/* removed */'),
    },
    expected: ['packages/web/src/styles.css: 缺少 @custom-variant dark (&:where(.dark, .dark *));'],
  },
  {
    name: 'styles.css 定义 .dark 主题块',
    rule: 'styles-dark-block',
    files: {
      'packages/web/src/styles.css': `${validCss}\n.dark {\n  --color-background: black;\n}\n`,
    },
    expected: ['禁止定义 .dark 主题块'],
  },
  {
    name: 'styles.css muted 等于 foreground',
    rule: 'styles-muted-token',
    files: {
      'packages/web/src/styles.css': validCss.replace(
        '--color-muted: var(--color-neutral-100);',
        '--color-muted: var(--color-muted-foreground);',
      ),
    },
    expected: ['--color-muted 不得等于 var(--color-muted-foreground)'],
  },
  {
    name: 'styles.css radius-4xl 不等于 radius-tag',
    rule: 'styles-radius-4xl',
    files: {
      'packages/web/src/styles.css': validCss.replace(
        '--radius-4xl: var(--radius-tag);',
        '--radius-4xl: 2rem;',
      ),
    },
    expected: ['--radius-4xl 必须等于 var(--radius-tag)'],
  },
  {
    name: 'styles.css shadow-md 与 shadow-lg 不等于 shadow-overlay',
    rule: 'styles-shadow',
    files: {
      'packages/web/src/styles.css': validCss
        .replace('--shadow-md: var(--shadow-overlay);', '--shadow-md: 0 1px 2px;')
        .replace('--shadow-lg: var(--shadow-overlay);', '--shadow-lg: 0 8px 24px;'),
    },
    expected: [
      '--shadow-md 必须等于 var(--shadow-overlay)',
      '--shadow-lg 必须等于 var(--shadow-overlay)',
    ],
  },
  {
    name: 'collapsible-content 设置 content-visibility',
    rule: 'collapsible-content-visibility',
    files: {
      'packages/web/src/components/collapsible.css':
        "[data-slot='collapsible-content'] {\n  content-visibility: auto;\n}\n",
    },
    expected: ['禁止在 collapsible-content 上设置 content-visibility'],
  },
  {
    name: 'package.json engines.node 升级到 26',
    rule: 'node-version-lock',
    files: {
      'package.json': JSON.stringify({
        engines: { node: '>=26.0.0 <27' },
        workspaces: { catalog: { '@types/node': '24.19.2' } },
      }),
    },
    expected: ['package.json: engines.node', '永久锁定 24.x'],
  },
  {
    name: 'package.json engines.node 缺少上限',
    rule: 'node-version-lock',
    files: {
      'package.json': JSON.stringify({
        engines: { node: '>=24' },
        workspaces: { catalog: { '@types/node': '24.19.2' } },
      }),
    },
    expected: ['package.json: engines.node', '永久锁定 24.x'],
  },
  {
    name: 'package.json catalog @types/node 升级到 26',
    rule: 'node-version-lock',
    files: {
      'package.json': JSON.stringify({
        engines: { node: '>=24.22.2 <25' },
        workspaces: { catalog: { '@types/node': '26.0.0' } },
      }),
    },
    expected: ['package.json: workspaces.catalog["@types/node"]', '永久锁定 24.x'],
  },
  {
    name: 'package.json @types/node 复合范围绕过',
    rule: 'node-version-lock',
    files: {
      'package.json': JSON.stringify({
        engines: { node: '>=24.22.2 <25' },
        workspaces: { catalog: { '@types/node': '24.19.2 || ^26.0.0' } },
      }),
    },
    expected: ['package.json: workspaces.catalog["@types/node"]', '永久锁定 24.x'],
  },
  {
    name: 'package.json overrides @types/node 升级到 26',
    rule: 'node-version-lock',
    files: {
      'package.json': JSON.stringify({
        engines: { node: '>=24.22.2 <25' },
        workspaces: { catalog: { '@types/node': '24.19.2' } },
        overrides: { '@types/node': '26.0.0' },
      }),
    },
    expected: ['package.json: overrides["@types/node"]', '永久锁定 24.x'],
  },
  {
    name: '子包 package.json 直接声明 @types/node 26',
    rule: 'node-version-lock',
    files: {
      'packages/api/package.json': JSON.stringify({
        devDependencies: { '@types/node': '^26.0.0' },
      }),
    },
    expected: ['packages/api/package.json: devDependencies["@types/node"]', '永久锁定 24.x'],
  },
  {
    name: '子包 package.json peerDependencies 声明 @types/node 26',
    rule: 'node-version-lock',
    files: {
      'packages/api/package.json': JSON.stringify({
        peerDependencies: { '@types/node': '^26.0.0' },
      }),
    },
    expected: ['packages/api/package.json: peerDependencies["@types/node"]', '永久锁定 24.x'],
  },
  {
    name: '子包 package.json engines.node 升 26',
    rule: 'node-version-lock',
    files: {
      'packages/api/package.json': JSON.stringify({
        engines: { node: '>=26' },
      }),
    },
    expected: ['packages/api/package.json: engines.node', '永久锁定 24.x'],
  },
  {
    name: 'Dockerfile 使用 node:26-alpine',
    rule: 'node-version-lock',
    files: {
      Dockerfile: 'FROM node:26-alpine AS base\n',
    },
    expected: ['Dockerfile:1: FROM node:26-alpine AS base', '永久锁定 24.x'],
  },
  {
    name: 'Dockerfile 带镜像前缀使用 node:26-alpine',
    rule: 'node-version-lock',
    files: {
      Dockerfile: 'FROM docker.io/library/node:26-alpine AS base\n',
    },
    expected: ['Dockerfile:1: FROM docker.io/library/node:26-alpine AS base', '永久锁定 24.x'],
  },
  {
    name: 'Dockerfile 使用无 tag 的 node 镜像',
    rule: 'node-version-lock',
    files: {
      Dockerfile: 'FROM node\nFROM node AS base\nFROM node@sha256:deadbeef\n',
    },
    expected: [
      'Dockerfile:1: FROM node',
      'Dockerfile:2: FROM node AS base',
      'Dockerfile:3: FROM node@sha256:deadbeef',
    ],
  },
  ...[
    'scheduling/scheduler.ts',
    'scheduling/reconcile.ts',
    'runtime-environments/reconcile.ts',
    'knowledge/scheduler.ts',
    'knowledge/reconcile.ts',
    'data-domains/build.ts',
    'data-domains/enrich.ts',
  ].map((file) => ({
    name: `${file} 直接调用 setInterval`,
    rule: 'worker-scheduler-setinterval',
    files: {
      [`packages/worker/src/${file}`]: `${file.startsWith('data-domains/') ? 'import { startIntervalTicker } from "../scheduling/interval-ticker";\n' : ''}tick();\nconst timer = setInterval(tick, RECONCILE_MS);\ntimer.unref();\n`,
    },
    expected: [
      '改用 packages/worker/src/interval-ticker.ts 的 startIntervalTicker',
      'packages/worker/src/scheduling/single-flight.ts 的 startSingleFlight',
    ],
  })),
  {
    name: '调度器手写 inFlight 单飞状态',
    rule: 'worker-handrolled-single-flight',
    files: {
      'packages/worker/src/scheduling/scheduler.ts':
        'let inFlight: Promise<void> | null = null;\ninFlight = sync();',
      'packages/worker/src/knowledge/scheduler.ts': 'var inFlight = sync();\ninFlight = null;',
      'packages/worker/src/runtime-environments/reconcile.ts':
        'let inFlight = sync();\ninFlight = null;',
      'packages/worker/src/data-domains/build.ts': 'let inFlight = null;\ninFlight = sync();',
      'packages/worker/src/data-domains/enrich.ts': 'let inFlight = null;\ninFlight ??= sync();',
    },
    expected: [
      'packages/worker/src/scheduling/scheduler.ts:2',
      'packages/worker/src/knowledge/scheduler.ts:1',
      'packages/worker/src/runtime-environments/reconcile.ts:1',
      'packages/worker/src/data-domains/build.ts:2',
      'packages/worker/src/data-domains/enrich.ts:2',
      'packages/worker/src/scheduling/single-flight.ts 的 startSingleFlight',
      'SchedulerSync.tla',
      'InFlight = {}',
    ],
  },
  {
    name: '调度器通过属性保存、共享或清空 inFlight 单飞状态',
    rule: 'worker-handrolled-single-flight',
    files: {
      'packages/worker/src/scheduling/scheduler.ts':
        "const state = { inFlight: null };\nstate.inFlight = sync();\nstate['inFlight'] = sync();\nstate.inFlight = null;",
    },
    expected: [
      'packages/worker/src/scheduling/scheduler.ts:2',
      'packages/worker/src/scheduling/single-flight.ts 的 startSingleFlight',
      'SchedulerSync.tla',
      'InFlight = {}',
    ],
  },
  {
    name: '调度器通过无插值模板键读写 inFlight 单飞状态',
    rule: 'worker-handrolled-single-flight',
    files: {
      'packages/worker/src/scheduling/scheduler.ts':
        'const state = { inFlight: null };\nstate[`inFlight`] = sync();\nstate.inFlight = null;',
    },
    expected: [
      'packages/worker/src/scheduling/scheduler.ts:2',
      'packages/worker/src/scheduling/single-flight.ts 的 startSingleFlight',
      'SchedulerSync.tla',
      'InFlight = {}',
    ],
  },
  {
    name: '调度器在 finally 回调内清空外层 inFlight 绑定',
    rule: 'worker-handrolled-single-flight',
    files: {
      'packages/worker/src/scheduling/scheduler.ts': `let inFlight: Promise<void> | null = null;
const sync = () => {
  if (inFlight) return inFlight;
  inFlight = syncOnce()
    .catch(() => {})
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
};`,
    },
    expected: [
      'packages/worker/src/scheduling/scheduler.ts:4',
      'packages/worker/src/scheduling/single-flight.ts 的 startSingleFlight',
      'SchedulerSync.tla',
      'InFlight = {}',
    ],
  },
  {
    name: '调度器仅靠 finally 回调内清空未初始化声明的 inFlight',
    rule: 'worker-handrolled-single-flight',
    files: {
      'packages/worker/src/scheduling/scheduler.ts': `let inFlight: Promise<void> | null;
const sync = () => {
  inFlight = syncOnce().finally(() => {
    inFlight = null;
  });
  return inFlight;
};`,
    },
    expected: [
      'packages/worker/src/scheduling/scheduler.ts:3',
      'packages/worker/src/scheduling/single-flight.ts 的 startSingleFlight',
      'SchedulerSync.tla',
      'InFlight = {}',
    ],
  },
  {
    name: '调度器同一绑定下点号与字符串键读写 inFlight 合并识别',
    rule: 'worker-handrolled-single-flight',
    files: {
      'packages/worker/src/scheduling/scheduler.ts':
        'function run(ctx) {\n  ctx.state.inFlight = sync();\n  ctx["state"].inFlight = null;\n}',
    },
    expected: [
      'packages/worker/src/scheduling/scheduler.ts:2',
      'packages/worker/src/scheduling/single-flight.ts 的 startSingleFlight',
      'SchedulerSync.tla',
      'InFlight = {}',
    ],
  },
  ...[
    ['build', 'Build', 'reconcileStaleDataDomainBuilds'],
    ['enrich', 'Enrichment', 'reconcileStaleDataDomainEnrichmentProposals'],
  ].map(([file, kind, reconcile]) => ({
    name: `data-domains/${file}.ts 完整回退到 setInterval`,
    rule: 'worker-scheduler-setinterval',
    files: {
      [`packages/worker/src/data-domains/${file}.ts`]: `export function startDataDomain${kind}Reconciler(input: {
  db: Database;
  logger: Logger;
}): () => Promise<void> {
  const tick = () => {
    void ${reconcile}(input.db, input.logger).catch(() => {
      input.logger.error('data domain reconcile failed');
    });
  };
  tick();
  const timer = setInterval(tick, RECONCILE_MS);
  timer.unref();
  return async () => clearInterval(timer);
}
`,
    },
    expected: [`packages/worker/src/data-domains/${file}.ts:11: 调度器直接调用 setInterval`],
  })),
  {
    name: '嵌套模板插值中调用 setInterval',
    rule: 'worker-scheduler-setinterval',
    files: {
      'packages/worker/src/knowledge/reconcile.ts': `const text = \`outer \${\`inner \${/* \` } */ setInterval(tick, 1000)}\`} end\`;`,
    },
    expected: ['packages/worker/src/knowledge/reconcile.ts:1: 调度器直接调用 setInterval'],
  },
  ...['params', 'query'].map((part) => ({
    name: `router 内 input.${part}.safeParse`,
    rule: 'router-safe-parse',
    files: { 'packages/api/src/modules/chat/router.ts': `input.${part}.safeParse(raw);\n` },
    expected: [
      `router 内对 input.${part} 使用 safeParse`,
      '校验只在 @agentport/contract 的 input schema 完成',
    ],
  })),
  {
    name: 'require pino',
    rule: 'pino-dynamic',
    files: { 'packages/api/src/lib/log.ts': "const pino = require('pino');\n" },
    expected: ['动态引入 pino', '改用 @agentport/core/logger'],
  },
  {
    name: 'lucide 图标逐个传 strokeWidth',
    rule: 'lucide-icon-size',
    files: {
      'packages/web/src/components/search.tsx':
        "import { Search } from 'lucide-react';\nexport const Icon = () => <Search strokeWidth={2} />;\n",
    },
    expected: ['lucide 图标 Search 逐个传 strokeWidth/size'],
  },
  {
    name: 'AppError 经 HTTP 模块再导出并改名',
    rule: 'error-message-duplicate',
    files: {
      'packages/core/src/errors.ts': 'export class AppError extends Error {}',
      'packages/core/src/index.ts': "export { AppError } from './errors.js';",
      'packages/api/src/http/errors.ts':
        "export { AppError, AppError as RequestError } from '@agentport/core';",
      'packages/api/src/modules/example/a.ts':
        "import { AppError } from '../../http/errors.js';\nnew AppError('INVALID_INPUT', '请求无效');",
      'packages/api/src/modules/example/b.ts':
        "import { RequestError as InvalidRequest } from '../../http/errors.js';\nnew InvalidRequest('INVALID_INPUT', '请求无效');",
    },
    expected: [
      '错误文案 "请求无效" 在多个文件重复出现',
      'packages/api/src/modules/example/a.ts:2、packages/api/src/modules/example/b.ts:2',
    ],
  },
  ...[
    {
      name: '跨文件重复字面量',
      message: 'invalid bearer token',
      first: "fail('UNAUTHORIZED', 'invalid bearer token');",
      second: "new AppError('UNAUTHORIZED', 'invalid bearer token');",
    },
    {
      name: '双引号内的单引号',
      message: "can't parse",
      first: `fail('INVALID_INPUT', "can't parse");`,
      second: `fail('INVALID_INPUT', 'can\\'t parse');`,
    },
    {
      name: '真实 MCP toolError 重复文案',
      message: '工具调用失败',
      first: "import { toolError } from './lib/mcp.js';\ntoolError('CODE', '工具调用失败');",
      second: "import { toolError } from './lib/mcp.js';\ntoolError('CODE', '工具调用失败');",
      extra: {
        'packages/api/src/lib/mcp.ts':
          'export function toolError(code: string, message: string) { return { code, message }; }',
      },
    },
    {
      name: '可选链的空值兜底文案重复',
      message: '请求无效',
      first: "fail('INVALID_INPUT', first?.message ?? '请求无效');",
      second: "fail('INVALID_INPUT', first?.message ?? '请求无效');",
    },
    {
      name: '逻辑或兜底文案读取带 TypeScript 包装的导入常量',
      message: '请求无效',
      first: "export const FALLBACK = '请求无效' as const;\nfail('INVALID_INPUT', '请求无效');",
      second:
        "import { FALLBACK } from './a.js';\nfail('INVALID_INPUT', ((first?.message || FALLBACK!) satisfies string));",
    },
    {
      name: '常量与字面量单点回退',
      message: 'invalid bearer token',
      first:
        "export const TOKEN_MESSAGE = 'invalid bearer token';\nfail('UNAUTHORIZED', 'invalid bearer token');",
      second: "import { TOKEN_MESSAGE } from './a';\nfail('UNAUTHORIZED', TOKEN_MESSAGE);",
    },
    {
      name: 'notFound 第二实参',
      message: 'missing document',
      first: "notFound('DOCUMENT', 'missing document');",
      second: "new AppError('NOT_FOUND', 'missing document');",
    },
    {
      name: 'Zod refine 第二实参',
      message: 'invalid URL',
      first: String.raw`z.string().refine((value, ctx) => /^https?:\/\//i.test(value) && valid(value, ctx), 'invalid URL');`,
      second: "z.string().refine(valid, 'invalid URL');",
    },
    {
      name: 'Zod refine 回调正则字符类包含右括号',
      message: 'invalid pattern',
      first: String.raw`z.string().refine((value) => /[)]/.test(value) && /[\]\/]/.test(value), 'invalid pattern');`,
      second: "fail('INVALID_INPUT', 'invalid pattern');",
    },
    {
      name: '两份同值常量的声明身份不同',
      message: 'missing document',
      first: "const MESSAGE = 'missing document';\nfail('NOT_FOUND', MESSAGE);",
      second: 'const MESSAGE = "missing document";\nfail("NOT_FOUND", MESSAGE);',
    },
    {
      name: '相对导入别名解析到实际模块的同名导出',
      message: 'missing document',
      first: "export const MESSAGE = 'missing document';\nfail('NOT_FOUND', 'missing document');",
      second: "import { MESSAGE as MISSING } from './a.js';\nfail('NOT_FOUND', MISSING);",
      extra: { 'packages/api/src/c.ts': "export const MESSAGE = 'invalid document';" },
    },
  ].map(({ name, message, first, second, extra }) => ({
    name,
    rule: 'error-message-duplicate',
    files: {
      ...extra,
      'packages/api/src/a.ts': `\n${errorImports} ${first}\n`,
      'packages/api/src/b.ts': `\n${errorImports} ${second}\n`,
    },
    expected: [
      `错误文案 "${message}" 在多个文件重复出现`,
      `packages/api/src/a.ts:${first.includes('\n') ? 3 : 2}、packages/api/src/b.ts:${second.includes('\n') ? 3 : 2}`,
      '提取到 packages/core/src/errors.ts 或 packages/shared 的命名常量',
      'packages/api/src/http/errors.ts',
    ],
  })),
];

for (const { name, rule, files, expected } of fixtures) {
  test(name, () => {
    const { code, output } = runContract(makeRepo(files));
    const diagnostics = output.split('\n').filter((line) => line.startsWith(`[${rule}] `));
    for (const text of expected) expect(diagnostics.join('\n')).toContain(text);
    expect(code).toBe(1);
  });
}

test('手写 inFlight 每个接收者只报一次并锚定首个 Promise 赋值', () => {
  const { code, output } = runContract(
    makeRepo({
      'packages/worker/src/scheduling/scheduler.ts':
        'const state = { inFlight: null };\nstate.inFlight = sync();\nstate.inFlight = sync();\nstate.inFlight = null;',
    }),
  );
  const diagnostics = output
    .split('\n')
    .filter((line) => line.startsWith('[worker-handrolled-single-flight] '));
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toContain('packages/worker/src/scheduling/scheduler.ts:2');
  expect(code).toBe(1);
});

test.each([
  {
    name: 'setInterval 字符串、模板正文、注释与 ticker 实现',
    files: {
      'packages/worker/src/knowledge/reconcile.ts':
        'const text = "setInterval()";\nconst template = `setInterval()`;\n// setInterval(tick, 1000);',
      'packages/worker/src/scheduling/interval-ticker.ts': 'const timer = setInterval(tick, 1000);',
    },
  },
  {
    name: '单飞和 ticker 实现、非调度路径、字符串与普通读取中的 inFlight',
    files: {
      'packages/worker/src/scheduling/interval-ticker.ts': 'let inFlight; inFlight = tick();',
      'packages/worker/src/scheduling/single-flight.ts': 'let inFlight; inFlight = sync();',
      'packages/worker/src/job/queue.ts': 'let inFlight; inFlight = work();',
      'packages/worker/src/knowledge/reconcile.ts':
        'const text = "let inFlight"; inFlight === null;',
    },
  },
  {
    name: '调度器中只读的 inFlight 声明',
    files: {
      'packages/worker/src/scheduling/scheduler.ts':
        'async function tick() {\n  const inFlight = await queue.getActiveCount();\n  return inFlight;\n}',
    },
  },
  {
    name: '调度器中 inFlight 计数器自增与普通状态写入',
    files: {
      'packages/worker/src/scheduling/scheduler.ts':
        'let inFlight = 0;\ninFlight++;\nconst status = { inFlight: 0 };\nstatus.inFlight = await queue.getActiveCount();',
    },
  },
  {
    name: '调度器中可空计数在关闭时置 null',
    files: {
      'packages/worker/src/scheduling/scheduler.ts':
        'const status = { inFlight: null };\nstatus.inFlight = await queue.getActiveCount();\nstatus.inFlight = null;\nlet inFlight = null;\ninFlight = await queue.getActiveCount();\ninFlight = null;',
    },
  },
  {
    name: '调度器中不同函数各自的 ctx.state.inFlight 不合并',
    files: {
      'packages/worker/src/scheduling/scheduler.ts':
        'function a(ctx) {\n  ctx.state.inFlight = sync();\n}\nfunction b(ctx) {\n  ctx.state.inFlight = null;\n}',
    },
  },
  {
    name: '模板插值注释中的反引号和右花括号不结束模板',
    files: {
      'packages/worker/src/knowledge/reconcile.ts': `const text = \`prefix \${/* \` } */ 1} setInterval(tick, 1000)\`;`,
    },
  },
  {
    name: '非调度路径即使导入 ticker 也可直接调用 setInterval',
    files: Object.fromEntries(
      ['knowledge/queue.ts', 'runtime-environments/build.ts', 'integrations/deliver.ts'].map(
        (file) => [
          `packages/worker/src/${file}`,
          "import { startIntervalTicker } from '../scheduling/interval-ticker.js';\nsetInterval(tick, 1000);",
        ],
      ),
    ),
  },
  {
    name: '成员 fail 与独立 fail 的同文案',
    files: {
      'packages/api/src/a.ts':
        "obj.fail('NOT_FOUND', 'missing document');\nobj?.fail('NOT_FOUND', 'missing document');",
      'packages/api/src/b.ts': "fail('NOT_FOUND', 'missing document');",
    },
  },
  {
    name: '包导入、缺失导出和非字面量导出不借用同名常量',
    files: {
      'packages/api/src/a.ts':
        "export const MESSAGE = 'missing document';\nfail('NOT_FOUND', 'missing document');",
      'packages/api/src/b.ts':
        "import { MESSAGE } from 'other-package';\nfail('NOT_FOUND', MESSAGE);",
      'packages/api/src/c.ts':
        "import { MESSAGE } from './messages.js';\nfail('NOT_FOUND', MESSAGE);",
      'packages/api/src/d.ts':
        "import { MESSAGE } from './missing.js';\nfail('NOT_FOUND', MESSAGE);",
      'packages/api/src/messages.ts': "export const MESSAGE = 'other' + suffix;",
    },
  },
  {
    name: '局部变量遮蔽同名导入',
    files: {
      'packages/api/src/a.ts':
        "export const MESSAGE = 'missing document';\nfail('NOT_FOUND', 'missing document');",
      'packages/api/src/b.ts':
        "import { MESSAGE } from './a.js';\nfunction run() { const MESSAGE = lookup(); fail('NOT_FOUND', MESSAGE); }",
    },
  },
  {
    name: '模板错误文案',
    files: {
      'packages/api/src/a.ts': `fail('NOT_FOUND', \`missing \${id}\`);`,
      'packages/api/src/b.ts': `fail('NOT_FOUND', \`missing \${id}\`);`,
    },
  },
  {
    name: '错误文案字符串拼接',
    files: {
      'packages/api/src/a.ts': "fail('NOT_FOUND', 'Missing ' + name);",
      'packages/api/src/b.ts': "fail('NOT_FOUND', 'Missing ' + id);",
    },
  },
  {
    name: '模板正文与注释中的假调用',
    files: {
      'packages/api/src/a.ts':
        "const text = `fail('NOT_FOUND', 'missing document')`;\n// fail('NOT_FOUND', 'missing document');",
      'packages/api/src/b.ts': "fail('NOT_FOUND', 'missing document');",
    },
  },
  {
    name: '测试文件中的重复文案',
    files: {
      'packages/api/src/a.ts': "fail('NOT_FOUND', 'missing document');",
      'packages/api/src/a.test.ts': "fail('NOT_FOUND', 'missing document');",
      'packages/api/src/b.test.tsx': "fail('NOT_FOUND', 'missing document');",
    },
  },
  {
    name: '跨文件复用同一消息常量',
    files: {
      'packages/api/src/errors.ts': "export const MISSING = 'missing document';",
      'packages/api/src/a.ts': "import { MISSING } from './errors';\nfail('NOT_FOUND', MISSING);",
      'packages/api/src/b.ts':
        "import { MISSING } from './errors';\nnotFound('DOCUMENT', MISSING);",
    },
  },
  {
    name: '多阶段 Dockerfile 与带前缀 node:24 镜像及合法 24.x 版本范围',
    files: {
      'package.json': JSON.stringify({
        engines: { node: '>=24.22.2 <25.0.0' },
        workspaces: { catalog: { '@types/node': '^24.19.2' } },
        overrides: { '@types/node': '~24.19.0' },
        devDependencies: { '@types/node': 'catalog:' },
      }),
      'packages/api/package.json': JSON.stringify({
        engines: { node: '24.x' },
        peerDependencies: { '@types/node': '^24' },
      }),
      Dockerfile:
        'FROM oven/bun:1.4.5-alpine AS bun\nFROM --platform=linux/amd64 docker.io/library/node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS base\nFROM base AS sandbox\n',
    },
  },
])('$name 不触发违规', ({ files }) => {
  const sources = Object.fromEntries(
    Object.entries(files).map(([file, source]) => [
      file,
      file.startsWith('packages/api/src/') ? `${errorImports}\n${source}` : source,
    ]),
  );
  expect(runContract(makeRepo(sources)).code).toBe(0);
});

test.each([
  ['正则字面量', 'if (enabled) /setInterval()/.test(text);', 0],
  ['对象方法声明', 'const timer = { setInterval(tick, ms) {} };', 0],
  ['可选全局定时调用', 'globalThis.setInterval?.(tick, 1000);', 1],
  ['参数遮蔽 globalThis', 'function run(globalThis) { globalThis.setInterval?.(tick, 1000); }', 0],
])('调度器中的%s', (_name, source, expectedCode) => {
  const { code, output } = runContract(
    makeRepo({ 'packages/worker/src/job/scheduler.ts': source }),
  );
  expect(code).toBe(expectedCode);
  if (expectedCode === 1) {
    expect(output).toContain(
      '[worker-scheduler-setinterval] packages/worker/src/job/scheduler.ts:1',
    );
  }
});

test.each([
  ['泛型实参里的字符串类型', "fail(make<Pair<number, 'missing document', boolean>>(), other);"],
  ['函数参数遮蔽导入', "function run(MESSAGE: string) { fail('NOT_FOUND', MESSAGE); }"],
  ['参数解构遮蔽导入', "function run({ MESSAGE }) { fail('NOT_FOUND', MESSAGE); }"],
  ['局部 fail', "function run() { function fail(code, message) {} fail('NOT_FOUND', MESSAGE); }"],
  [
    '局部 class AppError',
    "function run() { class AppError extends Error {} new AppError('NOT_FOUND', MESSAGE); }",
  ],
  ['普通对象 refine', 'const object = { refine() {} }; object.refine(valid, MESSAGE);'],
])('%s不计入重复文案', (_name, source) => {
  const { code, output } = runContract(
    makeRepo({
      'packages/api/src/a.ts':
        "import { AppError } from '@agentport/core';\nexport const MESSAGE = 'missing document';\nnew AppError('NOT_FOUND', 'missing document');",
      'packages/api/src/b.ts': `import { fail } from '@agentport/core';\nimport { MESSAGE } from './a.js';\n${source}`,
    }),
  );
  expect(output).not.toContain('[error-message-duplicate]');
  expect(code).toBe(0);
});

test('不同空值兜底文案不计入重复文案', () => {
  const { code, output } = runContract(
    makeRepo({
      'packages/api/src/a.ts': `${errorImports} fail('INVALID_INPUT', first?.message ?? '请求无效');`,
      'packages/api/src/b.ts': `${errorImports} fail('INVALID_INPUT', first?.message ?? '输入无效');`,
    }),
  );
  expect(output).not.toContain('[error-message-duplicate]');
  expect(code).toBe(0);
});

test('仅 shared/mcp.ts 回退字面量仍命中跨包重复文案', () => {
  const files = Object.fromEntries(
    [
      'packages/core/src/errors.ts',
      'packages/core/src/net-guard.ts',
      ...new Bun.Glob('packages/shared/src/**/*.ts').scanSync({ cwd: REPO_ROOT }),
    ].map((file) => [file, readFileSync(join(REPO_ROOT, file), 'utf8')]),
  );
  const file = 'packages/shared/src/mcp.ts';
  const source = files[file];
  const message = 'URL不能包含账号密码，请通过加密headers配置凭证';
  files[file] = source.replace('}, URL_CREDENTIALS_MESSAGE);', `}, '${message}');`);
  expect(files[file]).not.toBe(source);
  const { code, output } = runContract(makeRepo(files));
  expect(output).toContain(`[error-message-duplicate] 错误文案 "${message}"`);
  expect(output).toMatch(
    /packages\/core\/src\/net-guard\.ts:\d+、packages\/shared\/src\/mcp\.ts:\d+/,
  );
  expect(code).toBe(1);
});

test('当前真实仓库通过契约检查', () => {
  const { code, output } = runContract(REPO_ROOT);
  expect(output).toContain('project contract OK');
  expect(code).toBe(0);
});

test('规则 ID 与非空 fixture 注册表双向一致', () => {
  const result = Bun.spawnSync([process.execPath, SCRIPT, '--rule-ids']);
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  expect(fixtures.every(({ expected }) => expected.length > 0)).toBe(true);
  const fixtureRules = [...new Set(fixtures.map(({ rule }) => rule))].sort();
  expect(JSON.parse(result.stdout.toString())).toEqual(fixtureRules);
});

test.each([
  { code: 'report("extra-rule", "extra");', error: '', id: 'extra-rule' },
  { code: 'report(rule, "extra");', error: 'report 缺少静态规则 ID' },
  { code: 'report("extra" + suffix, "extra");', error: 'report 缺少静态规则 ID' },
  { code: 'problems /* comment */ . push("extra");', error: '请通过 report 添加诊断' },
])('规则注册表检查 $code', ({ code, error, id }) => {
  const dir = makeRepo({ 'guard.mjs': `${readFileSync(SCRIPT, 'utf8')}\n${code}\n` });
  const result = Bun.spawnSync([process.execPath, join(dir, 'guard.mjs'), '--rule-ids'], {
    env: { ...process.env, NODE_PATH: join(REPO_ROOT, 'node_modules') },
  });
  if (id) {
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toContain(id);
  } else {
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(error);
  }
});
