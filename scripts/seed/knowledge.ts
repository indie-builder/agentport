import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chunkDocument, markdownBlocks, segmentForSearch, sha256Hex } from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import { knowledgeBaseSettingsSchema } from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
import { DEMO_KNOWLEDGE } from './constants';
import { storageDir } from './paths';
import type { SeedContext } from './types';

const DEMO_KNOWLEDGE_DESCRIPTION = '演示用业务知识库：员工手册、采购流程与客服话术。';
const PROFILE_NAME = '演示·本地向量';
const PROFILE_ENDPOINT = 'http://127.0.0.1:9/v1';
const PROFILE_MODEL = 'demo-embedding';

const SETTINGS = knowledgeBaseSettingsSchema.parse({
  chunkTokens: 800,
  chunkOverlap: 100,
  wikiAutoUpdate: false,
});

const DOCUMENTS = [
  {
    sourceId: 'demo-handbook-employee',
    title: '员工手册',
    markdown: `# 员工手册

## 入职与试用

新员工入职当天完成账号开通、工位分配与设备领取。试用期为三个月，期间每两周与直属主管进行一次一对一沟通，记录目标进展和需要支持的资源。

转正评估由直属主管发起，综合试用期目标完成度、协作反馈与业务贡献。评估材料在转正评审会前三个工作日提交人力资源部。

## 考勤与请假

标准工作时间为每周一至周五 9:30 至 18:30，午休一小时。弹性到岗允许在 8:30 至 10:30 之间选择，离开时间相应顺延。

请假通过内部系统提交。年假按入职月份折算，事假需提前一个工作日申请，病假需在当天上午告知直属主管并补充证明材料。连续请假超过三个工作日，需要部门负责人审批。

## 远程办公

员工每周可申请两天远程办公，需保证在线响应和会议参与。涉及客户现场、生产变更或安全敏感工作的日期不支持远程。

远程办公期间使用公司统一账号登录，禁止在公共设备上保存业务数据。离开工位时锁定屏幕，会议中避免展示客户敏感信息。

## 信息安全

账号、密码与访问令牌不得共享。发现账号异常、设备丢失或数据误发，立即通知信息安全团队，并在事件登记表中记录时间、影响范围与处置动作。

对外发送包含客户数据的文件前，必须确认接收方与用途，并使用加密链接或受控共享目录。离职交接时归还全部设备并注销访问权限。`,
  },
  {
    sourceId: 'demo-handbook-procurement',
    title: '采购流程',
    markdown: `# 采购流程

## 适用范围

本流程适用于办公设备、软件订阅、外包服务与市场物料的采购。单笔金额低于五千元由部门负责人审批，五千元至五万元需财务与采购共同审批，超过五万元提交月度采购委员会。

## 申请与比价

申请人填写采购申请，说明用途、预算来源、交付时间与验收标准。采购金额超过一万元时，至少获取三家供应商报价；只有一家可选的，需在申请中说明原因并附替代方案评估。

软件订阅需同时提交数据安全评估，说明数据存储位置、账号权限与退出时的数据导出方式。涉及个人信息处理的，必须由法务确认合同条款。

## 合同与付款

合同由法务审核后签署，禁止先付款后补合同。预付款比例原则上不超过合同金额的百分之三十。验收完成后，申请人上传验收记录，财务在五个工作日内安排付款。

供应商交付延期超过一周时，采购负责人应启动沟通并记录影响。连续两次延期或交付质量不达标的供应商，暂停进入下一轮比价。

## 验收与归档

验收由申请人与使用方共同完成，核对数量、规格、许可证期限与发票信息。验收记录、合同、报价单与付款凭证统一归档到采购台账，保存期限不少于五年。`,
  },
  {
    sourceId: 'demo-handbook-support',
    title: '客服话术',
    markdown: `# 客服话术

## 首次响应

收到客户咨询后，先在两分钟内确认收到，并说明预计回复时间。标准开场为：「您好，已收到您的问题，我先核对相关信息，预计十分钟内给您进一步答复。」

回复时先复述客户诉求，确认理解一致，再给出结论和下一步动作。避免使用「应该」「可能」等不确定表述；无法立即确认时，明确说明需要核实的内容和时间点。

## 退款与售后

客户提出退款时，先确认订单号、购买时间和退款原因。符合七天无理由条件的，引导客户提交申请并告知退款到账时间。超过期限或已使用的服务，说明政策边界，并询问是否需要升级处理。

遇到情绪激动的客户，先表达理解，不打断对方。重复关键事实并给出可执行的解决路径，必要时转交主管。不要在未确认政策前承诺退款金额。

## 升级与交接

以下情况必须升级：涉及资金安全、账号被盗、批量故障、监管投诉或客户明确要求主管介入。升级时填写交接摘要，包含客户信息、问题经过、已采取措施和期望结果。

交接后由接手人继续跟进，原客服不再重复联系客户。每日下班前更新未结案工单状态，避免客户重复描述问题。`,
  },
] as const;

