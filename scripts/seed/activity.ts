import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  encryptSecrets,
  prepareOutputDraft,
  publishOutputSnapshot,
  readOutputFile,
  sha256Hex,
} from '@agentport/core';
import { newId, repo, schema, type Transaction } from '@agentport/db';
import { and, asc, eq } from 'drizzle-orm';
import { DEMO_CONVERSATIONS } from './constants.js';
import { storageDir } from './paths.js';
import type { DemoCatalog, SeedContext } from './types.js';

const SLOT = {
  review: 'succeeded',
  incident: 'failed',
} as const;

const REPORT_PATH = '报告.md';
const DATA_PATH = '数据.csv';

const REPORT_MARKDOWN = `# 第三季度经营复盘

## 结论摘要

本季度整体收入环比增长 12.4%，订单量增长 8.1%，增长主要来自华东与华南区域的复购。退款率从 2.6% 降至 1.9%，但华北区域新客转化仍低于目标。

## 关键指标

| 指标 | 上季度 | 本季度 | 变化 |
| --- | --- | --- | --- |
| 收入 | 1,286,000 | 1,446,000 | +12.4% |
| 订单量 | 4,180 | 4,520 | +8.1% |
| 退款率 | 2.6% | 1.9% | -0.7pp |
| 客单价 | 307.7 | 319.9 | +4.0% |

## 风险与建议

1. 华北区域新客转化率连续两个季度低于 20%，建议补充本地化素材并复盘投放渠道。
2. 退款原因中「物流延迟」占比上升，需要与履约团队约定异常订单的主动通知机制。
3. 高价值客户复购集中在少数品类，建议在下季度增加组合优惠，扩大复购品类覆盖。`;

const DATA_CSV = `区域,订单数,收入,退款率
华东,1480,486000,1.6%
华南,1260,412000,1.8%
华北,980,298000,2.4%
西南,800,250000,1.9%
合计,4520,1446000,1.9%
`;

interface MessageSpec {
  role: 'user' | 'assistant';
  offsetMs: number;
  text: string;
}

interface ConversationSpec {
  key: keyof typeof SLOT | 'planning';
  title: string;
  agent: { id: string; slug: string; name: string };
  status: 'succeeded' | 'failed';
  latencyMs: number;
  turns: number;
  costUsd: string;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  errorKind: 'agent' | null;
  messages: MessageSpec[];
}

async function publishReviewOutputs(
  ctx: SeedContext,
  slug: string,
  conversationId: string,
  runId: string,
  userMessageId: string,
  afterMessageId: string,
): Promise<void> {
  const root = storageDir('WORKSPACES_DIR', './data/workspaces');
  await mkdir(root, { recursive: true });
  const draft = await prepareOutputDraft({ root, slug, conversationId, runId });
  const report = Buffer.from(REPORT_MARKDOWN, 'utf8');
  await Bun.write(join(draft, REPORT_PATH), report);
  await Bun.write(join(draft, DATA_PATH), Buffer.from(DATA_CSV, 'utf8'));
  await publishOutputSnapshot({
    root,
    slug,
    conversationId,
    runId,
    status: 'succeeded',
    userMessageId,
    afterMessageId,
  });

  const published = await readOutputFile({ root, slug, conversationId, runId, path: REPORT_PATH });

  const secretKey = process.env.APP_SECRET_KEY;
  if (!secretKey) throw new Error('APP_SECRET_KEY 未配置，无法创建成果分享');

  const existing = await repo.outputShares.findByTriple(ctx.db, conversationId, runId, REPORT_PATH);
  if (existing) {
    ctx.log(`成果分享已就绪：/s/${existing.id}`);
    return;
  }

  const token = crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: 'base64url', omitPadding: true });
  const share = await repo.outputShares.create(ctx.db, {
    conversationId,
    runId,
    path: REPORT_PATH,
    sha256: sha256Hex(published.data),
    tokenHash: sha256Hex(token),
    tokenEncrypted: await encryptSecrets({ token }, secretKey),
  });
  ctx.log(`成果分享已就绪：/s/${share.id}`);
}

