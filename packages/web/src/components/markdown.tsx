import { code, type ThemeInput } from '@streamdown/code';
import { type ComponentProps, memo } from 'react';
import { type Components, Streamdown } from 'streamdown';

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

const heading = (tag: 'h2' | 'h3' | 'h4' | 'h5' | 'h6', className: string) => {
  const Heading = tag;
  return ({ children, node: _node, ...props }: ComponentProps<'h2'> & { node?: unknown }) => (
    <Heading {...props} className={className}>
      {children}
    </Heading>
  );
};

/** 外链新开页并补齐 noopener；Streamdown 默认只给 noreferrer。 */
const components: Components = {
  // 消息内标题整体下移一级：页面本身已有 h1，不能再出现第二个 h1。
  h1: heading('h2', 'mt-4 mb-2 text-base font-medium text-fg'),
  h2: heading('h3', 'mt-3 mb-1.5 text-sm font-medium text-fg'),
  h3: heading('h4', 'mt-3 mb-1 text-sm font-medium text-fg'),
  h4: heading('h5', 'mt-3 mb-1 text-sm font-medium text-fg'),
  h5: heading('h6', 'mt-3 mb-1 text-sm font-medium text-fg'),
  h6: heading('h6', 'mt-3 mb-1 text-sm font-medium text-fg'),
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

/**
 * 高频 text_delta 下逐字走 Markdown 解析会把流式回放拖慢一个数量级。
 * 只有出现常见 Markdown 标记时才交给 Streamdown；纯文本直接渲染。
 */
const MARKDOWN_HINT =
  /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>|\||```|---|\*\*\*|___)|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^)\n]+\)|!\[[^\]\n]*\]\([^)\n]+\)/;

/** 助手文本的流式 Markdown；半截语法由 Streamdown/remend 自行补齐。 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  if (!MARKDOWN_HINT.test(text)) {
    return (
      <p className="min-w-0 whitespace-pre-wrap break-words text-md leading-[1.7] text-fg">
        {text}
      </p>
    );
  }
  return (
    <Streamdown
      className="min-w-0 text-md leading-[1.7] text-fg [&_[data-streamdown=code-block]]:rounded-card [&_[data-streamdown=code-block]]:border-line [&_[data-streamdown=code-block]]:bg-code [&_[data-streamdown=code-block-body]]:bg-transparent"
      components={components}
      plugins={PLUGINS}
      shikiTheme={SHIKI_THEMES}
    >
      {text}
    </Streamdown>
  );
});
