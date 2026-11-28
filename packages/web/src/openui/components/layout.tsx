import { isSafeOpenUrl } from '@agentport/shared';
import { useIsStreaming, useTriggerAction } from '@openuidev/react-lang';
import { Button as ButtonPrimitive } from '@ui-sdk/react/button';
import { CircleDot, icons, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Markdown } from '../../components/markdown.js';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../components/ui/accordion.js';
import { Button } from '../../components/ui/button.js';
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
import {
  asArray,
  type CardSource,
  CardSourceContext,
  childProps,
  metricTone,
  type RenderProps,
  ValueText,
} from './shared.js';

function toPascalCase(name: string): string {
  return name
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

const CATEGORY_FALLBACKS: Record<string, string> = {
  accessibility: 'Accessibility',
  account: 'User',
  animals: 'Cat',
  arrows: 'ArrowRight',
  brands: 'Box',
  buildings: 'Building',
  charts: 'ChartLine',
  communication: 'MessageSquare',
  connectivity: 'Wifi',
  cursors: 'MousePointer',
  design: 'Palette',
  development: 'Code',
  devices: 'Smartphone',
  emoji: 'FaceSlightlySmiling',
  files: 'File',
  finance: 'DollarSign',
  'food-beverage': 'CookingPot',
  gaming: 'Gamepad',
  home: 'House',
  layout: 'LayoutGrid',
  mail: 'Mail',
  math: 'Calculator',
  medical: 'HeartPulse',
  multimedia: 'ListMusic',
  nature: 'TreePine',
  navigation: 'MapPin',
  notifications: 'Bell',
  people: 'Users',
  photography: 'Camera',
  science: 'Microscope',
  seasons: 'Sun',
  security: 'Shield',
  shapes: 'Circle',
  shopping: 'ShoppingCart',
  social: 'Share2',
  sports: 'Trophy',
  sustainability: 'Leaf',
  text: 'Type',
  time: 'Clock',
  tools: 'Wrench',
  transportation: 'Car',
  travel: 'Plane',
  weather: 'Cloud',
};

const DEFAULT_FALLBACK_ICON = 'CircleDot';

function isIconName(name: string): name is keyof typeof icons {
  return Object.hasOwn(icons, name);
}

function lookupIcon(name: string): LucideIcon | undefined {
  return isIconName(name) ? icons[name] : undefined;
}

function resolveIcon(name: string, category?: string): LucideIcon {
  const direct = lookupIcon(toPascalCase(name)) ?? lookupIcon(name);
  if (direct) return direct;
  const fallback = category ? CATEGORY_FALLBACKS[category.trim().toLowerCase()] : undefined;
  return (
    (fallback ? lookupIcon(fallback) : undefined) ?? lookupIcon(DEFAULT_FALLBACK_ICON) ?? CircleDot
  );
}

export function IconRenderer({ props }: RenderProps<{ name: string; category?: string }>) {
  const Icon = resolveIcon(String(props.name ?? ''), props.category);
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

function SourceStrip({ sources }: { sources: readonly CardSource[] }) {
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
  const sources = useMemo<CardSource[]>(
    () =>
      (props.sources ?? []).map((source) => ({
        title: source.title,
        sourceName: source.sourceName,
        ...(source.url && isSafeOpenUrl(source.url) ? { url: source.url } : {}),
      })),
    [props.sources],
  );
  return (
    <div className="cds-card-surface flex min-w-0 flex-col gap-4 rounded-card bg-surface p-3 has-[.cds-card-surface]:transform-none has-[.cds-card-surface]:bg-transparent has-[.cds-card-surface]:p-0 has-[.cds-card-surface]:shadow-none">
      <CardSourceContext.Provider value={sources}>
        {renderNode(props.children)}
      </CardSourceContext.Provider>
      <SourceStrip sources={sources} />
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

function groupAriaLabel(
  entries: ReadonlyArray<{ itemProps: { trigger?: unknown } | undefined }>,
  fallback: string,
): string {
  const titles = entries
    .map((entry) => String(entry.itemProps?.trigger ?? '').trim())
    .filter(Boolean)
    .slice(0, 2);
  return titles.length > 0 ? `${fallback}：${titles.join(' / ')}` : fallback;
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
  const contentSignature = entries
    .map((entry) => `${entry.value}\u0001${JSON.stringify(entry.itemProps?.content)?.length ?? 0}`)
    .join('\u0000');

  useEffect(() => {
    if (touched.current || !streaming) return;
    const pairs = contentSignature
      ? contentSignature.split('\u0000').map((part) => {
          const [value = '', sizeText = '0'] = part.split('\u0001');
          return [value, Number(sizeText)] as const;
        })
      : [];
    const baseline = previousSizes.current;
    const nextSizes = Object.fromEntries(pairs);
    previousSizes.current = nextSizes;
    if (!baseline) return;
    const candidate = pairs.reduce<string | null>(
      (latest, [value, size]) => (size > (baseline[value] ?? 0) ? value : latest),
      null,
    );
    if (candidate && candidate !== resolvedActive) setActive(candidate);
  }, [streaming, contentSignature, resolvedActive]);

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
        aria-label={groupAriaLabel(entries, '标签页')}
        className="w-full justify-start gap-1 overflow-x-auto px-0.75 [&_[role=tab]]:after:bottom-[-4.5px]"
      >
        {entries.map(({ itemProps, value }) => (
          <TabsTrigger key={value} value={value} padding="sm" className="flex-none">
            {String(itemProps?.trigger ?? '')}
          </TabsTrigger>
        ))}
      </TabsList>
      {entries.map(({ itemProps, value }) => (
        <TabsContent key={value} value={value} keepMounted className="flex flex-col gap-3 pt-1">
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
  const entryValuesKey = entries.map((entry) => entry.value).join('\u0000');
  const firstOpen = open[0];

  useEffect(() => {
    const values = entryValuesKey ? entryValuesKey.split('\u0000') : [];
    if (!touched.current) {
      if (previousCount.current === null) {
        if (values.length > 0) autoOpenIndex.current = 0;
      } else if (values.length > previousCount.current) {
        autoOpenIndex.current = values.length - 1;
      }
      const autoOpenValue = values[autoOpenIndex.current];
      if (autoOpenValue && autoOpenValue !== firstOpen) setOpen([autoOpenValue]);
    }
    previousCount.current = values.length;
  }, [entryValuesKey, firstOpen]);

  if (entries.length === 0) return null;
  return (
    <Accordion
      aria-label={groupAriaLabel(entries, '折叠列表')}
      value={open}
      onValueChange={(value) => {
        touched.current = true;
        setOpen(value.map(String));
      }}
    >
      {entries.map(({ itemProps, value }) => (
        <AccordionItem key={value} value={value}>
          <AccordionTrigger>{String(itemProps?.trigger ?? '')}</AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-3">{renderNode(itemProps?.content)}</div>
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
  const entries = keyedItems(sections, 'section');
  const baseId = useId();
  const streaming = useIsStreaming();
  const firstValue = entries[0]?.value;
  const [openItems, setOpenItems] = useState<string[]>(() => (firstValue ? [firstValue] : []));
  const userSelected = useRef(false);
  const prevCount = useRef(0);
  const prevStreaming = useRef(streaming);
  const entryValuesKey = entries.map((entry) => entry.value).join('\u0000');

  useEffect(() => {
    const values = entryValuesKey ? entryValuesKey.split('\u0000') : [];
    if (values.length === 0) return;
    const first = values[0];
    if (streaming && values.length > prevCount.current && !userSelected.current) {
      const arrived = values.slice(prevCount.current);
      setOpenItems((previous) => {
        const next = [...previous];
        for (const value of arrived) {
          if (!next.includes(value)) next.push(value);
        }
        return next;
      });
    } else if (first && !userSelected.current) {
      setOpenItems((previous) => (previous.length === 0 ? [first] : previous));
    }
    prevCount.current = values.length;
  }, [entryValuesKey, streaming]);

  useEffect(() => {
    const values = entryValuesKey ? entryValuesKey.split('\u0000') : [];
    if (prevStreaming.current && !streaming && !userSelected.current && values.length > 0) {
      setOpenItems(values[0] ? [values[0]] : []);
    }
    prevStreaming.current = streaming;
  }, [streaming, entryValuesKey]);

  if (entries.length === 0) return null;

  if (props.isFoldable === false) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {entries.map(({ itemProps, value }, index) => {
          const headingId = `${baseId}-section-${index}`;
          return (
            <section key={value} aria-labelledby={headingId} className="flex flex-col gap-2">
              <h3 id={headingId} className="text-base font-medium break-words text-fg">
                {String(itemProps?.trigger ?? '')}
              </h3>
              <div className="flex flex-col gap-3">{renderNode(itemProps?.content)}</div>
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <Accordion
      multiple
      aria-label={groupAriaLabel(entries, '分区')}
      value={openItems}
      onValueChange={(value) => {
        userSelected.current = true;
        setOpenItems(value.map(String));
      }}
    >
      {entries.map(({ itemProps, value }) => (
        <AccordionItem key={value} value={value}>
          <AccordionTrigger>{String(itemProps?.trigger ?? '')}</AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-3">{renderNode(itemProps?.content)}</div>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
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
          <TimelineTitle size="base">{title}</TimelineTitle>
          {details != null && details !== '' ? (
            <TimelineDescription size="base">
              {typeof details === 'string' ? (
                <Markdown text={details} streaming={streaming} presentation="inherit" />
              ) : (
                renderNode(details)
              )}
            </TimelineDescription>
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
        <CarouselContent padding="y" className="ml-0">
          {slideEntries.map(({ slide, key }) => (
            <CarouselItem key={key} className="basis-4/5 @min-[481px]:basis-1/2">
              <div className="h-full px-2">
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
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
      </CarouselViewport>
      <div className="mt-2 flex items-center justify-end gap-1">
        <CarouselPrevious position="inline" />
        <CarouselNext position="inline" />
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
                type="button"
                aria-label={itemProps.title}
                className="flex w-full min-w-0 items-start justify-start gap-2.5 rounded-item px-1.5 py-2 text-left text-sm font-normal whitespace-normal outline-none transition-colors duration-150 ease-out-soft hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
          <Button
            // biome-ignore lint/suspicious/noArrayIndexKey: 追问项文本可能重复，位置即身份
            key={index}
            type="button"
            variant="outline"
            size="none"
            disabled={streaming}
            className="whitespace-normal"
            onClick={() => void trigger(text)}
          >
            <span className="px-3 py-1.5 font-normal">{text}</span>
          </Button>
        );
      })}
    </div>
  );
}

export function SeparatorRenderer({
  props,
}: RenderProps<{ orientation?: 'horizontal' | 'vertical'; decorative?: boolean }>) {
  return (
    <Separator
      orientation={props.orientation ?? 'horizontal'}
      {...(props.decorative === undefined ? {} : { decorative: props.decorative })}
    />
  );
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
