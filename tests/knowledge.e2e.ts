import { randomUUID } from 'node:crypto';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

/**
 * 知识库端到端验收：真实页面 + 真实 API，不调用付费模型、不伪造索引。
 *
 * 依赖知识库联调实例（用 E2E_APP_URL 指向；本地夹具地址可由 E2E_KNOWLEDGE_FEED_URL 覆盖）：
 * 仅该实例的 KNOWLEDGE_PRIVATE_HOST_ALLOWLIST 放行本地夹具。检索与文档检查器读
 * 已由 worker 处理为 ready 的种子文档；写路径只验证"入队"，不假装完成 ingest。
 */
const skipUnlessKnowledgeRuntime =
  process.env.E2E_KNOWLEDGE_SEED === '1'
    ? false
    : '需要知识库联调实例：把 E2E_APP_URL 指向该实例并设置 E2E_KNOWLEDGE_SEED=1';

const SEEDED_BASE_NAME = '知识库浏览器联调';
const SEEDED_DOCUMENT_TITLE = 'browser-note';
/** 本地 RSS 协议夹具：只证明来源抓取链路，不接真实订阅。 */
const FIXTURE_FEED_URL = process.env.E2E_KNOWLEDGE_FEED_URL ?? 'http://127.0.0.1:3356/feed.xml';

interface KnowledgeBase {
  id: string;
  slug: string;
  name: string;
}

interface Workspace {
  suffix: string;
  profile: { id: string; name: string };
  /** 创建前登记 slug；teardown 按 slug 清理，创建失败也不留残骸。 */
  track: (slug: string) => void;
  createBase: (slug: string, name: string) => Promise<KnowledgeBase>;
  api: (path: string, init?: RequestInit) => Promise<Response>;
}

