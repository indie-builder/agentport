/**
 * 品牌：项目头像（public/brand.gif）+ PACE 字标。
 * 侧栏、登录页共用这一份；只显示头像时用 BrandMark。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img src="/brand.gif" alt="" aria-hidden="true" className={className} width={32} height={32} />
  );
}

export function Brand() {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <BrandMark className="size-7 shrink-0 rounded-icon object-cover" />
      <span className="truncate text-[12.5px] font-medium tracking-[0.14em] text-fg">PACE</span>
    </span>
  );
}
