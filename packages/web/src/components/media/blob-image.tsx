import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { LoadingState } from '../states.js';

type DecodeState = 'loading' | 'ready' | 'error';

export function BlobImage({
  blob,
  alt,
  className,
}: {
  blob: Blob;
  alt: string;
  className?: string;
}) {
  const [source, setSource] = useState<{ blob: Blob; url: string } | null>(null);
  const [state, setState] = useState<DecodeState>('loading');

  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setSource({ blob, url });
    setState('loading');
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  const active = source !== null && source.blob === blob ? source : null;
  const loading = active === null || state === 'loading';

  return (
    <div className="flex min-w-0 flex-col gap-2" aria-busy={loading}>
      {active === null ? null : (
        <img
          src={active.url}
          alt={alt}
          className={cn(className, state !== 'ready' && 'hidden')}
          onLoad={() => setState('ready')}
          onError={() => setState('error')}
        />
      )}
      {loading ? <LoadingState rows={3} /> : null}
      {active !== null && state === 'error' ? (
        <p
          role="alert"
          className="rounded-card border border-dashed border-line-strong/70 px-3 py-4 text-sm text-muted-foreground"
        >
          图片无法解码，请下载原件查看。
        </p>
      ) : null}
    </div>
  );
}
