import { code, type ThemeInput } from '@streamdown/code';
import { type ComponentProps, type CSSProperties, memo, useDeferredValue, useMemo } from 'react';
import {
  type Components,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
} from 'streamdown';
import { cn } from '../lib/cn.js';

function grayscaleTheme(name: string): ThemeInput {
  const token = (key: string) => `var(--shiki-${key})`;
  return {
    name,
    type: 'light',
    colors: {
      'editor.background': token('background'),
      'editor.foreground': token('foreground'),
    },
    tokenColors: [
      {
        scope: ['comment', 'string.quoted.docstring.multi'],
        settings: { foreground: token('token-comment') },
      },
      {
        scope: ['string', 'markup.fenced_code', 'markup.inline'],
        settings: { foreground: token('token-string') },
      },
      {
        scope: [
          'entity.name.tag',
          'string.quoted',
          'string.regexp',
          'string.interpolated',
          'string.template',
          'keyword.other.template',
        ],
        settings: { foreground: token('token-string-expression') },
      },
      {
        scope: [
          'constant.numeric',
          'constant.language',
          'constant.other.placeholder',
          'variable.language.this',
          'variable.other.object',
          'variable.other.class',
          'variable.other.constant',
          'meta.property-name',
          'meta.property-value',
          'support',
        ],
        settings: { foreground: token('token-constant') },
      },
      {
        scope: [
          'keyword',
          'storage.modifier',
          'storage.type',
          'entity.name.tag.yaml',
          'punctuation.separator.key-value',
          'punctuation.definition.template-expression',
        ],
        settings: { foreground: token('token-keyword') },
      },
      {
        scope: [
          'support.function',
          'entity.name.type',
          'entity.other.inherited-class',
          'meta.function-call',
          'entity.other.attribute-name',
          'entity.name.function',
        ],
        settings: { foreground: token('token-function') },
      },
      {
        scope: ['variable.parameter.function'],
        settings: { foreground: token('token-parameter') },
      },
      {
        scope: [
          'punctuation.definition.arguments',
          'punctuation.definition.dict',
          'punctuation.separator',
          'meta.function-call.arguments',
        ],
        settings: { foreground: token('token-punctuation') },
      },
      {
        scope: [
          'markup.underline.link',
          'punctuation.definition.metadata.markdown',
          'meta.link.inline.markdown',
        ],
        settings: { foreground: token('token-link') },
      },
    ],
  };
}

const SHIKI_THEMES: [ThemeInput, ThemeInput] = [
  grayscaleTheme('agentport-grayscale-light'),
  grayscaleTheme('agentport-grayscale-dark'),
];
const PLUGINS = { code };

const SUBHEADING_STYLE: CSSProperties = { fontSize: 'max(1em, var(--text-base))' };

const heading = (
  tag: 'h2' | 'h3' | 'h4' | 'h5' | 'h6',
  className: string,
  style?: CSSProperties,
) => {
  const Heading = tag;
  return ({ children, node: _node, ...props }: ComponentProps<'h2'> & { node?: unknown }) => (
    <Heading {...props} className={className} style={style}>
      {children}
    </Heading>
  );
};

