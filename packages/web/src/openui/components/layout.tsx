import { isSafeOpenUrl } from '@agentport/shared';
import { useIsStreaming, useTriggerAction } from '@openuidev/react-lang';
import { Button as ButtonPrimitive } from '@ui-sdk/react/button';
import type { LucideIcon } from 'lucide-react';
import { icons } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
  CarouselViewport,
} from '../../components/ui/carousel.js';
import { Separator } from '../../components/ui/separator.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import {
  Timeline,
  TimelineConnector,
  TimelineDescription,
  TimelineItem,
  TimelineMarker,
  type TimelineStatus,
  TimelineTitle,
} from '../../components/ui/timeline.js';
import { cn } from '../../lib/cn.js';
import { asArray, childProps, metricTone, type RenderProps, ValueText } from './shared.js';

/** lucide 只导出 PascalCase 命名；模型给的是 kebab-case 或任意大小写。 */
function toPascalCase(name: string): string {
  return name
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

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

function resolveIcon(name: string, category?: string): LucideIcon | null {
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
          {source.url && isSafeOpenUrl(source.url) ? (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 break-words font-medium text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg"
            >
              {source.title}
            </a>
          ) : (
            <span className="min-w-0 break-words font-medium text-fg">{source.title}</span>
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
    <div className="cds-card-surface flex min-w-0 flex-col gap-4 rounded-card bg-surface p-3 has-[.cds-card-surface]:transform-none has-[.cds-card-surface]:bg-transparent has-[.cds-card-surface]:p-0 has-[.cds-card-surface]:shadow-none">
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
        <h2 className="text-base font-medium break-words text-fg">{props.title}</h2>
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
      <span className="text-base font-medium break-words text-fg">{props.heading}</span>
      {props.description ? (
        <span className="text-sm break-words text-muted-foreground">{props.description}</span>
      ) : null}
    </div>
  );
}

function keyedItems(items: unknown[], fallback: string) {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const itemProps = childProps<{ value?: unknown; trigger?: unknown; content?: unknown }>(item);
    const raw = itemProps?.value ?? itemProps?.trigger;
    const base = raw !== undefined && String(raw) !== '' ? String(raw) : fallback;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { itemProps, value: count === 1 ? base : `${base}-${count}` };
  });
}

