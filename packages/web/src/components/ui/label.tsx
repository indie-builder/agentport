import type * as React from 'react';
import { cn } from '../../lib/cn.js';

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: 通用 label，控件关联由调用方的 htmlFor 提供
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };

/** 必填标记；读屏念作「必填」，不靠颜色。 */
export function RequiredMark() {
  return (
    <span className="ml-0.5 text-danger" aria-hidden="true">
      *
    </span>
  );
}
