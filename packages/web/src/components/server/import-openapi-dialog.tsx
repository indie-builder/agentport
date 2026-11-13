import type { Server } from '@agentport/shared';
import { CircleAlert, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { errorMessage } from '../../lib/orpc.js';
import { useImportOpenApi, usePreviewOpenApi } from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { DialogShell } from '../dialog-shell.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';
import { Dialog } from '../ui/dialog.js';
import { Field, FieldDescription, FieldLabel } from '../ui/field.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { Textarea } from '../ui/textarea.js';

/** 粘贴或上传 OpenAPI/Swagger 文档，预览后按名称挑选要创建的 MCP 工具。 */
export function ImportOpenApiDialog({
  server,
  onClose,
  getReturnFocus,
}: {
  server: Server;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const preview = usePreviewOpenApi(server.id);
  const importTools = useImportOpenApi(server.id);
  const fileRef = useRef<HTMLInputElement>(null);
  const [spec, setSpec] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const result = preview.data ?? null;
  const pending = importTools.isPending;
  const specId = `openapi-spec-${server.id}`;

  const replaceSpec = (value: string): void => {
    setSpec(value);
    setSelected(new Set());
    preview.reset();
  };

  const toggle = (name: string, checked: boolean): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  const runPreview = (): void => {
    const value = spec.trim();
    if (!value || preview.isPending || pending) return;
    preview.mutate(value, {
      onSuccess: (data) => setSelected(new Set(data.tools.map((tool) => tool.name))),
      onError: (error) => toastError(error),
    });
  };

  const runImport = (): void => {
    if (selected.size === 0 || pending) return;
    importTools.mutate(
      { spec: spec.trim(), selectedNames: [...selected] },
      {
        onSuccess: (data) => {
          toastSuccess(`已导入 ${data.created.length} 个工具`);
          onClose();
        },
        onError: (error) => toastError(error),
      },
    );
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
        title="导入 OpenAPI 接口"
        description="每个 operation 转成一个 MCP 工具，导入前可挑选需要的接口。"
        finalFocus={getReturnFocus}
        closeDisabled={pending}
        className="max-w-3xl sm:max-w-3xl"
      >
        <div className="flex flex-col gap-5">
          <Field className="gap-1.5">
            <FieldLabel htmlFor={specId}>OpenAPI / Swagger 文档</FieldLabel>
            <Textarea
              id={specId}
              value={spec}
              disabled={pending || preview.isPending}
              rows={6}
              className="min-h-40 font-mono text-xs"
              placeholder="粘贴 JSON 或 YAML 文档内容…"
              onChange={(event) => replaceSpec(event.target.value)}
            />
            <FieldDescription>支持 OpenAPI 3.x 与 Swagger 2.0，JSON 或 YAML。</FieldDescription>
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".json,.yaml,.yml,application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // 先清空 value，同一个文件重试时才会再次触发 change。
                event.target.value = '';
                if (!file) return;
                file
                  .text()
                  .then(replaceSpec)
                  .catch((error: unknown) => toastError(error));
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || preview.isPending}
              onClick={() => fileRef.current?.click()}
            >
              <Upload data-icon="inline-start" aria-hidden="true" /> 选择文件
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!spec.trim() || preview.isPending || pending}
              aria-busy={preview.isPending}
              onClick={runPreview}
            >
              {preview.isPending ? '解析中…' : '解析预览'}
            </Button>
          </div>

          {preview.isError ? (
            <p role="alert" className="text-sm text-danger">
              {errorMessage(preview.error)}
            </p>
          ) : null}

          {result && result.warnings.length > 0 ? (
            <ul
              aria-label="解析警告"
              className="flex flex-col gap-1 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning"
            >
              {result.warnings.map((warning) => (
                <li key={warning} className="flex gap-1.5">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span className="break-words">{warning}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {result && result.tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">未解析到任何接口。</p>
          ) : null}

          {result && result.tools.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                已选 {selected.size} / 共 {result.total}
              </p>
              <div className="max-h-80 overflow-y-auto rounded-lg border">
                <Table>
                  <caption className="sr-only">解析出的接口</caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <span className="sr-only">选择</span>
                      </TableHead>
                      <TableHead>名称</TableHead>
                      <TableHead className="w-20">方法</TableHead>
                      <TableHead>路径</TableHead>
                      <TableHead>描述</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.tools.map((tool) => (
                      <TableRow key={tool.name}>
                        <TableCell>
                          <Checkbox
                            className="size-3.5"
                            aria-label={`导入工具 ${tool.name}`}
                            checked={selected.has(tool.name)}
                            disabled={pending}
                            onCheckedChange={(checked) => toggle(tool.name, checked)}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs text-fg">{tool.name}</TableCell>
                        <TableCell>
                          <Badge variant="secondary" className="font-mono text-2xs">
                            {tool.method}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-2xs text-muted-foreground">
                          {tool.pathTemplate}
                        </TableCell>
                        <TableCell
                          className="max-w-60 truncate text-2xs text-muted-foreground"
                          title={tool.description}
                        >
                          {tool.description || '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              取消
            </Button>
            <Button
              type="button"
              disabled={selected.size === 0 || pending}
              aria-busy={pending}
              onClick={runImport}
            >
              {pending ? '导入中…' : `导入选中 (${selected.size})`}
            </Button>
          </div>
        </div>
      </DialogShell>
    </Dialog>
  );
}
