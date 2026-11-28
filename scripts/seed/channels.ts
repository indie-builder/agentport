import { channelMessages, channels, newId, repo } from '@agentport/db';
import { and, eq } from 'drizzle-orm';
import { DEMO_CHANNELS } from './constants.js';
import type { DemoCatalog, SeedContext } from './types.js';

type ChannelKey = keyof typeof DEMO_CHANNELS;
type AgentKey = 'analyst' | 'support';

type DemoMessage =
  | { kind: 'human'; body: string }
  | { kind: 'agent'; agent: AgentKey; body: string }
  | { kind: 'system'; agent: AgentKey; body: string };

interface ChannelSpec {
  key: ChannelKey;
  name: string;
  description: string;
  agents: AgentKey[];
  messages: DemoMessage[];
}

export async function seedChannels(ctx: SeedContext, catalog: DemoCatalog): Promise<void> {
  const { db, businessId, now } = ctx;
  const agentsCatalog = catalog.agents;
  if (!agentsCatalog) throw new Error('seedChannels: catalog.agents 缺失');
  const agentOf = (key: AgentKey) => agentsCatalog[key];

  let created = 0;
  let reused = 0;

  async function ensureChannel(spec: ChannelSpec): Promise<{ id: string; name: string }> {
    const [existing] = await db
      .select({ id: channels.id, name: channels.name, description: channels.description })
      .from(channels)
      .where(and(eq(channels.name, spec.name), eq(channels.createdBy, businessId)))
      .limit(1);
    if (existing && existing.description !== spec.description) {
      throw new Error(`频道「${spec.name}」已存在但不是演示数据，请先改名或清理`);
    }
    if (existing) {
      reused += 1;
      return { id: existing.id, name: existing.name };
    }
    const channel = await repo.channels.createChannel(db, {
      id: newId('channel'),
      name: spec.name,
      description: spec.description,
      createdBy: businessId,
    });
    created += 1;

    for (const key of spec.agents) {
      const binding = await repo.channels.addAgentBinding(db, { businessId }, channel.id, {
        agentId: agentOf(key).id,
        autoWakeOnAll: false,
      });
      if (binding.kind !== 'ok' && binding.kind !== 'conflict') {
        throw new Error(`频道「${spec.name}」绑定智能体失败：${binding.kind}`);
      }
    }

    const base = now.getTime() - spec.messages.length * 6 * 60_000;
    const at = (index: number) => new Date(base + index * 6 * 60_000);

    for (const [index, message] of spec.messages.entries()) {
      const clientMessageId = `demo-${spec.key}-${index + 1}`;
      if (message.kind === 'human') {
        const posted = await repo.channels.postMessage(db, { businessId }, channel.id, {
          id: newId('channelMessage'),
          body: message.body,
          clientMessageId,
        });
        if (posted.kind !== 'ok') {
          throw new Error(`频道「${spec.name}」写入人工消息失败：${posted.kind}`);
        }
        if (!posted.duplicate) {
          await db
            .update(channelMessages)
            .set({ createdAt: at(index) })
            .where(eq(channelMessages.id, posted.message.id));
        }
        continue;
      }
      if (message.kind === 'agent') {
        await db
          .insert(channelMessages)
          .values({
            id: newId('channelMessage'),
            channelId: channel.id,
            kind: 'agent',
            agentId: agentOf(message.agent).id,
            body: message.body,
            clientMessageId,
            createdAt: at(index),
          })
          .onConflictDoNothing();
        continue;
      }
      const [existingSystem] = await db
        .select({ id: channelMessages.id })
        .from(channelMessages)
        .where(
          and(
            eq(channelMessages.channelId, channel.id),
            eq(channelMessages.kind, 'system'),
            eq(channelMessages.body, message.body),
          ),
        )
        .limit(1);
      if (existingSystem) continue;
      const posted = await repo.channels.postSystemMessage(db, {
        channelId: channel.id,
        agentId: agentOf(message.agent).id,
        body: message.body,
      });
      if (posted) {
        await db
          .update(channelMessages)
          .set({ createdAt: at(index) })
          .where(eq(channelMessages.id, posted.id));
      }
    }

    return { id: channel.id, name: channel.name };
  }

  const deliverySpec: ChannelSpec = {
    key: 'delivery',
    ...DEMO_CHANNELS.delivery,
    agents: ['analyst', 'support'],
    messages: [
      {
        kind: 'human',
        body: '本周交付进度同步：订单查询接口已联调完成，前端筛选页预计周四提测。',
      },
      {
        kind: 'agent',
        agent: 'analyst',
        body: '已核对联调数据：用户与帖子两个查询返回结构正常；建议列表为空时给出明确提示，避免误判为加载失败。',
      },
      {
        kind: 'system',
        agent: 'analyst',
        body: '演示·系统：交付清单已更新，当前待办 3 项，其中 1 项等待排期。',
      },
      {
        kind: 'human',
        body: '风险：列表页在大数据量下首屏偏慢，需要前端本周给出分页或虚拟滚动方案。',
      },
      {
        kind: 'agent',
        agent: 'support',
        body: '客服侧收到 2 个订单状态刷新相关咨询，已记录复现步骤并同步给前端。',
      },
      {
        kind: 'human',
        body: '交接：明天起由前端工程师跟进分页改造，产品分析师继续盯接口回归和指标变化。',
      },
      {
        kind: 'system',
        agent: 'support',
        body: '演示·系统：本周交付评审已排期，请相关同事提前准备材料。',
      },
    ],
  };

  const supportSpec: ChannelSpec = {
    key: 'support',
    ...DEMO_CHANNELS.support,
    agents: ['support'],
    messages: [
      {
        kind: 'human',
        body: '客服值班交接：昨晚有 3 个升级工单，其中 1 个仍在等待退款政策确认。',
      },
      {
        kind: 'agent',
        agent: 'support',
        body: '已整理升级工单摘要：退款政策咨询 1 个、登录异常 2 个；登录问题均已恢复并回访。',
      },
      {
        kind: 'system',
        agent: 'support',
        body: '演示·系统：今日值班已开始，升级阈值保持不变。',
      },
      {
        kind: 'human',
        body: '退款政策那个工单请合规审查员确认例外条款，确认前不要向客户承诺处理时效。',
      },
      {
        kind: 'agent',
        agent: 'support',
        body: '收到，已在工单备注标记待合规确认，并向客户说明会尽快回复。',
      },
      {
        kind: 'human',
        body: '交接：下午由客服主管继续跟进，登录异常的两位客户需要再次回访。',
      },
      {
        kind: 'system',
        agent: 'support',
        body: '演示·系统：值班交接完成，未处理工单 1 个。',
      },
    ],
  };

  const delivery = await ensureChannel(deliverySpec);
  const support = await ensureChannel(supportSpec);
  catalog.channels = { delivery, support };
  ctx.log(`频道：新建 ${created} / 复用 ${reused}`);
}