const knowledgeTest = test.extend<{ workspace: Workspace }>({
  workspace: async ({ app, browser }, use) => {
    const baseUrl = process.env.E2E_APP_URL ?? app.baseUrl;
    if (!baseUrl) throw new Error('E2E_APP_URL is required for knowledge fixtures');
    // 会话先于 fixture 恢复；这里用页面 cookie 直接打真实 API。
    const cookie = (await browser.cookies()).map((item) => `${item.name}=${item.value}`).join('; ');
    const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
      const response = await fetch(new URL(path, baseUrl), {
        ...init,
        // 无 body 的 DELETE 不能带 JSON content-type，Fastify 会按空 body 拒绝。
        headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      });
      if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}`);
      return response;
    };

    const suffix = randomUUID().slice(0, 8);
    // 复用联调实例已有的 embedding profile：新建/删除会多打请求并触发全局限流，
    // 而库本身只需要一个启用的 profile 才能创建。
    const profiles = (await (await api('/api/knowledge/model-profiles')).json()) as Array<{
      id: string;
      name: string;
      kind: string;
      enabled: boolean;
    }>;
    const profile = profiles.find((item) => item.kind === 'embedding' && item.enabled);
    if (!profile) throw new Error('知识库联调实例缺少启用的 embedding profile');

    const slugs = new Set<string>();
    const createBase = async (slug: string, name: string): Promise<KnowledgeBase> => {
      slugs.add(slug);
      return (await (
        await api('/api/knowledge/bases', {
          method: 'POST',
          body: JSON.stringify({
            slug,
            name,
            description: '知识库端到端用例',
            embeddingProfileId: profile.id,
            rerankProfileId: null,
            settings: { chunkTokens: 800, chunkOverlap: 120, wikiAutoUpdate: false },
          }),
        })
      ).json()) as KnowledgeBase;
    };

    try {
      await use({
        suffix,
        profile,
        track: (slug) => slugs.add(slug),
        createBase,
        api,
      });
    } finally {
      // 清理失败必须报出来，否则残留 fixture 会悄悄污染下一轮。
      for (const slug of slugs) {
        const list = (await (await api('/api/knowledge/bases?limit=200')).json()) as {
          items: KnowledgeBase[];
        };
        const base = list.items.find((item) => item.slug === slug);
        if (base) await api(`/api/knowledge/bases/${base.id}`, { method: 'DELETE' });
      }
    }
  },
});

test('knowledge tab, document inspector and search highlight read the seeded base', {
  session: 'admin',
  skip: skipUnlessKnowledgeRuntime,
}, async ({ app, screen, browser }) => {
  // 第四个资源页签进入知识库；资源中心不再包含专家，从资源页开始。
  await app.open('/skills');
  await screen.getByRole('link', '知识库', { exact: true }).tap();
  await expect(browser).toHaveURL(/\/knowledge$/);
  await expect(browser).toHaveTitle('知识库 · PACE');
  await expect(screen.getByRole('heading', { level: 1, name: '知识库' })).toBeVisible();
  await expect(screen.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(screen.getByText(/共 \d+ 个知识库/)).toBeVisible();

  // 卡片整卡是一个带 aria-label 的 Link，按链接角色定位。
  await screen.getByRole('link', `查看知识库 ${SEEDED_BASE_NAME}`, { exact: true }).tap();
  await expect(browser).toHaveURL(/\/knowledge\/kb_/);
  // 详情标题只有一个 h1，内容是知识库名；document.title 跟随实际 h1。
  await expect(screen.getByRole('heading', { level: 1, name: SEEDED_BASE_NAME })).toBeVisible();
  await expect(screen.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(browser).toHaveTitle(`${SEEDED_BASE_NAME} · PACE`);

  // 文档列表 → 检查器：解析正文、分块与代码块都来自真实索引。
  await screen.getByRole('button', SEEDED_DOCUMENT_TITLE, { exact: true }).tap();
  const viewer = screen.getByRole('dialog');
  await expect(viewer).toContainText('解析正文');
  await expect(viewer).toContainText('混合检索');
  await expect(viewer).toContainText("const scope = 'selected'");
  await expect(viewer).toContainText('发布检查');
  await expect(viewer.getByText('分块', { exact: true })).toBeVisible();
  await screen.getByRole('button', '关闭', { exact: true }).tap();
  await expect(viewer).not.toBeVisible();

  // 检索 → 查看原文：命中片段在引用弹窗里高亮，并可下载原件。
  await screen.getByRole('tab', '检索测试', { exact: true }).tap();
  await screen.getByRole('searchbox', '检索知识库').fill('混合检索');
  await screen.getByRole('button', '检索', { exact: true }).tap();
  await browser
    .locator('li')
    .filter({ hasText: '混合检索' })
    .first()
    .getByRole('button', '查看原文')
    .tap();
  const quote = screen.getByRole('dialog');
  await expect(quote).toContainText('引用原文');
  await expect(browser.locator('[role="dialog"] mark')).toContainText('混合检索');
  await expect(quote.getByRole('link', '下载原件')).toBeVisible();
});

knowledgeTest(
  'knowledge base and source config create through the UI, document enqueue is visible',
  {
    session: 'admin',
    skip: skipUnlessKnowledgeRuntime,
  },
  async ({ app, screen, browser, workspace }) => {
    const slug = `e2e-kb-${workspace.suffix}`;
    const name = `E2E 知识库 ${workspace.suffix}`;
    const documentTitle = `E2E 手写文档 ${workspace.suffix}`;
    workspace.track(slug);

    await app.open('/knowledge');
    await screen.getByRole('button', '新建知识库').first().tap();
    await browser.locator('#knowledge-name').fill(name);
    // slug 与模型选择都在高级设置里；折叠时字段不可操作，先展开再填。
    await screen.getByRole('button', '高级设置', { exact: true }).tap();
    await browser.locator('#knowledge-slug').fill(slug);
    // 库必须绑定一个启用的 embedding profile；只有一个时是只读展示，多个才是 Select。
    if ((await browser.locator('#knowledge-embedding').count()) > 0) {
      await screen.getByRole('combobox', /^Embedding/).tap();
      await screen.getByRole('option', workspace.profile.name, { exact: true }).tap();
    }
    await screen.getByRole('button', '创建', { exact: true }).tap();
    // 创建成功后直接进入详情，不再停在列表成功卡。
    await expect(browser).toHaveURL(/\/knowledge\/kb_/);
    await expect(screen.getByRole('heading', { level: 1, name })).toBeVisible();
    const baseId = (await browser.url()).split('/').pop() ?? '';
    expect(baseId).toMatch(/^kb_/);

    // 来源配置 UI：先在对话框里选来源类型，再填名称与 Feed 地址。
    await screen.getByRole('tab', '来源', { exact: true }).tap();
    // 工具栏与空状态各有一个入口。
    await screen.getByRole('button', '新建来源', { exact: true }).first().tap();
    await screen.getByRole('dialog').getByRole('button', { name: /^RSS/ }).tap();
    await browser.locator('#source-name').fill(`E2E Feed ${workspace.suffix}`);
    await browser.locator('#source-range-0-external').fill(FIXTURE_FEED_URL);
    await screen.getByRole('button', '创建', { exact: true }).tap();
    await expect(screen.getByText('来源已创建')).toBeVisible();
    await expect(screen.getByText(`E2E Feed ${workspace.suffix}`, { exact: true })).toBeVisible();

    // 手写中文文档走真实 API 入队；worker 暂停时不假装已完成 ingest。
    await workspace.api(`/api/knowledge/bases/${baseId}/documents/manual`, {
      method: 'POST',
      body: JSON.stringify({
        title: documentTitle,
        content: `# ${documentTitle}\n\n发布前需要评审并备份。`,
        folderId: null,
        tags: [],
      }),
    });

    await app.open(`/knowledge/${baseId}`);
    await expect(screen.getByRole('button', documentTitle, { exact: true })).toBeVisible();
    await screen.getByRole('tab', '处理记录', { exact: true }).tap();
    await expect(screen.getByRole('table', '知识库任务')).toContainText('文档摄取');
  },
);

