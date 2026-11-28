import { isSafeOpenUrl } from '@agentport/shared';
import { useIsStreaming, useStateField } from '@openuidev/react-lang';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type CSSProperties, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from '../../components/markdown.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { cn } from '../../lib/cn.js';
import { type CardSource, CardSourceContext, type RenderProps, ValueText } from './shared.js';

const CONTENT_SIZES = {
  small: 'text-sm text-muted-foreground',
  default: 'text-base text-fg',
  large: 'text-lg text-fg',
  'small-heavy': 'text-sm font-medium text-fg',
  'large-heavy': 'text-lg font-semibold text-fg',
} as const;

const CITATION_RE = /(?<![[\\\]])\[(\d+)\](?![([:\]])/g;

function replaceCitationsInProse(segment: string, sources: readonly CardSource[]): string {
  return segment.replace(CITATION_RE, (match, digits: string) => {
    const index = Number(digits) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= sources.length) return match;
    const source = sources[index];
    if (!source) return match;
    if (source.url && isSafeOpenUrl(source.url)) {
      const href = new URL(source.url).href
        .replaceAll('(', '%28')
        .replaceAll(')', '%29')
        .replaceAll('"', '%22');
      const title = (source.title || source.sourceName)
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replace(/\s+/g, ' ')
        .trim();
      return title ? `[\\[${digits}\\]](${href} "${title}")` : `[\\[${digits}\\]](${href})`;
    }
    return `[${digits}]`;
  });
}

function formatTextWithCitations(text: string, sources: readonly CardSource[]): string {
  if (sources.length === 0 || !text.includes('[')) return text;
  let result = '';
  let prose = '';
  let index = 0;

  const flush = () => {
    if (prose !== '') {
      result += replaceCitationsInProse(prose, sources);
      prose = '';
    }
  };

  while (index < text.length) {
    const atLineStart = index === 0 || text[index - 1] === '\n';
    if (atLineStart) {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(index));
      if (fenceMatch) {
        flush();
        const fence = fenceMatch[1] ?? '```';
        const marker = fence[0] ?? '`';
        const minLen = fence.length;
        const firstNewline = text.indexOf('\n', index);
        if (firstNewline === -1) {
          result += text.slice(index);
          break;
        }
        let cursor = firstNewline + 1;
        let end = text.length;
        const closeRe = new RegExp(`^ {0,3}${marker}{${minLen},}[ \\t]*$`);
        while (cursor < text.length) {
          const nextNewline = text.indexOf('\n', cursor);
          const lineEnd = nextNewline === -1 ? text.length : nextNewline;
          const line = text.slice(cursor, lineEnd).replace(/\r$/, '');
          if (closeRe.test(line)) {
            end = nextNewline === -1 ? text.length : nextNewline + 1;
            break;
          }
          if (nextNewline === -1) break;
          cursor = nextNewline + 1;
        }
        result += text.slice(index, end);
        index = end;
        continue;
      }
    }

    if (text[index] === '`') {
      let tickEnd = index;
      while (tickEnd < text.length && text[tickEnd] === '`') tickEnd += 1;
      const tickLen = tickEnd - index;
      let search = tickEnd;
      let closePos = -1;
      while (search < text.length) {
        const found = text.indexOf('`', search);
        if (found === -1) break;
        let runEnd = found;
        while (runEnd < text.length && text[runEnd] === '`') runEnd += 1;
        if (runEnd - found === tickLen) {
          closePos = runEnd;
          break;
        }
        search = runEnd;
      }
      if (closePos !== -1) {
        flush();
        result += text.slice(index, closePos);
        index = closePos;
        continue;
      }
      prose += text.slice(index, tickEnd);
      index = tickEnd;
      continue;
    }

    prose += text[index];
    index += 1;
  }

  flush();
  return result;
}

export function TextContentRenderer({ props }: RenderProps<{ text: string; size?: string }>) {
  const streaming = useIsStreaming();
  const sources = useContext(CardSourceContext);
  const rawText = String(props.text ?? '');
  const text = useMemo(() => formatTextWithCitations(rawText, sources), [rawText, sources]);
  const size = (props.size ?? 'default') as keyof typeof CONTENT_SIZES;
  return (
    <div className={cn('min-w-0', CONTENT_SIZES[size] ?? CONTENT_SIZES.default)}>
      <Markdown text={text} streaming={streaming} presentation="inherit" />
    </div>
  );
}

const MD_VARIANTS = {
  clear: '',
  card: 'cds-card-surface rounded-card bg-surface p-3',
  sunk: 'rounded-card bg-sunken p-3',
} as const;

export function MarkDownRenderer({
  props,
}: RenderProps<{ textMarkdown: string; variant?: keyof typeof MD_VARIANTS }>) {
  const streaming = useIsStreaming();
  return (
    <div className={cn('min-w-0 text-base text-fg', MD_VARIANTS[props.variant ?? 'clear'])}>
      <Markdown
        text={String(props.textMarkdown ?? '')}
        streaming={streaming}
        presentation="inherit"
      />
    </div>
  );
}

