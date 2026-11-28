import { Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '../../components/ui/button.js';
import { FieldError } from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import { fieldErrors } from '../../lib/form.js';

type KeyValueRow = { key: string; value: string };

type KeyValueRowMessages = {
  emptyKey: (index: number) => string;
  duplicate: (index: number, previous: number) => string;
};

export function keyValueRowIssues(
  rows: KeyValueRow[],
  messages: KeyValueRowMessages,
): Array<{ index: number; message: string }> {
  const issues: Array<{ index: number; message: string }> = [];
  const seen = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    const key = row.key.trim();
    if (key === '' && row.value === '') continue;
    if (key === '') {
      issues.push({ index, message: messages.emptyKey(index) });
      continue;
    }
    const previous = seen.get(key);
    if (previous !== undefined) {
      issues.push({ index, message: messages.duplicate(index, previous) });
      continue;
    }
    seen.set(key, index);
  }
  return issues;
}

export function rowsToRecord(rows: KeyValueRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.flatMap((row) => {
      const key = row.key.trim();
      return key === '' ? [] : [[key, row.value] as const];
    }),
  );
}

export function refineKeyValueRows(
  ctx: z.RefinementCtx,
  values: {
    path: string;
    rows: KeyValueRow[];
    issues: Array<{ index: number; message: string }>;
    emptyMessage: string | null;
    keyType: z.ZodType<string>;
    valueType: z.ZodType<string>;
    skipEmptyRows: boolean;
  },
): void {
  for (const issue of values.issues) {
    ctx.addIssue({
      code: 'custom',
      path: [values.path, issue.index, 'key'],
      message: issue.message,
    });
  }
  const hasRow = values.rows.some((row) => row.key.trim() !== '' || row.value !== '');
  if (!hasRow) {
    if (values.emptyMessage !== null) {
      ctx.addIssue({ code: 'custom', path: [values.path], message: values.emptyMessage });
    }
    return;
  }
  if (values.issues.length > 0) return;
  for (const [index, row] of values.rows.entries()) {
    if (values.skipEmptyRows && row.key.trim() === '' && row.value === '') continue;
    for (const [field, schema] of [
      ['key', values.keyType],
      ['value', values.valueType],
    ] as const) {
      const parsed = schema.safeParse(field === 'key' ? row.key.trim() : row.value);
      if (parsed.success) continue;
      const issue = parsed.error.issues[0];
      if (issue === undefined) continue;
      ctx.addIssue({
        code: 'custom',
        path: [values.path, index, field],
        message: Object.values(fieldErrors([issue]))[0] ?? issue.message,
      });
    }
  }
}

export function KeyValueRowEditor({
  rows,
  prefix,
  keyAriaLabel,
  valueAriaLabel,
  removeLabel,
  addLabel,
  rootErrorId,
  rootError,
  disabled,
  secretValue,
  registerKey,
  registerValue,
  keyError,
  valueError,
  onAppend,
  onRemove,
  extraActions,
}: {
  rows: Array<KeyValueRow & { id: string }>;
  prefix: string;
  keyAriaLabel: string;
  valueAriaLabel: string;
  removeLabel: string;
  addLabel: string;
  rootErrorId: string;
  rootError: string | undefined;
  disabled: boolean;
  secretValue?: boolean | undefined;
  registerKey: (index: number) => UseFormRegisterReturn;
  registerValue: (index: number) => UseFormRegisterReturn;
  keyError: (index: number) => string | undefined;
  valueError: (index: number) => string | undefined;
  onAppend: () => void;
  onRemove: (index: number) => void;
  extraActions?: ReactNode;
}) {
  return (
    <>
      <div className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <div key={row.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Input
                {...registerKey(index)}
                aria-label={`第 ${index + 1} 项${keyAriaLabel}`}
                placeholder="key"
                className="w-40 shrink-0 font-mono text-xs"
                autoComplete="off"
                disabled={disabled}
                aria-invalid={Boolean(keyError(index))}
                aria-describedby={
                  keyError(index)
                    ? `${prefix}-${index}-key-error`
                    : index === 0 && rootError
                      ? rootErrorId
                      : undefined
                }
              />
              <Input
                {...registerValue(index)}
                aria-label={`第 ${index + 1} 项${valueAriaLabel}`}
                placeholder="value"
                className="min-w-0 flex-1 font-mono text-xs"
                autoComplete="off"
                disabled={disabled}
                aria-invalid={Boolean(valueError(index))}
                aria-describedby={valueError(index) ? `${prefix}-${index}-value-error` : undefined}
                {...(secretValue ? { 'data-agent-secret': true } : {})}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`移除第 ${index + 1} 项${removeLabel}`}
                disabled={disabled}
                onClick={() => onRemove(index)}
              >
                <Trash2 />
              </Button>
            </div>
            <FieldError id={`${prefix}-${index}-key-error`}>{keyError(index)}</FieldError>
            <FieldError id={`${prefix}-${index}-value-error`}>{valueError(index)}</FieldError>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-invalid={Boolean(rootError)}
          aria-describedby={rootError ? rootErrorId : undefined}
          onClick={onAppend}
        >
          <Plus data-icon="inline-start" /> {addLabel}
        </Button>
        {extraActions}
      </div>
      <FieldError id={rootErrorId}>{rootError}</FieldError>
    </>
  );
}
