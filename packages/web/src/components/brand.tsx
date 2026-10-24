import { cn } from '../lib/cn.js';

/** 品牌：原创小狗标记 + `PACE` 字标（见 DESIGN-SYSTEM §5）。 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/pace-puppy.webp"
      alt=""
      aria-hidden="true"
      width={32}
      height={32}
      className={cn('size-8 shrink-0 object-contain', className)}
    />
  );
}

export function Brand() {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <BrandMark className="shrink-0" />
      <span className="truncate text-[12.5px] font-medium tracking-[0.14em] text-fg">PACE</span>
    </span>
  );
}
