import type { PersonalOutputShare } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Copy, FileText, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageToolbar,
  PageTopbar,
} from '../../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { Button, buttonVariants } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { FieldError } from '../../components/ui/field.js';
import { type ListView, ViewToggle } from '../../components/view-toggle.js';
import { can } from '../../lib/access.js';
import { errorMessage } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { formatDateTime } from '../../lib/format.js';
import {
  meQuery,
  usePersonalOutputShares,
  useRevokePersonalOutputShare,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';

function shareLink(share: PersonalOutputShare): string {
  return `${window.location.origin}${share.urlPath}`;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

function ShareSourceCell({
  share,
  canOpenConversation,
}: {
  share: PersonalOutputShare;
  canOpenConversation: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sourceTitle = share.conversationTitle || share.conversationId;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {open && canOpenConversation ? (
        <Link
          to="/chat"
          search={{ agent: share.agentId, conversation: share.conversationId }}
          className="break-words text-sm text-link underline underline-offset-4"
        >
          {sourceTitle}
        </Link>
      ) : (
        <span
          className={open ? 'break-words text-sm text-fg' : 'line-clamp-2 text-sm text-fg'}
          title={open ? undefined : sourceTitle}
        >
          {sourceTitle}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 justify-start px-0 text-sm text-muted-foreground"
        aria-expanded={open}
        aria-label={
          open ? `收起 ${fileName(share.path)} 的来源` : `展开 ${fileName(share.path)} 的来源`
        }
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '收起来源' : '展开来源'}
      </Button>
    </div>
  );
}

function ShareFile({ share }: { share: PersonalOutputShare }) {
  const name = fileName(share.path);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="break-words text-base text-fg" title={share.path}>
        {name}
      </span>
      {name === share.path ? null : (
        <span className="break-all font-mono text-xs text-muted-foreground">{share.path}</span>
      )}
    </div>
  );
}

function ShareCopyButton({ value, name }: { value: string; name: string }) {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const copied = copiedValue === value;
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setCopiedValue((current) => (current === value ? current : null));
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      resetTimer.current = null;
    };
  }, [value]);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      setNonce((current) => current + 1);
      setCopiedValue(value);
      resetTimer.current = setTimeout(() => setCopiedValue(null), 2500);
    } catch {
      toastError(new Error('无法复制，请选择内容后手动复制。'));
    }
  };
  const label = copied ? '已复制' : '复制链接';
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void copy()}
      aria-label={copied ? `已复制 ${name} 的链接` : `复制 ${name} 的链接`}
      title={label}
    >
      <span key={`icons-${nonce}`} className="grid">
        <Copy
          aria-hidden="true"
          data-icon="inline-start"
          className={cn(
            'col-start-1 row-start-1 transition-opacity duration-150 ease-out-soft',
            copied ? 'opacity-0' : 'opacity-100',
          )}
        />
        <Check
          aria-hidden="true"
          data-icon="inline-start"
          className={cn(
            'col-start-1 row-start-1 text-success transition-opacity duration-150 ease-out-soft',
            copied ? 'saved-check-decay opacity-100' : 'opacity-0',
          )}
        />
      </span>
      <span key={`label-${nonce}`} className={cn(copied && 'saved-check-decay')}>
        {label}
      </span>
    </Button>
  );
}

function ShareActions({
  share,
  revokePending,
  onRevoke,
  className,
}: {
  share: PersonalOutputShare;
  revokePending: boolean;
  onRevoke: (share: PersonalOutputShare) => void;
  className?: string;
}) {
  const name = fileName(share.path);
  return (
    <div className={cn('flex items-center gap-x-3 whitespace-nowrap', className)}>
      <a
        href={share.urlPath}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`查看 ${name} 的分享`}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        查看分享
      </a>
      <ShareCopyButton value={shareLink(share)} name={name} />
      <Button
        variant="destructive"
        size="sm"
        aria-label={`撤销 ${name} 的分享`}
        disabled={revokePending}
        onClick={() => onRevoke(share)}
      >
        撤销
      </Button>
    </div>
  );
}

function ShareCard({
  share,
  canOpenConversation,
  revokePending,
  onRevoke,
}: {
  share: PersonalOutputShare;
  canOpenConversation: boolean;
  revokePending: boolean;
  onRevoke: (share: PersonalOutputShare) => void;
}) {
  return (
    <Card size="sm" className="h-full">
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex items-start gap-2">
          <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <ShareFile share={share} />
        </div>
        <span className="text-xs text-muted-foreground" title={share.createdAt}>
          分享于 {formatDateTime(share.createdAt)}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">来源会话</span>
          <ShareSourceCell share={share} canOpenConversation={canOpenConversation} />
        </div>
        <ShareActions
          share={share}
          revokePending={revokePending}
          onRevoke={onRevoke}
          className="mt-auto flex-wrap justify-end gap-y-1"
        />
      </CardContent>
    </Card>
  );
}

