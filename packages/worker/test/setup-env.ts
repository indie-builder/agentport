import { inject } from 'vitest';
import type { BackendInfra } from './isolated-db.js';

// 必须在测试模块导入前切到本轮独享资源；拿不到时 globalSetup 给的是不可连地址。
const infra = inject('backendInfra') as BackendInfra;

process.env.DATABASE_URL = infra.DATABASE_URL;
process.env.REDIS_URL = infra.REDIS_URL;
