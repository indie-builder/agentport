import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: 通用 label，控件关联由调用方的 htmlFor 提供
    <label className={cn('text-xs font-medium text-zinc-400', className)} {...props} />
  );
}
