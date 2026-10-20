import { Check, Copy } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../lib/cn.js';

const JSON_TOKEN =
  /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:)|("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** 轻量 JSON 高亮：只区分键、字符串、字面量、数字，够读且不引入依赖。 */
export function highlightJson(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const start = match.index;
    if (start > last) nodes.push(text.slice(last, start));
    const [token, key, string, literal, number] = match;
    // 浅色底上要压深：颜色只区分词法类别，不承担装饰。
    let className = 'text-fg';
    if (key) className = 'text-code-key';
    else if (string) className = 'text-code-string';
    else if (literal) className = literal === 'null' ? 'text-subtle' : 'text-code-literal';
    else if (number) className = 'text-code-number';
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
  const [copied, setCopied] = useState(false);
  // 超大内容默认不渲染，避免一次插入数万行 DOM。
  const [expanded, setExpanded] = useState(false);
  const lines = code.split('\n');

  if (code.length > LARGE_CONTENT_CHARS && !expanded) {
    return (
      <div className={cn('rounded-[3px] border border-line bg-code px-3 py-2', className)}>
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
          className="text-xs text-signal-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        >
          内容过大，点击查看
        </button>
      </div>
    );
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 非安全上下文或权限被拒时静默失败，内容仍可手动选择。
    }
  };

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-[3px] border border-line bg-code',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? '已复制' : copyLabel}
        className="absolute right-2 top-2 z-10 flex h-7 items-center gap-1 rounded-[2px] border border-line bg-surface/90 px-2 text-2xs text-muted opacity-0 backdrop-blur transition-opacity hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal group-hover:opacity-100"
      >
        {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
        {copied ? '已复制' : copyLabel}
      </button>
      <pre className="overflow-auto py-3 font-mono text-xs leading-5" style={{ maxHeight }}>
        <code className="block">
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 代码行没有稳定 id，行号即身份
            <span key={i} className="flex min-w-max px-3">
              {lineNumbers ? (
                <span
                  aria-hidden="true"
                  className="mr-3 inline-block w-8 shrink-0 select-none text-right text-subtle/50"
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
    </div>
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
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="text-xs text-signal-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
      >
        {open ? '收起内容' : '内容过大，点击查看'}
      </button>
      {open ? <div className="mt-1">{text}</div> : null}
    </div>
  );
}
