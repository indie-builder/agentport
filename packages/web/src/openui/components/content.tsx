import { useIsStreaming } from '@openuidev/react-lang';
import { useState } from 'react';
import { Markdown } from '../../components/markdown.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { cn } from '../../lib/cn.js';
import { type RenderProps, ValueText } from './shared.js';

/** TextContent 的字号与行高：small 13/20、default 14/22、large 16/24。 */
const CONTENT_SIZES = {
  small: 'text-sm text-muted-foreground',
  default: 'text-base text-fg',
  large: 'text-lg text-fg',
  'small-heavy': 'text-sm font-medium text-fg',
  'large-heavy': 'text-lg font-semibold text-fg',
} as const;

export function TextContentRenderer({ props }: RenderProps<{ text: string; size?: string }>) {
  const streaming = useIsStreaming();
  const size = (props.size ?? 'default') as keyof typeof CONTENT_SIZES;
  return (
    <div className={cn('min-w-0', CONTENT_SIZES[size] ?? CONTENT_SIZES.default)}>
      {/* 字号与颜色由上面的容器决定，Markdown 不再覆盖成正文档。 */}
      <Markdown text={String(props.text ?? '')} streaming={streaming} presentation="inherit" />
    </div>
  );
}

const MD_VARIANTS = {
  clear: '',
  card: 'rounded-card bg-chip p-3',
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
  info: { line: 'border-line-strong', title: 'text-fg' },
  neutral: { line: 'border-line', title: 'text-muted-foreground' },
  success: { line: 'border-success', title: 'text-success' },
  warning: { line: 'border-warning', title: 'text-warning' },
  error: { line: 'border-danger', title: 'text-danger' },
} as const;

export function Callout({
  props,
}: RenderProps<{
  variant: keyof typeof CALLOUT_TONES;
  title: string;
  description: string;
  visible?: boolean;
}>) {
  const streaming = useIsStreaming();
  if (props.visible === false) return null;
  const tone = CALLOUT_TONES[props.variant ?? 'neutral'];
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 border-l pl-3', tone.line)}>
      <span className={cn('text-base font-medium', tone.title)}>{props.title}</span>
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

/** 代码含三反引号时，围栏要比最长连续反引号更长，否则 Streamdown 会提前闭合。 */
function fenceFor(code: string): string {
  let longest = 0;
  for (const match of code.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function CodeBlock({ props }: RenderProps<{ language: string; codeString: string }>) {
  const streaming = useIsStreaming();
  const code = String(props.codeString ?? '');
  const fence = fenceFor(code);
  // 交给消息同一套 Streamdown，沿用灰度 Shiki 主题、复制按钮与代码块圆角；
  // 语言名只保留字母数字，避免注入额外围栏元数据。
  const language = String(props.language ?? '').replace(/[^\w+#.-]/g, '');
  return <Markdown text={`${fence}${language}\n${code}\n${fence}`} streaming={streaming} />;
}

/**
 * 官方 Image 默认 3:2（react-ui components/Image/Image.tsx 的 aspectRatioMap），
 * 先按比例占好空间，流式生成或图片加载时都不会再跳布局；失败时保留框并露出 alt。
 * 用 contain 完整容纳原图，不为了填满 3:2 裁掉主体。
 */
function ReservedImage({ src, alt }: { src: string; alt: string }) {
  // src 在流式生成中会变化；key 让加载/失败状态随地址重置，A→B→A 时重新请求而不是复用旧的失败结果。
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

/** 没有真实 URL 的图片不渲染：占位块只会让人以为图挂了。 */
export function ImageRenderer({ props }: RenderProps<{ alt: string; src?: string }>) {
  if (!props.src) return null;
  return <ReservedImage src={props.src} alt={props.alt ?? ''} />;
}

/**
 * 官方 ImageBlock 按原图几何渲染（w-full h-auto），骨架只出现在加载期间，不设比例/固定终态高度。
 * schema 没有宽高字段，原图比例未知时加载完成会有一次高度收敛，无法承诺零位移。
 */
export function ImageBlock({ props }: RenderProps<{ src: string; alt?: string }>) {
  if (!props.src) return null;
  // 同上：按 src 重置状态，换地址（含切回旧地址）都会重新加载。
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

export function ImageGallery({
  props,
}: RenderProps<{ images: Array<{ src: string; alt?: string; details?: string }> }>) {
  const images = (props.images ?? []).filter((image) => image?.src);
  if (images.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {images.map((image) => (
        <figure key={image.src} className="min-w-0">
          <img
            src={image.src}
            alt={image.alt ?? ''}
            loading="lazy"
            className="aspect-square w-full rounded-card object-cover"
          />
          {image.details ? (
            <figcaption className="mt-1 text-xs text-muted-foreground">{image.details}</figcaption>
          ) : null}
        </figure>
      ))}
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
  // 项目小缩略图默认 40px，竖排仍按缩略图呈现；显式 imageSize 优先。
  const size = props.imageSize ?? 40;
  return (
    <div className={cn('flex min-w-0 gap-3', vertical ? 'flex-col items-start' : 'items-center')}>
      <div
        className="shrink-0 overflow-hidden rounded-icon bg-sunken"
        style={{ width: size, height: size }}
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

export function Tag({
  props,
  renderNode,
}: RenderProps<{
  text: string;
  icon?: unknown;
  size?: 'sm' | 'md' | 'lg';
  variant?: keyof typeof TAG_TONES;
}>) {
  return (
    <StatusBadge tone={TAG_TONES[props.variant ?? 'neutral']} className="max-w-full">
      {props.icon ? renderNode(props.icon) : null}
      <span className="truncate">{props.text}</span>
    </StatusBadge>
  );
}

export function TagBlock({ props }: RenderProps<{ tags: string[]; size?: 'sm' | 'md' | 'lg' }>) {
  const tags = props.tags ?? [];
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 标签由模型按顺序生成，文本可能重复
        <StatusBadge key={`${tag}-${index}`} tone="default" className="max-w-full">
          <span className="truncate">{tag}</span>
        </StatusBadge>
      ))}
    </div>
  );
}
