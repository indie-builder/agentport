import { lazy, Suspense } from 'react';
import { cn } from '../lib/cn.js';

export type SourceLanguage = 'json' | 'markdown' | 'text';

export type SourceEditorProps = {
  value: string;
  onChange: (value: string) => void;
  id?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  language?: SourceLanguage | undefined;
  className?: string | undefined;
  onBlur?: (() => void) | undefined;
};

// CodeMirror 只在真正渲染编辑器时才加载；其余页面不为它付首屏体积。
const LazySourceEditor = lazy(() =>
  import('./source-editor-inner.js').then((module) => ({ default: module.SourceEditorInner })),
);

/**
 * 源码编辑器：对外是受控的字符串字段，内部按需加载 CodeMirror。
 * 加载期间用同样的外壳渲染一个可用的 textarea，外观与可访问名称保持一致。
 */
export function SourceEditor({
  value,
  onChange,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid = false,
  disabled = false,
  readOnly = false,
  language = 'text',
  className,
  onBlur,
}: SourceEditorProps) {
  return (
    <div
      data-slot="source-editor"
      data-disabled={disabled || undefined}
      data-invalid={ariaInvalid || undefined}
      className={cn(
        'flex w-full overflow-hidden rounded-lg border border-input bg-transparent font-mono text-mobile-input transition-colors md:text-sm',
        // 输入类控件只留一层焦点信号：边框换色，不叠光环。
        disabled
          ? 'cursor-not-allowed bg-control-boundary/50 opacity-50'
          : ariaInvalid
            ? 'border-destructive has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-ring has-[:focus-visible]:outline-offset-2'
            : 'focus-within:border-input-focus',
        className,
      )}
    >
      <Suspense
        fallback={
          <textarea
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid || undefined}
            disabled={disabled}
            readOnly={readOnly}
            className="field-sizing-content block min-h-16 w-full resize-none bg-transparent px-2.5 py-2 text-inherit outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
        }
      >
        <LazySourceEditor
          value={value}
          onChange={onChange}
          id={id}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          disabled={disabled}
          readOnly={readOnly}
          language={language}
          onBlur={onBlur}
        />
      </Suspense>
    </div>
  );
}
