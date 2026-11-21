import { type Browser, test } from '@e2e-dev/web';
import type { AgentSummary } from '../../packages/shared/src/agent.js';
import type {
  ChannelDetail,
  ChannelListItem,
  ChannelMessage,
} from '../../packages/shared/src/channels.js';
import {
  api,
  apiAllPages,
  DATASET_ID,
  datasetPath,
  readManifest,
  writeManifest,
} from '../support/business-dataset.js';
import { resolveOwnership } from '../support/dataset-ownership.js';

const CHANNEL_NAME = '【青禾演示】采购与售后协作';
const CHANNEL_DESCRIPTION = `DEV-DATA ${DATASET_ID} · 采购与售后协作 v1；由 tests/dev-data/channels.e2e.ts 生成，请勿手工改名`;
const AGENT_SLUGS = [`${DATASET_ID}-main`, `${DATASET_ID}-supplier-analyst`];

async function listAllChannels(browser: Browser): Promise<ChannelListItem[]> {
  const items: ChannelListItem[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await api<{ items: ChannelListItem[]; nextCursor: string | null }>(
      browser,
      cursor === undefined ? '/api/channels' : `/api/channels?cursor=${encodeURIComponent(cursor)}`,
    );
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    cursor = page.nextCursor;
  }
}
const MESSAGES = [
  {
    key: 'welcome',
    body: `DEV-DATA ${DATASET_ID} · 采购与售后协作频道已建立，本周交付与售后进展在这里同步。`,
  },
  {
    key: 'purchase',
    body: `DEV-DATA ${DATASET_ID} · 采购单 QH-PO-2026-001 已完成验收，交期与抽检比例按合同执行。`,
  },
  {
    key: 'aftersales',
    body: `DEV-DATA ${DATASET_ID} · 售后反馈已归档，等待供应商确认换货方案。`,
  },
] as const;

interface ChannelsManifest {
  datasetId: string;
  version: 1;
  origin: string | null;
  actor: { businessId: string; username: string } | null;
  channel: { id: string; name: string } | null;
  members: string[];
  agents: Array<{ id: string; name: string }>;
  messages: Array<{ key: string; clientMessageId: string; id: string; seq: number }>;
  gaps: string[];
  updatedAt: string;
}

interface AccountRow {
  businessId: string;
  status: string;
}

function emptyManifest(origin: string): ChannelsManifest {
  return {
    datasetId: DATASET_ID,
    version: 1,
    origin,
    actor: null,
    channel: null,
    members: [],
    agents: [],
    messages: [],
    gaps: [],
    updatedAt: new Date().toISOString(),
  };
}

