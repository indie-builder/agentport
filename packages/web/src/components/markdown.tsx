import { code, type ThemeInput } from '@streamdown/code';
import { type ComponentProps, type CSSProperties, memo, useDeferredValue } from 'react';
import { type Components, Streamdown } from 'streamdown';
import { cn } from '../lib/cn.js';

/**
 * Shiki 的 css-variables 主题：颜色全部落在 styles.css 的 --shiki-* 变量上，
 * 高亮因此只使用无彩度令牌，不引入任何色相。
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
        className="break-words font-medium text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg"
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

export interface MarkdownProps {
  text: string;
  /** 真实流式状态：开 remend 补齐半截语法，并禁用代码/表格的复制按钮。 */
  streaming?: boolean;
  className?: string;
  /** `body`（默认）承载 15/26 阅读正文；`inherit` 完全沿用父级字号与颜色。 */
  presentation?: 'body' | 'inherit';
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
}: MarkdownProps) {
  const deferred = useDeferredValue(text);
  return (
    <Streamdown
      className={cn(presentation === 'inherit' ? INHERIT_CLASS : BODY_CLASS, className)}
      components={components}
      plugins={PLUGINS}
      shikiTheme={SHIKI_THEMES}
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      animated={false}
    >
      {streaming ? deferred : text}
    </Streamdown>
  );
});
