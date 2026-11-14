import type { ConnectorCatalogItem } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { DialogShell } from '../../components/dialog-shell.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { connectorCatalogQuery } from '../../lib/queries.js';

/** 只读策划目录；选中只预填创建表单，不创建、不执行任何命令。 */
export function ConnectorCatalogDialog({
  onClose: onClosed,
  onPick,
  getReturnFocus,
}: {
  onClose: () => void;
  onPick: (item: ConnectorCatalogItem) => void;
  getReturnFocus: () => HTMLElement | null;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const catalog = useQuery(connectorCatalogQuery);

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={(next) => (next ? undefined : onClose())}
    >
      <DialogShell
        title="连接器目录"
        description="策划清单，仅用于预填创建表单；不会自动执行任何命令。"
        finalFocus={getReturnFocus}
        className="max-w-2xl sm:max-w-2xl"
      >
        {catalog.isPending ? <LoadingState rows={3} /> : null}
        {catalog.isError ? (
          <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
        ) : null}
        {catalog.data ? (
          <ul aria-label="连接器目录" className="flex flex-col divide-y border-y">
            {catalog.data.map((item) => (
              <li key={item.slug} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-fg">{item.name}</span>
                  <Badge variant="secondary">{item.kind === 'http' ? 'HTTP' : 'stdio'}</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    onClick={() => dialog.finish(() => onPick(item))}
                  >
                    使用
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">{item.description}</p>
                {item.kind === 'stdio' ? (
                  <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                    <code className="break-words font-mono text-fg">
                      {[item.command, ...(item.args ?? [])].filter(Boolean).join(' ')}
                    </code>
                    {item.envKeys?.length ? (
                      <p className="break-words font-mono">
                        需要环境变量：{item.envKeys.join('、')}
                      </p>
                    ) : null}
                    <p className="text-danger">
                      保存并测试时会在隔离沙盒中执行上述命令；仍请确认命令来源可信。
                    </p>
                  </div>
                ) : null}
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="w-fit text-xs text-muted-foreground underline underline-offset-4 hover:text-fg"
                >
                  来源
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </DialogShell>
    </Dialog>
  );
}
