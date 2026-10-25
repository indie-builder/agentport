import { type ReactNode, useState } from 'react';
import { cn } from '../lib/cn.js';
import { CopyButton } from './copy-button.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './motion-collapsible.js';

const JSON_TOKEN =
  /"(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:|"(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"|\b(?:true|false|(null))\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** 轻量 JSON 高亮：null 表示缺失，用弱化文字；其余 token 与正文同色，避免引入高亮依赖。 */
export function highlightJson(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const start = match.index;
    if (start > last) nodes.push(text.slice(last, start));
    const [token] = match;
    const className = match[1] === 'null' ? 'text-muted-foreground' : 'text-fg';
    nodes.push(
      <span key={index++} className={className}>
        {token}
      </span>,
    );
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** 尽量 pretty-print JSON；解析失败原样返回，避免吞掉上游错误文本。 */
export function prettyJson(value: string | unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 单块内容超过该长度时默认折叠：整块渲染会明显拖慢页面。 */
export const LARGE_CONTENT_CHARS = 64 * 1024;

export function CodeBlock({
  code,
  lineNumbers = false,
  maxHeight = '65vh',
  className,
  copyLabel = '复制',
  json = false,
}: {
  code: string;
  lineNumbers?: boolean;
  maxHeight?: string;
  className?: string;
  copyLabel?: string;
  json?: boolean;
}) {
  // 超大内容默认不渲染，避免一次插入数万行 DOM。
  const [expanded, setExpanded] = useState(false);
  const large = code.length > LARGE_CONTENT_CHARS;
  const open = !large || expanded;

  // Collapsible is unstyled; keep the code surface, border, and container corners.
  return (
    <Collapsible
      open={open}
      onOpenChange={setExpanded}
      className={cn('group relative overflow-hidden rounded-card border bg-code', className)}
    >
      {large && (
        // Keep compact disclosure text and its focus ring; the primitive supplies no styling.
        <CollapsibleTrigger className="px-3 py-2 text-xs text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {expanded ? '收起内容' : '内容过大，点击查看'}
        </CollapsibleTrigger>
      )}
      <CollapsibleContent>
        {open && (
          <>
            <CopyButton
              value={code}
              label={copyLabel}
              showLabel
              className="absolute right-2 top-2 z-10 bg-surface/90 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
            />
            {/* 滚动区可聚焦，键盘用户才能用方向键/PageDown 浏览超长内容。 */}
            <section
              // biome-ignore lint/a11y/noNoninteractiveTabindex: 滚动容器必须进入键盘序列才能滚动
              tabIndex={0}
              aria-label="代码内容"
              className="overflow-auto overscroll-contain"
              style={{ maxHeight }}
            >
              <pre className="py-3 font-mono text-xs leading-5">
                <code className="block">
                  {code.split('\n').map((line, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 代码行没有稳定 id，行号即身份
                    <span key={i} className="flex min-w-max px-3">
                      {lineNumbers ? (
                        <span
                          aria-hidden="true"
                          className="mr-3 inline-block w-8 shrink-0 select-none text-right text-muted-foreground"
                        >
                          {i + 1}
                        </span>
                      ) : null}
                      <span className="whitespace-pre text-fg/90">
                        {json ? highlightJson(line) : line || ' '}
                      </span>
                    </span>
                  ))}
                </code>
              </pre>
            </section>
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function JsonBlock({
  value,
  maxHeight = '20rem',
}: {
  value: string | unknown;
  maxHeight?: string;
}) {
  return <CodeBlock code={prettyJson(value)} lineNumbers={false} json maxHeight={maxHeight} />;
}

export function CollapsibleText({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= LARGE_CONTENT_CHARS) return <div className={className}>{text}</div>;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      {/* Keep compact disclosure text and its focus ring; the primitive supplies no styling. */}
      <CollapsibleTrigger className="text-xs text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {open ? '收起内容' : '内容过大，点击查看'}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1">{text}</CollapsibleContent>
    </Collapsible>
  );
}
