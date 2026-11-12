import type { ApiTool, Server } from '@agentport/shared';
import { useState } from 'react';
import { formatDuration } from '../../lib/format.js';
import { errorMessage } from '../../lib/orpc.js';
import { useTestInvokeTool } from '../../lib/queries.js';
import { DialogShell } from '../dialog-shell.js';
import { Button } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { Field, FieldDescription, FieldLabel } from '../ui/field.js';
import { Textarea } from '../ui/textarea.js';

function parseArgs(text: string): { args?: Record<string, unknown>; error?: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { error: `参数不是合法 JSON：${errorMessage(error)}` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '参数必须是 JSON 对象' };
  }
  return { args: value as Record<string, unknown> };
}

/** 用一组参数直接调用工具，结果留在弹层里方便反复试跑。 */
export function TestInvokeDialog({
  server,
  tool,
  onClose,
  getReturnFocus,
}: {
  server: Server;
  tool: ApiTool;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const run = useTestInvokeTool(server.id);
  const [argsText, setArgsText] = useState('{}');
  const parsed = parseArgs(argsText);
  const pending = run.isPending;
  const result = run.data ?? null;
  const argsId = `test-invoke-args-${tool.id}`;
  const errorId = `test-invoke-args-error-${tool.id}`;

  const execute = (): void => {
    if (!parsed.args || pending) return;
    run.mutate({ toolId: tool.id, args: parsed.args });
  };

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (next) return;
        if (pending) details.cancel();
        else onClose();
      }}
    >
      <DialogShell
        title={`试跑工具「${tool.name}」`}
        description={`${tool.method} ${tool.pathTemplate}`}
        finalFocus={getReturnFocus}
        closeDisabled={pending}
      >
        <div className="flex flex-col gap-5">
          <Field className="gap-1.5">
            <FieldLabel htmlFor={argsId}>调用参数</FieldLabel>
            <Textarea
              id={argsId}
              value={argsText}
              disabled={pending}
              rows={5}
              spellCheck={false}
              className="min-h-28 font-mono text-xs"
              aria-invalid={Boolean(parsed.error)}
              aria-describedby={parsed.error ? errorId : undefined}
              onChange={(event) => setArgsText(event.target.value)}
            />
            {parsed.error ? (
              <p id={errorId} role="alert" className="text-sm text-danger">
                {parsed.error}
              </p>
            ) : (
              <FieldDescription>JSON 对象，对应工具 inputSchema 的属性。</FieldDescription>
            )}
          </Field>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={Boolean(parsed.error) || pending}
              aria-busy={pending}
              onClick={execute}
            >
              {pending ? '运行中…' : '运行'}
            </Button>
            {pending ? (
              <span className="text-sm text-muted-foreground" aria-live="polite">
                正在调用上游接口…
              </span>
            ) : null}
          </div>

          {run.isError ? (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(run.error)}
            </p>
          ) : null}

          {result ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm text-muted-foreground">
                {result.ok ? '调用成功' : '调用失败'} · 耗时 {formatDuration(result.durationMs)}
              </p>
              {result.ok ? (
                <pre className="max-h-60 overflow-y-auto overscroll-contain rounded-lg bg-chip p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-fg">
                  {result.text || '（空响应）'}
                </pre>
              ) : (
                <p
                  role="alert"
                  className="max-h-60 overflow-y-auto overscroll-contain rounded-lg bg-danger-soft p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-danger"
                >
                  {result.error ?? result.text ?? '调用失败'}
                </p>
              )}
            </div>
          ) : null}

          <div className="flex justify-end border-t pt-4">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              关闭
            </Button>
          </div>
        </div>
      </DialogShell>
    </Dialog>
  );
}
