import { code, type ThemeInput } from '@streamdown/code';
import { type ComponentProps, type CSSProperties, memo, useDeferredValue, useMemo } from 'react';
import {
  type Components,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
} from 'streamdown';
import { cn } from '../lib/cn.js';

/**
 * Shiki 的 css-variables 主题：颜色全部落在 styles.css 的 --shiki-* 变量上，
 * 高亮配色（含中性主色关键字）只由主题令牌决定。
 */
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

// H3–H6 固定 15px 在大字号容器（TextContent large 的 16px 正文）里会倒挂。
// 1em 下限跟随父级字号；默认 15px 正文下仍是原档位。
const SUBHEADING_STYLE: CSSProperties = { fontSize: 'max(1em, var(--text-md))' };

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
  // 消息内标题整体下移一级：页面本身已有 h1，不能再出现第二个 h1。
  // 正文只有一级（md 15px），任何标题都不小于它：H1 18、H2 16 靠字号递进，
  // H3–H6 收成一级 15/600，靠字重区分。小于正文的标题会比它概括的内容还弱。
  // 标题不写 text-fg：颜色跟随所在容器，Callout 与 TextContent 的语义色才能生效。
  h1: heading('h2', 'mt-5 mb-2 text-xl font-semibold'),
  h2: heading('h3', 'mt-4 mb-2 text-lg font-semibold'),
  h3: heading('h4', 'mt-3.5 mb-1.5 text-md font-semibold', SUBHEADING_STYLE),
  h4: heading('h5', 'mt-3 mb-1 text-md font-semibold', SUBHEADING_STYLE),
  h5: heading('h6', 'mt-3 mb-1 text-md font-semibold', SUBHEADING_STYLE),
  h6: heading('h6', 'mt-3 mb-1 text-md font-semibold', SUBHEADING_STYLE),
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
        className="break-words font-medium text-primary underline decoration-line-strong underline-offset-2 hover:decoration-primary"
        {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      >
        {children}
      </a>
    );
  },
};

// 代码块沿用消息同一套灰度主题与圆角；类名保持常量，Streamdown 的 memo 才能命中。
const CODE_BLOCK_CLASS =
  '[&_[data-streamdown=code-block]]:rounded-card [&_[data-streamdown=code-block]]:border-line [&_[data-streamdown=code-block]]:bg-code [&_[data-streamdown=code-block-body]]:bg-transparent';
// 单换行保留：模型常按行生成纯文本，折叠成空格会改变原意（与旧的纯文本路径一致）。
const PARAGRAPH_CLASS = '[&_p]:whitespace-pre-wrap';
const BODY_CLASS = `min-w-0 text-md text-fg ${PARAGRAPH_CLASS} ${CODE_BLOCK_CLASS}`;
// 父级决定字号与颜色：OpenUI 的 TextContent/Callout 等容器自己带排版。
const INHERIT_CLASS = `min-w-0 ${PARAGRAPH_CLASS} ${CODE_BLOCK_CLASS}`;

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
};

/** 移除 raw 后，remark 阶段把 HTML 节点换成文本，HTML 只作为字面量出现。 */
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

/** 静态正文：明确移除 raw，保留 sanitize / harden；本地链接先改写成本项目可识别的 fragment。 */
const STATIC_REHYPE_PLUGINS = Object.entries(defaultRehypePlugins)
  .filter(([name]) => name !== 'raw')
  .map(([, plugin]) => plugin);
const STATIC_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), htmlAsText];
type RemarkPlugins = NonNullable<Parameters<typeof Streamdown>[0]['remarkPlugins']>;

const LINK_CLASS = 'break-words font-medium underline decoration-line-strong underline-offset-2';

