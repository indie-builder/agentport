import { credentials, test } from 'e2e';

/**
 * 登录一次，供所有用例复用。
 * 对应 Playwright 的 e2e/fixtures.ts `login(page)`，改为 setup + session。
 */
test.setup('sign in as admin', { sessions: ['admin'] }, async ({ app, screen, session }) => {
  const admin = credentials.user('admin');
  await app.open('/login');
  await screen.getByLabel('用户名').fill(admin.username);
  await screen.getByLabel('密码').fill(admin.password);
  await screen.getByRole('button', '进入工作台').tap();
  // 登录成功后 AppShell 才渲染导航；资源入口名称会随页签增删变化，按开头匹配。
  await screen.getByRole('link', /^专家/).waitFor();
  await session.save('admin');
});
