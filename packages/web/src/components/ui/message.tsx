import type * as React from 'react';
import { cn } from '@/lib/cn';

function MessageGroup({
  className,
  gap = 'default',
  ...props
}: React.ComponentProps<'div'> & { gap?: 'default' | 'lg' }) {
  return (
    <div
      data-slot="message-group"
      className={cn('flex min-w-0 flex-col', gap === 'lg' ? 'gap-4' : 'gap-2', className)}
      {...props}
    />
  );
}

function Message({
  className,
  align = 'start',
  size = 'default',
  ...props
}: React.ComponentProps<'div'> & { align?: 'start' | 'end'; size?: 'default' | 'base' }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      data-size={size}
      className={cn(
        'group/message relative flex w-full min-w-0 gap-2 data-[align=end]:flex-row-reverse',
        size === 'base' ? 'text-base' : 'text-sm',
        className,
      )}
      {...props}
    />
  );
}

function MessageContent({
  className,
  gap = 'default',
  ...props
}: React.ComponentProps<'div'> & { gap?: 'default' | 'lg' }) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        'flex w-full min-w-0 flex-col wrap-break-word group-data-[align=end]/message:*:data-slot:self-end',
        gap === 'lg' ? 'gap-4' : 'gap-2.5',
        className,
      )}
      {...props}
    />
  );
}

export { Message, MessageContent, MessageGroup };
