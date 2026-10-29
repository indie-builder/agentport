import type { PublicOutputShare } from '@agentport/shared';
import { createFileRoute } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BrandMark } from '../components/brand.js';
import { CodeBlock } from '../components/code-block.js';
import { Markdown } from '../components/markdown.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { ApiError, api } from '../lib/api.js';
import { formatBytes, formatDateTime } from '../lib/format.js';
import { toastError } from '../lib/toast.js';

type ShareFile = PublicOutputShare['file'];
type LoadState =
  | { status: 'loading' }
  | { status: 'invalid' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; file: ShareFile };

type PreviewKind = 'markdown' | 'code' | 'image' | 'pdf' | 'none';

function previewKind(mediaType: string): PreviewKind {
  const type = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'text/markdown' || type === 'text/x-markdown') return 'markdown';
  if (type.startsWith('text/') || type === 'application/json' || type === 'image/svg+xml') {
    return 'code';
  }
  if (type === 'image/png' || type === 'image/jpeg' || type === 'image/gif') return 'image';
  if (type === 'image/webp') return 'image';
  if (type === 'application/pdf') return 'pdf';
  return 'none';
}

export function readShareToken(): string | null {
  const token = window.location.hash.slice(1);
  return token === '' ? null : token;
}

export const Route = createFileRoute('/s/$shareId')({
  component: SharePage,
});

function SharePage() {
  const { shareId } = Route.useParams();
  return <ShareView shareId={shareId} token={readShareToken()} />;
}

/** 公开分享页：不经过应用外壳、不读管理会话，只凭 URL 片段里的 token 访问。 */
export function ShareView({ shareId, token }: { shareId: string; token: string | null }) {
  const [state, setState] = useState<LoadState>(
    token === null ? { status: 'invalid' } : { status: 'loading' },
  );
  const [attempt, setAttempt] = useState(0);

  // 先挂上 no-referrer，再发第一次公开请求，避免分享地址出现在请求来源里。
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.append(meta);
    return () => meta.remove();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 只用于手动重试时重跑请求。
  useEffect(() => {
    if (token === null) {
      setState({ status: 'invalid' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    api.publicOutputShare(shareId, token).then(
      (data) => {
        if (!cancelled) setState({ status: 'ready', file: data.file });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState(
          error instanceof ApiError && error.status === 404
            ? { status: 'invalid' }
            : { status: 'error', error },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [shareId, token, attempt]);

  useEffect(() => {
    const name =
      state.status === 'ready'
        ? state.file.name
        : state.status === 'invalid'
          ? '链接无效或已撤销'
          : '共享文件';
    document.title = `${name} · PACE`;
  }, [state]);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <main className="mx-auto flex w-full max-w-[728px] flex-1 flex-col gap-4 px-4 py-6">
        <BrandMark className="size-6" />
        {state.status === 'loading' ? (
          <>
            <h1 className="sr-only">共享文件</h1>
            <LoadingState rows={4} />
          </>
        ) : state.status === 'invalid' ? (
          <>
            <h1 className="text-lg font-medium tracking-[-0.01em] text-fg">链接无效或已撤销</h1>
            <p className="text-sm text-muted-foreground">请向分享者确认链接是否仍然有效。</p>
          </>
        ) : state.status === 'error' ? (
          <>
            <h1 className="text-lg font-medium tracking-[-0.01em] text-fg">分享内容没有加载出来</h1>
            <ErrorState error={state.error} onRetry={() => setAttempt((value) => value + 1)} />
          </>
        ) : token === null ? null : (
          <SharedFile shareId={shareId} token={token} file={state.file} />
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
  const kind = previewKind(file.mediaType);
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
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      // 立即撤销会让部分浏览器取消下载，留到本轮事件后再释放。
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      toastError(error);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-card bg-surface ring-1 ring-line">
      <header className="flex flex-col gap-3 border-b px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 break-words text-lg font-medium tracking-[-0.01em] text-fg">
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

type PreviewState =
  | { status: 'loading' }
  | { status: 'text'; content: string }
  | { status: 'blob'; url: string }
  | { status: 'error'; error: unknown };

function SharePreview({
  shareId,
  token,
  file,
  kind,
}: {
  shareId: string;
  token: string;
  file: ShareFile;
  kind: Exclude<PreviewKind, 'none'>;
}) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 只用于手动重试时重跑请求。
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: 'loading' });
    const request =
      kind === 'image' || kind === 'pdf'
        ? api.publicOutputShareDownload(shareId, token).then((blob) => {
            objectUrl = URL.createObjectURL(blob);
            return { status: 'blob' as const, url: objectUrl };
          })
        : api.publicOutputShareContent(shareId, token).then((data) => ({
            status: 'text' as const,
            content: data.content,
          }));
    request.then(
      (next) => {
        if (!cancelled) setState(next);
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', error });
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [shareId, token, kind, attempt]);

  if (state.status === 'loading') return <LoadingState rows={5} />;
  if (state.status === 'error') {
    return (
      <ErrorState
        error={state.error}
        title="预览没有加载出来"
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }

  if (kind === 'image') {
    return state.status === 'blob' ? (
      <img
        src={state.url}
        alt={file.name}
        className="mx-auto max-h-[70vh] max-w-full rounded-item object-contain"
      />
    ) : null;
  }

  if (kind === 'pdf') {
    return state.status === 'blob' ? (
      <iframe title={file.name} src={state.url} className="h-[70vh] w-full rounded-item border" />
    ) : null;
  }

  if (state.status !== 'text') return null;
  return kind === 'markdown' ? (
    <Markdown text={state.content} staticContent />
  ) : (
    <CodeBlock
      code={state.content}
      copyable={false}
      maxHeight="60vh"
      json={file.mediaType === 'application/json' || /\.json$/i.test(file.name)}
    />
  );
}
