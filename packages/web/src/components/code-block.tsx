import { createContext, type ReactNode, useContext, useState } from 'react';
import { cn } from '../lib/cn.js';
import { CopyButton } from './copy-button.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './motion-collapsible.js';

export const CodeBlockCopyAllowed = createContext(true);

const JSON_TOKEN =
  /"(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:|"(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"|\b(?:true|false|(null))\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function highlightJson(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const start = match.index;
    if (start > last) nodes.push(text.slice(last, start));
    const [token] = match;
    const className = match[1] === 'null' ? 'text-code-block-dim' : 'text-code-block-fg';
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

export const LARGE_CONTENT_CHARS = 64 * 1024;

/** 行拆分放在子组件里：Panel 收起时不挂载它，超大内容就不会被提前构造。 */
function CodeLines({
  code,
  lineNumbers,
  json,
}: {
  code: string;
  lineNumbers: boolean;
  json: boolean;
}) {
  return (
    <code className="block">
      {code.split('\n').map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 代码行没有稳定 id，行号即身份
        <span key={i} className="flex min-w-max px-3">
          {lineNumbers ? (
            <span
              aria-hidden="true"
              className="mr-3 inline-block w-8 shrink-0 select-none text-right text-code-block-faint"
            >
              {i + 1}
            </span>
          ) : null}
          <span className="whitespace-pre text-code-block-fg">
            {json ? highlightJson(line) : line || ' '}
          </span>
        </span>
      ))}
    </code>
  );
}

export function CodeBlock({
  code,
  lineNumbers = false,
  maxHeight = '65vh',
  className,
  copyLabel = '复制',
  json = false,
  copyable = true,
}: {
  code: string;
  lineNumbers?: boolean;
  maxHeight?: string;
  className?: string;
  copyLabel?: string;
  json?: boolean;
  copyable?: boolean;
}) {
  const copyAllowed = useContext(CodeBlockCopyAllowed);
  const [expanded, setExpanded] = useState(false);
  const large = code.length > LARGE_CONTENT_CHARS;
  const open = !large || expanded;

  return (
    <Collapsible
      open={open}
      onOpenChange={setExpanded}
      className={cn(
        'cds-code-surface group relative overflow-hidden rounded-card border border-code-block-border bg-code-block text-code-block-fg',
        className,
      )}
    >
      {large && (
        <CollapsibleTrigger className="px-3 py-2 text-xs hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-code-block-fg">
          {expanded ? '收起内容' : '内容过大，点击查看'}
        </CollapsibleTrigger>
      )}
      <CollapsibleContent animated>
        {copyable && copyAllowed ? (
          <span className="absolute right-2 top-2 z-10 inline-flex [@media(hover:hover)_and_(pointer:fine)]:opacity-0 transition-opacity duration-150 ease-out-soft group-focus-within:opacity-100 has-focus-visible:opacity-100 group-hover:opacity-100">
            <CopyButton
              value={code}
              label={copyLabel}
              showLabel
              className="bg-surface/90 text-fg focus-visible:ring-code-block-fg"
            />
          </span>
        ) : null}
        <section
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 滚动容器必须进入键盘序列才能滚动
          tabIndex={0}
          aria-label="代码内容"
          className="overflow-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-code-block-fg"
          style={{ maxHeight }}
        >
          <pre className="py-3 font-mono text-xs leading-5">
            <CodeLines code={code} lineNumbers={lineNumbers} json={json} />
          </pre>
        </section>
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
      <CollapsibleTrigger className="text-xs text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {open ? '收起内容' : '内容过大，点击查看'}
      </CollapsibleTrigger>
      <CollapsibleContent animated className="pt-1">
        {text}
      </CollapsibleContent>
    </Collapsible>
  );
}
