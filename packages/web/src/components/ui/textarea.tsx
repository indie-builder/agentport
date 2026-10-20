import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full resize-y rounded-[9px] border border-line bg-surface px-2.5 py-2 text-sm leading-relaxed text-fg transition-colors placeholder:text-subtle hover:border-line-strong focus-visible:border-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/15 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger',
        className,
      )}
      {...props}
    />
  );
}
