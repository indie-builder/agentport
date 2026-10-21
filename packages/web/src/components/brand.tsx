/**
 * 品牌：项目头像（public/brand.gif）。
 * 侧栏、登录页共用这一份；没有字标，强调靠头像本身。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img src="/brand.gif" alt="" aria-hidden="true" className={className} width={32} height={32} />
  );
}

export function Brand() {
  return <BrandMark className="size-7 shrink-0 rounded-icon object-cover" />;
}
