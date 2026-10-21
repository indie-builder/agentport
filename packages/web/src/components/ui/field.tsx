/**
 * 项目自定义层：表单字段的辅助组件。
 *
 * 刻意放在独立文件里而不是塞进底座的 input.tsx / label.tsx：
 * 底座随时可以 `shadcn add --overwrite` 重装，自定义层不会被冲掉。
 */
export function FieldError({ children, id }: { children?: string | undefined; id?: string }) {
  if (!children) return null;
  // 没有显式 id 时无法被 aria-describedby 引用；调用方应传 id。
  return (
    <p id={id} role="alert" className="text-2xs leading-relaxed text-danger">
      {children}
    </p>
  );
}

export function FieldHint({ children, id }: { children?: string | undefined; id?: string }) {
  if (!children) return null;
  return (
    <p id={id} className="text-2xs leading-relaxed text-subtle">
      {children}
    </p>
  );
}

/** 必填标记；读屏念作「必填」，不靠颜色。 */
export function RequiredMark() {
  return (
    <span className="ml-0.5 text-danger" aria-hidden="true">
      *
    </span>
  );
}
