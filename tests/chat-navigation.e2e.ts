import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('unknown agent link has no composer and can start a new conversation', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await app.open('/chat?agent=agt_missing_navigation_check');
  await expect(screen.getByText('找不到这个智能体', { exact: true })).toBeVisible();
  await expect(browser.locator('textarea[aria-label="消息"]')).toHaveCount(0);
  await screen.getByRole('button', '开始新对话', { exact: true }).tap();
  await expect(browser).toHaveURL(/\/chat$/);
  await expect(screen.getByRole('textbox', '消息')).toBeVisible();
});

test('missing conversation link has no composer and can clear the selection', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await app.open('/chat?conversation=conv_missing_navigation_check');
  await expect(screen.getByRole('button', '开始新对话', { exact: true })).toBeVisible();
  await expect(browser.locator('textarea[aria-label="消息"]')).toHaveCount(0);
  await screen.getByRole('button', '开始新对话', { exact: true }).tap();
  await expect(screen.getByRole('textbox', '消息')).toBeVisible();
});

test('invalid conversation and agent can both be cleared in one action', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await app.open(
    '/chat?agent=agt_missing_navigation_check&conversation=conv_missing_navigation_check',
  );
  await screen.getByRole('button', '开始新对话', { exact: true }).tap();
  await expect(browser).toHaveURL(/\/chat$/);
  await expect(screen.getByRole('textbox', '消息')).toBeVisible();
});
