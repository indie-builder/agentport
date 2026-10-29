import type { OutputShare } from '@agentport/shared';
import { Copy, Share2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { formatDateTime } from '../lib/format.js';
import { useCreateOutputShare, useOutputShares, useRevokeOutputShare } from '../lib/queries.js';
import { toastError, toastSuccess } from '../lib/toast.js';
import { DialogShell } from './dialog-shell.js';
import { ErrorState, LoadingState } from './states.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Dialog, DialogTrigger } from './ui/dialog.js';

function fullUrl(urlPath: string): string {
  return `${window.location.origin}${urlPath}`;
}

/**
 * 选中版本的固定分享：链接内容锁定在创建时快照，之后更新同一路径不会改变已发出的链接。
 * 展示路径与版本时间，已有分享按创建时间倒序列出（含撤销状态）。
 */
export function ShareDialog({
  conversationId,
  runId,
  path,
  createdAt,
}: {
  conversationId: string;
  runId: string;
  path: string;
  createdAt: string | null;
}) {
  const [open, setOpen] = useState(false);
  const shares = useOutputShares(
    open ? conversationId : null,
    open ? runId : null,
    open ? path : null,
  );
  const create = useCreateOutputShare();
  const revoke = useRevokeOutputShare();
  const items = shares.data?.items ?? [];
  const active = items.filter((share) => share.revokedAt === null);
  const pending = create.isPending || revoke.isPending;

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toastSuccess('链接已复制');
    } catch {
      toastError(new Error('无法复制，请手动选择链接复制。'));
    }
  }, []);

  const changeOpen = (next: boolean): void => {
    if (!next && pending) return;
    if (!next) {
      create.reset();
      revoke.reset();
    }
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Share2 data-icon="inline-start" />
        分享
      </DialogTrigger>
      <DialogShell title="分享成果" closeDisabled={pending}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="break-all text-sm text-fg">{path}</span>
            <span className="text-xs text-muted-foreground">{formatDateTime(createdAt)}</span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            链接固定在这个版本，之后更新同一路径不会改变链接内容。持有链接的人可查看和下载此文件。
          </p>

          {shares.isPending ? (
            <LoadingState rows={2} />
          ) : shares.isError ? (
            <ErrorState error={shares.error} onRetry={() => void shares.refetch()} />
          ) : null}

          {items.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {items.map((share) => (
                <ShareRow
                  key={share.id}
                  share={share}
                  pending={pending}
                  onCopy={() => void copy(fullUrl(share.urlPath))}
                  onRevoke={() => revoke.mutate(share.id)}
                />
              ))}
            </ul>
          ) : null}

          {!shares.isPending && active.length === 0 ? (
            <div className="flex flex-col gap-2 rounded-item border border-dashed px-3 py-3">
              <Button
                size="sm"
                className="self-start"
                disabled={create.isPending}
                aria-busy={create.isPending}
                onClick={() => create.mutate({ conversationId, runId, path })}
              >
                {create.isPending ? '正在创建…' : '创建分享链接'}
              </Button>
            </div>
          ) : null}

          {create.isError ? <ErrorState error={create.error} /> : null}
          {revoke.isError ? <ErrorState error={revoke.error} /> : null}
        </div>
      </DialogShell>
    </Dialog>
  );
}

function ShareRow({
  share,
  pending,
  onCopy,
  onRevoke,
}: {
  share: OutputShare;
  pending: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}) {
  const revoked = share.revokedAt !== null;
  const version = formatDateTime(share.createdAt);
  return (
    <li className="flex flex-col gap-1.5 rounded-item border px-3 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
          {fullUrl(share.urlPath)}
        </code>
        <Badge variant="outline" className={revoked ? 'text-muted-foreground' : undefined}>
          {revoked ? '已撤销' : '有效'}
        </Badge>
      </div>
      {revoked ? null : (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`复制 ${version} 的链接`}
            title={`复制 ${version} 的链接`}
            onClick={onCopy}
          >
            <Copy />
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label={`撤销 ${version} 的链接`}
            disabled={pending}
            onClick={onRevoke}
          >
            撤销
          </Button>
        </div>
      )}
    </li>
  );
}
