import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerVisibility,
} from '@shadcn/react/message-scroller';
import { ArrowDownIcon } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useLayoutEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '../../lib/cn.js';

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>,
) {
  return <MessageScrollerPrimitive.Provider {...props} />;
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        'group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerViewport({
  className,
  onScroll,
  ref,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);

  const setViewportRef = useCallback(
    (node: HTMLDivElement | null) => {
      viewportRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const syncFade = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const top = el.scrollTop <= 2 ? '0px' : '28px';
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 2 ? '0px' : '28px';
    if (el.style.getPropertyValue('--fade-top') !== top) el.style.setProperty('--fade-top', top);
    if (el.style.getPropertyValue('--fade-bottom') !== bottom) {
      el.style.setProperty('--fade-bottom', bottom);
    }
  }, []);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      onScroll?.(event);
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        syncFade();
      });
    },
    [onScroll, syncFade],
  );

  useLayoutEffect(() => {
    syncFade();
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [syncFade]);

  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      ref={setViewportRef}
      onScroll={handleScroll}
      className={cn(
        'size-full min-h-0 min-w-0 cds-scroll-fade-y scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content data-autoscrolling:scrollbar-thumb-transparent data-autoscrolling:scrollbar-track-transparent data-pending-scroll:invisible',
        className,
      )}
      {...props}
    />
  );
}

const messageScrollerContentGap = {
  default: 'gap-6',
  sm: 'gap-4',
} as const;

const messageScrollerContentPadding = {
  none: '',
  x: 'px-6',
  xy: 'px-6 py-4',
} as const;

function MessageScrollerContent({
  className,
  gap = 'default',
  padding = 'none',
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content> & {
  gap?: keyof typeof messageScrollerContentGap | undefined;
  padding?: keyof typeof messageScrollerContentPadding | undefined;
}) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn(
        'flex h-max min-h-full flex-col',
        messageScrollerContentGap[gap],
        messageScrollerContentPadding[padding],
        className,
      )}
      {...props}
    />
  );
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn('min-w-0 shrink-0', className)}
      {...props}
    />
  );
}

function MessageScrollerButton({
  direction = 'end',
  className,
  children,
  render,
  variant = 'secondary',
  size = 'icon-sm',
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      data-variant={variant}
      data-size={size}
      direction={direction}
      className={cn(
        'absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground hover:bg-hover hover:text-foreground motion-reduce:transition-none data-[active=false]:pointer-events-none data-[active=false]:opacity-0 data-[direction=end]:bottom-4 data-[direction=start]:top-4 rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180',
        className,
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <ArrowDownIcon />
          <span className="sr-only">{direction === 'end' ? '滚动到底部' : '滚动到顶部'}</span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  );
}

export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerVisibility,
};
