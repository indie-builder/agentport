import { Command } from 'lucide-react';

/** 品牌：lucide 线框标记 + `PACE` 字标（12.5px / 0.14em，见 DESIGN-SYSTEM §5）。 */
export function BrandMark({ className }: { className?: string }) {
  return <Command aria-hidden="true" className={className} />;
}

export function Brand() {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <BrandMark className="shrink-0" />
      <span className="truncate text-[12.5px] font-medium tracking-[0.14em] text-fg">PACE</span>
    </span>
  );
}
