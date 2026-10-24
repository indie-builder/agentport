import { cn } from '../lib/cn.js';

/** 木工小狗品牌标记；与对话欢迎区共用形象。 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/pace-mark.svg"
      alt=""
      aria-hidden="true"
      width={32}
      height={32}
      className={cn('size-8 shrink-0 object-contain', className)}
    />
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <img
      src="/brand/pace-wordmark.webp"
      alt="PACE"
      width={768}
      height={568}
      className={cn('h-12 w-auto max-w-full shrink-0 self-start object-contain', className)}
    />
  );
}
