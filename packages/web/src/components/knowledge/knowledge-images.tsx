import type { KnowledgeImageAsset } from '@agentport/contract/knowledge';
import { useEffect, useRef, useState } from 'react';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { formatRelative } from '../../lib/format.js';
import { useKnowledgeImages } from '../../lib/queries.js';
import { useDebouncedValue } from '../../lib/use-debounced-value.js';
import { DialogShell } from '../dialog-shell.js';
import { PageToolbar } from '../page.js';
import { SearchInput } from '../search-input.js';
import { EmptyState, ErrorState, LoadingState } from '../states.js';
import { Button } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { KnowledgeImage } from './knowledge-citations.js';

export function ImagesTab({
  baseId,
  onOpenDocument,
}: {
  baseId: string;
  onOpenDocument?: (documentId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const settledQuery = useDebouncedValue(query.trim(), 300);
  const images = useKnowledgeImages(baseId, { q: settledQuery });
  const items = Array.from(
    new Map(
      (images.data?.pages.flatMap((page) => page.items) ?? []).map(
        (asset) => [`${asset.versionId}:${asset.name}`, asset] as const,
      ),
    ).values(),
  );
  const [active, setActive] = useState<KnowledgeImageAsset | null>(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageToolbar>
        <SearchInput
          label="搜索图片"
          placeholder="按描述或 OCR 文本搜索图片…"
          value={query}
          onChange={setQuery}
          maxLength={200}
          className="w-72"
        />
        <span role="status" className="ml-auto text-xs text-muted-foreground">
          {images.isPending
            ? '加载中…'
            : images.hasNextPage
              ? `已加载 ${items.length} 张图片`
              : `共 ${items.length} 张图片`}
        </span>
      </PageToolbar>

      {images.isPending ? <LoadingState layout="cards" rows={8} /> : null}
      {images.isError && !images.isFetchNextPageError ? (
        <ErrorState error={images.error} onRetry={() => void images.refetch()} />
      ) : null}
      {images.isSuccess && items.length === 0 ? (
        settledQuery === '' ? (
          <EmptyState
            title="这个知识库还没有可浏览的图片"
            description="上传含图片的文档并开启图片处理后即可看到"
          />
        ) : (
          <EmptyState
            title="没有匹配的图片"
            description={`没有找到与「${settledQuery}」匹配的图片。`}
            action={
              <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                清除搜索
              </Button>
            }
          />
        )
      ) : null}

      {items.length > 0 ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4 pt-2">
          {items.map((asset) => (
            <li key={`${asset.versionId}:${asset.name}`}>
              <div
                data-hover="lift"
                className="cds-card-surface relative flex flex-col overflow-hidden rounded-card bg-card"
              >
                <div className="h-36 overflow-hidden bg-sunken">
                  <LazyKnowledgeImage
                    versionId={asset.versionId}
                    name={asset.name}
                    alt={imageAlt(asset)}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2 px-3 py-2">
                  <span
                    className="min-w-0 flex-1 truncate text-xs font-medium text-fg"
                    title={asset.documentTitle}
                  >
                    {asset.documentTitle}
                  </span>
                  {asset.page === null ? null : (
                    <span className="shrink-0 rounded-tag bg-sunken px-1.5 py-0.5 text-2xs text-muted-foreground">
                      第 {asset.page} 页
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={`查看 ${asset.documentTitle}${imagePageLabel(asset)} 的图片：${asset.name}`}
                  onClick={(event) => {
                    setTrigger(event.currentTarget);
                    setActive(asset);
                  }}
                  className="absolute inset-0 rounded-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
                />
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {images.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={images.isFetchingNextPage}
          aria-busy={images.isFetchingNextPage}
          onClick={() => void images.fetchNextPage()}
        >
          {images.isFetchingNextPage ? '加载中…' : '加载更多图片'}
        </Button>
      ) : null}
      {images.isFetchNextPageError ? (
        <ErrorState
          error={images.error}
          title="更多图片没有加载出来"
          onRetry={() => void images.fetchNextPage()}
        />
      ) : null}

      {active === null ? null : (
        <ImageDialog
          asset={active}
          onClose={() => setActive(null)}
          finalFocus={() => (trigger?.isConnected ? trigger : null)}
          {...(onOpenDocument === undefined ? {} : { onOpenDocument })}
        />
      )}
    </div>
  );
}

function imagePageLabel(asset: KnowledgeImageAsset): string {
  return asset.page === null ? '' : ` 第 ${asset.page} 页`;
}

function imageAlt(asset: KnowledgeImageAsset): string {
  if (asset.caption) return asset.caption;
  return `${asset.documentTitle}${imagePageLabel(asset)} · ${asset.name}`;
}

// shortcut: gallery serves the stored image resized by the browser (no server-side thumbnail); add a thumbnail endpoint if stored images are large.
function LazyKnowledgeImage({
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
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry?.isIntersecting === true),
      { rootMargin: '200px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <span ref={ref} className="block h-full w-full">
      {near ? (
        <KnowledgeImage versionId={versionId} name={name} alt={alt} className={className} />
      ) : null}
    </span>
  );
}

function ImageDialog({
  asset,
  onClose: onClosed,
  onOpenDocument,
  finalFocus,
}: {
  asset: KnowledgeImageAsset;
  onClose: () => void;
  onOpenDocument?: (documentId: string) => void;
  finalFocus: () => HTMLElement | null;
}) {
  const dialog = useDialogClose(onClosed);
  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={(next) => (next ? undefined : dialog.close())}
    >
      <DialogShell
        title={asset.documentTitle}
        className="max-w-215 sm:max-w-215"
        finalFocus={finalFocus}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <KnowledgeImage
            versionId={asset.versionId}
            name={asset.name}
            alt={imageAlt(asset)}
            className="max-h-[60vh] w-full rounded-card border border-line object-contain"
          />
          <div className="flex min-w-0 flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {asset.page === null ? null : <span>第 {asset.page} 页</span>}
            <span>{asset.mimeType}</span>
            <span>{formatRelative(asset.createdAt)}</span>
          </div>
          {asset.caption === null ? null : <p className="text-sm text-fg">{asset.caption}</p>}
          {asset.ocrText === null ? null : (
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs font-medium text-fg">OCR 文本</span>
              <p className="max-h-48 overflow-y-auto break-words whitespace-pre-wrap text-sm text-muted-foreground">
                {asset.ocrText}
              </p>
            </div>
          )}
          {onOpenDocument === undefined ? null : (
            <div className="flex justify-end">
              <Button
                onClick={() =>
                  dialog.finish(() => {
                    onClosed();
                    onOpenDocument(asset.documentId);
                  })
                }
              >
                查看文档
              </Button>
            </div>
          )}
        </div>
      </DialogShell>
    </Dialog>
  );
}
