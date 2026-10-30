import { useIsStreaming, useTriggerAction } from '@openuidev/react-lang';
import type { LucideIcon } from 'lucide-react';
import { icons } from 'lucide-react';
import { type ComponentType, useEffect, useRef, useState } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../components/ui/accordion.js';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '../../components/ui/carousel.js';
import { Separator } from '../../components/ui/separator.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { cn } from '../../lib/cn.js';
import { asArray, childProps, metricTone, type RenderProps, ValueText } from './shared.js';

// ─── Icon ────────────────────────────────────────────────────────────────────

/** lucide 只导出 PascalCase 命名；模型给的是 kebab-case 或任意大小写。 */
function toPascalCase(name: string): string {
  return name
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** 名称解析不到时按官方 category 回退，而不是空白。 */
const CATEGORY_FALLBACKS: Record<string, string> = {
  buildings: 'Building',
  charts: 'ChartLine',
  communication: 'MessageSquare',
  finance: 'DollarSign',
  home: 'House',
  multimedia: 'Music',
  nature: 'TreePine',
  people: 'Users',
  shapes: 'Circle',
  shopping: 'ShoppingCart',
  time: 'Clock',
  tools: 'Wrench',
  transportation: 'Car',
  travel: 'Plane',
};

export function resolveIcon(name: string, category?: string): LucideIcon | null {
  const catalog = icons as unknown as Record<string, LucideIcon | undefined>;
  const direct = catalog[toPascalCase(name)] ?? catalog[name];
  if (direct) return direct;
  const fallback = category ? CATEGORY_FALLBACKS[category.trim().toLowerCase()] : undefined;
  return (fallback ? catalog[fallback] : undefined) ?? null;
}

export function IconRenderer({ props }: RenderProps<{ name: string; category?: string }>) {
  const Icon = resolveIcon(String(props.name ?? ''), props.category);
  if (!Icon) return null;
  return <Icon aria-hidden="true" />;
}

// ─── Text primitives ─────────────────────────────────────────────────────────

type TextSize = 'xs' | 'sm' | 'md' | 'lg';

export function TextRenderer({
  props,
}: RenderProps<{
  variant: 'text' | 'number';
  value: string;
  subtext?: string;
  subtextVariant: 'text' | 'number' | 'metric';
  size: TextSize;
}>) {
  return (
    <ValueText
      value={String(props.value ?? '')}
      subtext={props.subtext}
      numeric={props.variant === 'number' || props.subtextVariant === 'number'}
      size={props.size ?? 'md'}
      subtextTone={props.subtextVariant === 'metric' ? metricTone(props.subtext) : 'neutral'}
    />
  );
}

export function BoldTextRenderer({
  props,
}: RenderProps<{
  variant: 'text' | 'number';
  value: string;
  subtext?: string;
  subtextVariant: 'text' | 'number' | 'metric';
  size: TextSize;
}>) {
  return (
    <ValueText
      value={String(props.value ?? '')}
      subtext={props.subtext}
      numeric={props.variant === 'number' || props.subtextVariant === 'number'}
      size={props.size ?? 'md'}
      bold
      subtextTone={props.subtextVariant === 'metric' ? metricTone(props.subtext) : 'neutral'}
    />
  );
}

const ICON_BADGE_TONES = {
  neutral: 'bg-chip text-fg',
  info: 'bg-chip text-fg',
  success: 'bg-chip text-success',
  warning: 'bg-chip text-warning',
  danger: 'bg-chip text-danger',
  inverted: 'bg-ink text-primary-foreground',
  filled: 'bg-chip text-fg',
  soft: 'bg-chip text-muted-foreground',
} as const;

export function IconTextRenderer({
  props,
  renderNode,
}: RenderProps<{
  icon: unknown;
  iconVariant: keyof typeof ICON_BADGE_TONES;
  iconSize: string;
  title: string;
  subtitle?: string;
  bold: boolean;
  layout: 'horizontal' | 'vertical';
}>) {
  return (
    <div
      className={cn(
        'flex min-w-0 gap-2.5',
        props.layout === 'horizontal' ? 'items-center' : 'flex-col items-start',
      )}
    >
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-icon',
          ICON_BADGE_TONES[props.iconVariant ?? 'neutral'],
        )}
      >
        {renderNode(props.icon)}
      </span>
      <ValueText
        value={props.title}
        subtext={props.subtitle}
        bold={props.bold}
        size={props.layout === 'horizontal' ? 'xs' : 'sm'}
      />
    </div>
  );
}

