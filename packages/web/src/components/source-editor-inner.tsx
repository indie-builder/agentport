import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SourceEditorProps } from './source-editor.js';

type InnerProps = Omit<SourceEditorProps, 'className'>;

function languageExtension(language: InnerProps['language']): Extension {
  if (language === 'json') return json();
  if (language === 'markdown') return markdown();
  return [];
}

type ContentAria = {
  id?: string | undefined;
  label?: string | undefined;
  describedBy?: string | undefined;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
};

function contentAttributes({ id, label, describedBy, invalid, disabled }: ContentAria) {
  const attrs: Record<string, string> = {};
  if (id) attrs.id = id;
  if (label) attrs['aria-label'] = label;
  if (describedBy) attrs['aria-describedby'] = describedBy;
  if (invalid) attrs['aria-invalid'] = 'true';
  if (disabled) attrs['aria-disabled'] = 'true';
  return attrs;
}

// 颜色全部走 styles.css 的 @theme 变量；焦点由外层容器的边框表达，编辑器本身不画轮廓。
const editorTheme = EditorView.theme({
  '&': { color: 'var(--color-fg)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5', overflow: 'auto' },
  '.cm-content': {
    padding: '0.5rem 0.625rem',
    caretColor: 'var(--color-fg)',
    minHeight: '4rem',
    // 冲突时压过全局 :focus-visible 轮廓；焦点信号只留外层容器的边框。
    outline: 'none',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-muted-foreground)',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.25rem 0 0.5rem', minWidth: '1.5rem' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--color-selected)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--color-fg)' },
  // 内置搜索面板与括号/匹配高亮默认带彩色，这里统一收回到中性令牌。
  '.cm-panels': { backgroundColor: 'var(--color-surface)', color: 'var(--color-fg)' },
  '.cm-panel.cm-search': {
    backgroundColor: 'var(--color-surface)',
    borderTop: '1px solid var(--color-line)',
    padding: '0.25rem 0.5rem',
    fontSize: 'var(--text-sm)',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    fontFamily: 'inherit',
    fontSize: 'inherit',
    color: 'var(--color-fg)',
    backgroundColor: 'transparent',
    borderRadius: 'var(--radius-md)',
  },
  '.cm-panel.cm-search .cm-textfield': {
    padding: '0.125rem 0.375rem',
    // 输入家族默认浅线；按钮与复选框仍用各自原生焦点。
    border: '1px solid var(--color-input)',
  },
  '.cm-panel.cm-search .cm-textfield:focus-visible': {
    borderColor: 'var(--color-input-focus)',
    // 与输入家族一致：焦点只由浅线加深表达，不叠加全局 2px 轮廓。
    outline: 'none',
  },
  '.cm-panel.cm-search button': { border: '1px solid var(--color-line)' },
  '.cm-searchMatch, .cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--color-selected)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--color-hover)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--color-selected)',
    outline: '1px solid var(--color-line-strong)',
  },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--color-danger-soft)' },
});

// CodeMirror 内置搜索面板默认是英文，这里给出项目内使用的中文文案。
const phrases = EditorState.phrases.of({
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全部',
  'match case': '区分大小写',
  regexp: '正则',
  'by word': '整词',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'Go to line': '跳转到行',
  go: '跳转',
});

/** CodeMirror 内核。由 SourceEditor 按需加载，不直接对外。 */
export function SourceEditorInner({
  value,
  onChange,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid = false,
  disabled = false,
  readOnly = false,
  language = 'text',
  onBlur,
}: InnerProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 外部同步触发的 dispatch 不应回传 onChange，否则父组件会被自己的值再唤醒一次。
  const syncing = useRef(false);
  const handlers = useRef({ onChange, onBlur });
  useEffect(() => {
    handlers.current = { onChange, onBlur };
  }, [onChange, onBlur]);

  const [compartments] = useState(() => ({
    readOnly: new Compartment(),
    editable: new Compartment(),
    language: new Compartment(),
    attributes: new Compartment(),
  }));

  const aria = useMemo<ContentAria>(
    () => ({ id, label: ariaLabel, describedBy: ariaDescribedBy, invalid: ariaInvalid, disabled }),
    [id, ariaLabel, ariaDescribedBy, ariaInvalid, disabled],
  );
  // 只用于首帧创建；后续变化由 reconfigure 生效。
  const [initial] = useState(() => ({ value, disabled, readOnly, language, aria }));

  // 在绘制前建好编辑器，避免换掉 Suspense 回退时闪一帧空白。
  useLayoutEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const first = initial;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: first.value,
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          indentOnInput(),
          search(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          phrases,
          EditorView.lineWrapping,
          editorTheme,
          compartments.readOnly.of(EditorState.readOnly.of(first.disabled || first.readOnly)),
          compartments.editable.of(EditorView.editable.of(!first.disabled)),
          compartments.language.of(languageExtension(first.language)),
          compartments.attributes.of(
            EditorView.contentAttributes.of(contentAttributes(first.aria)),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncing.current) {
              handlers.current.onChange(update.state.doc.toString());
            }
          }),
          EditorView.domEventHandlers({
            blur: () => {
              handlers.current.onBlur?.();
              return false;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [compartments, initial]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    syncing.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        // 外部重置不是用户编辑，不进入撤销栈。
        annotations: Transaction.addToHistory.of(false),
      });
    } finally {
      syncing.current = false;
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        compartments.readOnly.reconfigure(EditorState.readOnly.of(disabled || readOnly)),
        compartments.editable.reconfigure(EditorView.editable.of(!disabled)),
        compartments.language.reconfigure(languageExtension(language)),
        compartments.attributes.reconfigure(
          EditorView.contentAttributes.of(contentAttributes(aria)),
        ),
      ],
    });
  }, [compartments, aria, disabled, readOnly, language]);

  return <div ref={host} className="min-w-0 flex-1" />;
}
