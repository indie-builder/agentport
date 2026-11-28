import { ACTION_STEPS, BuiltinActionType } from '@openuidev/react-lang';
import { Button as ButtonPrimitive } from '@ui-sdk/react/button';
import { Children, type CSSProperties, createContext, isValidElement, type ReactNode } from 'react';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  CarouselViewport,
} from '../../components/ui/carousel.js';
import { cn } from '../../lib/cn.js';

export type CardSource = {
  url?: string | undefined;
  title: string;
  sourceName: string;
};

export const CardSourceContext = createContext<readonly CardSource[]>([]);

export interface RenderProps<P> {
  props: P;
  renderNode: (value: unknown) => ReactNode;
  statementId?: string;
}

export function childProps<T = Record<string, unknown>>(node: unknown): T | undefined {
  if (typeof node !== 'object' || node === null) return undefined;
  const candidate = node as { type?: unknown; props?: unknown };
  if (candidate.type !== 'element') return undefined;
  return (candidate.props ?? {}) as T;
}

export function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function isActionPlan(action: unknown): action is { steps: Array<Record<string, unknown>> } {
  return (
    typeof action === 'object' &&
    action !== null &&
    Array.isArray((action as { steps?: unknown }).steps)
  );
}

/**
 * 与官方 cardActionUtils 相同的语义：把点中的卡片信息附加到动作上下文。
 * react-lang 只把 ToAssistant 步骤的 context 透传给宿主，所以只改这一类步骤。
 */
export function withItemContext(action: unknown, context: Record<string, unknown>): unknown {
  const filled = Object.fromEntries(Object.entries(context).filter(([, v]) => v !== undefined));
  if (action == null) {
    return { type: BuiltinActionType.ContinueConversation, params: filled };
  }
  if (isActionPlan(action)) {
    if (Object.keys(filled).length === 0) return action;
    const suffix = `Selected item: ${JSON.stringify(filled)}`;
    return {
      ...action,
      steps: action.steps.map((step) => {
        if (step.type !== ACTION_STEPS.ToAssistant) return step;
        if (step.context == null) return { ...step, context: suffix };
        const existing =
          typeof step.context === 'string' ? step.context : JSON.stringify(step.context);
        return { ...step, context: `${existing}\n${suffix}` };
      }),
    };
  }
  const legacy = action as { type?: string; params?: Record<string, unknown>; url?: string };
  return {
    type: legacy.type ?? BuiltinActionType.ContinueConversation,
    params: {
      ...(legacy.params ?? {}),
      ...(legacy.url !== undefined ? { url: legacy.url } : {}),
      ...filled,
    },
  };
}

const TEXT_SIZES = {
  xs: 'text-xs',
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
} as const;

export type TextSize = keyof typeof TEXT_SIZES;

export function ValueText({
  value,
  subtext,
  numeric,
  size = 'md',
  bold = false,
  subtextTone,
  className,
}: {
  value: string;
  subtext?: string | undefined;
  numeric?: boolean;
  size?: TextSize;
  bold?: boolean;
  subtextTone?: 'neutral' | 'positive' | 'negative';
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <span
        className={cn(
          TEXT_SIZES[size],
          bold ? 'font-semibold text-fg' : 'font-normal text-fg',
          numeric && 'font-mono tabular-nums',
          'break-words',
        )}
      >
        {value}
      </span>
      {subtext ? (
        <span
          className={cn(
            'text-sm',
            subtextTone === 'positive' && 'text-success',
            subtextTone === 'negative' && 'text-danger',
            subtextTone === undefined && 'text-muted-foreground',
            numeric && 'font-mono tabular-nums',
          )}
        >
          {subtext}
        </span>
      ) : null}
    </div>
  );
}

export function metricTone(subtext: string | undefined): 'neutral' | 'positive' | 'negative' {
  if (!subtext) return 'neutral';
  if (subtext.startsWith('+')) return 'positive';
  if (subtext.startsWith('-')) return 'negative';
  return 'neutral';
}