export function TabsRenderer({ props, renderNode }: RenderProps<{ items: unknown[] }>) {
  const items = (props.items ?? []).filter((item) => childProps(item) !== undefined);
  const entries = keyedItems(items, 'tab');
  const firstValue = entries[0]?.value ?? '';
  const streaming = useIsStreaming();
  const [active, setActive] = useState('');
  const touched = useRef(false);
  const previousSizes = useRef<Record<string, number> | null>(null);
  const resolvedActive = entries.some((entry) => entry.value === active) ? active : firstValue;

  useEffect(() => {
    if (touched.current || !streaming) return;
    const baseline = previousSizes.current;
    const nextSizes = Object.fromEntries(
      entries.map((entry) => [entry.value, JSON.stringify(entry.itemProps?.content)?.length ?? 0]),
    );
    previousSizes.current = nextSizes;
    if (!baseline) return;
    const candidate = entries.reduce<string | null>(
      (latest, entry) =>
        (nextSizes[entry.value] ?? 0) > (baseline[entry.value] ?? 0) ? entry.value : latest,
      null,
    );
    if (candidate && candidate !== resolvedActive) setActive(candidate);
  });

  if (entries.length === 0) return null;

  return (
    <Tabs
      value={resolvedActive}
      onValueChange={(value) => {
        touched.current = true;
        setActive(String(value));
      }}
      className="min-w-0"
    >
      <TabsList
        variant="line"
        aria-label="标签页"
        className="w-full justify-start gap-1 overflow-x-auto px-[3px] [&_[role=tab]]:after:bottom-[-4.5px]"
      >
        {entries.map(({ itemProps, value }) => (
          <TabsTrigger key={value} value={value} className="flex-none px-2">
            {String(itemProps?.trigger ?? '')}
          </TabsTrigger>
        ))}
      </TabsList>
      {entries.map(({ itemProps, value }) => (
        <TabsContent key={value} value={value} className="flex flex-col gap-3 pt-1">
          {renderNode(itemProps?.content)}
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function AccordionRenderer({ props, renderNode }: RenderProps<{ items: unknown[] }>) {
  const items = (props.items ?? []).filter((item) => childProps(item) !== undefined);
  const entries = keyedItems(items, 'item');
  const [open, setOpen] = useState<string[]>(() => (entries[0] ? [entries[0].value] : []));
  const touched = useRef(false);
  const previousCount = useRef<number | null>(null);
  const autoOpenIndex = useRef(-1);

  useEffect(() => {
    if (!touched.current) {
      if (previousCount.current === null) {
        if (entries.length > 0) autoOpenIndex.current = 0;
      } else if (entries.length > previousCount.current) {
        autoOpenIndex.current = entries.length - 1;
      }
      const autoOpenValue = entries[autoOpenIndex.current]?.value;
      if (autoOpenValue && autoOpenValue !== open[0]) setOpen([autoOpenValue]);
    }
    previousCount.current = entries.length;
  });

  if (entries.length === 0) return null;
  return (
    <Accordion
      aria-label="折叠列表"
      value={open}
      onValueChange={(value) => {
        touched.current = true;
        setOpen(value.map(String));
      }}
    >
      {entries.map(({ itemProps, value }) => (
        <AccordionItem key={value} value={value}>
          <AccordionTrigger>{String(itemProps?.trigger ?? '')}</AccordionTrigger>
          <AccordionContent className="flex flex-col gap-3">
            {renderNode(itemProps?.content)}
          </AccordionContent>
        </AccordionItem>
      ))}
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
    const used = new Set<string>();
    const entries = sections.map((section) => {
      const sectionProps = childProps<{ value?: unknown; trigger?: unknown; content?: unknown }>(
        section,
      );
      const raw = sectionProps?.value ?? sectionProps?.trigger;
      const base = raw !== undefined && String(raw) !== '' ? String(raw) : 'section';
      let key = base;
      let suffix = 2;
      while (used.has(key)) {
        key = `${base}-${suffix}`;
        suffix += 1;
      }
      used.add(key);
      return { sectionProps, key };
    });
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {entries.map(({ sectionProps, key }) => (
          <section key={key} className="flex flex-col gap-2">
            <h3 className="text-base font-medium break-words text-fg">
              {String(sectionProps?.trigger ?? '')}
            </h3>
            <div className="flex flex-col gap-3">{renderNode(sectionProps?.content)}</div>
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

export function StepsRenderer({ props, renderNode }: RenderProps<{ items: unknown[] }>) {
  const items = (props.items ?? []).filter((item) => childProps(item) !== undefined);
  const streaming = useIsStreaming();
  if (items.length === 0) return null;
  const seen = new Map<string, number>();
  const entries = items.map((item, index) => {
    const itemProps = childProps<{ title?: unknown; details?: unknown; status?: unknown }>(item);
    const title = String(itemProps?.title ?? '');
    const base = title || 'step';
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const key = count === 1 ? base : `${base}-${count}`;
    const rawStatus = itemProps?.status;
    const status: TimelineStatus | undefined =
      rawStatus === 'complete' || rawStatus === 'current' || rawStatus === 'upcoming'
        ? rawStatus
        : streaming
          ? index < items.length - 1
            ? 'complete'
            : 'current'
          : undefined;
    return { key, index, title, details: itemProps?.details, status };
  });
  return (
    <Timeline aria-label="步骤" className="min-w-0">
      {entries.map(({ key, index, title, details, status }) => (
        <TimelineItem key={key} value={key} {...(status === undefined ? {} : { status })}>
          <TimelineMarker>{index + 1}</TimelineMarker>
          <TimelineConnector />
          <TimelineTitle className="text-base">{title}</TimelineTitle>
          {details ? (
            <TimelineDescription className="text-base">{renderNode(details)}</TimelineDescription>
          ) : null}
        </TimelineItem>
      ))}
    </Timeline>
  );
}

export function CarouselRenderer({
  props,
  renderNode,
}: RenderProps<{ children: unknown[][]; variant?: 'card' | 'sunk' }>) {
  const slides = (props.children ?? []).filter((slide) => Array.isArray(slide));
  if (slides.length === 0) return null;
  const seenSlides = new Map<string, number>();
  const slideEntries = slides.map((slide) => {
    const first = childProps<Record<string, unknown>>(slide[0]);
    const hint = [
      first?.id,
      first?.value,
      first?.trigger,
      first?.heading,
      first?.title,
      first?.label,
    ].find((part) => typeof part === 'string' && part.length > 0);
    const base =
      typeof hint === 'string'
        ? hint
        : slide
            .map((node) =>
              typeof node === 'object' && node !== null
                ? String((node as { typeName?: unknown }).typeName ?? 'node')
                : typeof node,
            )
            .join('+') || 'slide';
    const count = (seenSlides.get(base) ?? 0) + 1;
    seenSlides.set(base, count);
    return { slide, key: count === 1 ? base : `${base}-${count}` };
  });
  return (
    <Carousel aria-label="内容轮播" align="start" className="@container min-w-0">
      <CarouselViewport>
        <CarouselContent className="ml-0 py-2">
          {slideEntries.map(({ slide, key }) => (
            <CarouselItem key={key} className="basis-4/5 px-2 @min-[481px]:basis-1/2">
              <div
                className={cn(
                  'flex h-full flex-col gap-3 rounded-card p-3',
                  props.variant === 'sunk'
                    ? 'bg-sunken'
                    : 'cds-card-surface bg-surface has-[.cds-card-surface]:transform-none has-[.cds-card-surface]:bg-transparent has-[.cds-card-surface]:p-0 has-[.cds-card-surface]:shadow-none',
                )}
              >
                {renderNode(slide)}
              </div>
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
              <ButtonPrimitive
                className="flex w-full min-w-0 items-start gap-2.5 py-2 text-left transition-colors duration-150 ease-out-soft hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void trigger(itemProps.title, undefined, action)}
              >
                {content}
              </ButtonPrimitive>
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
          <ButtonPrimitive
            // biome-ignore lint/suspicious/noArrayIndexKey: 追问项文本可能重复，位置即身份
            key={index}
            disabled={streaming}
            className="rounded-full border border-line px-3 py-1.5 text-sm text-fg transition-colors duration-150 ease-out-soft hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void trigger(text)}
          >
            {text}
          </ButtonPrimitive>
        );
      })}
    </div>
  );
}

export function SeparatorRenderer({
  props,
}: RenderProps<{ orientation?: 'horizontal' | 'vertical'; decorative?: boolean }>) {
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
