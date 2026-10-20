import type { ComponentProps } from 'react';
import { cn } from '../../lib/cn.js';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-fg transition-colors placeholder:text-subtle hover:border-line-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger',
        className,
      )}
      {...props}
    />
  );
}

export function FieldError({ children, id }: { children?: string | undefined; id?: string }) {
  if (!children) return null;
  // 没有显式 id 时无法被 aria-describedby 引用；调用方应传 id。
  return (
    <p id={id} role="alert" className="text-[11px] leading-relaxed text-danger">
      {children}
    </p>
  );
}

export function FieldHint({ children, id }: { children?: string | undefined; id?: string }) {
  if (!children) return null;
  return (
    <p id={id} className="text-[11px] leading-relaxed text-subtle">
      {children}
    </p>
  );
}
