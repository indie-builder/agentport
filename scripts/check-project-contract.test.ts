import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runContractCheck } from './contract/index.js';

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

const validRootPackageJson = JSON.stringify({
  engines: { node: '>=24.22.2 <25' },
  workspaces: { catalog: { '@types/node': '24.19.2' } },
  devDependencies: { '@types/node': 'catalog:' },
});

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

function runContract(cwd: string): { code: number; output: string } {
  const problems = runContractCheck({ root: cwd });
  return {
    code: problems.length > 0 ? 1 : 0,
    output: problems.length > 0 ? problems.join('\n') : 'project contract OK',
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
    name: 'web 引 @agentport/sandbox',
    rule: 'web-server-import',
    files: {
      'packages/web/src/lib/sandbox.ts': "import { probe } from '@agentport/sandbox';\n",
    },
    expected: ['web 禁止引入 @agentport/sandbox'],
  },
  {
    name: 'web 动态 import @agentport/db',
    rule: 'web-server-import',
    files: {
      'packages/web/src/lib/agents.ts': "export const load = () => import('@agentport/db');\n",
    },
    expected: ['web 禁止引入 @agentport/db'],
  },
  {
    name: 'web 动态 import @radix-ui',
    rule: 'web-banned-primitive',
    files: {
      'packages/web/src/components/dialog.tsx':
        "export const load = () => import('@radix-ui/react-dialog');\n",
    },
    expected: ['引入 @radix-ui/react-dialog'],
  },
  {
    name: 'shared 跨层 import',
    rule: 'shared-import',
    files: { 'packages/shared/src/fs.ts': "import { readFileSync } from 'node:fs';\n" },
    expected: ['shared 禁止引入 node:fs', 'packages/shared 只允许依赖 zod 与包内相对路径'],
  },
  {
    name: 'shared 动态 import node:fs',
    rule: 'shared-import',
    files: { 'packages/shared/src/fs.ts': "export const load = () => import('node:fs');\n" },
    expected: ['shared 禁止引入 node:fs'],
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
    name: 'contract 引 @agentport/web 与 @agentport/sandbox',
    rule: 'contract-import',
    files: {
      'packages/contract/src/a.ts': "import { x } from '@agentport/web';\n",
      'packages/contract/src/b.ts': "export const load = () => import('@agentport/sandbox');\n",
    },
    expected: ['contract 禁止引入 @agentport/web', 'contract 禁止引入 @agentport/sandbox'],
  },
  {
    name: 'db 跨层 import',
    rule: 'db-import',
    files: { 'packages/db/src/repo/agent.ts': "import { Hono } from 'hono';\n" },
    expected: ['db 禁止引入 hono', 'db 模块边界只使用 drizzle-orm/bun-sql'],
  },
  {
    name: 'db 引 @agentport/contract、@agentport/web 与 @agentport/sandbox',
    rule: 'db-import',
    files: {
      'packages/db/src/repo/a.ts': "import { c } from '@agentport/contract';\n",
      'packages/db/src/repo/b.ts': "import { w } from '@agentport/web';\n",
      'packages/db/src/repo/c.ts': "export const load = () => import('@agentport/sandbox');\n",
      'packages/db/src/repo/d.ts': "export const loadHono = () => require('hono');\n",
    },
    expected: [
      'db 禁止引入 @agentport/contract',
      'db 禁止引入 @agentport/web',
      'db 禁止引入 @agentport/sandbox',
      'db 禁止引入 hono',
    ],
  },
  {
    name: 'core 引 @agentport/db',
    rule: 'core-import',
    files: { 'packages/core/src/bad.ts': "import { repo } from '@agentport/db';\n" },
    expected: ['core 禁止引入 @agentport/db', 'packages/core 只允许依赖 @agentport/shared'],
  },
  {
    name: 'core 引 @agentport/sandbox',
    rule: 'core-import',
    files: { 'packages/core/src/bad.ts': "import { run } from '@agentport/sandbox/runner';\n" },
    expected: ['core 禁止引入 @agentport/sandbox/runner'],
  },
  {
    name: 'core 动态 import @agentport/db',
    rule: 'core-import',
    files: { 'packages/core/src/bad.ts': "export const load = () => import('@agentport/db');\n" },
    expected: ['core 禁止引入 @agentport/db'],
  },
  {
    name: 'worker 引 @agentport/api',
    rule: 'worker-import',
    files: { 'packages/worker/src/bad.ts': "import { app } from '@agentport/api';\n" },
    expected: ['worker 禁止引入 @agentport/api', 'packages/worker 只允许依赖 @agentport/core'],
  },
  {
    name: 'worker 引 @agentport/sandbox',
    rule: 'worker-import',
    files: { 'packages/worker/src/bad.ts': "import { probe } from '@agentport/sandbox/probe';\n" },
    expected: ['worker 禁止引入 @agentport/sandbox/probe'],
  },
  {
    name: 'worker 动态 import @agentport/api',
    rule: 'worker-import',
    files: {
      'packages/worker/src/bad.ts': "export const load = () => import('@agentport/api');\n",
    },
    expected: ['worker 禁止引入 @agentport/api'],
  },
  {
    name: 'sandbox 引 @agentport/core',
    rule: 'sandbox-import',
    files: { 'packages/sandbox/src/runner.ts': "import { fail } from '@agentport/core';\n" },
    expected: ['sandbox 禁止引入 @agentport/core', 'packages/sandbox 只允许依赖 @agentport/shared'],
  },
  {
    name: 'sandbox 引 @agentport/db',
    rule: 'sandbox-import',
    files: { 'packages/sandbox/src/probe.ts': "import { repo } from '@agentport/db';\n" },
    expected: ['sandbox 禁止引入 @agentport/db'],
  },
  {
    name: 'sandbox 动态 import @agentport/core',
    rule: 'sandbox-import',
    files: {
      'packages/sandbox/src/runner.ts': "export const load = () => import('@agentport/core');\n",
    },
    expected: ['sandbox 禁止引入 @agentport/core'],
  },
  {
    name: 'api 跨层 import @agentport/{worker,sandbox,web}',
    rule: 'api-import',
    files: {
      'packages/api/src/a.ts': "import { run } from '@agentport/worker';\n",
      'packages/api/src/b.ts': "import { probe } from '@agentport/sandbox/probe';\n",
      'packages/api/src/c.ts': "import { App } from '@agentport/web';\n",
      'packages/api/src/d.ts': "export const load = () => import('@agentport/worker');\n",
      'packages/api/src/e.ts': "export const req = () => require('@agentport/sandbox');\n",
    },
    expected: [
      'packages/api/src/a.ts:1: api 禁止引入 @agentport/worker',
      'packages/api/src/b.ts:1: api 禁止引入 @agentport/sandbox/probe',
      'packages/api/src/c.ts:1: api 禁止引入 @agentport/web',
      'packages/api/src/d.ts:1: api 禁止引入 @agentport/worker',
      'packages/api/src/e.ts:1: api 禁止引入 @agentport/sandbox',
      'packages/api 只允许依赖 @agentport/contract、@agentport/core、@agentport/db 与 @agentport/shared',
    ],
  },
  {
    name: '文件级循环依赖（相对导入三元环）',
    rule: 'file-cycle',
    files: {
      'packages/core/src/a.ts': "import { b } from './b.js';\nexport const a = () => b;\n",
      'packages/core/src/b.ts': "import { c } from './c.js';\nexport const b = () => c;\n",
      'packages/core/src/c.ts': "import { a } from './a.js';\nexport const c = () => a;\n",
    },
    expected: [
      '发现文件级循环依赖：packages/core/src/a.ts -> packages/core/src/b.ts -> packages/core/src/c.ts -> packages/core/src/a.ts',
    ],
  },
  {
    name: '文件级循环依赖（web @/ 别名与跨包 @agentport/*）',
    rule: 'file-cycle',
    files: {
      'packages/web/src/a.tsx': "import { b } from '@/b';\nexport const A = () => b;\n",
      'packages/web/src/b.ts': "import { A } from './a';\nexport const b = A;\n",
      'packages/core/src/x.ts': "import { s } from '@agentport/shared';\nexport const x = s;\n",
      'packages/shared/src/index.ts':
        "import { x } from '@agentport/core/x';\nexport const s = x;\n",
    },
    expected: [
      '发现文件级循环依赖：packages/core/src/x.ts -> packages/shared/src/index.ts -> packages/core/src/x.ts',
      '发现文件级循环依赖：packages/web/src/a.tsx -> packages/web/src/b.ts -> packages/web/src/a.tsx',
    ],
  },
  {
    name: 'API 业务域循环依赖（跨文件模块环）',
    rule: 'api-module-cycle',
    files: {
      'packages/api/src/modules/alpha/a.ts':
        "import { b } from '../beta/b.js';\nexport const a = b;\n",
      'packages/api/src/modules/alpha/d.ts': 'export const d = 1;\n',
      'packages/api/src/modules/beta/b.ts': 'export const b = 2;\n',
      'packages/api/src/modules/beta/c.ts':
        "import { d } from '../alpha/d.js';\nexport const c = d;\n",
    },
    expected: ['发现 API 业务域循环依赖：alpha -> beta -> alpha'],
  },
  {
    name: 'Worker 子域循环依赖（跨文件子域环）',
    rule: 'worker-domain-cycle',
    files: {
      'packages/worker/src/runs/a.ts':
        "import { b } from '../scheduling/b.js';\nexport const a = b;\n",
      'packages/worker/src/runs/d.ts': 'export const d = 1;\n',
      'packages/worker/src/scheduling/b.ts': 'export const b = 2;\n',
      'packages/worker/src/scheduling/c.ts':
        "import { d } from '../runs/d.js';\nexport const c = d;\n",
    },
    expected: ['发现 Worker 子域循环依赖：runs -> scheduling -> runs'],
  },
  {
    name: 'api http/lib/queue 禁止引入 modules',
    rule: 'api-http-no-module-import',
    files: {
      'packages/api/src/http/mid.ts':
        "import { run } from '../modules/chat/use-cases.js';\nexport const mid = run;\n",
      'packages/api/src/lib/helper.ts':
        "import { auth } from '../modules/auth/session.js';\nexport const helper = auth;\n",
      'packages/api/src/queue/producer.ts':
        "import { svc } from '../modules/agents/service.js';\nexport const p = svc;\n",
    },
    expected: [
      'packages/api/src/http/mid.ts:1: 基础设施层禁止引入业务模块 ../modules/chat/use-cases.js',
      'packages/api/src/lib/helper.ts:1: 基础设施层禁止引入业务模块 ../modules/auth/session.js',
      'packages/api/src/queue/producer.ts:1: 基础设施层禁止引入业务模块 ../modules/agents/service.js',
    ],
  },
  {
    name: 'api http/lib/queue 动态 import modules',
    rule: 'api-http-no-module-import',
    files: {
      'packages/api/src/http/mid.ts':
        "export const load = () => import('../modules/chat/use-cases.js');\n",
      'packages/api/src/lib/helper.ts':
        "export const req = () => require('../modules/auth/session.js');\n",
    },
    expected: [
      'packages/api/src/http/mid.ts:1: 基础设施层禁止引入业务模块 ../modules/chat/use-cases.js',
      'packages/api/src/lib/helper.ts:1: 基础设施层禁止引入业务模块 ../modules/auth/session.js',
    ],
  },
  {
    name: 'api 禁止在 routes/index.ts 之外导入 router',
    rule: 'api-no-cross-router-import',
    files: {
      'packages/api/src/modules/chat/use-cases.ts':
        "import { agentsRouter } from '../agents/router.js';\nexport const r = agentsRouter;\n",
      'packages/api/src/modules/chat/http.ts':
        "import { chatRouter } from './router.ts';\nexport const r = chatRouter;\n",
    },
    expected: [
      'packages/api/src/modules/chat/use-cases.ts:1: 禁止在 routes/index.ts 之外导入 ../agents/router.js',
      'packages/api/src/modules/chat/http.ts:1: 禁止在 routes/index.ts 之外导入 ./router.ts',
    ],
  },
  {
    name: 'api routes/index.ts 之外动态 import router',
    rule: 'api-no-cross-router-import',
    files: {
      'packages/api/src/modules/chat/use-cases.ts':
        "export const load = () => import('../agents/router.js');\n",
    },
    expected: [
      'packages/api/src/modules/chat/use-cases.ts:1: 禁止在 routes/index.ts 之外导入 ../agents/router.js',
    ],
  },
  {
    name: 'api 禁止直接静态导入 hono/body-limit',
    rule: 'api-no-raw-hono-bodylimit',
    files: {
      'packages/api/src/modules/chat/http.ts':
        "import { bodyLimit } from 'hono/body-limit';\nexport const limit = bodyLimit;\n",
    },
    expected: [
      'packages/api/src/modules/chat/http.ts:1: 禁止直接导入 hono/body-limit（改用 packages/api/src/http/body-limit.ts 的 requestBodyLimit）',
    ],
  },
  {
    name: 'api 禁止直接动态导入 hono/body-limit',
    rule: 'api-no-raw-hono-bodylimit',
    files: {
      'packages/api/src/modules/chat/http.ts':
        "export const load = () => import('hono/body-limit');\n",
    },
    expected: [
      'packages/api/src/modules/chat/http.ts:1: 禁止直接导入 hono/body-limit（改用 packages/api/src/http/body-limit.ts 的 requestBodyLimit）',
    ],
  },
  {
    name: 'api modules 禁止直接抛出 new ORPCError 与 new z.ZodError',
    rule: 'api-no-orpc-zod-throw',
    files: {
      'packages/api/src/modules/knowledge/router.ts':
        "import { ORPCError } from '@orpc/server';\nexport const run = () => { throw new ORPCError('CONFLICT', { message: 'bad' }); };\n",
      'packages/api/src/modules/chat/use-cases.ts':
        "import { ORPCError } from '@orpc/contract';\nexport const run = () => { throw new ORPCError('NOT_FOUND'); };\n",
      'packages/api/src/modules/agents/use-cases.ts':
        "import { z } from 'zod';\nexport const run = () => { throw new z.ZodError([]); };\n",
    },
    expected: [
      'packages/api/src/modules/knowledge/router.ts:2: 业务模块禁止直接抛出 new ORPCError()',
      'packages/api/src/modules/chat/use-cases.ts:2: 业务模块禁止直接抛出 new ORPCError()',
      'packages/api/src/modules/agents/use-cases.ts:2: 业务模块禁止直接抛出 new ZodError()',
      'AppError',
      'fail()',
      'extra',
      'http/orpc.ts',
    ],
  },
  {
    name: 'api modules 通过别名、命名空间或动态导入抛出 ORPCError 与 ZodError',
    rule: 'api-no-orpc-zod-throw',
    files: {
      'packages/api/src/modules/knowledge/router.ts':
        "import { ORPCError as RpcErr } from '@orpc/server';\nconst Err = RpcErr;\nexport const run = () => { throw new Err('BAD_REQUEST'); };\n",
      'packages/api/src/modules/chat/router.ts':
        "import * as orpc from '@orpc/contract';\nexport const run = () => { throw new orpc.ORPCError('CONFLICT'); };\n",
      'packages/api/src/modules/agents/router.ts':
        "import { ZodError as ZErr } from 'zod';\nexport const run = () => { throw new ZErr([]); };\n",
      'packages/api/src/modules/eval/router.ts':
        "import { z as zod } from 'zod';\nexport const run = () => { throw new zod.ZodError([]); };\n",
      'packages/api/src/modules/servers/router.ts':
        "import zDefault from 'zod';\nexport const run = () => { throw new zDefault.ZodError([]); };\n",
      'packages/api/src/modules/runs/router.ts':
        "export const run = async () => {\n  const { ORPCError: DynamicRpcErr } = await import('@orpc/server');\n  throw new DynamicRpcErr('FORBIDDEN');\n};\n",
      'packages/api/src/modules/auth/router.ts':
        "import * as zNs from 'zod';\nexport const run = () => { throw new zNs.z.ZodError([]); };\n",
    },
    expected: [
      'packages/api/src/modules/knowledge/router.ts:3: 业务模块禁止直接抛出 new ORPCError()',
      'packages/api/src/modules/chat/router.ts:2: 业务模块禁止直接抛出 new ORPCError()',
      'packages/api/src/modules/agents/router.ts:2: 业务模块禁止直接抛出 new ZodError()',
      'packages/api/src/modules/eval/router.ts:2: 业务模块禁止直接抛出 new ZodError()',
      'packages/api/src/modules/servers/router.ts:2: 业务模块禁止直接抛出 new ZodError()',
      'packages/api/src/modules/runs/router.ts:3: 业务模块禁止直接抛出 new ORPCError()',
      'packages/api/src/modules/auth/router.ts:2: 业务模块禁止直接抛出 new ZodError()',
    ],
  },
  {
    name: 'api 禁止直接调用 Drizzle 表 insert/update/delete（含 schema 成员、表导入与别名）',
    rule: 'api-no-raw-dml',
    files: {
      'packages/api/src/modules/runs/cancel-run.ts':
        "import { schema } from '@agentport/db';\nexport const run = (tx: { update: (t: unknown) => unknown }) => tx.update(schema.agentRuns);\n",
      'packages/api/src/modules/auth/session.ts':
        "import { authSessions } from '@agentport/db';\nexport const revoke = (db: { delete: (t: unknown) => unknown }) => db.delete(authSessions);\n",
      'packages/api/src/modules/auth/bootstrap.ts':
        "import { roles as roleTable, schema as dbSchema } from '@agentport/db';\nconst { agentRuns: runsTable } = dbSchema;\nexport const seed = (tx: { insert: (t: unknown) => unknown; delete: (t: unknown) => unknown }) => [tx.insert(roleTable), tx.delete(runsTable)];\n",
      'packages/api/src/modules/agents/package.ts':
        "import * as dbPkg from '@agentport/db';\nconst tbl = dbPkg.schema.agentRules;\nexport const write = (db: { insert: (t: unknown) => unknown; update: (t: unknown) => unknown }) => [db.insert(dbPkg.agents), db.update(tbl)];\n",
      'packages/api/src/http/cleanup.ts':
        "import { agents as agentsTbl } from '@agentport/db/schema';\nexport const clean = (db: { delete: (t: unknown) => unknown }) => db.delete(agentsTbl);\n",
    },
    expected: [
      'packages/api/src/modules/runs/cancel-run.ts:2: 禁止在 API 层直接调用 Drizzle 表 DML .update()',
      'packages/api/src/modules/auth/session.ts:2: 禁止在 API 层直接调用 Drizzle 表 DML .delete()',
      'packages/api/src/modules/auth/bootstrap.ts:3: 禁止在 API 层直接调用 Drizzle 表 DML .insert()',
      'packages/api/src/modules/auth/bootstrap.ts:3: 禁止在 API 层直接调用 Drizzle 表 DML .delete()',
      'packages/api/src/modules/agents/package.ts:3: 禁止在 API 层直接调用 Drizzle 表 DML .insert()',
      'packages/api/src/modules/agents/package.ts:3: 禁止在 API 层直接调用 Drizzle 表 DML .update()',
      'packages/api/src/http/cleanup.ts:2: 禁止在 API 层直接调用 Drizzle 表 DML .delete()',
      '全部写操作收口至 @agentport/db/src/repo/',
    ],
  },
  {
    name: 'api 禁止在 sql 模板与 sql.raw 中直接执行 INSERT INTO / DELETE FROM / UPDATE ... SET',
    rule: 'api-no-raw-dml',
    files: {
      'packages/api/src/modules/knowledge/use-cases/model-profiles.ts':
        "import { sql } from 'drizzle-orm';\nexport const del = (db: { execute: (q: unknown) => unknown }, id: string) => db.execute(sql`delete from knowledge_model_profiles where id = $" +
        '{id}`);\n',
      'packages/api/src/modules/knowledge/use-cases/jobs.ts':
        "import { sql as rawSql } from 'drizzle-orm';\nimport { schema } from '@agentport/db';\nexport const ins = (db: { execute: (q: unknown) => unknown }, id: string) => db.execute(rawSql`INSERT INTO $" +
        '{schema.knowledgeJobs} (id) VALUES ($' +
        '{id})`);\n',
      'packages/api/src/modules/eval/use-cases.ts':
        "import * as orm from 'drizzle-orm';\nexport const upd = (db: { execute: (q: unknown) => unknown }, id: string) => db.execute(orm.sql`UPDATE eval_runs AS r SET status = 'failed' WHERE r.id = $" +
        '{id}`);\n',
      'packages/api/src/modules/servers/repo.ts':
        "import { sql } from 'drizzle-orm';\nexport const rawDel = (db: { execute: (q: unknown) => unknown }) => db.execute(sql.raw('DELETE FROM servers'));\n",
    },
    expected: [
      'packages/api/src/modules/knowledge/use-cases/model-profiles.ts:2: 禁止在 API 层 sql 模板中直接执行 DELETE FROM',
      'packages/api/src/modules/knowledge/use-cases/jobs.ts:3: 禁止在 API 层 sql 模板中直接执行 INSERT INTO',
      'packages/api/src/modules/eval/use-cases.ts:2: 禁止在 API 层 sql 模板中直接执行 UPDATE ... SET',
      'packages/api/src/modules/servers/repo.ts:2: 禁止在 API 层 sql.raw() 中直接执行 DELETE FROM',
      '全部写操作收口至 @agentport/db/src/repo/',
    ],
  },
  {
    name: 'api config.ts 之外禁止直接访问 process.env 或 Bun.env',
    rule: 'api-no-process-env',
    files: {
      'packages/api/src/modules/chat/http.ts': 'export const port = process.env.PORT;\n',
      'packages/api/src/http/health.ts': 'export const env = Bun.env.NODE_ENV;\n',
      'packages/api/src/lib/auth.ts':
        'const { env } = globalThis.process;\nexport const x = env;\n',
    },
    expected: [
      'packages/api/src/modules/chat/http.ts:1: 禁止在 config.ts 之外直接访问 process.env',
      'packages/api/src/http/health.ts:1: 禁止在 config.ts 之外直接访问 Bun.env',
      'packages/api/src/lib/auth.ts:1: 禁止在 config.ts 之外直接访问 process.env',
    ],
  },
  {
    name: 'api config.ts 之外通过 ESM 导入访问 process.env 或 Bun.env',
    rule: 'api-no-process-env',
    files: {
      'packages/api/src/modules/chat/http.ts':
        "import process from 'node:process';\nexport const port = process.env.PORT;\n",
      'packages/api/src/modules/chat/use-cases.ts':
        "import * as proc from 'process';\nexport const port = proc.env.PORT;\n",
      'packages/api/src/modules/agents/http.ts':
        "import { env } from 'node:process';\nexport const port = env.PORT;\n",
      'packages/api/src/modules/agents/use-cases.ts':
        "import { env as e } from 'process';\nexport const port = e.PORT;\n",
      'packages/api/src/http/health.ts':
        "import * as BunNS from 'bun';\nexport const mode = BunNS.env.NODE_ENV;\n",
      'packages/api/src/http/security.ts':
        "import BunDefault from 'bun';\nexport const { env } = BunDefault;\n",
      'packages/api/src/lib/auth.ts':
        "import { env as bunEnv } from 'bun';\nexport const mode = bunEnv.NODE_ENV;\n",
    },
    expected: [
      'packages/api/src/modules/chat/http.ts:2: 禁止在 config.ts 之外直接访问 process.env',
      'packages/api/src/modules/chat/use-cases.ts:2: 禁止在 config.ts 之外直接访问 process.env',
      'packages/api/src/modules/agents/http.ts:2: 禁止在 config.ts 之外直接访问 process.env',
      'packages/api/src/modules/agents/use-cases.ts:2: 禁止在 config.ts 之外直接访问 process.env',
      'packages/api/src/http/health.ts:2: 禁止在 config.ts 之外直接访问 Bun.env',
      'packages/api/src/http/security.ts:2: 禁止在 config.ts 之外直接访问 Bun.env',
      'packages/api/src/lib/auth.ts:2: 禁止在 config.ts 之外直接访问 Bun.env',
    ],
  },
  {
    name: 'db 禁止直接访问 process.env 或 Bun.env',
    rule: 'db-no-process-env',
    files: {
      'packages/db/src/index.ts': 'export const url = process.env.DATABASE_URL;\n',
      'packages/db/src/repo/agents.ts': 'export const env = Bun?.env?.NODE_ENV;\n',
    },
    expected: [
      'packages/db/src/index.ts:1: db 模块禁止直接访问 process.env',
      'packages/db/src/repo/agents.ts:1: db 模块禁止直接访问 Bun.env',
    ],
  },
  {
    name: 'db 通过 ESM 导入访问 process.env 或 Bun.env',
    rule: 'db-no-process-env',
    files: {
      'packages/db/src/index.ts':
        "import * as proc from 'node:process';\nexport const url = proc.env.DATABASE_URL;\n",
      'packages/db/src/repo/agents.ts':
        "import { env as e } from 'node:process';\nexport const url = e.DATABASE_URL;\n",
      'packages/db/src/repo/runs.ts':
        "import * as BunNS from 'bun';\nexport const mode = BunNS.env.NODE_ENV;\n",
      'packages/db/src/repo/skills.ts':
        "import { env as bunEnv } from 'bun';\nexport const mode = bunEnv.NODE_ENV;\n",
    },
    expected: [
      'packages/db/src/index.ts:2: db 模块禁止直接访问 process.env',
      'packages/db/src/repo/agents.ts:2: db 模块禁止直接访问 process.env',
      'packages/db/src/repo/runs.ts:2: db 模块禁止直接访问 Bun.env',
      'packages/db/src/repo/skills.ts:2: db 模块禁止直接访问 Bun.env',
    ],
  },
  {
    name: 'worker 组合根之外禁止调用 createDb 或 new DockerSandboxProvider',
    rule: 'worker-single-composition-root',
    files: {
      'packages/worker/src/handlers.ts':
        "import { createDb } from '@agentport/db';\nexport const h = () => createDb('postgres://localhost/db');\n",
      'packages/worker/src/sandbox/sessions.ts':
        "import { DockerSandboxProvider } from './docker.js';\nexport const p = new DockerSandboxProvider({});\n",
    },
    expected: [
      'packages/worker/src/handlers.ts:2: 禁止在组合根（index.ts / maintenance.ts）之外调用 createDb()',
      'packages/worker/src/sandbox/sessions.ts:2: 禁止在组合根（index.ts / maintenance.ts）之外实例化 new DockerSandboxProvider()',
    ],
  },
  {
    name: 'worker 组合根之外通过别名或命名空间调用 createDb 或 new DockerSandboxProvider',
    rule: 'worker-single-composition-root',
    files: {
      'packages/worker/src/handlers.ts':
        "import { createDb as openDb } from '@agentport/db';\nexport const h = () => openDb('postgres://localhost/db');\n",
      'packages/worker/src/jobs.ts':
        "import * as dbMod from '@agentport/db';\nexport const h = () => dbMod.createDb('postgres://localhost/db');\n",
      'packages/worker/src/sandbox/sessions.ts':
        "import { DockerSandboxProvider as DSP } from './docker.js';\nexport const p = new DSP({});\n",
      'packages/worker/src/sandbox/pool.ts':
        "import * as dockerMod from './docker.js';\nexport const p = new dockerMod.DockerSandboxProvider({});\n",
      'packages/worker/src/runs/dynamic.ts':
        "export const run = async () => {\n  const { createDb: openDb } = await import('@agentport/db');\n  return openDb('postgres://localhost/db');\n};\n",
    },
    expected: [
      'packages/worker/src/handlers.ts:2: 禁止在组合根（index.ts / maintenance.ts）之外调用 createDb()',
      'packages/worker/src/jobs.ts:2: 禁止在组合根（index.ts / maintenance.ts）之外调用 createDb()',
      'packages/worker/src/sandbox/sessions.ts:2: 禁止在组合根（index.ts / maintenance.ts）之外实例化 new DockerSandboxProvider()',
      'packages/worker/src/sandbox/pool.ts:2: 禁止在组合根（index.ts / maintenance.ts）之外实例化 new DockerSandboxProvider()',
      'packages/worker/src/runs/dynamic.ts:3: 禁止在组合根（index.ts / maintenance.ts）之外调用 createDb()',
    ],
  },
  {
    name: '多子包共享依赖未使用 catalog: 且未在根 catalog 声明',
    rule: 'catalog-shared-deps',
    files: {
      'package.json': validRootPackageJson,
      'packages/api/package.json': JSON.stringify({
        dependencies: { zod: '^4.6.7', 'shared-lib': 'catalog:' },
      }),
      'packages/worker/package.json': JSON.stringify({
        peerDependencies: { zod: 'catalog:', 'shared-lib': 'catalog:' },
      }),
    },
    expected: [
      'packages/api/package.json: dependencies["zod"] 为 "^4.6.7"',
      'package.json: workspaces.catalog 缺少共享依赖 "zod"',
      'package.json: workspaces.catalog 缺少共享依赖 "shared-lib"',
    ],
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
    name: 'DB check <@ array 硬编码枚举',
    rule: 'db-enum-check',
    files: {
      'packages/db/src/schema/integrations.ts':
        "import { sql } from 'drizzle-orm';\nimport { check } from 'drizzle-orm/pg-core';\nexport const constraint = check('api_tokens_scopes_check', sql`scopes <@ array['read', 'write']::text[]`);\n",
    },
    expected: [
      "DB check 'api_tokens_scopes_check' 未从 @agentport/shared 的 *.options 派生",
      `改用 \${schema}.options 派生枚举`,
    ],
  },
  {
    name: 'DB check <@ array 未从 .options 派生',
    rule: 'db-enum-check',
    files: {
      'packages/db/src/schema/integrations.ts':
        "import { sql } from 'drizzle-orm';\nimport { check } from 'drizzle-orm/pg-core';\nexport const constraint = check('api_tokens_scopes_check', sql`scopes <@ array[" +
        '$' +
        "{sql.raw('SCOPES')}]::text[]`);\n",
    },
    expected: [
      "DB check 'api_tokens_scopes_check' 未从 @agentport/shared 的 *.options 派生",
      `改用 \${schema}.options 派生枚举`,
    ],
  },
  {
    name: 'DB check <@ array 混用 .options 与硬编码字面量',
    rule: 'db-enum-check',
    files: {
      'packages/db/src/schema/integrations.ts':
        "import { sql } from 'drizzle-orm';\nimport { check } from 'drizzle-orm/pg-core';\nexport const constraint = check('api_tokens_scopes_check', sql`scopes <@ array[" +
        '$' +
        "{sql.raw(integrationScopeSchema.options.join(','))}, 'extra']::text[]`);\n",
    },
    expected: [
      "DB check 'api_tokens_scopes_check' 未从 @agentport/shared 的 *.options 派生",
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
    name: 'web 使用 dark: 变体类',
    rule: 'web-no-dark-variant',
    files: {
      'packages/web/src/components/panel.tsx':
        'export const Panel = ({ active }: { active: boolean }) => (\n' +
        '  <div className="bg-surface dark:bg-input/30">\n' +
        '    <span className={`px-2 $' +
        '{active ? "hover:dark:text-fg" : ""}`} />\n' +
        '    <span className="dark:data-[state=open]:bg-hover" />\n' +
        '    <span className="dark:*:data-[slot=bubble-content]:bg-red" />\n' +
        '    <span className="group-data-[variant=line]/tabs-list:dark:bg-transparent" />\n' +
        '  </div>\n' +
        ');\n',
    },
    expected: [
      'packages/web/src/components/panel.tsx:2: 禁止使用 dark: 变体类（本项目仅亮色，删除无用 dark: 类）',
      'packages/web/src/components/panel.tsx:3: 禁止使用 dark: 变体类（本项目仅亮色，删除无用 dark: 类）',
      'packages/web/src/components/panel.tsx:4: 禁止使用 dark: 变体类（本项目仅亮色，删除无用 dark: 类）',
      'packages/web/src/components/panel.tsx:5: 禁止使用 dark: 变体类（本项目仅亮色，删除无用 dark: 类）',
      'packages/web/src/components/panel.tsx:6: 禁止使用 dark: 变体类（本项目仅亮色，删除无用 dark: 类）',
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
    name: 'collapsible-panel 设置 content-visibility',
    rule: 'collapsible-panel-visibility',
    files: {
      'packages/web/src/components/collapsible.css':
        "[data-slot='collapsible-panel'] {\n  content-visibility: auto;\n}\n",
    },
    expected: ['禁止在 collapsible-panel 上设置 content-visibility'],
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
    files: { 'packages/api/package.json': JSON.stringify({ engines: { node: '>=26' } }) },
    expected: ['packages/api/package.json: engines.node', '永久锁定 24.x'],
  },
  {
    name: 'Dockerfile 使用 node:26-alpine',
    rule: 'node-version-lock',
    files: { Dockerfile: 'FROM node:26-alpine AS base\n' },
    expected: ['Dockerfile:1: FROM node:26-alpine AS base', '永久锁定 24.x'],
  },
  {
    name: 'Dockerfile 带镜像前缀使用 node:26-alpine',
    rule: 'node-version-lock',
    files: { Dockerfile: 'FROM docker.io/library/node:26-alpine AS base\n' },
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
  {
    name: 'Dockerfile 引用不存在的子包',
    rule: 'dockerfile-workspace-sync',
    files: {
      'packages/api/package.json': JSON.stringify({ name: '@agentport/api' }),
      Dockerfile: 'FROM node:24-alpine AS base\nCOPY packages/ghost/package.json packages/ghost/\n',
    },
    expected: ['Dockerfile:2: 引用了不存在的子包 packages/ghost'],
  },
  ...[
    'scheduling/scheduler.ts',
    'scheduling/reconcile.ts',
    'runtime-environments/reconcile.ts',
    'knowledge/scheduler.ts',
    'knowledge/reconcile.ts',
    'data-domains/build.ts',
    'data-domains/enrich.ts',
    'integrations/deliver.ts',
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
      'packages/worker/src/integrations/deliver.ts': 'let inFlight = null;\ninFlight = sync();',
    },
    expected: [
      'packages/worker/src/scheduling/scheduler.ts:2',
      'packages/worker/src/knowledge/scheduler.ts:1',
      'packages/worker/src/runtime-environments/reconcile.ts:1',
      'packages/worker/src/data-domains/build.ts:2',
      'packages/worker/src/data-domains/enrich.ts:2',
      'packages/worker/src/integrations/deliver.ts:2',
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
      ['knowledge/queue.ts', 'runtime-environments/build.ts'].map((file) => [
        `packages/worker/src/${file}`,
        "import { startIntervalTicker } from '../scheduling/interval-ticker.js';\nsetInterval(tick, 1000);",
      ]),
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
  {
    name: 'core/worker/sandbox/api 合法依赖边界与 http -> lib 及非导入伪调用',
    files: {
      'packages/core/src/ok.ts':
        "import { z } from 'zod';\nimport { idSchema } from '@agentport/shared';\nexport const s = z.string();\nexport const id = idSchema;\n",
      'packages/worker/src/ok.ts':
        "import { AppError } from '@agentport/core';\nimport { repo } from '@agentport/db';\nimport { idSchema } from '@agentport/shared';\nexport const ok = [AppError, repo, idSchema];\n",
      'packages/sandbox/src/ok.ts':
        "import { idSchema } from '@agentport/shared';\nexport const ok = idSchema;\n",
      'packages/api/src/http/mid.ts':
        "import { helper } from '../lib/helper.js';\nimport { contract } from '@agentport/contract';\nimport { repo } from '@agentport/db';\nimport { idSchema } from '@agentport/shared';\nexport const ok = [helper, contract, repo, idSchema];\n",
      'packages/api/src/lib/helper.ts':
        "const fake = { import: (x: string) => x, require: (x: string) => x };\nconst s = \"import('@agentport/worker')\";\nexport const helper = () => [fake.import('@agentport/worker'), fake.require('@agentport/sandbox'), s];\n",
    },
  },
  {
    name: 'api 与 db 导入 bun 或 node:process 未访问 env 或被局部同名变量与参数遮蔽',
    files: {
      'packages/api/src/index.ts':
        "import * as Bun from 'bun';\nimport process from 'node:process';\nexport const runtime = [Bun.serve, process.exit];\n",
      'packages/api/src/http/health.ts':
        "import process from 'node:process';\nimport { env } from 'node:process';\nimport { env as bunEnv } from 'bun';\nexport type ET = typeof env;\nexport const pid = process.pid;\nexport const fn = (process: { env: string }) => process.env;\nexport const fn2 = (env: { PORT: string }) => env.PORT;\nexport const fn3 = () => { const bunEnv = { NODE_ENV: 'test' }; return bunEnv.NODE_ENV; };\nexport const out = [pid, fn, fn2, fn3];\n",
      'packages/db/src/client.ts':
        "import { SQL } from 'bun';\nimport * as proc from 'node:process';\nimport { env } from 'bun';\nexport type SqlType = typeof SQL;\nexport const pid = proc.pid;\nexport const fn = (Bun: { env: string }) => Bun.env;\nexport const fn2 = (env: { URL: string }) => env.URL;\nexport const ok = [pid, fn, fn2];\n",
    },
  },
  {
    name: 'worker 组合根之外局部遮蔽 createDb 与 DockerSandboxProvider 别名及参数注入',
    files: {
      'packages/worker/src/runs/execute.ts':
        "import { type createDb as OpenDb } from '@agentport/db';\nexport type Db = ReturnType<typeof OpenDb>['db'];\n",
      'packages/worker/src/handlers.ts':
        "import { createDb as openDb } from '@agentport/db';\nimport { DockerSandboxProvider as DSP } from './sandbox/docker.js';\nexport const run = (openDb: (url: string) => string, DSP: new () => unknown) => [openDb('x'), new DSP()];\nexport const local = () => { const createDb = () => 1; class DockerSandboxProvider {} return [createDb(), new DockerSandboxProvider()]; };\nexport const injected = (deps: { createDb: () => number }) => { const { createDb: openDb } = deps; return openDb(); };\n",
    },
  },
  {
    name: '无环有向依赖与同域文件互引',
    files: {
      'packages/core/src/a.ts':
        "import { b } from './b.js';\nimport { c } from './c.js';\nexport const a = [b, c];\n",
      'packages/core/src/b.ts': "import { c } from './c.js';\nexport const b = c;\n",
      'packages/core/src/c.ts': 'export const c = 1;\n',
      'packages/api/src/modules/alpha/a.ts':
        "import { b } from './b.js';\nimport { x } from '../beta/x.js';\nexport const a = [b, x];\n",
      'packages/api/src/modules/alpha/b.ts': 'export const b = 1;\n',
      'packages/api/src/modules/beta/x.ts': 'export const x = 2;\n',
      'packages/worker/src/runs/a.ts':
        "import { s } from '../scheduling/s.js';\nexport const a = s;\n",
      'packages/worker/src/scheduling/s.ts': 'export const s = 1;\n',
    },
  },
  {
    name: 'api routes/index.ts 装配 router、http/body-limit.ts 与 config.ts 白名单入口',
    files: {
      'packages/api/src/routes/index.ts':
        "import { chatRouter } from '../modules/chat/router.js';\nimport { requestBodyLimit } from '../http/body-limit.js';\nexport const mounted = [chatRouter, requestBodyLimit];\n",
      'packages/api/src/http/body-limit.ts':
        "import { bodyLimit } from 'hono/body-limit';\nexport const requestBodyLimit = bodyLimit;\n",
      'packages/api/src/config.ts':
        'export const cfg = { a: process.env.PORT, b: Bun.env.NODE_ENV };\n',
      'packages/api/src/http/health.ts':
        "const text = 'process.env.PORT Bun.env.NODE_ENV';\n// process.env.PORT\nexport type E = typeof process.env;\nexport const pid = process.pid;\nexport const fn = (process: { env: string }) => process.env;\nexport const out = [text, pid, fn];\n",
      'packages/db/src/index.ts':
        "const label = 'process.env.DATABASE_URL';\nexport type Env = NodeJS.ProcessEnv;\nexport const fn = (Bun: { env: string }) => Bun.env;\nexport const ok = [label, fn];\n",
    },
  },
  {
    name: 'worker 组合根实例与非组合根类型引用/类定义',
    files: {
      'packages/worker/src/index.ts':
        "import { createDb } from '@agentport/db';\nimport { DockerSandboxProvider } from './sandbox/docker.js';\nexport const db = createDb('x');\nexport const p = new DockerSandboxProvider();\n",
      'packages/worker/src/maintenance.ts':
        "import { createDb } from '@agentport/db';\nexport const db = createDb('x');\n",
      'packages/worker/src/sandbox/docker.ts': 'export class DockerSandboxProvider {}\n',
      'packages/worker/src/runs/execute.ts':
        "import { type createDb } from '@agentport/db';\nexport type Db = ReturnType<typeof createDb>['db'];\n",
    },
  },
  {
    name: 'DB check <@ array 从 .options 派生',
    files: {
      'packages/db/src/schema/integrations.ts':
        "import { sql } from 'drizzle-orm';\nimport { check } from 'drizzle-orm/pg-core';\nexport const constraint = check('api_tokens_scopes_check', sql`cardinality(scopes) > 0 and scopes <@ array[" +
        '$' +
        "{sql.raw(integrationScopeSchema.options.map((o) => `'" +
        '$' +
        "{o}'`).join(', '))}]::text[]`);\n",
    },
  },
  {
    name: 'api http/orpc.ts 抛出 ORPCError、instanceof 检查、AppError/fail 及局部类遮蔽',
    files: {
      'packages/api/src/http/orpc.ts':
        "import { ORPCError } from '@orpc/contract';\nexport const wrap = (err: unknown) => { if (err instanceof ORPCError || err instanceof z.ZodError) throw err; throw new ORPCError('INTERNAL_ERROR'); };\n",
      'packages/api/src/modules/knowledge/router.ts':
        "import { ORPCError } from '@orpc/server';\nimport { ZodError } from 'zod';\nexport const handle = (err: unknown) => {\n  if (err instanceof ORPCError || err instanceof ZodError || err instanceof z.ZodError) return null;\n  if (!err) fail('NOT_FOUND', 'missing');\n  throw new AppError('CONFLICT', 'msg', { extra: { results: [] } });\n};\nexport function shadowed() {\n  class ORPCError {}\n  class ZodError {}\n  const z = { ZodError };\n  return [new ORPCError(), new ZodError(), new z.ZodError()];\n}\n",
    },
  },
  {
    name: 'api 非 Drizzle 表 delete/update（Set/Map/CryptoHasher/repo）、只读查询与合法 sql select',
    files: {
      'packages/api/src/queue/producer.ts':
        "const subscriptions = new Set<string>();\nsubscriptions.delete('redis');\nconst cache = new Map<string, number>();\ncache.delete('key');\n",
      'packages/api/src/modules/integrations/signature.ts':
        "const digest = new Bun.CryptoHasher('sha256').update('payload').digest('hex');\nconst hmac = { update: (v: string) => v };\nexport const out = [digest, hmac.update('body')];\n",
      'packages/api/src/modules/security/router.ts':
        "import { repo } from '@agentport/db';\nconst toolPolicies = repo.toolApprovalPolicies;\nconst { runs } = repo;\nexport const run = async (db: unknown) => [\n  await repo.memoryChanges.insert(db, {}),\n  await repo.agents.update(db, '1', {}),\n  await repo.agents.delete(db, '1'),\n  await toolPolicies.update(db, '1', {}),\n  await toolPolicies.delete(db, '1'),\n  await runs.delete(db, '1'),\n];\n",
      'packages/api/src/modules/overview/router.ts':
        "import { schema } from '@agentport/db';\nimport { sql } from 'drizzle-orm';\nconst fakeSchema = { agents: 'agents' };\nconst fakeDb = { delete: (x: string) => x, insert: (x: string) => x };\nexport const read = (db: { select: () => { from: (t: unknown) => unknown }; execute: (q: unknown) => unknown }, alias: string) => [\n  db.select().from(schema.agentRuns),\n  db.execute(sql`select 1 from $" +
        "{schema.agentRuns} where status = 'update' and mode = 'set' and note = 'delete from agents'`),\n  db.execute(sql`select id, updated_at from agents -- delete from agents\n/* insert into agents */`),\n  db.execute(sql.raw(alias)),\n  fakeDb.delete(fakeSchema.agents),\n];\nexport function shadowed(schema: { agents: string }) {\n  return fakeDb.insert(schema.agents);\n}\n",
    },
  },
  {
    name: '单包依赖、workspace 协议、同包多字段与合法 catalog 共享依赖',
    files: {
      'package.json': JSON.stringify({
        engines: { node: '>=24.22.2 <25' },
        workspaces: { catalog: { '@types/node': '24.19.4', zod: '4.6.7' } },
        devDependencies: { '@types/node': 'catalog:' },
      }),
      'packages/api/package.json': JSON.stringify({
        dependencies: { '@agentport/shared': 'workspace:*', fflate: '0.8.3', zod: 'catalog:' },
        peerDependencies: { fflate: '0.8.3' },
      }),
      'packages/worker/package.json': JSON.stringify({
        dependencies: { '@agentport/shared': 'workspace:*', zod: 'catalog:' },
      }),
    },
  },
  {
    name: 'web 对象 dark 键与普通文案中的 dark: 不误报',
    files: {
      'packages/web/src/components/theme.tsx':
        "export type T = 'dark:bg-input/30';\nconst THEMES = { light: '', dark: '.dark' } as const;\nconst label = 'dark: mode';\nconst url = 'https://example.com/dark:test';\nexport const out = [THEMES, label, url];\n",
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
  if (!source) throw new Error(`missing ${file}`);
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
