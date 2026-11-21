import { credentials, test } from 'e2e';

test.setup('sign in as admin', { sessions: ['admin'] }, async ({ app, screen, session }) => {
  const admin = credentials.user('admin');
  await app.open('/login');
  await screen.getByLabel('用户名').fill(admin.username);
  await screen.getByLabel('密码').fill(admin.password);
  await screen.getByRole('button', '登录').tap();
  await screen.getByRole('link', '找专家').waitFor();
  await session.save('admin');
});
