import { type KnowledgeSearchHit, knowledgeSearchResultSchema } from '@agentport/shared';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api.js';
import { DialogShell } from './dialog-shell.js';
import { Markdown } from './markdown.js';
import { LoadingState } from './states.js';
import { Button } from './ui/button.js';
import { Dialog } from './ui/dialog.js';

/** 知识库检索工具的结果 wire：服务端写 JSON 文本，这里按共享 schema 解析。 */
const SEARCH_TOOL = /^mcp__.+__knowledge_search$/;

export function knowledgeHitsFromTool(
  name: string,
  result: string | undefined,
): KnowledgeSearchHit[] | null {
  if (!SEARCH_TOOL.test(name) || result === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(result);
  } catch {
    // 工具错误是纯文本，正常结果才是 JSON；解析不了的都不当成引用。
    return null;
  }
  const parsed = knowledgeSearchResultSchema.safeParse(raw);
  return parsed.success ? parsed.data.hits : null;
}

/** 外部来源只允许 http/https：javascript: 等协议在这里直接丢弃，不做成可点击链接。 */
function safeSourceUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function pageLabel(hit: KnowledgeSearchHit): string | null {
  // 图片命中的页码以图片自身为准；文本命中仍用分块页范围。
  if (hit.image !== null && hit.image.page !== null) return `第 ${hit.image.page} 页`;
  if (hit.pageFrom === null) return null;
  const range =
    hit.pageTo !== null && hit.pageTo !== hit.pageFrom
      ? `${hit.pageFrom}–${hit.pageTo}`
      : `${hit.pageFrom}`;
  return `第 ${range} 页`;
}

/** 已保存的工具结果里带引用时，在 trace 中给出可点开的来源；普通 Markdown 不做处理。 */
export function KnowledgeCitations({ name, result }: { name: string; result: string | undefined }) {
  const hits = knowledgeHitsFromTool(name, result);
  const [cited, setCited] = useState<KnowledgeSearchHit | null>(null);
  if (hits === null || hits.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="px-1 text-2xs uppercase tracking-[0.06em] text-muted-foreground">
        来源 · {hits.length}
      </div>
      <ul className="flex flex-col">
        {hits.map((hit) => {
          const page = pageLabel(hit);
          return (
            <li key={hit.chunkId}>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto w-full min-w-0 justify-start gap-2 py-1 text-left whitespace-normal"
                onClick={() => setCited(hit)}
              >
                <span className="min-w-0 flex-1 truncate text-xs text-fg" title={hit.title}>
                  {hit.title}
                  {hit.heading ? (
                    <span className="text-muted-foreground"> · {hit.heading}</span>
                  ) : null}
                </span>
                {page === null ? null : (
                  <span className="shrink-0 text-2xs text-muted-foreground">{page}</span>
                )}
              </Button>
            </li>
          );
        })}
      </ul>
      {cited === null ? null : <CitationDialog hit={cited} onClose={() => setCited(null)} />}
    </div>
  );
}

type Viewer =
  | { status: 'loading' }
  | { status: 'ready'; markdown: string }
  | { status: 'error'; message: string };

function failureMessage(status: number): string {
  if (status === 401) return '登录已失效，请重新登录后再试。';
  if (status === 403) return '无权访问这个来源，或知识库已停用。';
  if (status === 404) return '来源已删除或尚未解析，无法查看原文。';
  return `原文没有加载出来（HTTP ${status}）。`;
}

function imageFailureMessage(status: number): string {
  if (status === 401) return '登录已失效，请重新登录后再试。';
  if (status === 403) return '无权读取这张图片，或知识库已停用。';
  if (status === 404) return '图片已删除或不存在，请重新解析该版本。';
  return `图片没有加载出来（HTTP ${status}）。`;
}

/** 图片走鉴权端点：状态码是唯一能区分失权与缺图的信号，img 的 onError 拿不到。 */
async function fetchVersionImage(
  versionId: string,
  name: string,
  signal: AbortSignal,
): Promise<Blob> {
  const res = await fetch(api.knowledgeVersionImageUrl(versionId, name), {
    credentials: 'include',
    signal,
  });
  if (res.ok) return res.blob();
  const data = (await res.json().catch(() => null)) as { message?: string } | null;
  throw new ApiError(res.status, data?.message ?? `HTTP ${res.status}`);
}