/** 本地文件链接的 fragment 前缀；harden 放行纯 fragment，且不会改写其中的路径。 */
const PLUGIN_FILE_PREFIX = '#plugin-file=';
/** 任何带 scheme 的地址（http:/mailto:/javascript: 等）都不属于本地文件。 */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export interface MarkdownFileLinks {
  /** 当前 Markdown 文件路径，相对链接以它所在目录为基准。 */
  from: string;
  /** 插件内真实存在的文件路径；只有命中这里的链接才可点击。 */
  files: ReadonlySet<string>;
  onSelect: (path: string) => void;
}

/** `./`、`../` 与裸路径按当前目录解析一次，`/` 按插件根；其余越界或不存在返回 undefined。 */
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
  /** 改写单个地址：外链原样（协议相对补全），本地文件换成 token，不可点击返回 undefined。 */
  const rewriteUrl = (url: string): string | undefined => {
    if (url.startsWith('//')) {
      // harden 会把协议相对地址塌成本地路径；显式补成外链。
      return `https:${url}`;
    }
    if (url.startsWith('#') || URL_SCHEME.test(url)) return url;
    const path = resolvePluginFile(options.from, url, files);
    return path === undefined ? undefined : `${PLUGIN_FILE_PREFIX}${encodeURIComponent(path)}`;
  };
  // definition 可以出现在文档任意位置，先整体收集；identifier 已由解析器规范化，按库的惯例忽略大小写。
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
          // 没有对应真实文件的本地链接退回文字，不交给 harden 误判成本地路由。
          nodes.splice(index, 1, ...(node.children ?? []));
        } else {
          nodes[index] = { ...node, url };
        }
      } else if (node.type === 'linkReference') {
        const identifier = String(node.identifier).toUpperCase();
        // 无 definition 的引用保持原样，交给 to-hast 按字面输出；目标不存在的退回文字。
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

/** 静态正文的链接：只打开安全外链、页内 fragment 或插件内真实文件，其余按文字呈现。 */
const staticAnchor =
  (fileLinks?: MarkdownFileLinks) =>
  ({ href, children, node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) => {
    const url = href ?? '';
    const path = pluginFilePath(url);
    if (path !== undefined) {
      // token 也可能来自正文直接书写，只有白名单里的真实文件才可点击。
      if (fileLinks === undefined || !fileLinks.files.has(path)) {
        return <span className={`${LINK_CLASS} text-fg`}>{children}</span>;
      }
      return (
        <button
          type="button"
          onClick={() => fileLinks.onSelect(path)}
          className={`${LINK_CLASS} text-primary`}
        >
          {children}
        </button>
      );
    }
    if (!url.startsWith('#') && !isSafeExternal(url)) {
      return <span className={`${LINK_CLASS} text-fg`}>{children}</span>;
    }
    const external = /^https?:|^\/\//i.test(url);
    // 页内 fragment 不能沿用 harden 加的 target=_blank，否则跳转落在新标签页。
    const browsing = url.startsWith('#') ? { target: undefined, rel: undefined } : {};
    return (
      <a
        {...props}
        href={url}
        className={`${LINK_CLASS} text-primary hover:decoration-primary`}
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
  /** 真实流式状态：开 remend 补齐半截语法，并禁用代码/表格的复制按钮。 */
  streaming?: boolean;
  className?: string;
  /** `body`（默认）承载 15/26 阅读正文；`inherit` 完全沿用父级字号与颜色。 */
  presentation?: 'body' | 'inherit';
  /** 只读文件正文：静态解析、HTML 字面量、链接不落到不存在的应用路由。 */
  staticContent?: boolean;
  fileLinks?: MarkdownFileLinks;
}

/**
 * 助手文本始终走同一棵 Streamdown 树：从纯文本到插入粗体、列表、代码块都只更新块内容，
 * 不会在“现在是 Markdown 了吗”之间整段换根。半截语法由 Streamdown/remend 自行补齐。
 *
 * streaming 时增量更新走 useDeferredValue：每个 delta 仍是一次真实输入，
 * 但低优先级渲染可以合并掉中间帧，避免高频事件逐个同步跑完整解析。
 * 这不会减少总解析量，只把每次事件的同步阻塞让给调度器；结束态立即用原 text。
 */
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
