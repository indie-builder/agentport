import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

/**
 * 多模态验收：只读现有多模态联调实例里由 worker 处理完成的种子，不伪造索引、不调用模型。
 * 重点证明图片命中在引用弹窗里以鉴权 Blob URL 真实解码（naturalWidth > 0），而不是仅有 img 元素。
 */
const skipUnlessMultimodalRuntime =
  process.env.E2E_KNOWLEDGE_MULTIMODAL === '1'
    ? false
    : '需要多模态联调实例：E2E_APP_URL 指向 3306 且设置 E2E_KNOWLEDGE_MULTIMODAL=1';

const SEEDED_BASE_NAME = process.env.E2E_KNOWLEDGE_MULTIMODAL_BASE ?? '多模态验收';
const SEARCH_TERM = '季度收入';

test('multimodal hit renders the authenticated blob image and its quote', {
  session: 'admin',
  skip: skipUnlessMultimodalRuntime,
}, async ({ app, screen, browser }) => {
  await app.open('/knowledge');
  await screen.getByRole('link', `查看知识库 ${SEEDED_BASE_NAME}`, { exact: true }).tap();
  await expect(screen.getByRole('heading', { level: 1, name: SEEDED_BASE_NAME })).toBeVisible();
  await expect(screen.getByRole('heading', { level: 1 })).toHaveCount(1);

  await screen.getByRole('tab', '检索测试', { exact: true }).tap();
  await screen.getByRole('searchbox', '检索知识库').fill(SEARCH_TERM);
  await screen.getByRole('button', '检索', { exact: true }).tap();
  // 同一张图会有 OCR 与描述两条命中，取第一条带引用的即可。
  await browser
    .locator('li')
    .filter({ hasText: SEARCH_TERM })
    .first()
    .getByRole('button', '查看原文')
    .tap();

  const dialog = screen.getByRole('dialog');
  await expect(dialog).toContainText('引用原文');
  await expect(dialog.getByRole('link', '下载原件')).toBeVisible();
  await expect(browser.locator('[role="dialog"] mark')).toContainText(SEARCH_TERM);

  const image = browser.locator('[role="dialog"] img').first();
  await expect(image).toBeVisible();
  // 可见不等于已解码：按官方 evaluate 在页面里真实读 naturalWidth 与 Blob URL。
  await expect
    .poll(
      () =>
        browser.evaluate(() => {
          const img = document.querySelector<HTMLImageElement>('[role="dialog"] img');
          return img === null
            ? null
            : { src: img.src, loaded: img.complete && img.naturalWidth > 0 };
        }),
      { timeout: 15_000, message: '引用弹窗中的原图应完成解码' },
    )
    .toMatchObject({ src: expect.stringMatching(/^blob:/), loaded: true });

  // 解析正文里的图片占位若被漏渲染，Streamdown 会显示 "Image blocked"；成功时必须没有它。
  await expect(dialog).not.toContainText('Image blocked');
  await expect(dialog).not.toContainText('图片没有加载出来');
  await expect(dialog).not.toContainText('图片已下载但无法显示');
});