test('channels dataset build: fixed channel, dataset members, expert bindings, idempotent messages', {
  session: 'admin',
  timeout: 5 * 60_000,
}, async ({ app, browser }) => {
  test.skip(process.env.E2E_DEV_DATA !== '1', '专用数据构建：设置 E2E_DEV_DATA=1 才运行');
  test.skip(process.env.E2E_DEV_DATA_VERIFY === '1', 'E2E_DEV_DATA_VERIFY=1 只做只读验收');

  const origin = app.baseUrl === undefined ? null : new URL(app.baseUrl).origin;
  if (origin === null) throw new Error('E2E 实例地址缺失');
  const manifest = await readManifest<ChannelsManifest>('channels', emptyManifest(origin));
  if (manifest.datasetId !== DATASET_ID || manifest.origin !== origin)
    throw new Error('channels manifest 身份或 origin 不一致');

  await app.open('/channels');
  const me = await api<{
    authenticated: boolean;
    user?: { businessId: string; username: string };
  }>(browser, '/api/auth/me');
  if (!me.authenticated || me.user === undefined) throw new Error('E2E 管理员会话未生效');
  if (manifest.actor !== null && manifest.actor.businessId !== me.user.businessId)
    throw new Error('channels manifest 主体与当前账户不一致');
  const actorBusinessId = me.user.businessId;
  manifest.actor = { businessId: actorBusinessId, username: me.user.username };

  const list = await listAllChannels(browser);
  const decision = resolveOwnership({
    dataset: DATASET_ID,
    label: `频道 ${CHANNEL_NAME}`,
    hasRecord: manifest.channel !== null,
    owned:
      manifest.channel === null ? undefined : list.find((item) => item.id === manifest.channel?.id),
    named: list.find((item) => item.name === CHANNEL_NAME),
    expectedName: CHANNEL_NAME,
    nameOf: (item) => item.name,
  });
  if (decision.kind === 'conflict') throw new Error(decision.message);
  let channelId: string;
  if (decision.kind === 'reuse') {
    if (decision.entity.description !== CHANNEL_DESCRIPTION)
      throw new Error('频道描述已被修改，未覆盖');
    if (decision.entity.archivedAt !== null) throw new Error('频道已归档，未复用');
    channelId = decision.entity.id;
  } else {
    const created = await api<{ id: string; name: string }>(browser, '/api/channels', {
      method: 'POST',
      body: { name: CHANNEL_NAME, description: CHANNEL_DESCRIPTION },
    });
    channelId = created.id;
    manifest.channel = { id: created.id, name: created.name };
    writeManifest('channels', manifest);
  }

  const detail = await api<ChannelDetail>(browser, `/api/channels/${channelId}`);

  const accounts = (
    await api<{ items: AccountRow[] }>(
      browser,
      `/api/accounts?q=${encodeURIComponent(DATASET_ID)}&limit=100&offset=0`,
    )
  ).items.filter(
    (account) =>
      account.status === 'active' &&
      account.businessId.startsWith(DATASET_ID) &&
      account.businessId !== actorBusinessId,
  );
  if (accounts.length === 0) throw new Error(`缺少 ${DATASET_ID} 可复用账户，先运行 assets 分片`);
  for (const account of accounts.slice(0, 2)) {
    if (detail.members.some((member) => member.businessId === account.businessId)) continue;
    await api(browser, `/api/channels/${channelId}/members`, {
      method: 'POST',
      body: { businessId: account.businessId, role: 'member' },
    });
  }

  const summaries = await apiAllPages<AgentSummary>(browser, '/api/agents');
  const agents = AGENT_SLUGS.flatMap((slug) =>
    summaries.filter((agent) => agent.enabled && agent.slug === slug),
  ).slice(0, 2);
  if (agents.length === 0) throw new Error(`缺少 ${DATASET_ID} 可绑定专家，先运行 business 分片`);
  for (const agent of agents) {
    const binding = detail.agentBindings.find((item) => item.agentId === agent.id);
    if (binding !== undefined) {
      if (binding.status !== 'active' || binding.autoWakeOnAll)
        throw new Error(`专家 ${agent.name} 的频道绑定已偏离数据集定义`);
      continue;
    }
    await api(browser, `/api/channels/${channelId}/agents`, {
      method: 'POST',
      body: { agentId: agent.id, autoWakeOnAll: false },
    });
  }

  const messages: ChannelsManifest['messages'] = MESSAGES.map((spec) => {
    const clientMessageId = `${DATASET_ID}:channels:${spec.key}`;
    return { key: spec.key, clientMessageId, id: '', seq: 0 };
  });
  for (const [index, spec] of MESSAGES.entries()) {
    const clientMessageId = `${DATASET_ID}:channels:${spec.key}`;
    const posted = await api<ChannelMessage>(browser, `/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: { body: spec.body, clientMessageId },
    });
    if (
      posted.kind !== 'human' ||
      posted.clientMessageId !== clientMessageId ||
      posted.body !== spec.body ||
      posted.authorBusinessId !== actorBusinessId
    )
      throw new Error(`频道消息 ${spec.key} 写入结果已偏离数据集定义`);
    messages[index] = {
      key: spec.key,
      clientMessageId,
      id: posted.id,
      seq: posted.seq,
    };
  }

  const current = await api<ChannelDetail>(browser, `/api/channels/${channelId}`);
  manifest.members = current.members.map((member) => member.businessId);
  manifest.agents = agents.map((agent) => ({ id: agent.id, name: agent.name }));
  manifest.messages = messages;
  manifest.gaps = [
    'kind=system 消息没有公共写入入口，只由真实 run 生命周期（忙碌提示、唤醒失败、运行收尾）产生；本分片不发模型请求，未生成 system 消息。',
    'agent 回复需要 @ 唤醒真实 run，会消耗模型与 worker；本分片未触发。',
    'runs、审批、questions、outputs 都依附于真实 run；本分片没有 run，不伪造这些状态。',
  ];
  manifest.updatedAt = new Date().toISOString();
  writeManifest('channels', manifest);
});

test('channels dataset verify: read-only checks for channel, members, bindings, messages, unread', {
  session: 'admin',
  timeout: 3 * 60_000,
}, async ({ app, browser }) => {
  test.skip(
    process.env.E2E_DEV_DATA_VERIFY !== '1',
    '专用数据验收：设置 E2E_DEV_DATA_VERIFY=1 才运行',
  );

  const manifest = await readManifest<ChannelsManifest | null>('channels', null);
  if (manifest === null) throw new Error(`缺少 ${datasetPath('channels')}；先运行构建`);
  const problems: string[] = [];
  const check = (condition: unknown, message: string): void => {
    if (!condition) problems.push(message);
  };

  check(manifest.datasetId === DATASET_ID, `manifest datasetId 不是 ${DATASET_ID}`);
  check(
    manifest.origin !== null &&
      app.baseUrl !== undefined &&
      new URL(app.baseUrl).origin === manifest.origin,
    `manifest origin 与当前实例不一致：${manifest.origin}`,
  );
  if (manifest.channel === null) throw new Error('channels manifest 缺少频道 ID');
  const actorBusinessId = manifest.actor?.businessId;
  if (actorBusinessId === undefined) throw new Error('channels manifest 缺少主体 businessId');

  await app.open('/channels');
  const me = await api<{
    authenticated: boolean;
    user?: { businessId: string };
  }>(browser, '/api/auth/me');
  check(
    me.authenticated && me.user?.businessId === actorBusinessId,
    '管理员会话主体与 manifest 不一致',
  );
  const list = await listAllChannels(browser);
  const item = list.find((channel) => channel.id === manifest.channel?.id);
  check(item !== undefined, '频道不在当前账户的频道列表中');
  const detail = await api<ChannelDetail>(browser, `/api/channels/${manifest.channel.id}`);
  check(detail.name === CHANNEL_NAME, `频道名称已被改为 ${detail.name}`);
  check(
    detail.description === CHANNEL_DESCRIPTION,
    `频道描述已被改为 ${String(detail.description)}`,
  );
  check(detail.members.length >= 1, '频道没有成员');
  check(
    detail.members.some(
      (member) => member.businessId === actorBusinessId && member.role === 'owner',
    ),
    '数据集主体不是频道 owner',
  );
  for (const businessId of manifest.members) {
    check(
      detail.members.some((member) => member.businessId === businessId),
      `manifest 成员 ${businessId} 已不在频道内`,
    );
  }
  const activeBindings = detail.agentBindings.filter((binding) => binding.status === 'active');
  check(activeBindings.length >= 1, '频道没有 active 的专家绑定');
  for (const agent of manifest.agents) {
    check(
      activeBindings.some((binding) => binding.agentId === agent.id),
      `manifest 专家 ${agent.name} 已不在频道绑定中`,
    );
  }

  const messages: ChannelMessage[] = [];
  let after = 0;
  while (true) {
    const page = await api<ChannelMessage[]>(
      browser,
      `/api/channels/${manifest.channel.id}/messages?after=${after}&limit=200`,
    );
    messages.push(...page);
    const cursor = page.at(-1)?.seq;
    if (page.length < 200 || cursor === undefined) break;
    after = cursor;
  }
  const humanMessages = messages.filter((message) => message.kind === 'human');
  check(humanMessages.length >= 2, `human 消息不足 2 条：${humanMessages.length}`);
  check(
    messages.every((message, index) => {
      const previous = messages[index - 1];
      return previous === undefined || message.seq > previous.seq;
    }),
    '消息 seq 不是严格递增',
  );
  for (const spec of MESSAGES) {
    const clientMessageId = `${DATASET_ID}:channels:${spec.key}`;
    const actual = messages.find((message) => message.clientMessageId === clientMessageId);
    check(
      actual?.kind === 'human' &&
        actual.body === spec.body &&
        actual.authorBusinessId === actorBusinessId,
      `固定消息 ${spec.key} 缺失或内容/作者不一致`,
    );
    const record = manifest.messages.find((entry) => entry.clientMessageId === clientMessageId);
    check(
      record !== undefined && actual?.id === record.id && actual.seq === record.seq,
      `manifest 消息 ${spec.key} 与时间线不一致`,
    );
  }
  const last = messages.at(-1);
  check(last !== undefined, '频道没有消息');
  if (item !== undefined && last !== undefined) {
    check(
      item.lastMessage?.id === last.id &&
        item.lastMessage.seq === last.seq &&
        item.lastMessage.kind === last.kind,
      '列表末条消息与时间线不一致',
    );
    const expectedUnread = messages.filter(
      (message) => message.seq > item.lastReadSeq && message.authorBusinessId !== actorBusinessId,
    ).length;
    check(
      item.unreadCount === expectedUnread,
      `未读数 ${item.unreadCount} 与时间线计算值 ${expectedUnread} 不一致`,
    );
    check(item.memberCount === detail.members.length, '列表成员数与详情不一致');
    check(item.agentCount === detail.agentBindings.length, '列表专家数与详情不一致');
  }
  check(
    detail.members.some(
      (member) =>
        member.businessId !== actorBusinessId &&
        messages.some(
          (message) =>
            message.seq > member.lastReadSeq && message.authorBusinessId !== member.businessId,
        ),
    ),
    '没有其他成员按自身游标存在未读消息，频道未形成未读数据',
  );

  if (problems.length > 0) {
    throw new Error(`频道数据验收失败：\n- ${[...new Set(problems)].join('\n- ')}`);
  }
});
