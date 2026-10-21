import { Command } from 'lucide-react';

/** 品牌标记：lucide 线框 + 12.5px 字标。登录页与侧栏共用同一份。 */
export function Brand() {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Command aria-hidden="true" className="size-4 shrink-0" />
      <span className="truncate text-[12.5px] font-medium tracking-[0.14em] text-fg">PACE</span>
    </span>
  );
}