/** 外链新开页并补齐 noopener；Streamdown 默认只给 noreferrer。 */
const components: Components = {
  h1: heading('h2', 'mt-5 mb-2 text-xl font-semibold'),
  h2: heading('h3', 'mt-4 mb-2 text-lg font-semibold'),
  h3: heading('h4', 'mt-3.5 mb-1.5 text-base font-semibold', SUBHEADING_STYLE),
  h4: heading('h5', 'mt-3 mb-1 text-base font-semibold', SUBHEADING_STYLE),
  h5: heading('h6', 'mt-3 mb-1 text-base font-semibold', SUBHEADING_STYLE),
  h6: heading('h6', 'mt-3 mb-1 text-base font-semibold', SUBHEADING_STYLE),
  a: ({ href, children, node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) => {
    // 流式中的未闭合链接由 remend 标成哨兵值，不能变成可点击的相对地址。
    if (href === 'streamdown:incomplete-link') {
      return (
        <span className="break-words font-medium text-fg underline decoration-line-strong underline-offset-2">
          {children}
        </span>
      );
    }
    const external = /^https?:\/\//i.test(href ?? '');
    return (
      <a
        {...props}
        href={href}
        className="break-words font-medium text-[var(--color-link)] underline decoration-line-strong underline-offset-2 hover:decoration-primary"
        {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      >
        {children}
      </a>
    );
  },
};

const CODE_BLOCK_CLASS =
  '[&_[data-streamdown=inline-code]]:bg-code [&_[data-streamdown=code-block]]:rounded-card [&_[data-streamdown=code-block]]:border-white/10 [&_[data-streamdown=code-block]]:bg-[var(--color-code-block)] [&_[data-streamdown=code-block]]:text-[var(--color-code-block-fg)] [&_[data-streamdown=code-block-body]]:border-white/10 [&_[data-streamdown=code-block-body]]:bg-transparent';
const PARAGRAPH_CLASS = '[&_p]:whitespace-pre-wrap';
const BODY_CLASS = `min-w-0 text-base text-fg ${PARAGRAPH_CLASS} ${CODE_BLOCK_CLASS}`;
const INHERIT_CLASS = `min-w-0 ${PARAGRAPH_CLASS} ${CODE_BLOCK_CLASS}`;

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
};

const htmlAsText = () => (tree: MarkdownNode) => {
  const walk = (nodes: MarkdownNode[]) => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node) continue;
      if (node.type === 'html') {
        nodes[index] = { type: 'text', value: node.value ?? '' };
      } else if (node.children) {
        walk(node.children);
      }
    }
  };
  walk(tree.children ?? []);
};

type RehypePlugins = NonNullable<Parameters<typeof Streamdown>[0]['rehypePlugins']>;
type RehypeTuple = Extract<RehypePlugins[number], readonly unknown[]>;
const STATIC_REHYPE_PLUGINS: RehypePlugins = Object.entries(defaultRehypePlugins)
  .filter(([name]) => name !== 'raw' && name !== 'undoubleClobberPrefix')
  .map(([name, plugin]) => {
    if (name !== 'sanitize') return plugin;
    const [sanitize, schema] = plugin as RehypeTuple;
    return [sanitize, { ...schema, clobberPrefix: '' }];
  });
const STATIC_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), htmlAsText];
type RemarkPlugins = NonNullable<Parameters<typeof Streamdown>[0]['remarkPlugins']>;

const LINK_CLASS =
  'break-words font-medium text-[var(--color-link)] underline decoration-line-strong underline-offset-2';

/** 本地文件链接的 fragment 前缀；harden 放行纯 fragment，且不会改写其中的路径。 */
const PLUGIN_FILE_PREFIX = '#plugin-file=';
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export interface MarkdownFileLinks {
  from: string;
  files: ReadonlySet<string>;
  onSelect: (path: string) => void;
}

function resolvePluginFile(
  from: string,
  href: string,
  files: ReadonlySet<string>,
): string | undefined {
  let clean = href.split(/[?#]/, 1)[0] ?? '';
  try {
    clean = decodeURIComponent(clean);
  } catch {
    return undefined;
  }
  const segments = href.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const segment of clean.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const path = segments.join('/');
  return files.has(path) ? path : undefined;
}

function pluginFilePath(href: string): string | undefined {
  if (!href.startsWith(PLUGIN_FILE_PREFIX)) return undefined;
  try {
    return decodeURIComponent(href.slice(PLUGIN_FILE_PREFIX.length));
  } catch {
    return undefined;
  }
}

/**
 * 本地文件链接在 harden 之前换成只含 fragment 的 token：harden 会重写相对 URL
 * （裸路径被拦、`..` 被塌到根、`//host` 丢 host），原始语义只有 mdast 阶段还完整。
 * 引用式链接在这里按 definition 解析成普通 link，才能和行内链接走同一套规则。
 * 参数走插件 options，流式解析器按插件名 + options 缓存处理器，闭包会让不同文件复用旧映射。
 */
const rewriteLinks = (options: { from: string; files: string[] }) => (tree: MarkdownNode) => {
  const files = new Set(options.files);
  const rewriteUrl = (url: string): string | undefined => {
    if (url.startsWith('//')) {
      // harden 会把协议相对地址塌成本地路径；显式补成外链。
      return `https:${url}`;
    }
    if (url.startsWith('#') || URL_SCHEME.test(url)) return url;
    const path = resolvePluginFile(options.from, url, files);
    return path === undefined ? undefined : `${PLUGIN_FILE_PREFIX}${encodeURIComponent(path)}`;
  };
  const definitions = new Map<string, string | undefined>();
  const collect = (nodes: MarkdownNode[]) => {
    for (const node of nodes) {
      if (node.type === 'definition') {
        definitions.set(String(node.identifier).toUpperCase(), rewriteUrl(node.url ?? ''));
      } else if (node.children) {
        collect(node.children);
      }
    }
  };
  collect(tree.children ?? []);
  const walk = (nodes: MarkdownNode[]) => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node) continue;
      if (node.type === 'link') {
        const url = rewriteUrl(node.url ?? '');
        if (url === undefined) {
          nodes.splice(index, 1, ...(node.children ?? []));
        } else {
          nodes[index] = { ...node, url };
        }
      } else if (node.type === 'linkReference') {
        const identifier = String(node.identifier).toUpperCase();
        if (definitions.has(identifier)) {
          const url = definitions.get(identifier);
          if (url === undefined) {
            nodes.splice(index, 1, ...(node.children ?? []));
          } else {
            nodes[index] = { ...node, type: 'link', url };
          }
        }
      } else if (node.children) {
        walk(node.children);
      }
    }
  };
  walk(tree.children ?? []);
};