const CALLOUT_TONES = {
  info: 'text-fg',
  neutral: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger',
} as const;

export function Callout({
  props,
}: RenderProps<{
  variant: keyof typeof CALLOUT_TONES;
  title: string;
  description: string;
  visible?: unknown;
}>) {
  const streaming = useIsStreaming();
  const field = useStateField('visible', props.visible);
  const isVisible = field.isReactive
    ? field.value === true || field.value === 'true'
    : props.visible !== false;
  const setVisibleRef = useRef(field.setValue);
  setVisibleRef.current = field.setValue;

  useEffect(() => {
    if (!field.isReactive || !isVisible) return;
    const timer = setTimeout(() => {
      setVisibleRef.current(false);
    }, 3000);
    return () => clearTimeout(timer);
  }, [field.isReactive, isVisible]);

  if (!isVisible) return null;
  const tone = CALLOUT_TONES[props.variant ?? 'neutral'];
  return (
    <div className="flex min-w-0 flex-col gap-1 border-l border-line pl-3">
      <span className={cn('text-base font-medium', tone)}>{props.title}</span>
      <div className="min-w-0 text-base text-fg">
        <Markdown
          text={String(props.description ?? '')}
          streaming={streaming}
          presentation="inherit"
        />
      </div>
    </div>
  );
}

const TEXT_CALLOUT_TONES = {
  neutral: 'text-muted-foreground',
  info: 'text-fg',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
} as const;

export function TextCallout({
  props,
}: RenderProps<{
  variant?: keyof typeof TEXT_CALLOUT_TONES;
  title?: string;
  description?: string;
}>) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-baseline gap-2 rounded-card bg-chip px-3 py-2 text-base',
        TEXT_CALLOUT_TONES[props.variant ?? 'neutral'],
      )}
    >
      {props.title ? <span className="font-medium">{props.title}</span> : null}
      {props.description ? <span className="min-w-0">{props.description}</span> : null}
    </div>
  );
}

