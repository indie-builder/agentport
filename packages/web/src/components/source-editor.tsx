import { lazy, Suspense } from 'react';
import { cn } from '../lib/cn.js';
import type { SourceEditorProps } from './source-editor-props.js';
import { Textarea } from './ui/textarea.js';

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
          <Textarea
            id={id}
            value={value}
            onValueChange={onChange}
            onBlur={onBlur}
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid || undefined}
            disabled={disabled}
            readOnly={readOnly}
            className="block resize-none rounded-none border-0 bg-transparent text-inherit focus-visible:border-transparent disabled:bg-transparent disabled:opacity-100 aria-invalid:border-transparent"
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
