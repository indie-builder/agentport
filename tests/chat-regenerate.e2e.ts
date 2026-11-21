import { type Browser, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';

interface ChatAccepted {
  runId: string;
  conversationId: string;
}

interface ConversationMessage {
  id: string;
  role: string;
  runId: string | null;
}

interface ConversationDetail {
  messages: ConversationMessage[];
  nextCursor: string | null;
}

interface RunDetail {
  run: { id: string; status: string };
}

async function getJson<T>(
  browser: Browser,
  path: string,
): Promise<{ status: number; json: T | null }> {
  const response = await browserFetch(browser, 'GET', path);
  return {
    status: response.status,
    json: response.text === '' ? null : (JSON.parse(response.text) as T),
  };
}

async function readConversation(
  browser: Browser,
  conversationId: string,
): Promise<ConversationDetail> {
  const result = await getJson<ConversationDetail>(
    browser,
    `/api/conversations/${conversationId}?limit=100`,
  );
  if (result.status !== 200 || result.json === null) {
    throw new Error(`读取会话详情失败：HTTP ${result.status}`);
  }
  return result.json;
}

async function runStatus(browser: Browser, runId: string): Promise<string | null> {
  const result = await getJson<RunDetail>(browser, `/api/runs/${runId}`);
  return result.status === 200 ? (result.json?.run.status ?? null) : null;
}

function summarize(
  detail: ConversationDetail,
  firstRunId: string,
  regeneratedRunId: string,
  replacedMessageId: string,
) {
  const assistants = detail.messages.filter((message) => message.role === 'assistant');
  const users = detail.messages.filter((message) => message.role === 'user');
  return {
    assistantCount: assistants.length,
    userCount: users.length,
    userMessageIds: users.map((message) => message.id),
    userRunIds: users.map((message) => message.runId),
    lastAssistantRunId: assistants.at(-1)?.runId ?? null,
    firstRunAssistantCount: assistants.filter((message) => message.runId === firstRunId).length,
    regeneratedAssistantCount: assistants.filter((message) => message.runId === regeneratedRunId)
      .length,
    replacedMessageStillPresent: detail.messages.some(
      (message) => message.id === replacedMessageId,
    ),
    nextCursor: detail.nextCursor,
  };
}

test('regenerating the last reply replaces it in place without duplicating messages', {
  session: 'admin',
  timeout: 180_000,
}, async ({ app, screen, browser }) => {
  const prompt = '只回复：好';

  await app.open('/chat');
  const composer = screen.getByRole('textbox', '消息');
  await expect(composer).toBeVisible();
  await composer.fill(prompt);

  const acceptedResponse = browser.waitForResponse(/\/api\/chat$/);
  await screen.getByRole('button', '发送消息').tap();
  const accepted = await acceptedResponse;
  expect(accepted.status).toBe(202);
  const first = await accepted.json<ChatAccepted>();
  const { runId: firstRunId, conversationId } = first;
  expect(conversationId).toBeDefined();

  await expect
    .poll(() => runStatus(browser, firstRunId), {
      timeout: 120_000,
      interval: 500,
      message: '首轮运行未在超时内成功',
    })
    .toBe('succeeded');

  await expect
    .poll(
      async () =>
        (await readConversation(browser, conversationId)).messages.filter(
          (message) => message.role === 'assistant',
        ).length,
      { timeout: 30_000, interval: 500, message: '首轮回复未落库' },
    )
    .toBeGreaterThan(0);

  const initial = await readConversation(browser, conversationId);
  const initialAssistants = initial.messages.filter((message) => message.role === 'assistant');
  const initialUsers = initial.messages.filter((message) => message.role === 'user');
  const assistantCount = initialAssistants.length;
  const lastAssistantId = initialAssistants.at(-1)?.id ?? '';
  const userMessageId = initialUsers[0]?.id ?? '';
  expect(initial.nextCursor).toBeNull();
  expect(initialUsers).toHaveLength(1);
  expect(initialAssistants.every((message) => message.runId === firstRunId)).toBe(true);
  expect(lastAssistantId).not.toBe('');
  expect(userMessageId).not.toBe('');

  const regenerateButton = screen.getByRole('button', '重新生成回复');
  await expect(regenerateButton).toBeVisible({ timeout: 30_000 });
  await expect(regenerateButton).toBeEnabled({ timeout: 30_000 });
  await expect(regenerateButton).toHaveCount(1);

  const regenerateResponse = browser.waitForResponse(
    new RegExp(`/api/chat/${conversationId}/regenerate$`),
  );
  await regenerateButton.tap();
  const regenerated = await regenerateResponse;
  expect(regenerated.status).toBe(202);
  const second = await regenerated.json<ChatAccepted>();
  const secondRunId = second.runId;
  expect(second.conversationId).toBe(conversationId);
  expect(secondRunId).not.toBe(firstRunId);

  await expect
    .poll(() => runStatus(browser, secondRunId), {
      timeout: 150_000,
      interval: 500,
      message: '重新生成运行未在超时内成功',
    })
    .toBe('succeeded');

  const liveMessages = browser.locator('[aria-label="对话消息"]');
  await expect(liveMessages.getByText(prompt, { exact: true })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(liveMessages.getByRole('button', { name: '复制回复' })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(liveMessages.getByRole('button', { name: '重新生成回复' })).toHaveCount(1, {
    timeout: 30_000,
  });

  const expected = {
    assistantCount,
    userCount: 1,
    userMessageIds: [userMessageId],
    userRunIds: [secondRunId],
    lastAssistantRunId: secondRunId,
    firstRunAssistantCount: 0,
    regeneratedAssistantCount: assistantCount,
    replacedMessageStillPresent: false,
    nextCursor: null,
  };
  await expect
    .poll(
      async () =>
        summarize(
          await readConversation(browser, conversationId),
          firstRunId,
          secondRunId,
          lastAssistantId,
        ),
      { timeout: 60_000, interval: 500, message: '旧回复未被原子替换' },
    )
    .toMatchObject(expected);

  const oldRun = await getJson<{ code: string }>(browser, `/api/runs/${firstRunId}`);
  expect(oldRun.status).toBe(404);

  await app.open(`/chat?conversation=${conversationId}`);
  await expect(screen.getByRole('textbox', '消息')).toBeVisible({ timeout: 30_000 });
  const messages = browser.locator('[aria-label="对话消息"]');
  await expect(messages.getByText(prompt, { exact: true })).toHaveCount(1, { timeout: 30_000 });
  await expect(messages.getByRole('button', { name: '复制回复' })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(messages.getByRole('button', { name: '重新生成回复' })).toHaveCount(1, {
    timeout: 30_000,
  });

  const persisted = summarize(
    await readConversation(browser, conversationId),
    firstRunId,
    secondRunId,
    lastAssistantId,
  );
  expect(persisted).toMatchObject(expected);

  console.log(
    `重新生成结果：A=${assistantCount} R1=${firstRunId} R2=${secondRunId} assistants=${persisted.assistantCount} users=${persisted.userCount}`,
  );
});

test('regenerating the last reply after multiple turns keeps the earlier turns', {
  session: 'admin',
  timeout: 300_000,
}, async ({ app, screen, browser }) => {
  const firstPrompt = '只回复：一';
  const secondPrompt = '只回复：二';

  await app.open('/chat');
  const composer = screen.getByRole('textbox', '消息');
  await expect(composer).toBeVisible();
  await composer.fill(firstPrompt);

  const firstAcceptedResponse = browser.waitForResponse(/\/api\/chat$/);
  await screen.getByRole('button', '发送消息').tap();
  const firstAccepted = await firstAcceptedResponse;
  expect(firstAccepted.status).toBe(202);
  const first = await firstAccepted.json<ChatAccepted>();
  const conversationId = first.conversationId;
  const runA = first.runId;
  expect(conversationId).toBeDefined();

  await expect
    .poll(() => runStatus(browser, runA), {
      timeout: 150_000,
      interval: 500,
      message: '第一轮运行未在超时内成功',
    })
    .toBe('succeeded');

  const textbox = screen.getByRole('textbox', '消息');
  await expect(textbox).toBeEnabled({ timeout: 60_000 });
  await textbox.fill(secondPrompt);
  const sendButton = screen.getByRole('button', '发送消息');
  await expect(sendButton).toBeEnabled({ timeout: 60_000 });
  const secondAcceptedResponse = browser.waitForResponse(/\/api\/chat$/);
  await sendButton.tap();
  const secondAccepted = await secondAcceptedResponse;
  expect(secondAccepted.status).toBe(202);
  const second = await secondAccepted.json<ChatAccepted>();
  const runB = second.runId;
  expect(second.conversationId).toBe(conversationId);

  await expect
    .poll(() => runStatus(browser, runB), {
      timeout: 150_000,
      interval: 500,
      message: '第二轮运行未在超时内成功',
    })
    .toBe('succeeded');

  await expect
    .poll(
      async () => {
        const detail = await readConversation(browser, conversationId);
        return {
          userRunIds: detail.messages
            .filter((message) => message.role === 'user')
            .map((message) => message.runId),
          assistantRunIds: detail.messages
            .filter((message) => message.role === 'assistant')
            .map((message) => message.runId),
        };
      },
      { timeout: 30_000, interval: 500, message: '两轮消息未落库' },
    )
    .toEqual({
      userRunIds: [runA, runB],
      assistantRunIds: [runA, runB],
    });

  const beforeRegenerate = await readConversation(browser, conversationId);
  const usersBefore = beforeRegenerate.messages.filter((message) => message.role === 'user');
  const assistantsBefore = beforeRegenerate.messages.filter(
    (message) => message.role === 'assistant',
  );
  expect(usersBefore).toHaveLength(2);
  expect(assistantsBefore).toHaveLength(2);
  const firstUserId = usersBefore[0]?.id ?? '';
  const userTwoId = usersBefore.at(-1)?.id ?? '';
  const firstAssistantId = assistantsBefore[0]?.id ?? '';
  const lastAssistantId = assistantsBefore.at(-1)?.id ?? '';
  expect(firstUserId).not.toBe('');
  expect(userTwoId).not.toBe('');
  expect(firstAssistantId).not.toBe('');
  expect(lastAssistantId).not.toBe('');

  const regenerateButton = screen.getByRole('button', '重新生成回复');
  await expect(regenerateButton).toBeVisible({ timeout: 30_000 });
  await expect(regenerateButton).toBeEnabled({ timeout: 30_000 });
  await expect(regenerateButton).toHaveCount(1);

  const regenerateResponse = browser.waitForResponse(
    new RegExp(`/api/chat/${conversationId}/regenerate$`),
  );
  await regenerateButton.tap();
  const regenerated = await regenerateResponse;
  expect(regenerated.status).toBe(202);
  const regeneration = await regenerated.json<ChatAccepted>();
  const runC = regeneration.runId;
  expect(regeneration.conversationId).toBe(conversationId);
  expect(runC).not.toBe(runB);

  await expect
    .poll(() => runStatus(browser, runC), {
      timeout: 150_000,
      interval: 500,
      message: '多轮重新生成运行未在超时内成功',
    })
    .toBe('succeeded');

  const liveMessages = browser.locator('[aria-label="对话消息"]');
  await expect(liveMessages.getByText(firstPrompt, { exact: true })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(liveMessages.getByText(secondPrompt, { exact: true })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(liveMessages.getByRole('button', { name: '复制回复' })).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect(liveMessages.getByRole('button', { name: '重新生成回复' })).toHaveCount(1, {
    timeout: 30_000,
  });

  await expect
    .poll(
      async () => {
        const detail = await readConversation(browser, conversationId);
        const users = detail.messages.filter((message) => message.role === 'user');
        const assistants = detail.messages.filter((message) => message.role === 'assistant');
        return {
          userCount: users.length,
          userIds: users.map((message) => message.id),
          userRunIds: users.map((message) => message.runId),
          assistantCount: assistants.length,
          assistantRunIds: assistants.map((message) => message.runId),
          firstAssistantPresent: detail.messages.some((message) => message.id === firstAssistantId),
          previousAssistantPresent: detail.messages.some(
            (message) => message.id === lastAssistantId,
          ),
        };
      },
      { timeout: 60_000, interval: 500, message: '多轮重新生成未按预期替换最后一轮' },
    )
    .toMatchObject({
      userCount: 2,
      userIds: [firstUserId, userTwoId],
      userRunIds: [runA, runC],
      assistantCount: 2,
      assistantRunIds: [runA, runC],
      firstAssistantPresent: true,
      previousAssistantPresent: false,
    });

  const replacedRun = await getJson<{ code: string }>(browser, `/api/runs/${runB}`);
  expect(replacedRun.status).toBe(404);
  const keptRun = await getJson<RunDetail>(browser, `/api/runs/${runA}`);
  expect(keptRun.status).toBe(200);

  await app.open(`/chat?conversation=${conversationId}`);
  await expect(screen.getByRole('textbox', '消息')).toBeVisible({ timeout: 30_000 });
  const messages = browser.locator('[aria-label="对话消息"]');
  await expect(messages.getByText(firstPrompt, { exact: true })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(messages.getByText(secondPrompt, { exact: true })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(messages.getByRole('button', { name: '重新生成回复' })).toHaveCount(1, {
    timeout: 30_000,
  });

  const persisted = await readConversation(browser, conversationId);
  const persistedUsers = persisted.messages.filter((message) => message.role === 'user');
  const persistedAssistants = persisted.messages.filter((message) => message.role === 'assistant');
  expect(persistedUsers.map((message) => message.id)).toEqual([firstUserId, userTwoId]);
  expect(persistedUsers.map((message) => message.runId)).toEqual([runA, runC]);
  expect(persistedAssistants.map((message) => message.runId)).toEqual([runA, runC]);
  expect(persisted.messages.some((message) => message.id === firstAssistantId)).toBe(true);
  expect(persisted.messages.some((message) => message.id === lastAssistantId)).toBe(false);

  console.log(
    `多轮重新生成结果：A=${runA} B=${runB} C=${runC} users=${persistedUsers.length} assistants=${persistedAssistants.length} runA=${keptRun.status} runB=${replacedRun.status}`,
  );
});

test('cancelling a regeneration keeps the previous reply', {
  session: 'admin',
  timeout: 300_000,
}, async ({ app, screen, browser }) => {
  const prompt = '请用中文写一篇不少于 1200 字的说明文，主题是「为什么要写测试」，只输出正文。';

  await app.open('/chat');
  const composer = screen.getByRole('textbox', '消息');
  await expect(composer).toBeVisible();
  await composer.fill(prompt);

  const acceptedResponse = browser.waitForResponse(/\/api\/chat$/);
  await screen.getByRole('button', '发送消息').tap();
  const accepted = await acceptedResponse;
  expect(accepted.status).toBe(202);
  const first = await accepted.json<ChatAccepted>();
  const conversationId = first.conversationId;
  const runD = first.runId;

  await expect
    .poll(() => runStatus(browser, runD), {
      timeout: 180_000,
      interval: 500,
      message: '首轮运行未在超时内成功',
    })
    .toBe('succeeded');

  const beforeRegenerate = await readConversation(browser, conversationId);
  const assistantsBefore = beforeRegenerate.messages.filter(
    (message) => message.role === 'assistant',
  );
  const usersBefore = beforeRegenerate.messages.filter((message) => message.role === 'user');
  const assistantCountBefore = assistantsBefore.length;
  const lastAssistantId = assistantsBefore.at(-1)?.id ?? '';
  expect(usersBefore).toHaveLength(1);
  expect(assistantCountBefore).toBeGreaterThan(0);
  expect(lastAssistantId).not.toBe('');

  const regenerateButton = screen.getByRole('button', '重新生成回复');
  await expect(regenerateButton).toBeVisible({ timeout: 30_000 });
  await expect(regenerateButton).toBeEnabled({ timeout: 30_000 });

  const regenerateResponse = browser.waitForResponse(
    new RegExp(`/api/chat/${conversationId}/regenerate$`),
  );
  await regenerateButton.tap();
  const regenerated = await regenerateResponse;
  expect(regenerated.status).toBe(202);
  const regeneration = await regenerated.json<ChatAccepted>();
  const runE = regeneration.runId;
  expect(regeneration.conversationId).toBe(conversationId);
  expect(runE).not.toBe(runD);

  const cancelResponse = await browserFetch(browser, 'POST', `/api/chat/${runE}/cancel`);
  expect(cancelResponse.status).toBe(202);

  await expect
    .poll(
      async () => {
        const status = await runStatus(browser, runE);
        return status === 'queued' || status === 'running' ? null : status;
      },
      { timeout: 150_000, interval: 500, message: '重新生成运行未进入终态' },
    )
    .not.toBeNull();

  const finalStatus = await runStatus(browser, runE);
  if (finalStatus !== 'cancelled') {
    throw new Error(`取消竞态未能命中：重新生成运行终态为 ${finalStatus}`);
  }

  const liveMessages = browser.locator('[aria-label="对话消息"]');
  await expect(liveMessages.getByRole('button', { name: '复制回复' })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(liveMessages.getByText(prompt, { exact: true })).toHaveCount(1, {
    timeout: 30_000,
  });

  const afterCancel = await readConversation(browser, conversationId);
  const assistantsAfter = afterCancel.messages.filter((message) => message.role === 'assistant');
  const usersAfter = afterCancel.messages.filter((message) => message.role === 'user');
  expect(assistantsAfter).toHaveLength(assistantCountBefore);
  expect(assistantsAfter.some((message) => message.id === lastAssistantId)).toBe(true);
  expect(usersAfter.map((message) => message.runId)).toEqual([runD]);

  const keptRun = await getJson<RunDetail>(browser, `/api/runs/${runD}`);
  expect(keptRun.status).toBe(200);

  console.log(
    `取消重新生成结果：D=${runD} E=${runE} users=${usersAfter.length} assistants=${assistantsAfter.length} oldReplyKept=${assistantsAfter.some((message) => message.id === lastAssistantId)} runD=${keptRun.status}`,
  );
});
