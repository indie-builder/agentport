import { test as base, type Page } from '@playwright/test';

export { expect } from '@playwright/test';

// E2E 不读 .env：CI 里用环境变量覆盖管理员口令。
export const ADMIN_USER = process.env.E2E_ADMIN_USER ?? 'admin';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'admin-change-me';

export const test = base.extend<{ unique: (prefix: string) => string }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright 要求 fixture 参数使用解构写法
  unique: async ({}, use) => {
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await use((prefix) => `${prefix}-${run}`);
  },
});

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('用户名').fill(ADMIN_USER);
  await page.getByLabel('密码').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  // 登录成功后 AppShell 才会渲染导航。
  await page.getByRole('link', { name: 'MCP Servers', exact: true }).waitFor();
}
