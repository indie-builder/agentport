import { Input as InputPrimitive } from '@base-ui/react/input';
import type * as React from 'react';
import { cn } from '../../lib/cn.js';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Input };

/**
 * 项目自定义层：底座（Base UI / shadcn）之上补充的字段辅助组件。
 * 这些是本项目表单的约定，不属于底座。
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
