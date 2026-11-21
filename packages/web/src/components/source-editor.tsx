import { lazy, Suspense } from 'react';
import { cn } from '../lib/cn.js';
import type { SourceEditorProps } from './source-editor-props.js';

const LazySourceEditor = lazy(() =>
  import('./source-editor-inner.js').then((module) => ({ default: module.SourceEditorInner })),
);

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
        'flex w-full overflow-hidden rounded-lg border border-input bg-transparent font-mono text-sm transition-colors',
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
