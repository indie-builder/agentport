import { SECRET_MASK, type Server } from '@agentport/shared';
import { KeyRound, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { CodeBlock } from '../../components/code-block.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { useRotateServerToken, useServerToken } from '../../lib/queries.js';

export function ConnectionDialog({
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
  const token = useServerToken(server.id);
  const rotate = useRotateServerToken(server.id);
  // 轮换后只在这里保留明文；关闭对话框即丢弃。
  const [revealed, setRevealed] = useState<{ token: string; endpoint: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const data = revealed ?? token.data;
  const retry = (): void => {
    void token.refetch();
  };

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={(next, details) => {
        if (next) return;
        // 轮换进行中关闭会丢掉新 token；请求完成前不允许关闭。
        if (rotate.isPending) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogShell
        title={`连接「${server.name}」`}
        description="外部 Host 用这个端点与 Bearer token 访问；token 只在这里轮换时才显示明文。"
        finalFocus={getReturnFocus}
        closeDisabled={rotate.isPending}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Endpoint</span>
            {token.isError && !revealed ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                Endpoint 读取失败。
                <Button variant="outline" size="sm" onClick={retry}>
                  <RefreshCw className="size-3.5" aria-hidden="true" /> 重试
                </Button>
              </p>
            ) : (
              <CodeBlock code={data?.endpoint ?? '加载中…'} copyLabel="复制 Endpoint" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Token</span>
            {data ? (
              // 未轮换时接口只回掩码：那不是可用的 token，不能让用户复制。
              data.token === SECRET_MASK || !revealed ? (
                <p className="text-sm text-muted-foreground">
                  {SECRET_MASK} 已配置。点「轮换 Token」生成新的明文，旧的立即失效。
                </p>
              ) : (
                <CodeBlock code={data.token} copyLabel="复制 Token" />
              )
            ) : token.isError ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                Token 读取失败。
                <Button variant="outline" size="sm" onClick={retry}>
                  <RefreshCw className="size-3.5" aria-hidden="true" /> 重试
                </Button>
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">加载中…</p>
            )}
            {revealed ? (
              <p role="status" className="text-sm text-warning">
                只显示这一次，请立即保存；旧 token 已失效。
              </p>
            ) : null}
          </div>
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={rotate.isPending}
              aria-busy={rotate.isPending}
              onClick={() => setConfirming(true)}
            >
              <KeyRound className="size-3.5" /> {rotate.isPending ? '轮换中' : '轮换'}
            </Button>
          </div>
        </div>
        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title="轮换 token？"
          description="旧 token 立即失效，正在使用的外部 Host 会中断。旧值不会再显示，只能把新 token 配置到每个 Host。"
          confirmLabel="轮换 token"
          onConfirm={async () => {
            const result = await rotate.mutateAsync(undefined);
            setRevealed(result);
          }}
        />
      </DialogShell>
    </Dialog>
  );
}
