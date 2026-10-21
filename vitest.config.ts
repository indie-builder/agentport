import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// 与 pnpm run up 写出的 .env 对齐：up.sh 会把随机 REDIS_PASSWORD 写进去，
// 若测试仍用旧默认值，集成套件会因 WRONGPASS 静默跳过。已存在的 env 变量优先。
if (existsSync('.env')) process.loadEnvFile('.env');

// 测试专用配置：缺省指向本地 compose；限制条件在 helpers 里探测。
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://agentport:agentport@localhost:5432/agentport';
// CI 里用服务容器的同名变量覆盖；本机读 .env（up.sh 写入随机密码）。
const redisUrl = process.env.REDIS_URL ?? 'redis://:agentport-dev@localhost:6379';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      // 测试用本地假上游（127.0.0.1），走与开发一致的安全策略。
      NODE_ENV: 'development',
      LOG_LEVEL: 'error',
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      // 32 字节 base64url，固定值保证加密/解密在测试间可复现。
      APP_SECRET_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'test-admin-password',
      JWT_SECRET: 'test-jwt-secret-at-least-16-bytes',
      // 登录限流会跨文件共享 Redis 计数，测试里关掉避免互相干扰。
      RATE_LIMIT_DISABLED: '1',
      SELF_URL: 'http://127.0.0.1:3000',
    },
  },
});
