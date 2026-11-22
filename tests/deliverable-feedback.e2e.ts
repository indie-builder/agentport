import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from '@e2e-dev/web';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { browserFetch } from './support/browser-api.js';
import {
  FEEDBACK_BAD_MARKER,
  FEEDBACK_GOOD_MARKER,
  OUTPUT_WRITE_MARKER,
} from './support/execution-stack.js';
import { fixture } from './support/fixture.js';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timeout']);
const SHOT_DIR = '/tmp/deliverable-feedback-shots';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
}

async function apiJson<T>(
  browser: Browser,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null }> {
  const response = await browserFetch(browser, method, path, body);
  let json: T | null = null;
  try {
    json = response.text === '' ? null : (JSON.parse(response.text) as T);
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function currentBusinessId(browser: Browser): Promise<string> {
  const me = await apiJson<{ authenticated: boolean; user?: { businessId: string } }>(
    browser,
    'GET',
    '/api/auth/me',
  );
  assert(me.status === 200 && me.json?.authenticated === true, '读取当前账户失败');
  const businessId = me.json.user?.businessId;
  assert(typeof businessId === 'string' && businessId.length > 0, '当前账户缺少 businessId');
  return businessId;
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  read: () => Promise<T | null | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`等待超时：${label}`);
}

const created: { agentIds: string[] } = { agentIds: [] };

test.afterEach(async () => {
  await fixture('deliverable-feedback', 'cleanup', { agentIds: created.agentIds });
  created.agentIds.length = 0;
});

test('rejects, accepts and converts a delivered run into an evaluation case', {
  session: 'admin',
  timeout: 600_000,
}, async ({ app, screen, browser }) => {
  const suffix = uniqueSuffix();
  const shots = join(SHOT_DIR, suffix);
  const shot = async (label: string): Promise<string> => {
    mkdirSync(shots, { recursive: true });
    const source = await app.screenshot(label);
    const target = join(shots, `${label}.png`);
    copyFileSync(source, target);
    return target;
  };

  await app.open('/agents');
  const businessId = await currentBusinessId(browser);
  const agent = await apiJson<{ id: string }>(browser, 'POST', '/api/agents', {
    slug: `e2e-deliverable-feedback-${suffix}`,
    name: `E2E 交付反馈 ${suffix}`,
    systemPrompt: '你是交付反馈验证智能体。收到消息后写入成果并直接回复内容。',
  });
  assert(agent.status === 201 && agent.json !== null, `创建智能体失败：${agent.status}`);
  const agentId = agent.json.id;
  created.agentIds.push(agentId);

  await app.open(`/chat?agent=${agentId}`);
  await screen
    .getByRole('textbox', '消息')
    .fill(`${FEEDBACK_BAD_MARKER} ${OUTPUT_WRITE_MARKER} 反馈缺陷 ${suffix}`);
  await screen.getByRole('button', { name: '发送消息' }).tap();

  const run1 = await waitFor('run1 进入终态', 180_000, async () => {
    const run = await fixture('deliverable-feedback', 'latestRun', agentId);
    return run !== null && TERMINAL_STATUSES.has(run.status) ? run : null;
  });
  expect(run1.status).toBe('succeeded');

  const output1 = await waitFor('初版成果已发布', 60_000, async () => {
    const response = await browserFetch(
      browser,
      'GET',
      `/api/conversations/${run1.conversation_id}/outputs`,
    );
    if (response.status !== 200) return null;
    const body = JSON.parse(response.text) as {
      items: Array<{ runId: string; path: string; sha256: string; size: number }>;
    };
    return (
      body.items.find((item) => item.runId === run1.id && item.path === 'feedback-report.md') ??
      null
    );
  });
  expect(output1.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(output1.size).toBeGreaterThan(0);

  const messages1 = await fixture('deliverable-feedback', 'runMessages', run1.id);
  const answer1 = messages1.map((message) => message.text ?? '').join('\n');
  expect(answer1).toContain('初版结果：39');
  expect(answer1).not.toContain('42');

  await app.open(`/runs/${run1.id}`);
  await expect(screen.getByText('交付验收', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByText('尚未验收', { exact: true })).toBeVisible({ timeout: 30_000 });
  await screen.getByRole('button', { name: '退回', exact: true }).tap();
  const rejectDialog = screen.getByRole('dialog', '退回本次成果');
  await expect(rejectDialog).toBeVisible({ timeout: 15_000 });
  await rejectDialog.getByRole('button', { name: '2 星' }).tap();
  await rejectDialog.getByLabel('评论').fill('请修正');
  await rejectDialog.getByLabel(/退回原因/).fill('结果数字不正确');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const rejectDialogShot = await shot('deliverable-feedback-reject-dialog');
  assert(rejectDialogShot.length > 0, '退回弹层截图未生成');
  await rejectDialog.getByRole('button', { name: '退回', exact: true }).tap();

  const rejected = await waitFor('退回记录落库', 30_000, async () => {
    const rows = await fixture('deliverable-feedback', 'listFeedback', run1.id);
    return rows.find((row) => row.decision === 'rejected') ?? null;
  });
  expect(rejected).toMatchObject({
    output_path: 'feedback-report.md',
    rating: 2,
    reason: '结果数字不正确',
    comment: '请修正',
    created_by: businessId,
  });
  expect(rejected.output_sha256).toBe(output1.sha256);
  await expect(screen.getByText('已退回', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(rejectDialog).toHaveCount(0);
  const rejectedShot = await shot('deliverable-feedback-rejected');
  assert(rejectedShot.length > 0, '退回截图未生成');

  await app.open(`/chat?agent=${agentId}&conversation=${run1.conversation_id}`);
  await screen
    .getByRole('textbox', '消息')
    .fill(`${FEEDBACK_GOOD_MARKER} ${OUTPUT_WRITE_MARKER} 已修正 ${suffix}`);
  await screen.getByRole('button', { name: '发送消息' }).tap();

  const run2 = await waitFor('run2 进入终态', 180_000, async () => {
    const run = await fixture('deliverable-feedback', 'latestRun', agentId);
    return run !== null && run.id !== run1.id && TERMINAL_STATUSES.has(run.status) ? run : null;
  });
  expect(run2.status).toBe('succeeded');

  const messages2 = await fixture('deliverable-feedback', 'runMessages', run2.id);
  const answer2 = messages2.map((message) => message.text ?? '').join('\n');
  expect(answer2).toContain('修正结果：42');

  await app.open(`/runs/${run2.id}`);
  await expect(screen.getByText('尚未验收', { exact: true })).toBeVisible({ timeout: 30_000 });
  await screen.getByRole('button', { name: '采纳', exact: true }).tap();
  const acceptDialog = screen.getByRole('dialog', '采纳本次成果');
  await expect(acceptDialog).toBeVisible({ timeout: 15_000 });
  await acceptDialog.getByRole('button', { name: '5 星' }).tap();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const acceptDialogShot = await shot('deliverable-feedback-accept-dialog');
  assert(acceptDialogShot.length > 0, '采纳弹层截图未生成');
  await acceptDialog.getByRole('button', { name: '采纳', exact: true }).tap();

  const accepted = await waitFor('采纳记录落库', 30_000, async () => {
    const rows = await fixture('deliverable-feedback', 'listFeedback', run2.id);
    return rows.find((row) => row.decision === 'accepted') ?? null;
  });
  expect(accepted).toMatchObject({
    output_path: 'feedback-report.md',
    rating: 5,
    created_by: businessId,
  });
  const run1Rows = await fixture('deliverable-feedback', 'listFeedback', run1.id);
  expect(run1Rows.filter((row) => row.decision === 'rejected')).toHaveLength(1);
  expect(run1Rows.some((row) => row.id === rejected.id)).toBe(true);
  await expect(acceptDialog).toHaveCount(0);

  await app.open(`/runs/${run1.id}`);
  const convert = screen.getByRole('button', { name: '转为评测用例' });
  await expect(convert).toBeVisible({ timeout: 30_000 });
  await convert.tap();
  const evalDialog = screen.getByRole('dialog', '新建评估用例');
  await expect(evalDialog).toBeVisible({ timeout: 15_000 });
  await evalDialog.getByRole('button', { name: '创建', exact: true }).tap();
  await expect(evalDialog.getByText('期望答案需要人工填写。', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  expect(await fixture('deliverable-feedback', 'evalCaseForFeedback', rejected.id)).toBeNull();

  await evalDialog.getByLabel(/^期望答案/).fill('42');
  await evalDialog.getByLabel(/我已人工核对期望答案/).tap();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const evalShot = await shot('deliverable-feedback-eval-dialog');
  assert(evalShot.length > 0, '转评测截图未生成');
  await evalDialog.getByRole('button', { name: '创建', exact: true }).tap();

  const evalCase = await waitFor('评估用例创建', 30_000, () =>
    fixture('deliverable-feedback', 'evalCaseForFeedback', rejected.id),
  );
  expect(evalCase.expectation).toBe('42');
  expect(evalCase.expectation).not.toContain('39');
  expect(evalCase.prompt).toContain(FEEDBACK_BAD_MARKER);
  const linkedRows = await fixture('deliverable-feedback', 'listFeedback', run1.id);
  const linked = linkedRows.find((row) => row.id === rejected.id);
  assert(linked !== undefined, '退回记录消失');
  expect(linked.eval_case_id).toBe(evalCase.id);
  await expect(evalDialog).toHaveCount(0);

  const evalStart = await browserFetch(browser, 'POST', '/api/eval/runs', { agentId });
  expect(evalStart.status).toBe(202);
  const evalRun = await waitFor('评估运行进入终态', 240_000, async () => {
    const row = await fixture('deliverable-feedback', 'latestEvalRun', agentId);
    return row !== null && TERMINAL_STATUSES.has(row.status) ? row : null;
  });
  expect(evalRun).toMatchObject({ status: 'succeeded', total: 1, passed: 1 });
  const results = await fixture('deliverable-feedback', 'evalResults', evalRun.id);
  expect(results).toHaveLength(1);
  expect(results[0]?.passed).toBe(true);
  expect(results[0]?.output).toContain('42');

  const origin = (await browser.evaluate(() => location.origin)) as string;
  const anonymous = await fetch(`${origin}/api/runs/${run1.id}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'accepted' }),
  });
  expect(anonymous.status).toBe(401);

  const missingReason = await browserFetch(browser, 'POST', `/api/runs/${run1.id}/feedback`, {
    decision: 'rejected',
    rating: 2,
  });
  expect(missingReason.status).toBe(400);
  expect(missingReason.text).toContain('INVALID_INPUT');

  const foreignMessage = messages2.at(-1)?.id;
  assert(foreignMessage !== undefined, 'run2 缺少 assistant 消息');
  const foreignAnchor = await browserFetch(browser, 'POST', `/api/runs/${run1.id}/feedback`, {
    decision: 'accepted',
    messageId: foreignMessage,
  });
  expect(foreignAnchor.status).toBe(400);
  expect(foreignAnchor.text).toContain('INVALID_INPUT');

  const badPath = await browserFetch(browser, 'POST', `/api/runs/${run1.id}/feedback`, {
    decision: 'accepted',
    outputPath: 'missing-report.md',
  });
  expect(badPath.status).toBe(400);
  expect(badPath.text).toContain('INVALID_INPUT');

  const rawAnswer = await browserFetch(browser, 'POST', '/api/eval/cases/from-run', {
    runId: run1.id,
    expectation: answer1,
    confirmed: true,
  });
  expect(rawAnswer.status).toBe(400);
  expect(rawAnswer.text).toContain('INVALID_INPUT');

  const secondFeedback = await browserFetch(browser, 'POST', `/api/runs/${run1.id}/feedback`, {
    decision: 'rejected',
    rating: 2,
    reason: '并发转用例校验',
  });
  expect(secondFeedback.status).toBe(201);
  const secondFeedbackId = (JSON.parse(secondFeedback.text) as { id: string }).id;
  const convertBody = {
    runId: run1.id,
    expectation: '42',
    confirmed: true,
    feedbackId: secondFeedbackId,
  };
  const [firstConvert, secondConvert] = await Promise.all([
    browserFetch(browser, 'POST', '/api/eval/cases/from-run', convertBody),
    browserFetch(browser, 'POST', '/api/eval/cases/from-run', convertBody),
  ]);
  expect([firstConvert.status, secondConvert.status].sort((a, b) => a - b)).toEqual([201, 409]);
  expect(
    await fixture('deliverable-feedback', 'evalCaseForFeedback', secondFeedbackId),
  ).not.toBeNull();
  expect(await fixture('deliverable-feedback', 'countEvalCases', agentId)).toBe(2);

  await browser.setViewport({ width: 1200, height: 900 });
  await app.open(`/runs/${run1.id}`);
  await expect(screen.getByText('交付验收', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByText('已退回', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  const narrowShot = await shot('deliverable-feedback-rejected-1200');
  assert(narrowShot.length > 0, '窄视口退回截图未生成');
});