function isSafeExternal(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href) || href.startsWith('//');
}

const staticAnchor =
  (fileLinks?: MarkdownFileLinks) =>
  ({ href, children, node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) => {
    const url = href ?? '';
    const path = pluginFilePath(url);
    if (path !== undefined) {
      if (fileLinks === undefined || !fileLinks.files.has(path)) {
        return <span className={cn(LINK_CLASS, 'text-fg')}>{children}</span>;
      }
      return (
        <button type="button" onClick={() => fileLinks.onSelect(path)} className={LINK_CLASS}>
          {children}
        </button>
      );
    }
    if (!url.startsWith('#') && !isSafeExternal(url)) {
      return <span className={cn(LINK_CLASS, 'text-fg')}>{children}</span>;
    }
    const external = /^https?:|^\/\//i.test(url);
    // 页内 fragment 不能沿用 harden 加的 target=_blank，否则跳转落在新标签页。
    const browsing = url.startsWith('#') ? { target: undefined, rel: undefined } : {};
    return (
      <a
        {...props}
        href={url}
        className={`${LINK_CLASS} hover:decoration-primary`}
        {...browsing}
        {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      >
        {children}
      </a>
    );
  };

function staticComponents(fileLinks?: MarkdownFileLinks): Components {
  return { ...components, a: staticAnchor(fileLinks) };
}

export interface MarkdownProps {
  text: string;
  streaming?: boolean;
  className?: string;
  presentation?: 'body' | 'inherit';
  staticContent?: boolean;
  fileLinks?: MarkdownFileLinks;
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  className,
  presentation = 'body',
  staticContent = false,
  fileLinks,
}: MarkdownProps) {
  const deferred = useDeferredValue(text);
  const resolvedComponents = useMemo(
    () => (staticContent ? staticComponents(fileLinks) : components),
    [staticContent, fileLinks],
  );
  const remarkPlugins = useMemo<RemarkPlugins>(() => {
    if (!staticContent) return STATIC_REMARK_PLUGINS;
    // 插件与其 options 以元组传入，解析器据此缓存处理器；options 必须完整描述映射。
    return [
      ...STATIC_REMARK_PLUGINS,
      [
        rewriteLinks,
        {
          from: fileLinks?.from ?? '',
          files: fileLinks === undefined ? [] : [...fileLinks.files].sort(),
        },
      ],
    ];
  }, [staticContent, fileLinks]);
  const live = streaming && !staticContent;
  return (
    <Streamdown
      {...(staticContent
        ? {
            mode: 'static' as const,
            rehypePlugins: STATIC_REHYPE_PLUGINS,
            remarkPlugins,
          }
        : {})}
      className={cn(presentation === 'inherit' ? INHERIT_CLASS : BODY_CLASS, className)}
      components={resolvedComponents}
      plugins={PLUGINS}
      shikiTheme={SHIKI_THEMES}
      mode={live ? 'streaming' : 'static'}
      isAnimating={live}
      animated={false}
    >
      {live ? deferred : text}
    </Streamdown>
  );
});