async function findOrCreateKnowledgeServer(
  ctx: SeedContext,
  requireNew = false,
): Promise<typeof schema.servers.$inferSelect> {
  const serverName = `kb-${DEMO_KNOWLEDGE.slug}`;
  const [existing] = await ctx.db
    .select()
    .from(schema.servers)
    .where(eq(schema.servers.name, serverName))
    .limit(1);
  if (existing) {
    if (requireNew) {
      throw new Error(
        `知识库连接器「${DEMO_KNOWLEDGE.name}」已存在但知识库缺失，请先清理或重置开发库`,
      );
    }
    if (existing.kind !== 'knowledge') {
      throw new Error(`服务「${serverName}」已存在但不是 knowledge 类型，请先改名或清理`);
    }
    return existing;
  }
  const [created] = await ctx.db
    .insert(schema.servers)
    .values({
      id: newId('server'),
      name: serverName,
      kind: 'knowledge',
      config: {},
      secretsEncrypted: null,
      ownerBusinessId: ctx.businessId,
    })
    .returning();
  if (!created) throw new Error('知识库 server 创建失败');
  return created;
}

async function ensureKnowledgeServer(
  ctx: SeedContext,
  base: typeof schema.knowledgeBases.$inferSelect,
): Promise<void> {
  const server = await findOrCreateKnowledgeServer(ctx);
  let serverId = server.id;
  if (base.serverId) {
    const [bound] = await ctx.db
      .select({ id: schema.servers.id })
      .from(schema.servers)
      .where(eq(schema.servers.id, base.serverId))
      .limit(1);
    if (bound) serverId = base.serverId;
  }
  if (serverId !== base.serverId) {
    await ctx.db
      .update(schema.knowledgeBases)
      .set({ serverId })
      .where(eq(schema.knowledgeBases.id, base.id));
  }
  const [target] = await ctx.db
    .select()
    .from(schema.servers)
    .where(eq(schema.servers.id, serverId))
    .limit(1);
  if (!target) throw new Error('知识库 server 绑定失败');
  if (target.config.knowledgeBaseId === undefined) {
    await ctx.db
      .update(schema.servers)
      .set({ config: { ...target.config, knowledgeBaseId: base.id } })
      .where(eq(schema.servers.id, serverId));
  }
}