function fenceFor(code: string): string {
  let longest = 0;
  for (const match of code.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function CodeBlock({ props }: RenderProps<{ language: string; codeString: string }>) {
  const streaming = useIsStreaming();
  const code = String(props.codeString ?? '');
  const fence = fenceFor(code);
  const language = String(props.language ?? '').replace(/[^\w+#.-]/g, '');
  return <Markdown text={`${fence}${language}\n${code}\n${fence}`} streaming={streaming} />;
}

function ReservedImage({ src, alt }: { src: string; alt: string }) {
  return <ReservedImageState key={src} src={src} alt={alt} />;
}

function ReservedImageState({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="aspect-[3/2] w-full overflow-hidden rounded-card bg-sunken">
      {failed ? (
        <div className="h-full w-full overflow-y-auto p-3">
          {alt ? (
            <span className="block text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {alt}
            </span>
          ) : null}
        </div>
      ) : (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain"
        />
      )}
    </div>
  );
}

export function ImageRenderer({ props }: RenderProps<{ alt: string; src?: string }>) {
  if (!props.src) return null;
  return <ReservedImage src={props.src} alt={props.alt ?? ''} />;
}

export function ImageBlock({ props }: RenderProps<{ src: string; alt?: string }>) {
  if (!props.src) return null;
  return <ImageBlockImage key={props.src} src={props.src} alt={props.alt ?? ''} />;
}

function ImageBlockImage({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return alt ? (
      <p className="rounded-card bg-sunken p-3 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {alt}
      </p>
    ) : null;
  }
  return (
    <div className="grid min-w-0 overflow-hidden rounded-card">
      {!loaded ? (
        <Skeleton
          role="status"
          aria-busy="true"
          aria-label="图片加载中"
          className="col-start-1 row-start-1 h-48 w-full rounded-card"
        />
      ) : null}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className="col-start-1 row-start-1 block h-auto w-full"
      />
    </div>
  );
}

const MAX_GRID_IMAGES = 5;

function GalleryThumbnail({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex aspect-square w-full items-center justify-center overflow-y-auto rounded-card bg-sunken p-3">
        {alt ? (
          <span className="block text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {alt}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="aspect-square w-full rounded-card object-cover"
    />
  );
}

function GalleryPreviewImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex min-h-48 w-full items-center justify-center rounded-card bg-sunken p-4">
        {alt ? (
          <span className="text-center text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {alt}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex max-h-[65vh] w-full items-center justify-center overflow-hidden rounded-card bg-sunken">
      <img
        src={src}
        alt={alt}
        onError={() => setFailed(true)}
        className="max-h-[65vh] w-auto max-w-full object-contain"
      />
    </div>
  );
}

export function ImageGallery({
  props,
}: RenderProps<{ images: Array<{ src: string; alt?: string; details?: string }> }>) {
  const images = (props.images ?? []).filter((image) => image?.src);
  const [expanded, setExpanded] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  if (images.length === 0) return null;

  const hasOverflow = images.length > MAX_GRID_IMAGES;
  const visibleImages = expanded ? images : images.slice(0, MAX_GRID_IMAGES);
  const activeIndex =
    previewIndex !== null && previewIndex >= 0 && previewIndex < images.length
      ? previewIndex
      : null;
  const activeImage = activeIndex !== null ? images[activeIndex] : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {visibleImages.map((image, index) => (
          <figure
            // biome-ignore lint/suspicious/noArrayIndexKey: 图片 URL 可能重复，需要索引消除冲突
            key={`${image.src}-${index}`}
            className="min-w-0"
          >
            <Button
              type="button"
              variant="plain"
              aria-label={image.alt ? `预览 ${image.alt}` : `预览第 ${index + 1} 张图片`}
              onClick={() => setPreviewIndex(index)}
              className="block h-auto w-full overflow-hidden rounded-card p-0"
            >
              <GalleryThumbnail key={image.src} src={image.src} alt={image.alt ?? ''} />
            </Button>
            {image.details ? (
              <figcaption className="mt-1 text-xs text-muted-foreground">
                {image.details}
              </figcaption>
            ) : null}
          </figure>
        ))}
      </div>
      {hasOverflow ? (
        <div className="flex justify-start">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setExpanded((previous) => !previous)}
          >
            {expanded ? '收起' : `查看全部（${images.length} 张）`}
          </Button>
        </div>
      ) : null}
      <Dialog
        open={activeIndex !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewIndex(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          {activeImage && activeIndex !== null ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {activeImage.alt || `图片 ${activeIndex + 1} / ${images.length}`}
                </DialogTitle>
                <DialogDescription>
                  {activeImage.details || `第 ${activeIndex + 1} 张，共 ${images.length} 张`}
                </DialogDescription>
              </DialogHeader>
              <GalleryPreviewImage
                key={activeImage.src}
                src={activeImage.src}
                alt={activeImage.alt ?? ''}
              />
              {images.length > 1 ? (
                <div className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPreviewIndex((activeIndex - 1 + images.length) % images.length)
                    }
                  >
                    <ChevronLeft aria-hidden="true" />
                    上一张
                  </Button>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {activeIndex + 1} / {images.length}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPreviewIndex((activeIndex + 1) % images.length)}
                  >
                    下一张
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ImageText({
  props,
}: RenderProps<{
  src: string;
  alt?: string;
  title: string;
  subtitle?: string;
  bold: boolean;
  layout: 'horizontal' | 'vertical';
  imageSize?: number;
}>) {
  if (!props.src) return null;
  const vertical = props.layout === 'vertical';
  const size = props.imageSize ?? 40;
  return (
    <div className={cn('flex min-w-0 gap-3', vertical ? 'flex-col items-start' : 'items-center')}>
      <div
        className="size-(--media-size) shrink-0 overflow-hidden rounded-icon bg-sunken"
        style={{ '--media-size': `${size}px` } as CSSProperties}
      >
        <img
          src={props.src}
          alt={props.alt ?? props.title ?? ''}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      </div>
      <ValueText
        value={props.title}
        subtext={props.subtitle}
        bold={props.bold}
        size={vertical ? 'sm' : 'xs'}
      />
    </div>
  );
}

export function ImageTextLarge({
  props,
}: RenderProps<{ src: string; alt?: string; title: string; subtitle?: string; bold: boolean }>) {
  if (!props.src) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ReservedImage src={props.src} alt={props.alt ?? props.title ?? ''} />
      <ValueText value={props.title} subtext={props.subtitle} bold={props.bold} size="sm" />
    </div>
  );
}

const TAG_TONES = {
  neutral: 'default',
  info: 'outline',
  success: 'success',
  warning: 'warn',
  danger: 'danger',
} as const;

const TAG_SIZES = {
  sm: 'h-5 px-1.5 text-xs gap-1',
  md: 'h-6 px-2 text-sm gap-1.5',
  lg: 'h-7 px-2.5 text-base gap-1.5',
} as const;

export function Tag({
  props,
  renderNode,
}: RenderProps<{
  text: string;
  icon?: unknown;
  size?: keyof typeof TAG_SIZES;
  variant?: keyof typeof TAG_TONES;
}>) {
  return (
    <StatusBadge
      tone={TAG_TONES[props.variant ?? 'neutral']}
      className={cn('max-w-full', TAG_SIZES[props.size ?? 'md'])}
    >
      {props.icon ? renderNode(props.icon) : null}
      <span className="truncate">{props.text}</span>
    </StatusBadge>
  );
}

export function TagBlock({
  props,
}: RenderProps<{ tags: string[]; size?: keyof typeof TAG_SIZES }>) {
  const tags = props.tags ?? [];
  if (tags.length === 0) return null;
  const sizeClass = TAG_SIZES[props.size ?? 'md'];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 标签由模型按顺序生成，文本可能重复
        <StatusBadge key={`${tag}-${index}`} tone="default" className={cn('max-w-full', sizeClass)}>
          <span className="truncate">{tag}</span>
        </StatusBadge>
      ))}
    </div>
  );
}
