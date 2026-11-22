import { test } from '@e2e-dev/web';
import { expect, type Locator, type Screen } from 'e2e';
import { fixture as runFixture } from './support/fixture.js';

interface Fixture {
  agents: [string, string];
  names: [string, string];
  conversations: { alpha: string; beta: string; gamma: string };
  titles: { alpha: string; beta: string; gamma: string };
  bodies: { alpha: string; beta: string; gamma: string };
}

async function seed(): Promise<Fixture> {
  return runFixture('chat-history-filter', 'seed');
}

async function cleanup(fixture: Fixture): Promise<void> {
  return runFixture('chat-history-filter', 'cleanup', fixture);
}

async function showHistory(screen: Screen): Promise<void> {
  await screen.getByRole('button', '显示会话历史').tap();
}

async function openSearch(screen: Screen): Promise<Locator> {
  await screen.getByRole('button', '搜索全部会话').tap();
  const dialog = screen.getByRole('dialog', '搜索会话');
  const input = dialog.getByRole('combobox', '搜索会话');
  await expect(input).toBeVisible();
  return dialog;
}

test('history search finds titles and message bodies across experts and clears back', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  let fixture: Fixture | undefined;
  try {
    fixture = await seed();
    await app.open(`/chat?agent=${fixture.agents[0]}`);
    await showHistory(screen);

    const aside = browser.locator('aside[aria-label="会话历史"]');
    await expect(aside.getByText(fixture.titles.alpha, { exact: true })).toBeVisible();
    await expect(aside.getByText(fixture.titles.beta, { exact: true })).toBeVisible();
    await expect(aside.getByText(fixture.titles.gamma, { exact: true })).toHaveCount(0);

    const dialog = await openSearch(screen);
    const input = dialog.getByRole('combobox', '搜索会话');

    await input.fill(fixture.titles.gamma);
    await expect(dialog.getByText(fixture.titles.gamma, { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.names[1], { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.titles.alpha, { exact: true })).toHaveCount(0);

    await input.fill(fixture.bodies.alpha);
    await expect(dialog.getByText(fixture.titles.alpha, { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.bodies.alpha, { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.titles.gamma, { exact: true })).toHaveCount(0);

    await dialog.getByRole('button', '清除搜索').tap();
    await expect(input).toHaveValue('');
    await expect(dialog.getByText(fixture.titles.alpha, { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.titles.gamma, { exact: true })).toBeVisible();
  } finally {
    if (fixture) await cleanup(fixture);
  }
});

test('history search with no match shows the empty text and no conversation rows', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  let fixture: Fixture | undefined;
  try {
    fixture = await seed();
    await app.open(`/chat?agent=${fixture.agents[0]}`);
    await showHistory(screen);

    const dialog = await openSearch(screen);
    await dialog
      .getByRole('combobox', '搜索会话')
      .fill(`不存在-${crypto.randomUUID().slice(0, 8)}`);
    await expect(dialog.getByText('没有匹配的会话', { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.titles.alpha, { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(fixture.titles.gamma, { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('combobox', '搜索会话')).toBeVisible();
    await expect(dialog.getByText('清除搜索', { exact: true })).toBeVisible();
  } finally {
    if (fixture) await cleanup(fixture);
  }
});

test('opening a cross-expert result keeps the unsent draft on its original conversation', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  let fixture: Fixture | undefined;
  try {
    fixture = await seed();
    const [agentA, agentB] = fixture.agents;
    const draft = `未发送草稿 ${crypto.randomUUID().slice(0, 8)}`;
    await app.open(`/chat?agent=${agentA}&conversation=${fixture.conversations.alpha}`);
    await screen.getByRole('textbox', '消息').fill(draft);

    await showHistory(screen);
    const dialog = await openSearch(screen);
    await dialog.getByRole('combobox', '搜索会话').fill(fixture.titles.gamma);
    await dialog.getByRole('option', new RegExp(fixture.titles.gamma)).tap();

    await expect(browser).toHaveURL(new RegExp(`agent=${agentB}`));
    await expect(browser).toHaveURL(new RegExp(`conversation=${fixture.conversations.gamma}`));
    await expect(screen.getByText(fixture.bodies.gamma, { exact: true })).toBeVisible();

    await app.open(`/chat?agent=${agentA}&conversation=${fixture.conversations.alpha}`);
    await expect(screen.getByRole('textbox', '消息')).toHaveValue(draft);
  } finally {
    if (fixture) await cleanup(fixture);
  }
});

test('search stays cross-expert after switching experts in the history header', {
  session: 'admin',
}, async ({ app, screen, browser }) => {
  await browser.setViewport({ width: 1440, height: 900 });
  await app.open('/chat');
  let fixture: Fixture | undefined;
  try {
    fixture = await seed();
    const [agentA, agentB] = fixture.agents;
    await app.open(`/chat?agent=${agentA}`);
    await showHistory(screen);

    await screen.getByRole('button', new RegExp(`切换专家：${fixture.names[0]}`)).tap();
    await screen.getByRole('option', new RegExp(fixture.names[1])).tap();
    await expect(browser).toHaveURL(new RegExp(`agent=${agentB}$`));
    const aside = browser.locator('aside[aria-label="会话历史"]');
    await expect(aside.getByText(fixture.titles.gamma, { exact: true })).toBeVisible();
    await expect(aside.getByText(fixture.titles.alpha, { exact: true })).toHaveCount(0);

    const dialog = await openSearch(screen);
    await dialog.getByRole('combobox', '搜索会话').fill(fixture.titles.alpha);
    const result = dialog.getByRole('option', new RegExp(fixture.titles.alpha));
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await expect(result.getByText(fixture.names[0], { exact: true })).toBeVisible();
    await result.tap();
    await expect(browser).toHaveURL(new RegExp(`agent=${agentA}`));
    await expect(browser).toHaveURL(new RegExp(`conversation=${fixture.conversations.alpha}`));
  } finally {
    if (fixture) await cleanup(fixture);
  }
});