async function writeExclusive(path: string, data: string | Buffer): Promise<void> {
  try {
    await writeFile(path, data, {
      encoding: typeof data === 'string' ? 'utf8' : undefined,
      flag: 'wx',
    });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}

export async function seedKnowledge(ctx: SeedContext): Promise<void> {
  const { db, businessId, log } = ctx;
  const knowledgeDir = storageDir('KNOWLEDGE_DIR', './data/knowledge');

  const [existingBase] = await db
    .select()
    .from(schema.knowledgeBases)
    .where(eq(schema.knowledgeBases.slug, DEMO_KNOWLEDGE.slug))
    .limit(1);
  const [existingProfile] = await db
    .select()
    .from(schema.knowledgeModelProfiles)
    .where(
      and(
        eq(schema.knowledgeModelProfiles.kind, 'embedding'),
        eq(schema.knowledgeModelProfiles.name, PROFILE_NAME),
      ),
    )
    .limit(1);
  if (
    existingBase &&
    !(
      existingBase.name === DEMO_KNOWLEDGE.name &&
      existingBase.description === DEMO_KNOWLEDGE_DESCRIPTION &&
      existingBase.ownerBusinessId === businessId &&
      existingProfile !== undefined &&
      existingBase.embeddingProfileId === existingProfile.id
    )
  ) {
    throw new Error(`知识库「${DEMO_KNOWLEDGE.name}」已存在但不是演示数据，请先改名或清理`);
  }
  if (
    existingProfile &&
    (existingProfile.model !== PROFILE_MODEL || existingProfile.endpointUrl !== PROFILE_ENDPOINT)
  ) {
    throw new Error(`模型端点「${PROFILE_NAME}」已存在但不是演示配置，请先改名或清理`);
  }
  let base = existingBase ?? null;
  if (base === null) {
    base = await db.transaction(async (tx) => {
      const txCtx: SeedContext = { ...ctx, db: tx };
      const embeddingProfile =
        existingProfile ??
        (await repo.knowledge.createModelProfile(tx, {
          kind: 'embedding',
          name: PROFILE_NAME,
          endpointUrl: PROFILE_ENDPOINT,
          model: PROFILE_MODEL,
          dimensions: 1024,
          secretsEncrypted: null,
          enabled: false,
        }));

      const server = await findOrCreateKnowledgeServer(txCtx, true);
      const created = await repo.knowledge.createBase(tx, {
        slug: DEMO_KNOWLEDGE.slug,
        name: DEMO_KNOWLEDGE.name,
        description: DEMO_KNOWLEDGE_DESCRIPTION,
        serverId: server.id,
        embeddingProfileId: embeddingProfile.id,
        rerankProfileId: null,
        settings: SETTINGS,
        ownerBusinessId: businessId,
      });
      await ensureKnowledgeServer(txCtx, created);
      return created;
    });
    log(`已创建知识库：${base.name}`);
  }

  for (const spec of DOCUMENTS) {
    const [existingDocument] = await db
      .select()
      .from(schema.knowledgeDocuments)
      .where(
        and(
          eq(schema.knowledgeDocuments.baseId, base.id),
          eq(schema.knowledgeDocuments.sourceType, 'manual'),
          eq(schema.knowledgeDocuments.sourceId, spec.sourceId),
        ),
      )
      .limit(1);

    if (existingDocument) {
      log(`知识库文档已存在，跳过：${spec.title}`);
      continue;
    }

    const document = await repo.knowledge.createDocument(db, {
      baseId: base.id,
      folderId: null,
      title: spec.title,
      sourceType: 'manual',
      sourceId: spec.sourceId,
      sourceUrl: null,
      sourcePath: null,
      mimeType: 'text/markdown',
      sizeBytes: Buffer.byteLength(spec.markdown, 'utf8'),
      metadata: { originalFilename: `${spec.title}.md` },
    });

    const data = Buffer.from(spec.markdown, 'utf8');
    const seedHash = sha256Hex(data);
    const version = await repo.knowledge.createVersion(db, {
      documentId: document.id,
      blobSha256: seedHash,
      markdownSha256: seedHash,
      originalFilename: `${spec.title}.md`,
      mimeType: 'text/markdown',
      sizeBytes: data.length,
      sourceRevision: null,
      origin: 'source',
      parentVersionId: null,
      metadata: { originalFilename: `${spec.title}.md` },
      parseStatus: 'parsed',
      pageMap: [],
      images: [],
      embeddingProfileId: base.embeddingProfileId,
    });

    const blob = join(knowledgeDir, 'blobs', version.blobSha256.slice(0, 2), version.blobSha256);
    await mkdir(dirname(blob), { recursive: true });
    await writeExclusive(blob, data);
    const markdownPath = join(knowledgeDir, 'docs', document.id, version.id, 'markdown.md');
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeExclusive(markdownPath, spec.markdown);

    const chunks = chunkDocument(
      {
        markdown: spec.markdown,
        blocks: markdownBlocks(spec.markdown, (line, start = 0, end = start) => ({
          line,
          startOffset: start,
          endOffset: end,
        })),
        images: [],
        pageMap: [],
      },
      { chunkSize: base.settings.chunkTokens, chunkOverlap: base.settings.chunkOverlap },
    ).map((chunk, ordinal) => ({
      ordinal,
      kind: 'text' as const,
      heading: chunk.heading === '' ? null : chunk.heading,
      content: chunk.content,
      searchText: segmentForSearch(chunk.content),
      embedding: null,
      pageFrom: null,
      pageTo: null,
      locator: null,
      tokenCount: Math.ceil(chunk.content.length / 2),
    }));

    await repo.knowledge.insertChunks(db, {
      baseId: base.id,
      documentId: document.id,
      versionId: version.id,
      folderId: null,
      chunks,
    });

    const published = await repo.knowledge.setCurrentVersion(db, document.id, version.id);
    if (!published) throw new Error(`知识库文档发布失败：${spec.title}`);
    log(`知识库文档已就绪：${spec.title}`);
  }
}