// ─── Card shell ──────────────────────────────────────────────────────────────

function SourceStrip({
  sources,
}: {
  sources: Array<{ url?: string; title: string; sourceName: string }>;
}) {
  if (sources.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-line pt-3">
      {sources.map((source, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 来源由模型按顺序生成，标题可能重复
        <div key={`${source.title}-${index}`} className="flex min-w-0 items-baseline gap-2 text-sm">
          <span className="shrink-0 tabular-nums text-muted-foreground">{index + 1}</span>
          {source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 break-words font-semibold text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg"
            >
              {source.title}
            </a>
          ) : (
            <span className="min-w-0 break-words font-semibold text-fg">{source.title}</span>
          )}
          <span className="shrink-0 text-muted-foreground">{source.sourceName}</span>
        </div>
      ))}
    </div>
  );
}

export function CardRenderer({
  props,
  renderNode,
}: RenderProps<{
  children: unknown[];
  sources?: Array<{ url?: string; title: string; sourceName: string }>;
}>) {
  return (
    // 设计系统：卡片不额外套边框或底色，内容与消息流同宽同间距。
    <div className="flex min-w-0 flex-col gap-4">
      {renderNode(props.children)}
      <SourceStrip sources={props.sources ?? []} />
    </div>
  );
}

export function CardHeaderRenderer({ props }: RenderProps<{ title?: string; subtitle?: string }>) {
  if (!props.title && !props.subtitle) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {props.title ? (
        <h2 className="text-lg font-semibold break-words text-fg">{props.title}</h2>
      ) : null}
      {props.subtitle ? (
        <p className="text-sm break-words text-muted-foreground">{props.subtitle}</p>
      ) : null}
    </div>
  );
}

export function InlineHeaderRenderer({
  props,
}: RenderProps<{ heading: string; description?: string }>) {
  if (!props.heading && !props.description) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-base font-semibold break-words text-fg">{props.heading}</span>
      {props.description ? (
        <span className="text-sm break-words text-muted-foreground">{props.description}</span>
      ) : null}
    </div>
  );
}

// ─── Tabs / Accordion / Sections ─────────────────────────────────────────────

