import { useEffect, useState } from 'react';
import { cn } from '../lib/cn.js';
import { LoadingState } from './states.js';

const UNSUPPORTED = '当前浏览器不支持 PDF 预览，请下载原件查看。';
const INVALID = '文件不是可预览的 PDF，请下载原件查看。';
const READ_ERROR = 'PDF 读取失败，请下载原件查看。';
const PDF_HEADER = '%PDF-';

type PdfState =
  | { blob: Blob; status: 'checking' }
  | { blob: Blob; status: 'invalid' }
  | { blob: Blob; status: 'readerror' }
  | { blob: Blob; status: 'ready'; url: string };

function pdfViewerEnabled(): boolean {
  return (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled === true;
}

function PdfNotice({ children }: { children: string }) {
  return (
    <p
      role="alert"
      className="rounded-card border border-dashed border-line-strong/70 px-3 py-4 text-xs leading-relaxed text-muted-foreground"
    >
      {children}
    </p>
  );
}

/**
 * 原生查看器预览：只做浏览器支持与 `%PDF-` header 门槛，不声称结构完整验证；
 * iframe 的 load/error 也不代表能解码，损坏或加密文件仍由外置下载兜底。
 */
export function BlobPdf({
  blob,
  title,
  className,
}: {
  blob: Blob;
  title: string;
  className?: string;
}) {
  const supported = pdfViewerEnabled();
  const [state, setState] = useState<PdfState | null>(null);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    let url: string | null = null;
    setState({ blob, status: 'checking' });
    blob
      .slice(0, PDF_HEADER.length)
      .arrayBuffer()
      .then(
        (header) => {
          if (cancelled) return;
          if (new TextDecoder().decode(header) !== PDF_HEADER) {
            setState({ blob, status: 'invalid' });
            return;
          }
          url = URL.createObjectURL(blob.slice(0, blob.size, 'application/pdf'));
          setState({ blob, status: 'ready', url });
        },
        () => {
          if (!cancelled) setState({ blob, status: 'readerror' });
        },
      );
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [blob, supported]);

  // 换 blob 后旧 state 立即失效；迟到的 header 结果也必须属于当前 blob 才能使用。
  const current = state !== null && state.blob === blob ? state : null;

  if (!supported) return <PdfNotice>{UNSUPPORTED}</PdfNotice>;
  if (current?.status === 'invalid') return <PdfNotice>{INVALID}</PdfNotice>;
  if (current?.status === 'readerror') return <PdfNotice>{READ_ERROR}</PdfNotice>;
  if (current?.status !== 'ready') {
    return (
      <div className="flex min-w-0 flex-col gap-2" aria-busy="true">
        <LoadingState rows={3} />
      </div>
    );
  }
  return <iframe title={title} src={current.url} className={cn(className)} />;
}
