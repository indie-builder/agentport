import { useEffect, useState } from 'react';
import { cn } from '../lib/cn.js';
import { LoadingState } from './states.js';

type DecodeState = 'loading' | 'ready' | 'error';

/**
 * Blob 图片只在浏览器真正 decode 成功后显示，避免把损坏字节当成可看图。
 * 对象 URL 与当前 blob 绑定并在卸载/换图时释放；它只是展示用的临时地址，不承担缓存。
 */
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

  // 换 blob 到 effect 执行之间 source 仍是上一张图：只认同一个 blob，绝不先显示旧图。
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
          className="rounded-card border border-dashed border-line-strong/70 px-3 py-4 text-xs leading-relaxed text-muted-foreground"
        >
          图片无法解码，请下载原件查看。
        </p>
      ) : null}
    </div>
  );
}
