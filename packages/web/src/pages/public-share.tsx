import type { PublicOutputShare } from '@agentport/shared';
import { useParams } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BrandMark } from '../components/brand.js';
import { BusinessIllustration } from '../components/business-illustration.js';
import { CodeBlock } from '../components/code-block.js';
import { Markdown } from '../components/markdown.js';
import { BlobImage } from '../components/media/blob-image.js';
import { BlobPdf } from '../components/media/blob-pdf.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { ApiError, api } from '../lib/api.js';
import { downloadBlob } from '../lib/browser-files.js';
import { formatBytes, formatDateTime } from '../lib/format.js';
import { type SharePreviewKind, sharePreviewKind } from '../lib/output-preview.js';
import { usePublicOutputShare, usePublicOutputSharePreview } from '../lib/queries/chat.js';
import { toastError } from '../lib/toast.js';

type ShareFile = PublicOutputShare['file'];

function shareError(error: unknown): Error {
  let message = '请稍后重试，若仍失败请联系分享者确认链接是否可用。';
  if (error instanceof ApiError && error.status >= 500) {
    message = '服务暂时无法提供分享内容，请稍后重试；若仍失败请联系分享者。';
  } else if (error instanceof ApiError && error.status === 0) {
    message = '网络连接失败，请检查网络后重试；若仍失败请联系分享者。';
  } else if (error instanceof SyntaxError) {
    message = '分享内容格式异常，请稍后重试；若仍失败请联系分享者。';
  }
  return new Error(message, { cause: error });
}

export function readShareToken(): string | null {
  const token = window.location.hash.slice(1);
  return token === '' ? null : token;
}

export function PublicSharePage() {
  const { shareId } = useParams({ from: '/s/$shareId' });
  return <ShareView shareId={shareId} token={readShareToken()} />;
}

export function ShareView({ shareId, token }: { shareId: string; token: string | null }) {
  const share = usePublicOutputShare(shareId, token);
  const isLoading =
    !share.isInvalid && (share.isPending || (share.isFetching && share.data === undefined));
  const titleName = share.isInvalid
    ? '链接无效或已撤销'
    : !isLoading && share.data !== undefined
      ? share.data.file.name
      : '共享文件';

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.append(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    document.title = `${titleName} · PACE`;
  }, [titleName]);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <main className="mx-auto flex w-full max-w-182 flex-1 flex-col gap-4 px-6 py-6">
        <BrandMark className="size-6" />
        {isLoading ? (
          <>
            <h1 className="sr-only">共享文件</h1>
            <LoadingState rows={4} />
          </>
        ) : share.isInvalid ? (
          <>
            <h1 className="sr-only">链接无效或已撤销</h1>
            <EmptyState
              variant="permission"
              scale="page"
              illustration={<BusinessIllustration name="not-found" size="error" />}
              title="链接无效或已撤销"
              description="该分享可能已被关闭，请联系分享者获取新链接。"
            />
          </>
        ) : share.isError || share.data === undefined ? (
          <>
            <h1 className="sr-only">共享文件</h1>
            <ErrorState
              title="分享内容没有加载出来"
              error={shareError(share.error)}
              onRetry={() => void share.refetch()}
            />
          </>
        ) : token === null ? null : (
          <SharedFile shareId={shareId} token={token} file={share.data.file} />
        )}
        <p className="mt-auto pt-4 text-xs text-muted-foreground">由 PACE 分享</p>
      </main>
    </div>
  );
}

/**
 * 访问 token 就存在地址片段里，页内锚点的默认跳转会把片段换成目标 id，刷新即丢失 token。
 * 监听正文容器的 click，原生链接的鼠标点击与键盘 Enter 都会走到这里；
 * 只接管 a[href^="#"]，外链与下载不受影响；目标不存在时同样不改 URL。
 */
function keepTokenOnAnchorClick(event: MouseEvent): void {
  const anchor = (event.target as Element | null)?.closest('a[href^="#"]');
  if (!(anchor instanceof HTMLAnchorElement)) return;
  event.preventDefault();
  const fragment = anchor.getAttribute('href')?.slice(1) ?? '';
  if (fragment === '') return;
  let id: string;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    return;
  }
  document.getElementById(id)?.scrollIntoView({ block: 'start' });
}

function SharedFile({ shareId, token, file }: { shareId: string; token: string; file: ShareFile }) {
  const kind = sharePreviewKind(file.mediaType);
  const [downloading, setDownloading] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = previewRef.current;
    if (node === null) return;
    node.addEventListener('click', keepTokenOnAnchorClick);
    return () => node.removeEventListener('click', keepTokenOnAnchorClick);
  }, []);

  const download = async (): Promise<void> => {
    setDownloading(true);
    try {
      const blob = await api.publicOutputShareDownload(shareId, token);
      downloadBlob(blob, file.name);
    } catch (error) {
      toastError(shareError(error));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section className="cds-card-surface overflow-hidden rounded-card bg-surface">
      <header className="flex flex-col gap-3 border-b px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 break-words text-lg font-medium tracking-heading text-fg">
            {file.name}
          </h1>
          <Button
            variant="default"
            onClick={() => void download()}
            disabled={downloading}
            aria-busy={downloading}
          >
            <Download data-icon="inline-start" />
            {downloading ? '正在下载…' : '下载'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{formatBytes(file.size)}</span>
          <span>{formatDateTime(file.createdAt)}</span>
        </div>
      </header>
      {kind === 'none' ? null : (
        <div ref={previewRef} className="px-6 py-5">
          <SharePreview shareId={shareId} token={token} file={file} kind={kind} />
        </div>
      )}
    </section>
  );
}

function SharePreview({
  shareId,
  token,
  file,
  kind,
}: {
  shareId: string;
  token: string;
  file: ShareFile;
  kind: Exclude<SharePreviewKind, 'none'>;
}) {
  const preview = usePublicOutputSharePreview(shareId, token, kind);

  if (preview.isPending || (preview.isFetching && preview.data === undefined)) {
    return <LoadingState rows={5} />;
  }
  if (preview.isError) {
    return (
      <ErrorState
        error={shareError(preview.error)}
        title="预览没有加载出来"
        onRetry={() => void preview.refetch()}
      />
    );
  }

  if (kind === 'image') {
    return preview.data?.kind === 'blob' ? (
      <BlobImage
        blob={preview.data.blob}
        alt={file.name}
        className="mx-auto max-h-[70vh] max-w-full rounded-item object-contain"
      />
    ) : null;
  }

  if (kind === 'pdf') {
    return preview.data?.kind === 'blob' ? (
      <BlobPdf
        blob={preview.data.blob}
        title={file.name}
        className="h-[70vh] w-full rounded-item border"
      />
    ) : null;
  }

  if (preview.data?.kind !== 'text') return null;
  return kind === 'markdown' ? (
    <Markdown text={preview.data.content} staticContent />
  ) : (
    <CodeBlock
      code={preview.data.content}
      copyable={false}
      maxHeight="60vh"
      json={file.mediaType === 'application/json' || /\.json$/i.test(file.name)}
    />
  );
}
