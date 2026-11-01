import { knowledgeSearchHitSchema, knowledgeSearchResultSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type KnowledgeContentKind,
  type KnowledgeDocumentVersion,
  type KnowledgeLocator,
  type KnowledgeSearchDirectAnswer,
  type KnowledgeSearchHit,
  type KnowledgeSearchScores,
} from '../lib/api.js';
import {
  useKnowledgeFaq,
  useKnowledgeMarkdown,
  useKnowledgeVersionDetails,
} from '../lib/queries.js';
import { BlobPdf } from './blob-pdf.js';
import { DialogShell } from './dialog-shell.js';
import { contentKindLabel, locatorLabel, scoreKindLabel } from './knowledge-shared.js';
import { Markdown } from './markdown.js';
import { LoadingState } from './states.js';
import { Button } from './ui/button.js';
import { Dialog } from './ui/dialog.js';

const KNOWLEDGE_TOOL = /^mcp__.+__knowledge_(search|read|list|read_image)$/;

export interface KnowledgeCitation {
  key: string;
  chunkId: string;
  target: { kind: KnowledgeContentKind; id: string };
  targetVersionId: string;
  /** 兼容旧 trace：没有 target 的检索命中按文档处理。 */
  versionId: string;
  title: string;
  heading: string | null;
  quote: string;
  locator: KnowledgeLocator | null;
  pageFrom: number | null;
  pageTo: number | null;
  sourceUrl: string | null;
  image: KnowledgeSearchHit['image'];
  parentContent: string | null;
  scores: KnowledgeSearchScores | undefined;
  scoreKind: 'rrf' | 'rerank' | undefined;
  score: number;
}

interface KnowledgeListItem {
  target: { kind: KnowledgeContentKind; id: string };
  versionId: string;
  title: string;
  folderId: string | null;
  tags: string[];
  updatedAt: string;
}

type ParsedToolResult =
  | {
      kind: 'search';
      citations: KnowledgeCitation[];
      directAnswer: KnowledgeSearchDirectAnswer | null;
    }
  | {
      kind: 'read';
      title: string;
      target: { kind: KnowledgeContentKind; id: string };
      versionId: string;
      citations: KnowledgeCitation[];
      nextOffset: number | null;
      totalCharacters: number | null;
    }
  | { kind: 'list'; items: KnowledgeListItem[]; nextCursor: string | null }
  | { kind: 'read_image'; citations: KnowledgeCitation[] };

export function citationFromHit(hit: KnowledgeSearchHit): KnowledgeCitation {
  const target = hit.target ?? { kind: 'document' as const, id: hit.documentId };
  return {
    key: `${target.kind}:${target.id}:${hit.chunkId}`,
    chunkId: hit.chunkId,
    target,
    targetVersionId: hit.targetVersionId ?? hit.versionId,
    versionId: hit.versionId,
    title: hit.title,
    heading: hit.heading,
    quote: hit.quote,
    locator: hit.locator ?? null,
    pageFrom: hit.pageFrom,
    pageTo: hit.pageTo,
    sourceUrl: hit.sourceUrl,
    image: hit.image ?? null,
    parentContent: hit.parentContent ?? null,
    scores: hit.scores,
    scoreKind: hit.scoreKind,
    score: hit.score,
  };
}