type LoadedImage =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string };

/**
 * 版本原图：先带鉴权取 Blob，再以对象 URL 展示；卸载或换图时释放对象 URL。
 * 401/403/404 各自给出合同要求的说明，不做无限重试。
 */
export function KnowledgeImage({
  versionId,
  name,
  alt,
  className,
}: {
  versionId: string;
  name: string;
  alt: string;
  className: string;
}) {
  const [image, setImage] = useState<LoadedImage>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setImage({ status: 'loading' });
    fetchVersionImage(versionId, name, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ status: 'ready', url: objectUrl });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setImage({
          status: 'error',
          message:
            error instanceof ApiError
              ? imageFailureMessage(error.status)
              : '连不上服务，请稍后重试。',
        });
      },
    );
    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [versionId, name]);

  if (image.status === 'ready') {
    return (
      <img
        src={image.url}
        alt={alt}
        loading="lazy"
        className={className}
        onError={() => setImage({ status: 'error', message: '图片已下载但无法显示，请下载原件。' })}
      />
    );
  }
  if (image.status === 'error') {
    return (
      <p role="alert" className="text-xs text-danger">
        {image.message}
      </p>
    );
  }
  return null;
}

/**
 * 解析正文里的图片引用指向版本图片端点，Markdown 组件不会带鉴权取图，只会渲染占位。
 * 这些图已经在上方按原图独立展示，正文里去掉重复引用（只动知识库生成的 images/ 路径）。
 */
export function stripImageReferences(markdown: string): string {
  return markdown.replace(/!\[[^\]]*\]\(images\/[^)\s]*\)\s*/g, '');
}

/** 引用查看器：读平台解析正文，不执行来源页脚本。
 * 来源被删/失权由接口状态码给出明确说明，而不是空白或静默失败。
 * 图片命中显示原图；失败只报一次，并保留“查看原文/下载原件”的恢复入口。
 */
function CitationDialog({ hit, onClose }: { hit: KnowledgeSearchHit; onClose: () => void }) {
  const [viewer, setViewer] = useState<Viewer>({ status: 'loading' });
  const sourceUrl = safeSourceUrl(hit.sourceUrl);

  useEffect(() => {
    const controller = new AbortController();
    setViewer({ status: 'loading' });
    api.knowledgeMarkdown(hit.versionId, controller.signal).then(
      (markdown) => setViewer({ status: 'ready', markdown }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setViewer({
          status: 'error',
          message:
            error instanceof ApiError ? failureMessage(error.status) : '连不上服务，请稍后重试。',
        });
      },
    );
    return () => controller.abort();
  }, [hit.versionId]);

  const page = pageLabel(hit);

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell title={hit.title} className="max-w-[860px] sm:max-w-[860px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-3 text-xs">
            {page === null ? null : <span className="text-muted-foreground">{page}</span>}
            <a
              href={api.knowledgeOriginalUrl(hit.versionId)}
              className="underline underline-offset-2"
              download
            >
              下载原件
            </a>
            {sourceUrl === null ? null : (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2"
              >
                查看来源
              </a>
            )}
          </div>
          {hit.image !== null ? (
            <KnowledgeImage
              versionId={hit.versionId}
              name={hit.image.name}
              alt={hit.quote || hit.image.name}
              className="max-h-96 w-full rounded-card border border-line object-contain"
            />
          ) : null}
          {hit.quote ? (
            <p className="border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-fg">
              <mark className="bg-warning-soft text-fg">{hit.quote}</mark>
            </p>
          ) : null}
          {viewer.status === 'loading' ? <LoadingState rows={3} /> : null}
          {viewer.status === 'error' ? (
            <p role="alert" className="text-xs text-danger">
              {viewer.message}
            </p>
          ) : null}
          {viewer.status === 'ready' ? (
            <Markdown text={stripImageReferences(viewer.markdown)} />
          ) : null}
        </div>
      </DialogShell>
    </Dialog>
  );
}
