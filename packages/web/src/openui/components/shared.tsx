import { ACTION_STEPS, BuiltinActionType } from '@openuidev/react-lang';
import { Children, type CSSProperties, type ReactNode } from 'react';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '../../components/ui/carousel.js';
import { cn } from '../../lib/cn.js';

/**
 * 组件渲染上下文的最小契约：与 `@openuidev/react-lang` 的 ComponentRenderProps 一致，
 * 这里再声明一份只是为了避免每个组件都从库里引类型。
 */
export interface RenderProps<P> {
  props: P;
  renderNode: (value: unknown) => ReactNode;
  statementId?: string;
}

/** 读取子元素节点的 props；用于父组件从 Col / TabItem 这类虚拟组件取数据。 */
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

/** `Text` / `BoldText` / `IconText` 共用的值 + 副文本排版。 */
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
          // 官方 Text / BoldText 的语义只有「正文」与「强调」两档。
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

/** `subtextVariant: "metric"` 时，正负号决定语义色。 */
export function metricTone(subtext: string | undefined): 'neutral' | 'positive' | 'negative' {
  if (!subtext) return 'neutral';
  if (subtext.startsWith('+')) return 'positive';
  if (subtext.startsWith('-')) return 'negative';
  return 'neutral';
}

/** 卡片块容器的单一来源：官方按卡片容器宽度换列；契约是 ≤480 单列、更宽两列。 */
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
  /**
   * 官方卡宽语义：small 17.5rem、medium 20rem、overview 15rem（容器 ≤30rem 时 12.5rem）；
   * responsive 关闭时按此固定。overview 必须由调用方显式传入。
   */
  size?: 'small' | 'medium' | 'overview';
  children: ReactNode;
}) {
  const gapStyle =
    gap === undefined ? undefined : { gap: typeof gap === 'number' ? `${gap}px` : gap };
  if (layout === 'carousel') {
    // 间距只放在轨道 gap 上：item 带内距会把 12px 算进 basis，可见卡宽短一截；
    // shadcn 默认的 -ml-4/pl-4 成对抵消，换成 gap 后必须都归零，避免双间距。
    // 两列时各让出半个 gap，两张加一个 gap 正好铺满轨道，不裁第二张；gap 走自定义属性，由轨道与卡宽共用。
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
    return (
      <Carousel opts={{ align: 'start' }} className="@container min-w-0">
        <CarouselContent style={trackStyle} className="ml-0">
          {Children.toArray(children).map((child, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 幻灯片由模型按顺序生成
            <CarouselItem key={index} className={itemClass}>
              {child}
            </CarouselItem>
          ))}
        </CarouselContent>
        {/* 官方把按钮放在轨道两侧，728px 轴线里会溢出；这里留在下方操作行。 */}
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
                // 2/3/5 张时奇数末张跨满两列；4 张保持 2×2，不制造半空行。
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

/** 卡片块里的单张卡片：可点时有 hover 与焦点环，不可点时保持纯展示。 */
export function BlockCard({
  clickable,
  onActivate,
  children,
  className,
}: {
  clickable: boolean;
  onActivate?: (() => void) | undefined;
  children: ReactNode;
  className?: string;
}) {
  const base = cn(
    'flex h-full min-w-0 flex-col gap-3 rounded-card bg-chip p-3 text-left',
    clickable &&
      'cursor-pointer transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    className,
  );
  if (!clickable) return <div className={base}>{children}</div>;
  // 卡片内可能已有真实按钮（CompositeCardItem footer）或链接：它自己的动作不能连带触发块级动作。
  const fromInnerControl = (target: EventTarget) =>
    target instanceof Element && target.closest('button, a, input, textarea, select') !== null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: 卡片内可能含真实按钮，嵌套 <button> 非法。
    <div
      role="button"
      tabIndex={0}
      className={base}
      onClick={(event) => {
        if (fromInnerControl(event.target)) return;
        onActivate?.();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (fromInnerControl(event.target)) return;
        event.preventDefault();
        onActivate?.();
      }}
    >
      {children}
    </div>
  );
}
