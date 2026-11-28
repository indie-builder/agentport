import type { HandoverChecklist, HandoverTransferResult } from '@agentport/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowRight, ArrowRightLeft } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../../components/ui/accordion.js';
import { Button } from '../../components/ui/button.js';
import { Field, FieldError, FieldLabel } from '../../components/ui/field.js';
import { errorMessage } from '../../lib/api.js';
import { useHandover, useTransferHandover } from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';
import { useOptimisticValue } from '../../lib/use-optimistic-value.js';
import { AccountCombobox } from './account-combobox.js';

const HANDOVER_GROUPS: readonly {
  key: keyof HandoverChecklist['items'] & keyof HandoverChecklist['counts'];
  label: string;
}[] = [
  { key: 'agents', label: '专家' },
  { key: 'knowledgeBases', label: '知识库' },
  { key: 'dataDomains', label: '数据域' },
  { key: 'skills', label: '技能' },
  { key: 'servers', label: '连接器' },
  { key: 'plugins', label: '插件' },
  { key: 'runtimeEnvironments', label: '运行环境' },
  { key: 'schedules', label: '定时任务' },
];

export function HandoverSection({ canManage }: { canManage: boolean }) {
  const search = useSearch({ from: '/_shell/governance' });
  const navigate = useNavigate({ from: '/governance' });
  const businessId = search.businessId ?? '';
  const [optimisticBusinessId, commitBusinessId] = useOptimisticValue(businessId);
  const checklist = useHandover(businessId);
  const transfer = useTransferHandover();
  const [receiver, setReceiver] = useState('');
  const [receiverName, setReceiverName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [result, setResult] = useState<HandoverTransferResult | null>(null);
  const data = checklist.data ?? null;
  const total = data ? Object.values(data.counts).reduce((sum, value) => sum + value, 0) : 0;
  const nonEmptyGroups = data
    ? HANDOVER_GROUPS.filter((group) => data.items[group.key].length > 0)
    : [];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="grid min-w-0 grid-cols-1 items-end gap-4 rounded-card border border-line bg-surface p-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
        <Field className="min-w-0">
          <FieldLabel htmlFor="handover-source">1. 选择离职账户</FieldLabel>
          <AccountCombobox
            id="handover-source"
            label="离职账户"
            placeholder="搜索离职账户姓名或业务 ID…"
            value={optimisticBusinessId}
            {...(data?.name ? { valueLabel: `${data.name}（${data.businessId}）` } : {})}
            onChange={(next) => {
              setReceiver('');
              setReceiverName('');
              setResult(null);
              setTransferError(null);
              commitBusinessId(next, () =>
                navigate({
                  to: '/governance',
                  search: { ...search, businessId: next || undefined },
                  replace: true,
                }),
              );
            }}
          />
        </Field>

        <div className="hidden h-8 items-center justify-center text-muted-foreground lg:flex">
          <ArrowRight aria-hidden="true" />
        </div>

        <Field className="min-w-0" data-disabled={!canManage || !data || total === 0}>
          <FieldLabel htmlFor="handover-target">2. 选择接收人</FieldLabel>
          <AccountCombobox
            id="handover-target"
            label="接收人"
            placeholder={
              !data ? '先选择离职账户' : total === 0 ? '没有可转交资产' : '搜索接收人姓名或业务 ID…'
            }
            value={receiver}
            activeOnly
            excludeBusinessIds={data ? [data.businessId] : []}
            disabled={!canManage || !data || total === 0}
            onChange={(next, account) => {
              setReceiver(next);
              setReceiverName(account?.name ?? '');
              setResult(null);
              setTransferError(null);
            }}
          />
        </Field>

        <div className="flex items-center justify-end gap-3">
          {result ? (
            <span role="status" className="text-sm text-muted-foreground">
              已转交 {result.total} 项
            </span>
          ) : null}
          <Button
            disabled={!canManage || !data || total === 0 || receiver.length === 0}
            onClick={() => setConfirming(true)}
          >
            <ArrowRightLeft data-icon="inline-start" aria-hidden="true" /> 批量转交
          </Button>
        </div>
      </div>

      {businessId.length === 0 ? (
        <EmptyState
          variant="idle"
          scale="section"
          icon={<ArrowRightLeft className="size-5" aria-hidden="true" />}
          title="选择需要交接的账户"
          description="将汇总其名下的专家、资源与定时任务，核对明细后一键整体转交。"
        />
      ) : null}
      {businessId.length > 0 && checklist.isPending ? <LoadingState rows={4} /> : null}
      {businessId.length > 0 && checklist.isError ? (
        <ErrorState error={checklist.error} onRetry={() => void checklist.refetch()} />
      ) : null}

      {data ? (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-fg">{data.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{data.businessId}</span>
                <StatusBadge
                  tone={
                    data.status === 'active'
                      ? 'success'
                      : data.status === 'deleted'
                        ? 'danger'
                        : 'default'
                  }
                >
                  {data.status === 'active'
                    ? '启用'
                    : data.status === 'deleted'
                      ? '已删除'
                      : '停用'}
                </StatusBadge>
              </div>
              <span className="text-sm tabular-nums text-muted-foreground">
                可转交资产 <strong className="font-medium text-fg">{total}</strong> 项
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line pt-2.5 text-xs">
              {HANDOVER_GROUPS.map((group) => {
                const count = data.counts[group.key];
                return (
                  <span key={group.key} className={count > 0 ? 'text-fg' : 'text-muted-foreground'}>
                    {group.label}{' '}
                    <span className="font-mono font-medium tabular-nums">{count}</span>
                  </span>
                );
              })}
            </div>

            {data.departments.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2.5 text-xs text-muted-foreground">
                <span>所属部门</span>
                {data.departments.map((department) => (
                  <StatusBadge key={department.id}>
                    {department.name}
                    {department.isManager ? ' · 负责人' : ''}
                  </StatusBadge>
                ))}
              </div>
            ) : null}
          </div>

          {nonEmptyGroups.length === 0 ? (
            <EmptyState variant="clear" scale="inline" title="该账户名下没有需要转交的资源" />
          ) : (
            <div className="rounded-card border border-line bg-surface px-4">
              <Accordion multiple aria-label="可转交资产明细">
                {nonEmptyGroups.map((group) => {
                  const groupItems = data.items[group.key];
                  return (
                    <AccordionItem key={group.key} value={group.key}>
                      <AccordionTrigger className="items-center gap-2 py-3 hover:no-underline">
                        <span className="text-sm font-medium text-fg">{group.label}</span>
                        <StatusBadge tone="mono">{groupItems.length}</StatusBadge>
                      </AccordionTrigger>
                      <AccordionContent>
                        <ul className="divide-y divide-line border-t border-line">
                          {groupItems.map((item) => (
                            <li
                              key={item.id}
                              className="flex min-w-0 items-baseline justify-between gap-3 py-2 text-sm"
                            >
                              <span
                                className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-fg"
                                title={item.name}
                              >
                                {item.name}
                              </span>
                              {'agentName' in item ? (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {item.agentName}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </div>
          )}

          <ConfirmDialog
            open={confirming}
            title="确认批量转交？"
            description={`把「${data.name}」名下的 ${total} 项资源转交给${receiverName ? `「${receiverName}」` : '接收人'}；接收人必须对各类资源拥有管理权限，校验失败时不会部分转交。`}
            confirmLabel="确认转交"
            tone="default"
            confirmDisabled={transfer.isPending}
            onClose={() => {
              setConfirming(false);
              setTransferError(null);
            }}
            onConfirm={async () => {
              const transferred = await transfer.mutateAsync({
                businessId: data.businessId,
                toBusinessId: receiver,
              });
              setResult(transferred);
              toastSuccess(`已转交 ${transferred.total} 项资源`);
            }}
            onError={(error) => setTransferError(errorMessage(error))}
          >
            {transferError ? <FieldError>{transferError}</FieldError> : null}
          </ConfirmDialog>
        </div>
      ) : null}
    </div>
  );
}