export function PersonalSharesPage() {
  const me = useQuery(meQuery);
  const search = useSearch({ from: '/_shell/personal/shares' });
  const navigate = useNavigate({ from: '/personal/shares' });
  const cursor = search.cursor ?? null;
  const view = search.view ?? 'cards';
  const shares = usePersonalOutputShares(cursor);
  const revoke = useRevokePersonalOutputShare();
  const [target, setTarget] = useState<PersonalOutputShare | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const canOpenConversation = can(me.data, 'conversations.read');

  const requestRevoke = (share: PersonalOutputShare): void => {
    setModalError(null);
    setTarget(share);
  };

  const columns: DataColumn<PersonalOutputShare>[] = [
    {
      id: 'file',
      header: '文件',
      locked: true,
      width: 'minmax(150px,1.4fr)',
      cell: (share) => <ShareFile share={share} />,
    },
    {
      id: 'conversation',
      header: '来源会话',
      width: 'minmax(140px,1fr)',
      cell: (share) => <ShareSourceCell share={share} canOpenConversation={canOpenConversation} />,
    },
    {
      id: 'createdAt',
      header: '分享于',
      width: '96px',
      cell: (share) => (
        <span className="block text-xs text-muted-foreground" title={share.createdAt}>
          {formatDateTime(share.createdAt)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '操作',
      align: 'end',
      width: 'minmax(270px,auto)',
      cell: (share) => (
        <ShareActions
          share={share}
          revokePending={revoke.isPending}
          onRevoke={requestRevoke}
          className="justify-end"
        />
      ),
    },
  ];

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="我的分享"
          actions={
            <>
              <ViewToggle
                value={view}
                onChange={(next: ListView) =>
                  void navigate({
                    to: '/personal/shares',
                    search: (current) => ({ ...current, view: next }),
                  })
                }
              />
              <Button
                variant="outline"
                onClick={() => void shares.refetch()}
                disabled={shares.isFetching}
              >
                <RefreshCw
                  data-icon="inline-start"
                  className={shares.isFetching ? 'animate-spin' : undefined}
                  aria-hidden="true"
                />
                {shares.isFetching ? '刷新中…' : '刷新'}
              </Button>
            </>
          }
        />
      </PageTopbar>

      <PageBody>
        {shares.isError && shares.data !== undefined ? (
          <PageNote
            tone="danger"
            title="刷新失败，已保留加载的内容"
            description={errorMessage(shares.error)}
            action={
              <Button variant="outline" size="sm" onClick={() => void shares.refetch()}>
                重试
              </Button>
            }
          />
        ) : null}

        {shares.isError && shares.data === undefined ? (
          <ErrorState error={shares.error} onRetry={() => void shares.refetch()} />
        ) : shares.data && shares.data.items.length === 0 ? (
          <EmptyState
            variant="stage"
            scale="page"
            specimen="shares"
            title="还没有分享过成果"
            description="在对话右侧的会话成果面板中，可为任意版本生成只读分享链接。"
            action={
              <Link to="/chat" className={buttonVariants({ size: 'sm' })}>
                去对话
              </Link>
            }
          />
        ) : view === 'cards' ? (
          shares.isPending ? (
            <LoadingState rows={3} layout="cards" />
          ) : (
            <ul
              aria-label="公开分享列表"
              className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,256px),1fr))] gap-4 p-0 pt-2"
            >
              {(shares.data?.items ?? []).map((share) => (
                <li key={share.id} className="min-w-0">
                  <ShareCard
                    share={share}
                    canOpenConversation={canOpenConversation}
                    revokePending={revoke.isPending}
                    onRevoke={requestRevoke}
                  />
                </li>
              ))}
            </ul>
          )
        ) : (
          <DataTable
            rows={shares.data?.items ?? []}
            columns={columns}
            rowKey={(share) => share.id}
            label="我的会话分享"
            loading={shares.isPending}
            empty="没有分享链接"
          />
        )}

        {cursor || shares.data?.nextCursor ? (
          <PageToolbar>
            {cursor ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: '/personal/shares',
                    search: (current) => ({ ...current, cursor: undefined }),
                  })
                }
              >
                回到最新
              </Button>
            ) : null}
            {shares.data?.nextCursor ? (
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() =>
                  void navigate({
                    to: '/personal/shares',
                    search: (current) => ({
                      ...current,
                      cursor: shares.data?.nextCursor ?? undefined,
                    }),
                  })
                }
              >
                下一页
              </Button>
            ) : null}
          </PageToolbar>
        ) : null}
      </PageBody>

      <ConfirmDialog
        open={target !== null}
        onClose={() => {
          setTarget(null);
          setModalError(null);
        }}
        title="撤销这次分享？"
        description={
          target ? `「${fileName(target.path)}」的公开链接会立即失效，已打开的人也无法再访问。` : ''
        }
        confirmLabel="撤销分享"
        confirmDisabled={revoke.isPending}
        onConfirm={async () => {
          if (!target) return;
          await revoke.mutateAsync(target.id);
          setTarget(null);
          setModalError(null);
          toastSuccess('分享已撤销');
        }}
        onError={(error) => setModalError(errorMessage(error))}
      >
        {modalError ? <FieldError>{modalError}</FieldError> : null}
      </ConfirmDialog>
    </Page>
  );
}