export async function seedActivity(ctx: SeedContext, catalog: DemoCatalog): Promise<void> {
  const { db, businessId, now, log } = ctx;

  const analyst = catalog.agents?.analyst;
  const engineer = catalog.agents?.engineer;
  const support = catalog.agents?.support;
  if (!analyst || !engineer || !support) {
    throw new Error('seedActivity: catalog.agents 缺少 analyst/engineer/support');
  }
  const startedAt = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

  const specs: ConversationSpec[] = [
    {
      key: 'review',
      title: DEMO_CONVERSATIONS.review,
      agent: analyst,
      status: 'succeeded',
      latencyMs: 95_000,
      turns: 4,
      costUsd: '0.0842',
      inputTokens: 4200,
      outputTokens: 1150,
      error: null,
      errorKind: null,
      messages: [
        {
          role: 'user',
          offsetMs: 2_000,
          text: '请分析上季度各区域销售数据，给出经营复盘和下一步建议。',
        },
        {
          role: 'assistant',
          offsetMs: 18_000,
          text: '已汇总四个区域的订单、收入与退款率。华东和华南贡献了主要增量，华北新客转化偏低。我正在把结论和风险整理成复盘报告。',
        },
        {
          role: 'user',
          offsetMs: 45_000,
          text: '重点补充退款率和履约风险，并给出一份可直接分享的报告。',
        },
        {
          role: 'assistant',
          offsetMs: 70_000,
          text: '报告已生成：本季度收入环比增长 12.4%，退款率降至 1.9%。主要风险是华北新客转化和物流延迟，建议补充本地化素材并建立异常订单主动通知。',
        },
      ],
    },
    {
      key: 'incident',
      title: DEMO_CONVERSATIONS.incident,
      agent: engineer,
      status: 'failed',
      latencyMs: 38_000,
      turns: 2,
      costUsd: '0.0120',
      inputTokens: 1800,
      outputTokens: 260,
      error: '工具调用连续失败：无法读取生产环境日志，运行已终止（演示失败）',
      errorKind: 'agent',
      messages: [
        {
          role: 'user',
          offsetMs: 3_000,
          text: '支付回调延迟告警刚触发，请排查最近一小时的服务日志并给出根因判断。',
        },
        {
          role: 'assistant',
          offsetMs: 30_000,
          text: '排查中断：当前环境无法访问生产日志服务，已连续重试工具调用但均失败。请检查日志网关连通性后重新发起排查。',
        },
      ],
    },
    {
      key: 'planning',
      title: DEMO_CONVERSATIONS.planning,
      agent: support,
      status: 'succeeded',
      latencyMs: 22_000,
      turns: 2,
      costUsd: '0.0086',
      inputTokens: 1200,
      outputTokens: 480,
      error: null,
      errorKind: null,
      messages: [
        {
          role: 'user',
          offsetMs: 4_000,
          text: '根据最近两周的工单量，规划下季度客服排班并说明高峰时段的人手安排。',
        },
        {
          role: 'assistant',
          offsetMs: 18_000,
          text: '工单高峰集中在工作日上午十点至十二点和下午三点至五点。建议高峰时段增加两名在线客服，晚间保留一名值班人员处理升级工单，并在周一预留机动人手。',
        },
      ],
    },
  ];

  const runs: NonNullable<DemoCatalog['runs']> = {};

  for (const spec of specs) {
    const [existing] = await db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.title, spec.title),
          eq(schema.conversations.createdBy, businessId),
        ),
      )
      .limit(1);

    if (existing) {
      const messages = await db
        .select({
          role: schema.messages.role,
          content: schema.messages.content,
          runId: schema.messages.runId,
        })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, existing.id))
        .orderBy(asc(schema.messages.createdAt));
      const seedMessage = messages.find(
        (message) =>
          message.role === 'user' &&
          repo.chat.messageText(message.content) === spec.messages[0]?.text,
      );
      const [run] = seedMessage?.runId
        ? await db
            .select({ id: schema.agentRuns.id })
            .from(schema.agentRuns)
            .where(eq(schema.agentRuns.id, seedMessage.runId))
            .limit(1)
        : [];
      if (!run) {
        log(`种子运行已不存在，跳过：${spec.title}`);
        continue;
      }
      if (spec.key !== 'planning') {
        runs[SLOT[spec.key]] = { conversationId: existing.id, runId: run.id };
      }
      log(`演示会话已存在，跳过：${spec.title}`);
      continue;
    }

    const conversationId = newId('conversation');
    const runId = newId('run');
    const runStartedAt = startedAt(spec.key === 'review' ? 120 : spec.key === 'incident' ? 45 : 20);
    const runEndedAt = new Date(runStartedAt.getTime() + spec.latencyMs);
    const messageRows = spec.messages.map((message) => ({
      id: newId('message'),
      conversationId,
      role: message.role,
      content: { type: 'text', text: message.text },
      ...(message.role === 'user'
        ? { senderBusinessId: businessId }
        : { uiFormat: 'markdown' as const }),
      runId,
      createdAt: new Date(runStartedAt.getTime() + message.offsetMs),
    }));

    await db.transaction(async (tx: Transaction) => {
      await repo.chat.createConversation(tx, {
        id: conversationId,
        agentId: spec.agent.id,
        title: spec.title,
        subject: { kind: 'user', businessId },
      });
      await tx.insert(schema.agentRuns).values({
        id: runId,
        conversationId,
        agentId: spec.agent.id,
        status: spec.status,
        trigger: 'chat',
        subjectKind: 'user',
        initiatedBy: businessId,
        createdAt: runStartedAt,
        startedAt: runStartedAt,
        endedAt: runEndedAt,
        latencyMs: spec.latencyMs,
        turns: spec.turns,
        costUsd: spec.costUsd,
        inputTokens: spec.inputTokens,
        outputTokens: spec.outputTokens,
        error: spec.error,
        errorKind: spec.errorKind,
      });
      await repo.chat.insertMessages(tx, messageRows);
    });

    if (spec.key === 'review') {
      const userMessage = messageRows.find((message) => message.role === 'user');
      const lastAssistant = messageRows.findLast((message) => message.role === 'assistant');
      if (!userMessage || !lastAssistant) {
        throw new Error('seedActivity: 复盘会话缺少用户或助手消息');
      }
      await publishReviewOutputs(
        ctx,
        spec.agent.slug,
        conversationId,
        runId,
        userMessage.id,
        lastAssistant.id,
      );
    }

    if (spec.key !== 'planning') {
      runs[SLOT[spec.key]] = { conversationId, runId };
    }
    log(`已创建演示会话：${spec.title}`);
  }

  catalog.runs = runs;
}
