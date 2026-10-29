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
  await screen.getByRole('button', '登录').tap();
  // 登录成功后 AppShell 才渲染导航；等业务首页标记，确认会话已生效。
  await screen.getByRole('link', '找专家').waitFor();
  await session.save('admin');
});
