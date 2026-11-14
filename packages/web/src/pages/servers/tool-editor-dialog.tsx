import type { ApiTool, Server } from '@agentport/shared';
import { Toolbar, ToolbarButton } from '@ui-sdk/react/toolbar';
import { Pencil, Play, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { ImportOpenApiDialog } from '../../components/server/import-openapi-dialog.js';
import { TestInvokeDialog } from '../../components/server/test-invoke-dialog.js';
import { ErrorState, InlineEmpty, LoadingState } from '../../components/states.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Dialog } from '../../components/ui/dialog.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import {
  useBatchSetToolsEnabled,
  useDeleteTool,
  useSetToolEnabled,
  useTools,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { approvalOptions } from './shared.js';
import { ToolForm } from './tool-form.js';

export function ToolEditorDialog({
  server,
  onClose: onClosed,
  getReturnFocus,
}: {
  server: Server;
  onClose: () => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const tools = useTools(server.id);
  const remove = useDeleteTool(server.id);
  const setEnabled = useSetToolEnabled(server.id);
  const batchSet = useBatchSetToolsEnabled(server.id);
  const [editing, setEditing] = useState<ApiTool | null>(null);
  const [deleting, setDeleting] = useState<ApiTool | null>(null);
  const [testing, setTesting] = useState<ApiTool | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const testingTrigger = useRef<HTMLElement | null>(null);
  const switching = useRef(false);
  // 表单是弹层里唯一未保存的内容：关闭与「取消编辑」都走同一道确认。
  const [formDirty, setFormDirty] = useState(false);
  const [formPending, setFormPending] = useState(false);
  const [discard, setDiscard] = useState<{ run: () => void } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);

  const guarded = (run: () => void): void => {
    if (formPending || setEnabled.isPending || remove.isPending || batchRunning) return;
    if (formDirty) {
      setDiscard({ run });
      return;
    }
    run();
  };

  const rows = tools.data ?? [];
  const selectedIds = rows.filter((tool) => selected.has(tool.id)).map((tool) => tool.id);
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const busy = formPending || setEnabled.isPending || remove.isPending || batchRunning;

  const toggleAll = (checked: boolean): void => {
    setSelected(checked ? new Set(rows.map((tool) => tool.id)) : new Set());
  };

  const toggleOne = (toolId: string, checked: boolean): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(toolId);
      else next.delete(toolId);
      return next;
    });
  };

  const runBatch = async (enabled: boolean): Promise<void> => {
    if (selectedIds.length === 0 || batchRunning) return;
    setBatchRunning(true);
    let updated = 0;
    try {
      // 契约限制单次最多 200 个，分批串行提交并累计结果。
      for (let i = 0; i < selectedIds.length; i += 200) {
        const data = await batchSet.mutateAsync({
          toolIds: selectedIds.slice(i, i + 200),
          enabled,
        });
        updated += data.updated;
      }
      toastSuccess(`已更新 ${updated} 个工具`);
      setSelected(new Set());
    } catch (error) {
      toastError(error);
    } finally {
      setBatchRunning(false);
    }
  };

  const setTool = async (vars: {
    toolId: string;
    enabled?: boolean;
    approvalMode?: ApiTool['approvalMode'];
  }): Promise<void> => {
    if (switching.current || busy) return;
    switching.current = true;
    try {
      await setEnabled.mutateAsync(vars);
    } catch (error) {
      toastError(error);
    } finally {
      switching.current = false;
    }
  };

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={(next, details) => {
        if (next) return;
        // 未保存或请求中时由页面决定是否关闭，先撤销这次关闭请求。
        if (formDirty || busy) details.cancel();
        guarded(onClose);
      }}
    >
      <DialogShell
        title={`工具定义「${server.name}」`}
        description="每个上游 HTTP 端点对应一个 MCP 工具。路径里的 {param} 必须在 inputSchema.properties 中有同名属性。"
        finalFocus={getReturnFocus}
        closeDisabled={busy}
        className="max-w-3xl sm:max-w-3xl"
      >
        <div className="flex flex-col gap-5">
          {server.kind === 'generated' ? (
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                disabled={formPending || setEnabled.isPending || remove.isPending}
                onClick={() => setImportOpen(true)}
              >
                <Upload data-icon="inline-start" aria-hidden="true" /> 导入 OpenAPI
              </Button>
            </div>
          ) : null}
          {tools.isPending ? <LoadingState rows={2} /> : null}
          {tools.isError ? (
            <ErrorState error={tools.error} onRetry={() => void tools.refetch()} />
          ) : null}
          {tools.data && tools.data.length === 0 ? (
            <InlineEmpty>在下方声明第一个 HTTP 端点，供智能体调用。</InlineEmpty>
          ) : null}
          {tools.data && tools.data.length > 0 ? (
            <div className="flex flex-col gap-2">
              {selectedIds.length > 0 ? (
                <Toolbar aria-label="批量操作" className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    已选 {selectedIds.length} 个
                  </span>
                  <ToolbarButton
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    disabled={busy}
                    aria-busy={batchRunning}
                    onClick={() => void runBatch(true)}
                  >
                    启用选中
                  </ToolbarButton>
                  <ToolbarButton
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    disabled={busy}
                    aria-busy={batchRunning}
                    onClick={() => void runBatch(false)}
                  >
                    停用选中
                  </ToolbarButton>
                  <ToolbarButton
                    className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                    disabled={busy}
                    onClick={() => setSelected(new Set())}
                  >
                    清除选择
                  </ToolbarButton>
                </Toolbar>
              ) : null}
              <Table>
                <caption className="sr-only">生成的工具定义</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        className="size-3.5"
                        aria-label="选择全部工具"
                        checked={allSelected}
                        indeterminate={selectedIds.length > 0 && !allSelected}
                        disabled={busy}
                        onCheckedChange={toggleAll}
                      />
                    </TableHead>
                    <TableHead>名称</TableHead>
                    <TableHead className="w-20">方法</TableHead>
                    <TableHead>路径</TableHead>
                    <TableHead className="w-20">参数</TableHead>
                    <TableHead className="w-16">启用</TableHead>
                    <TableHead className="w-28">审批</TableHead>
                    <TableHead className="w-20">
                      <span className="sr-only">操作</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tools.data.map((tool) => (
                    <TableRow key={tool.id} className="h-14">
                      <TableCell>
                        <Checkbox
                          className="size-3.5"
                          aria-label={`选择工具 ${tool.name}`}
                          checked={selected.has(tool.id)}
                          disabled={busy}
                          onCheckedChange={(checked) => toggleOne(tool.id, checked)}
                        />
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-fg">{tool.name}</span>
                        {tool.description ? (
                          <div className="max-w-xs truncate text-2xs text-muted-foreground">
                            {tool.description}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span className="rounded-tag bg-chip px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                          {tool.method}
                        </span>
                      </TableCell>
                      {/* Keep paths compact and monospaced beside tool metadata. */}
                      <TableCell className="font-mono text-2xs text-muted-foreground">
                        {tool.pathTemplate}
                      </TableCell>
                      {/* Keep parameter placement subordinate to the tool name. */}
                      <TableCell className="text-2xs text-muted-foreground">
                        {tool.paramsIn}
                      </TableCell>
                      <TableCell>
                        <Checkbox
                          className="size-3.5"
                          aria-label={`启用工具 ${tool.name}`}
                          checked={tool.enabled}
                          disabled={busy}
                          onCheckedChange={(enabled) => void setTool({ toolId: tool.id, enabled })}
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          value={tool.approvalMode}
                          items={approvalOptions}
                          disabled={editing?.id === tool.id || busy}
                          onValueChange={(approvalMode) => {
                            if (approvalMode !== null)
                              void setTool({ toolId: tool.id, approvalMode });
                          }}
                        >
                          <SelectTrigger className="w-full" aria-label={`审批策略 ${tool.name}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {approvalOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`试跑工具 ${tool.name}`}
                            disabled={busy}
                            onClick={(event) => {
                              testingTrigger.current = event.currentTarget;
                              setTesting(tool);
                            }}
                          >
                            <Play className="size-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`编辑工具 ${tool.name}`}
                            disabled={busy}
                            onClick={() => guarded(() => setEditing(tool))}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button
                            variant="destructive"
                            size="icon-sm"
                            aria-label={`删除工具 ${tool.name}`}
                            disabled={busy}
                            onClick={() => {
                              if (busy || switching.current) return;
                              setDeleting(tool);
                            }}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}

          <ToolForm
            key={editing?.id ?? 'new'}
            serverId={server.id}
            tool={editing}
            disabled={busy}
            onDirtyChange={setFormDirty}
            onPendingChange={setFormPending}
            onDone={() => setEditing(null)}
            onCancel={() => guarded(() => setEditing(null))}
          />

          <ConfirmDialog
            open={deleting !== null}
            onClose={() => setDeleting(null)}
            title={`删除工具「${deleting?.name ?? ''}」`}
            description="智能体将无法再调用该工具。此操作不可撤销。"
            onConfirm={async () => {
              if (!deleting || formPending || switching.current) return;
              await remove.mutateAsync(deleting.id);
              if (editing?.id === deleting.id) setEditing(null);
            }}
          />
          <ConfirmDialog
            open={discard !== null}
            onClose={() => setDiscard(null)}
            title="放弃未保存的更改？"
            description="关闭后这个工具的修改会丢失。"
            confirmLabel="放弃"
            onConfirm={async () => {
              discard?.run();
            }}
          />
          {importOpen ? (
            <ImportOpenApiDialog
              server={server}
              getReturnFocus={getReturnFocus}
              onClose={() => setImportOpen(false)}
            />
          ) : null}
          {testing ? (
            <TestInvokeDialog
              server={server}
              tool={testing}
              getReturnFocus={() =>
                testingTrigger.current?.isConnected ? testingTrigger.current : getReturnFocus()
              }
              onClose={() => setTesting(null)}
            />
          ) : null}
        </div>
      </DialogShell>
    </Dialog>
  );
}
