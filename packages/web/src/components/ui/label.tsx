import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: 通用 label，控件关联由调用方的 htmlFor 提供
    <label className={cn('text-sm font-medium text-fg', className)} {...props} />
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