function citationFromListItem(item: KnowledgeListItem): KnowledgeCitation {
  return {
    key: `${item.target.kind}:${item.target.id}`,
    chunkId: item.target.id,
    target: item.target,
    targetVersionId: item.versionId,
    versionId: item.versionId,
    title: item.title,
    heading: null,
    quote: '',
    locator: null,
    pageFrom: null,
    pageTo: null,
    sourceUrl: null,
    image: null,
    parentContent: null,
    scores: undefined,
    scoreKind: undefined,
    score: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function targetField(value: unknown): { kind: KnowledgeContentKind; id: string } | null {
  const record = asRecord(value);
  const kind = record?.kind;
  const id = record?.id;
  if ((kind === 'document' || kind === 'faq' || kind === 'wiki') && typeof id === 'string') {
    return { kind, id };
  }
  return null;
}

/**
 * MCP 结果按工具名解析；服务端四种知识工具都写 JSON 文本。
 * 解析失败返回 null，工具错误文本不会被当成引用。
 */
export function parseKnowledgeToolResult(
  name: string,
  result: string | undefined,
): ParsedToolResult | null {
  if (!KNOWLEDGE_TOOL.test(name) || result === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(result);
  } catch {
    return null;
  }
  const record = asRecord(raw);
  if (!record) return null;
  const tool = name.match(KNOWLEDGE_TOOL)?.[1];
  if (tool === 'search') {
    const parsed = knowledgeSearchResultSchema.safeParse(raw);
    return parsed.success
      ? {
          kind: 'search',
          citations: parsed.data.hits.map(citationFromHit),
          directAnswer: parsed.data.directAnswer,
        }
      : null;
  }
  if (tool === 'read_image') {
    const parsed = knowledgeSearchHitSchema.safeParse(record.hit);
    return parsed.success
      ? {
          kind: 'read_image',
          citations: [citationFromHit(parsed.data)],
        }
      : null;
  }
  if (tool === 'read') {
    const target = targetField(record.target);
    const title = stringField(record.title);
    const versionId = stringField(record.versionId);
    if (!target || !title || !versionId) return null;
    const citations = Array.isArray(record.citations)
      ? record.citations
          .map((value) => {
            const hit = knowledgeSearchHitSchema.safeParse(value);
            return hit.success ? citationFromHit(hit.data) : null;
          })
          .filter((value): value is KnowledgeCitation => value !== null)
      : [];
    return {
      kind: 'read',
      title,
      target,
      versionId,
      citations,
      nextOffset: typeof record.nextOffset === 'number' ? record.nextOffset : null,
      totalCharacters: typeof record.totalCharacters === 'number' ? record.totalCharacters : null,
    };
  }
  const items = Array.isArray(record.items)
    ? record.items
        .map((value) => {
          const item = asRecord(value);
          const target = targetField(item?.target);
          const title = stringField(item?.title);
          const versionId = stringField(item?.versionId);
          if (!target || !title || !versionId) return null;
          return {
            target,
            versionId,
            title,
            folderId: stringField(item?.folderId),
            tags: Array.isArray(item?.tags)
              ? item.tags.filter((tag): tag is string => typeof tag === 'string')
              : [],
            updatedAt: stringField(item?.updatedAt) ?? '',
          } satisfies KnowledgeListItem;
        })
        .filter((value): value is KnowledgeListItem => value !== null)
    : [];
  return {
    kind: 'list',
    items,
    nextCursor: stringField(record.nextCursor),
  };
}

/** 对话读数需要来源数量：四类工具都按可点开的引用计数，列表按条目计数。 */
export function knowledgeHitsFromTool(
  name: string,
  result: string | undefined,
): KnowledgeSearchHit[] | null {
  const parsed = parseKnowledgeToolResult(name, result);
  if (parsed === null) return null;
  if (parsed.kind === 'list') {
    return parsed.items.map((item) => ({
      chunkId: item.target.id,
      documentId: item.target.id,
      versionId: item.versionId,
      title: item.title,
      heading: null,
      quote: '',
      pageFrom: null,
      pageTo: null,
      sourceUrl: null,
      score: 0,
      image: null,
      target: item.target,
      targetVersionId: item.versionId,
      locator: null,
      parentContent: null,
      scores: { keyword: null, vector: null, rrf: 0, rerank: null },
      scoreKind: 'rrf',
      faq: null,
    }));
  }
  return parsed.citations.map((citation) => ({
    chunkId: citation.chunkId,
    documentId: citation.target.id,
    versionId: citation.versionId,
    title: citation.title,
    heading: citation.heading,
    quote: citation.quote,
    pageFrom: citation.pageFrom,
    pageTo: citation.pageTo,
    sourceUrl: citation.sourceUrl,
    score: citation.score,
    image: citation.image,
    target: citation.target,
    targetVersionId: citation.targetVersionId,
    locator: citation.locator,
    parentContent: citation.parentContent,
    scores: citation.scores ?? { keyword: null, vector: null, rrf: 0, rerank: null },
    scoreKind: citation.scoreKind ?? 'rrf',
    faq: null,
  }));
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

export function citationPageLabel(citation: KnowledgeCitation): string | null {
  const locator = locatorLabel(citation.locator);
  if (locator !== null) return locator;
  // 图片命中的页码以图片自身为准；文本命中仍用分块页范围。
  if (citation.image !== null && citation.image.page !== null)
    return `第 ${citation.image.page} 页`;
  if (citation.pageFrom === null) return null;
  const range =
    citation.pageTo !== null && citation.pageTo !== citation.pageFrom
      ? `${citation.pageFrom}–${citation.pageTo}`
      : `${citation.pageFrom}`;
  return `第 ${range} 页`;
}

function CitationList({
  citations,
  onOpen,
}: {
  citations: KnowledgeCitation[];
  onOpen: (citation: KnowledgeCitation) => void;
}) {
  return (
    <ul className="flex flex-col">
      {citations.map((citation) => {
        const page = citationPageLabel(citation);
        return (
          <li key={citation.key}>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto w-full min-w-0 justify-start gap-2 py-1 text-left whitespace-normal"
              onClick={() => onOpen(citation)}
            >
              <span className="min-w-0 flex-1 truncate text-xs text-fg" title={citation.title}>
                {citation.title}
                {citation.heading ? (
                  <span className="text-muted-foreground"> · {citation.heading}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {contentKindLabel[citation.target.kind]}
              </span>
              {page === null ? null : (
                <span className="shrink-0 text-2xs text-muted-foreground">{page}</span>
              )}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** 已保存的工具结果带引用时，在 trace 中给出可点开的来源；普通 Markdown 不做处理。 */
export function KnowledgeCitations({ name, result }: { name: string; result: string | undefined }) {
  const parsed = parseKnowledgeToolResult(name, result);
  const [cited, setCited] = useState<KnowledgeCitation | null>(null);
  if (parsed === null) return null;
  if (parsed.kind === 'list' && parsed.items.length === 0) return null;
  if (parsed.kind !== 'list' && parsed.citations.length === 0 && parsed.kind === 'search') {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="px-1 text-2xs uppercase tracking-[0.06em] text-muted-foreground">
        {parsed.kind === 'list'
          ? `对象 · ${parsed.items.length}`
          : parsed.kind === 'read'
            ? '引用'
            : `来源 · ${parsed.citations.length}`}
      </div>
      {parsed.kind === 'read' ? (
        <p className="px-1 text-xs text-muted-foreground">
          已读取 {parsed.title}
          {parsed.totalCharacters === null ? '' : ` · 共 ${parsed.totalCharacters} 字`}
          {parsed.nextOffset === null ? '' : ` · 可继续读取 ${parsed.nextOffset}`}
        </p>
      ) : null}
      {parsed.kind === 'list' ? (
        <CitationList citations={parsed.items.map(citationFromListItem)} onOpen={setCited} />
      ) : (
        <>
          {parsed.kind === 'search' && parsed.directAnswer ? (
            <div className="px-1 text-xs">
              <span className="font-medium text-fg">
                直接答案
                <span className="ml-2 font-normal text-2xs text-muted-foreground">
                  cosine {parsed.directAnswer.vectorScore.toFixed(3)}
                </span>
              </span>
              <ol className="mt-1 flex list-decimal flex-col gap-1 pl-5 text-fg">
                {parsed.directAnswer.answers.map((answer, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 答案按服务端顺序展示
                  <li key={`direct-${index}`}>{answer}</li>
                ))}
              </ol>
            </div>
          ) : null}
          <CitationList citations={parsed.citations} onOpen={setCited} />
        </>
      )}
      {cited === null ? null : (
        <KnowledgeHitDialog citation={cited} onClose={() => setCited(null)} />
      )}
    </div>
  );
}

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

function CitationMeta({ citation }: { citation: KnowledgeCitation }) {
  const page = citationPageLabel(citation);
  const sourceUrl = safeSourceUrl(citation.sourceUrl);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3 text-xs">
      {page === null ? null : <span className="text-muted-foreground">{page}</span>}
      {citation.target.kind !== 'document' ? (
        <span className="text-muted-foreground">
          {citation.target.kind === 'faq' ? 'FAQ' : 'Wiki'}
        </span>
      ) : null}
      {citation.target.kind === 'document' ? (
        <a
          href={api.knowledgeOriginalUrl(citation.targetVersionId)}
          className="text-[var(--color-link)] underline underline-offset-2"
          download
        >
          下载原件
        </a>
      ) : null}
      {sourceUrl === null ? null : (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[var(--color-link)] underline underline-offset-2"
        >
          查看来源
        </a>
      )}
    </div>
  );
}

/** 图片命中只展示版本原图；文档正文才需要判断 PDF 或 Markdown。 */
function CitationBody({ citation }: { citation: KnowledgeCitation }) {
  if (citation.image !== null) {
    return (
      <KnowledgeImage
        versionId={citation.targetVersionId}
        name={citation.image.name}
        alt={citation.quote || citation.image.name}
        className="max-h-96 w-full rounded-card border border-line object-contain"
      />
    );
  }
  return <DocumentCitationBody citation={citation} />;
}

/** 文档命中：解析正文为首选；PDF 复用 BlobPdf，其余走 Markdown。 */
function DocumentCitationBody({ citation }: { citation: KnowledgeCitation }) {
  const versionId = citation.targetVersionId;
  const markdown = useKnowledgeMarkdown(versionId);
  const details = useKnowledgeVersionDetails(versionId);
  const isPdf = details.data?.mimeType === 'application/pdf';
  const original = useQuery({
    queryKey: ['knowledge', 'original', versionId],
    queryFn: ({ signal }) => api.knowledgeOriginalBlob(versionId, signal),
    enabled: isPdf,
    staleTime: 60_000,
  });

  if (details.isPending) return <LoadingState rows={2} />;
  if (details.isError) {
    return <ErrorText>{failureMessage((details.error as ApiError).status)}</ErrorText>;
  }
  if (isPdf) {
    if (original.isError) return <ErrorText>PDF 没有加载出来，请下载原件。</ErrorText>;
    if (original.isPending) return <LoadingState rows={3} />;
    const page = citation.locator?.pageFrom ?? citation.pageFrom ?? undefined;
    return (
      <BlobPdf
        blob={original.data}
        title={citation.title}
        {...(page === undefined ? {} : { page })}
        className="h-[60vh] w-full rounded-card border border-line"
      />
    );
  }
  if (markdown.isPending) return <LoadingState rows={3} />;
  if (markdown.isError)
    return <ErrorText>{failureMessage((markdown.error as ApiError).status)}</ErrorText>;
  return <Markdown text={stripImageReferences(markdown.data)} />;
}

function ErrorText({ children }: { children: string }) {
  return (
    <p role="alert" className="text-xs text-danger">
      {children}
    </p>
  );
}

/** 版本历史按游标分页：引用按 ID 逐页读到目标版本或读到末尾，不换用当前版本。 */
async function findPagedVersion<T extends { id: string }>(
  load: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  versionId: string,
): Promise<T | null> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await load(cursor);
    const found = page.items.find((item) => item.id === versionId);
    if (found) return found;
    if (page.nextCursor === null || seen.has(page.nextCursor)) return null;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

function FaqCitationBody({ documentId, versionId }: { documentId: string; versionId: string }) {
  const detail = useKnowledgeFaq(documentId);
  // FAQ 详情只带当前发布版与最新草稿；历史引用必须从完整版本历史精确读取。
  const knownVersion =
    detail.data === undefined
      ? undefined
      : [detail.data.publishedVersion, detail.data.draftVersion].find(
          (version) => version?.id === versionId,
        );
  const exact = useQuery({
    queryKey: ['knowledge', 'faq-citation-version', documentId, versionId],
    queryFn: ({ signal }): Promise<KnowledgeDocumentVersion | null> =>
      findPagedVersion(
        (cursor) => api.knowledgeDocumentVersions(documentId, cursor, signal),
        versionId,
      ),
    enabled: detail.data !== undefined && knownVersion === undefined,
    staleTime: 60_000,
  });
  if (detail.isPending) return <LoadingState rows={3} />;
  if (detail.isError) return <ErrorText>FAQ 没有加载出来。</ErrorText>;
  const version = knownVersion ?? exact.data;
  if (version === undefined && exact.isPending) return <LoadingState rows={3} />;
  if (exact.isError) return <ErrorText>FAQ 没有加载出来。</ErrorText>;
  if (!version) return <ErrorText>该版本已不可读。</ErrorText>;
  const faq = version.faq;
  if (!faq) return <ErrorText>FAQ 尚未解析完成。</ErrorText>;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm font-medium text-fg">{faq.question}</p>
      <p className="text-2xs text-muted-foreground">
        {faq.answerStrategy === 'random' ? '检索随机返回一条' : '检索返回全部答案'} · 此处展示完整
        {faq.answers.length} 条{faq.isRecommended ? ' · 推荐' : ''}
      </p>
      {faq.similarQuestions.length > 0 ? (
        <p className="text-xs text-muted-foreground">相似问：{faq.similarQuestions.join(' · ')}</p>
      ) : null}
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm leading-relaxed text-fg">
        {faq.answers.map((answer, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 答案按原顺序渲染，不提供排序
          <li key={`answer-${index}`}>{answer}</li>
        ))}
      </ol>
      {faq.negativeQuestions.length > 0 ? (
        <p className="text-xs text-muted-foreground">反例：{faq.negativeQuestions.join(' · ')}</p>
      ) : null}
    </div>
  );
}

function WikiCitationBody({ pageId, versionId }: { pageId: string; versionId: string }) {
  const exact = useQuery({
    queryKey: ['knowledge', 'wiki-citation-version', pageId, versionId],
    queryFn: () =>
      findPagedVersion((cursor) => api.knowledgeWikiVersions(pageId, cursor), versionId),
    staleTime: 60_000,
  });
  if (exact.isPending) return <LoadingState rows={3} />;
  if (exact.isError) return <ErrorText>Wiki 页面没有加载出来。</ErrorText>;
  if (!exact.data) return <ErrorText>该版本已不可读。</ErrorText>;
  return <Markdown text={exact.data.markdown} />;
}

/** 管理检索、聊天引用与 FAQ 命中测试共用的引用查看器。 */
export function KnowledgeHitDialog({
  citation,
  onClose,
}: {
  citation: KnowledgeCitation;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogShell title="引用原文" className="max-w-[860px] sm:max-w-[860px]">
        <div className="flex min-w-0 flex-col gap-4">
          <p className="text-sm font-medium text-fg">{citation.title}</p>
          <CitationMeta citation={citation} />
          {citation.quote ? (
            <p className="border-l-2 border-line-strong pl-3 text-sm leading-relaxed text-fg">
              <mark className="bg-warning-soft text-fg">{citation.quote}</mark>
            </p>
          ) : null}
          {citation.parentContent ? (
            <details className="rounded-item border border-line px-3 py-2">
              <summary className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
                <ChevronDown className="size-3.5" aria-hidden="true" /> 父块上下文
              </summary>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {citation.parentContent}
              </p>
            </details>
          ) : null}
          {citation.target.kind === 'faq' ? (
            <FaqCitationBody documentId={citation.target.id} versionId={citation.targetVersionId} />
          ) : citation.target.kind === 'wiki' ? (
            <WikiCitationBody pageId={citation.target.id} versionId={citation.targetVersionId} />
          ) : (
            <CitationBody citation={citation} />
          )}
          <ScoreBreakdown
            scores={citation.scores}
            scoreKind={citation.scoreKind}
            score={citation.score}
          />
        </div>
      </DialogShell>
    </Dialog>
  );
}

export function ScoreBreakdown({
  scores,
  scoreKind,
  score,
}: {
  scores: KnowledgeSearchScores | undefined;
  scoreKind: 'rrf' | 'rerank' | undefined;
  score: number;
}) {
  if (!scores) return null;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
      <div className="flex gap-1">
        <dt>{scoreKindLabel(scoreKind)}</dt>
        <dd className="font-mono text-fg">{score.toFixed(4)}</dd>
      </div>
      <div className="flex gap-1">
        <dt>关键词</dt>
        <dd className="font-mono">{scores.keyword === null ? '—' : scores.keyword.toFixed(3)}</dd>
      </div>
      <div className="flex gap-1">
        <dt>向量</dt>
        <dd className="font-mono">{scores.vector === null ? '—' : scores.vector.toFixed(3)}</dd>
      </div>
      <div className="flex gap-1">
        <dt>RRF</dt>
        <dd className="font-mono">{scores.rrf.toFixed(4)}</dd>
      </div>
      <div className="flex gap-1">
        <dt>重排</dt>
        <dd className="font-mono">{scores.rerank === null ? '—' : scores.rerank.toFixed(3)}</dd>
      </div>
    </dl>
  );
}