export function TabsRenderer({ props, renderNode }: RenderProps<{ items: unknown[] }>) {
  const items = (props.items ?? []).filter((item) => childProps(item) !== undefined);
  const values = items.map((item, index) => String(childProps(item)?.value ?? index));
  const streaming = useIsStreaming();
  const [active, setActive] = useState<string | undefined>(undefined);
  const touched = useRef(false);
  const previousCount = useRef(0);

  // 流式期间自动跟随新出现的页签；用户点过之后就不再抢焦点。
  useEffect(() => {
    if (items.length === 0) return;
    const grew = items.length > previousCount.current;
    previousCount.current = items.length;
    if (touched.current) return;
    if (active === undefined || (streaming && grew)) setActive(values[values.length - 1]);
  }, [items.length, active, streaming, values]);

  if (items.length === 0) return null;
  const current = active !== undefined && values.includes(active) ? active : values[0];

  return (
    <Tabs
      value={current}
      onValueChange={(value) => {
        touched.current = true;
        setActive(String(value));
      }}
      className="min-w-0"
    >
      <TabsList variant="line" className="w-full justify-start overflow-x-auto">
        {items.map((item, index) => (
          <TabsTrigger
            key={values[index] ?? index}
            value={values[index] ?? ''}
            className="flex-none px-2"
          >
            {String(childProps(item)?.trigger ?? '')}
          </TabsTrigger>
        ))}
      </TabsList>
      {items.map((item, index) => (
        <TabsContent
          key={values[index] ?? index}
          value={values[index] ?? ''}
          className="flex flex-col gap-3 pt-1"
        >
          {renderNode(childProps(item)?.content)}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function AccordionRenderer({ props, renderNode }: RenderProps<{ items: unknown[] }>) {
  const items = (props.items ?? []).filter((item) => childProps(item) !== undefined);
  const streaming = useIsStreaming();
  const [open, setOpen] = useState<string[]>([]);
  const touched = useRef(false);
  const previousCount = useRef(0);

  // 只在折叠项数量变化时自动展开最新的一项；用户手动开合后不再干预。
  useEffect(() => {
    if (items.length === 0) return;
    const grew = items.length > previousCount.current;
    previousCount.current = items.length;
    if (touched.current) return;
    if (open.length === 0 || (streaming && grew)) {
      const newest = childProps(items[items.length - 1])?.value;
      if (newest !== undefined) setOpen([String(newest)]);
    }
  }, [items, open.length, streaming]);

  if (items.length === 0) return null;
  return (
    <Accordion
      value={open}
      onValueChange={(value) => {
        touched.current = true;
        setOpen(value.map(String));
      }}
    >
      {items.map((item, index) => {
        const value = String(childProps(item)?.value ?? index);
        return (
          <AccordionItem key={value} value={value}>
            <AccordionTrigger>{String(childProps(item)?.trigger ?? '')}</AccordionTrigger>
            <AccordionContent className="flex flex-col gap-3">
              {renderNode(childProps(item)?.content)}
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}

export function SectionBlockRenderer({
  props,
  renderNode,
}: RenderProps<{ sections: unknown[]; isFoldable?: boolean }>) {
  const sections = (props.sections ?? []).filter((item) => childProps(item) !== undefined);
  if (sections.length === 0) return null;
  if (props.isFoldable === false) {
    // 展开式分区：标题与内容靠间距分组，不再叠一层折叠语义。
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {sections.map((section, index) => (
          <section key={`${childProps(section)?.value ?? index}`} className="flex flex-col gap-2">
            <h3 className="text-base font-semibold break-words text-fg">
              {String(childProps(section)?.trigger ?? '')}
            </h3>
            <div className="flex flex-col gap-3">{renderNode(childProps(section)?.content)}</div>
          </section>
        ))}
      </div>
    );
  }
  return (
    <AccordionRenderer
      props={{ items: sections.map((section) => section) }}
      renderNode={renderNode}
    />
  );
}

// ─── Steps / Carousel ────────────────────────────────────────────────────────

export function StepsRenderer({ props, renderNode }: RenderProps<{ items: unknown[] }>) {
  const items = (props.items ?? []).filter((item) => childProps(item) !== undefined);
  if (items.length === 0) return null;
  return (
    <ol className="flex min-w-0 flex-col gap-3">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 步骤顺序即身份
        <li key={index} className="flex min-w-0 gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-chip font-mono text-xs tabular-nums text-muted-foreground">
            {index + 1}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-base font-semibold break-words text-fg">
              {String(childProps(item)?.title ?? '')}
            </span>
            {childProps(item)?.details ? (
              <div className="min-w-0 text-base text-muted-foreground">
                {renderNode(childProps(item)?.details)}
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function CarouselRenderer({
  props,
  renderNode,
}: RenderProps<{ children: unknown[][]; variant?: 'card' | 'sunk' }>) {
  const slides = (props.children ?? []).filter((slide) => Array.isArray(slide));
  if (slides.length === 0) return null;
  return (
    // 官方把翻页按钮放在轨道两侧，聊天 728px 轴线里会溢出；这里移到下方操作行。
    <Carousel opts={{ align: 'start' }} className="@container min-w-0">
      <CarouselContent>
        {slides.map((slide, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 幻灯片由模型按顺序生成
          <CarouselItem key={index} className="basis-4/5 @min-[481px]:basis-1/2">
            <div
              className={cn(
                'flex h-full flex-col gap-3 rounded-card p-3',
                props.variant === 'sunk' ? 'bg-sunken' : 'bg-chip',
              )}
            >
              {renderNode(slide)}
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>
      <div className="mt-2 flex items-center justify-end gap-1">
        <CarouselPrevious className="static inset-auto translate-y-0 rounded-icon" />
        <CarouselNext className="static inset-auto translate-y-0 rounded-icon" />
      </div>
    </Carousel>
  );
}

// ─── Lists / follow-ups ──────────────────────────────────────────────────────

export function ListRenderer({
  props,
}: RenderProps<{
  items: unknown[];
  variant?: 'number' | 'image';
  size?: 'default' | 'small';
}>) {
  const trigger = useTriggerAction();
  const streaming = useIsStreaming();
  const items = (props.items ?? []).filter((item) => childProps(item) !== undefined);
  if (items.length === 0) return null;
  return (
    <ul className="flex min-w-0 flex-col divide-y divide-line">
      {items.map((item, index) => {
        const itemProps = childProps<{
          title: string;
          subtitle?: string;
          image?: { src: string; alt: string };
          actionLabel?: string;
          action?: unknown;
        }>(item);
        if (!itemProps) return null;
        const action = itemProps.action;
        const clickable = action != null && !streaming;
        const content = (
          <>
            {props.variant === 'image' && itemProps.image ? (
              <img
                src={itemProps.image.src}
                alt={itemProps.image.alt}
                loading="lazy"
                className="size-10 shrink-0 rounded-icon object-cover"
              />
            ) : props.variant !== 'image' ? (
              <span className="shrink-0 pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                {index + 1}
              </span>
            ) : null}
            <ValueText
              value={itemProps.title}
              subtext={itemProps.subtitle}
              size={props.size === 'small' ? 'xs' : 'sm'}
              className="flex-1"
            />
            {clickable && itemProps.actionLabel ? (
              <span className="shrink-0 text-sm text-muted-foreground">
                {itemProps.actionLabel}
              </span>
            ) : null}
          </>
        );
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 列表项由模型按顺序生成
          <li key={index} className="min-w-0">
            {clickable ? (
              <button
                type="button"
                className="flex w-full min-w-0 items-start gap-2.5 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void trigger(itemProps.title, undefined, action)}
              >
                {content}
              </button>
            ) : (
              <div className="flex min-w-0 items-start gap-2.5 py-2">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function FollowUpBlockRenderer({ props }: RenderProps<{ items: unknown[] }>) {
  const trigger = useTriggerAction();
  const streaming = useIsStreaming();
  const items = (props.items ?? []).filter((item) => childProps(item) !== undefined);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      {items.map((item, index) => {
        const text = String(childProps(item)?.text ?? '');
        if (!text) return null;
        return (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: 追问项文本可能重复，位置即身份
            key={index}
            type="button"
            disabled={streaming}
            className="rounded-full border border-line px-3 py-1.5 text-sm text-fg transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void trigger(text)}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

// ─── Data display ────────────────────────────────────────────────────────────

export function SeparatorRenderer({
  props,
}: RenderProps<{ orientation?: 'horizontal' | 'vertical'; decorative?: boolean }>) {
  // Base UI 的 Separator 没有 `decorative`；默认就是装饰性 role="none"。
  return <Separator orientation={props.orientation ?? 'horizontal'} />;
}

type EntityRow = { left: string; right: string; rightVariant: 'text' | 'number' };

function EntityRowView({ row, kind }: { row: EntityRow; kind: 'header' | 'body' | 'footer' }) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-baseline justify-between gap-3 py-1.5',
        kind === 'body' && 'border-t border-line',
      )}
    >
      <span
        className={cn(
          'min-w-0 break-words',
          kind === 'header' ? 'text-xs text-muted-foreground' : 'text-sm text-muted-foreground',
        )}
      >
        {row.left}
      </span>
      <span
        className={cn(
          'shrink-0 break-words text-right',
          kind === 'header' ? 'text-xs text-muted-foreground' : 'text-sm font-normal text-fg',
          row.rightVariant === 'number' && 'font-mono tabular-nums',
        )}
      >
        {row.right}
      </span>
    </div>
  );
}

export function EntityListRenderer({
  props,
}: RenderProps<{
  rows: EntityRow[];
  size: 'small' | 'default';
  header?: EntityRow;
  footer?: EntityRow;
}>) {
  const rows = asArray(props.rows ?? []);
  if (rows.length === 0) return null;
  const showHeaderFooter = props.size !== 'small';
  return (
    <div className="flex min-w-0 flex-col">
      {showHeaderFooter && props.header ? <EntityRowView row={props.header} kind="header" /> : null}
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 键值行由模型按顺序生成
        <EntityRowView key={index} row={row} kind="body" />
      ))}
      {showHeaderFooter && props.footer ? <EntityRowView row={props.footer} kind="footer" /> : null}
    </div>
  );
}

/** 虚拟组件：数据由父容器读取，自身不渲染。 */
export const VirtualComponent: ComponentType = () => null;