knowledgeTest(
  'wiki page edits publish a new manual version in the UI',
  {
    session: 'admin',
    skip: skipUnlessKnowledgeRuntime,
  },
  async ({ app, screen, workspace }) => {
    const suffix = workspace.suffix;
    const base = await workspace.createBase(`e2e-wiki-${suffix}`, `E2E Wiki 知识库 ${suffix}`);
    // 只建页面，不写正文：无版本页的首稿必须从 UI 编辑器创建。
    const page = (await (
      await workspace.api(`/api/knowledge/bases/${base.id}/wiki-pages`, {
        method: 'POST',
        body: JSON.stringify({ slug: 'release-notes', title: `发布说明 ${suffix}` }),
      })
    ).json()) as { id: string };

    await app.open(`/knowledge/${base.id}?panel=wiki&page=${page.id}`);
    await expect(screen.getByRole('heading', { level: 1, name: base.name })).toBeVisible();
    await expect(screen.getByText('还没有正文', { exact: true })).toBeVisible();

    // 首稿：打开空编辑器，输入正文后保存草稿（expectedVersion 为 null）。
    await screen.getByRole('button', '编辑正文', { exact: true }).tap();
    const editor = screen.getByRole('dialog');
    await editor.getByLabel('Markdown').fill(`# 发布说明 ${suffix}\n\n初始正文 ${suffix}。`);
    await screen.getByRole('button', '保存草稿', { exact: true }).tap();
    await expect(screen.getByText('Wiki 草稿已保存，发布后才会上线')).toBeVisible();
    await expect(editor).not.toBeVisible();
    await expect(screen.getByText('草稿预览', { exact: true })).toBeVisible();
    await expect(screen.getByText(`初始正文 ${suffix}`, { exact: false })).toBeVisible();

    // 版本列表里显式发布首稿后才上线。
    await screen.getByRole('button', '发布此版本', { exact: true }).first().tap();
    await screen.getByRole('button', '发布', { exact: true }).tap();
    await expect(screen.getByText('当前发布', { exact: true })).toBeVisible();
    await expect(screen.getByText(`初始正文 ${suffix}`, { exact: false })).toBeVisible();

    // 第二稿只追加草稿，线上仍是首稿。
    await screen.getByRole('button', '编辑正文', { exact: true }).tap();
    const secondEditor = screen.getByRole('dialog');
    await secondEditor.getByLabel('Markdown').fill(`# 发布说明 ${suffix}\n\nUI 修订 ${suffix}。`);
    await screen.getByRole('button', '保存草稿', { exact: true }).tap();
    await expect(screen.getByText('Wiki 草稿已保存，发布后才会上线')).toBeVisible();
    await expect(secondEditor).not.toBeVisible();
    await expect(screen.getByText(`初始正文 ${suffix}`, { exact: false })).toBeVisible();
    await expect(screen.getByText(`UI 修订 ${suffix}`, { exact: false })).toHaveCount(0);

    // 显式发布第二稿后才改变线上正文。
    await screen.getByRole('button', '发布此版本', { exact: true }).first().tap();
    await screen.getByRole('button', '发布', { exact: true }).tap();
    await expect(screen.getByText(`UI 修订 ${suffix}`, { exact: false }).first()).toBeVisible();
    await expect(screen.getByText('当前发布', { exact: true })).toBeVisible();
    await expect(screen.getByText('人工编辑', { exact: true }).first()).toBeVisible();
  },
);