export function CardBlockGrid({
  layout,
  responsive,
  gap,
  count,
  size = 'small',
  children,
}: {
  layout: 'grid' | 'carousel';
  responsive: boolean;
  gap?: number | string | undefined;
  count: number;
  size?: 'small' | 'medium' | 'overview';
  children: ReactNode;
}) {
  const gapStyle =
    gap === undefined ? undefined : { gap: typeof gap === 'number' ? `${gap}px` : gap };
  if (layout === 'carousel') {
    const gapValue =
      gap === undefined ? 'calc(var(--spacing) * 3)' : typeof gap === 'number' ? `${gap}px` : gap;
    const trackStyle = { '--openui-card-gap': gapValue, gap: gapValue } as CSSProperties;
    const itemClass = cn(
      'pl-0',
      size === 'overview'
        ? 'basis-60 @max-[30rem]:basis-50'
        : responsive
          ? 'basis-4/5 @min-[481px]:basis-[calc((100%_-_var(--openui-card-gap))/2)]'
          : size === 'medium'
            ? 'basis-80'
            : 'basis-70',
    );
    const seenSlides = new Map<string, number>();
    const slideItems = Children.toArray(children).map((child) => {
      const rawKey = isValidElement(child) && child.key != null ? String(child.key) : String(child);
      const count = (seenSlides.get(rawKey) ?? 0) + 1;
      seenSlides.set(rawKey, count);
      return { child, key: count === 1 ? rawKey : `${rawKey}-${count}` };
    });
    return (
      <Carousel aria-label="卡片轮播" align="start" className="@container min-w-0">
        <CarouselViewport>
          <CarouselContent style={trackStyle} className="ml-0">
            {slideItems.map(({ child, key }) => (
              <CarouselItem key={key} className={itemClass}>
                {child}
              </CarouselItem>
            ))}
          </CarouselContent>
        </CarouselViewport>
        <div className="mt-2 flex items-center justify-end gap-1">
          <CarouselPrevious className="static inset-auto translate-y-0 rounded-icon" />
          <CarouselNext className="static inset-auto translate-y-0 rounded-icon" />
        </div>
      </Carousel>
    );
  }
  return (
    <div className="@container min-w-0">
      <div
        className={cn(
          'grid gap-3',
          responsive
            ? cn(
                'grid-cols-1 @min-[481px]:grid-cols-2',
                count % 2 === 1 && count > 1 && '@min-[481px]:[&>*:last-child]:col-span-2',
              )
            : count > 1
              ? 'grid-cols-2'
              : 'grid-cols-1',
        )}
        style={gapStyle}
      >
        {children}
      </div>
    </div>
  );
}

export function BlockCard({
  clickable,
  onActivate,
  children,
  footer,
  className,
}: {
  clickable: boolean;
  onActivate?: (() => void) | undefined;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const surface = cn(
    'cds-card-surface flex h-full min-w-0 flex-col gap-3 rounded-card bg-surface p-3 text-left',
    className,
  );
  if (!clickable) {
    return (
      <div className={surface}>
        {children}
        {footer}
      </div>
    );
  }
  const fromInnerControl = (target: EventTarget) =>
    target instanceof Element && target.closest('button, a, input, textarea, select') !== null;
  const splitFooter = footer !== undefined && footer !== null && footer !== false;
  const body = (
    <ButtonPrimitive
      render={<div />}
      className={
        splitFooter
          ? 'flex min-w-0 flex-1 cursor-pointer flex-col gap-3 rounded-card text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          : cn(
              surface,
              'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )
      }
      onClick={(event) => {
        if (fromInnerControl(event.target)) return;
        onActivate?.();
      }}
    >
      {children}
    </ButtonPrimitive>
  );
  if (!splitFooter) return body;
  return (
    <div className={surface}>
      {body}
      {footer}
    </div>
  );
}
