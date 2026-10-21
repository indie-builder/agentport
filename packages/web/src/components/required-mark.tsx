/** 项目自定义层：必填标记；读屏念作「必填」，不靠颜色。 */
export function RequiredMark() {
  return (
    <span className="ml-0.5 text-danger" aria-hidden="true">
      *
    </span>
  );
}
