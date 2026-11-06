if (process.env.AGENTPORT_BACKEND_TEST !== '1') {
  throw new Error('Run backend tests with bun run test so PostgreSQL and Redis stay isolated');
}

Object.assign(process.env, {
  NODE_ENV: 'development',
  LOG_LEVEL: 'error',
  APP_SECRET_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
  ADMIN_USER: 'admin',
  ADMIN_PASSWORD: 'test-admin-password',
  JWT_SECRET: 'test-jwt-secret-at-least-16-bytes',
  RATE_LIMIT_DISABLED: '1',
  SELF_URL: 'http://127.0.0.1:3000',
});
