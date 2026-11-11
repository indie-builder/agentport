import type { Agent } from '@agentport/shared';
import { ChevronRight, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/motion-collapsible.js';
import { ErrorState, InlineEmpty, LoadingState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import type { AgentVersionSummary } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { formatDateTime } from '../../lib/format.js';
import { useAgentVersion, useAgentVersions, useRollbackAgent } from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';

const diffFields: ReadonlyArray<readonly [keyof Agent, string]> = [
  ['name', '名称'],
  ['role', '角色'],
  ['description', '描述'],
  ['model', '模型'],
  ['systemPrompt', '系统提示词'],
  ['uiFormat', '回复格式'],
  ['serverIds', 'MCP Servers'],
  ['skillIds', '技能'],
  ['subAgentIds', '子智能体'],
  ['pluginBindings', '插件绑定'],
  ['allowedTools', '允许的工具'],
  ['disallowedTools', '禁用的工具'],
  ['permissionMode', '权限模式'],
  ['maxTurns', '最大轮次'],
  ['maxBudgetUsd', '预算上限'],
  ['timeoutMs', '独立运行超时'],
  ['runtimeEnvironmentId', '运行环境'],
  ['effort', '推理强度'],
  ['enabled', '启用状态'],
];

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '空';
  if (Array.isArray(value)) return value.length === 0 ? '空' : JSON.stringify(value, null, 2);
  if (typeof value === 'boolean') return value ? '启用' : '停用';
  return String(value);
}

function diffAgent(
  current: Agent,
  snapshot: Agent,
): Array<{ label: string; from: string; to: string }> {
  return diffFields
    .filter(([key]) => JSON.stringify(current[key]) !== JSON.stringify(snapshot[key]))
    .map(([key, label]) => ({
      label,
      from: displayValue(current[key]),
      to: displayValue(snapshot[key]),
    }));
}

export function VersionHistory({
  agentId,
  current,
  active,
  saving,
  dirty = false,
  canRestore = true,
  onPendingChange,
  onRolledBack,
}: {
  agentId: string;
  current: Agent;
  active: boolean;
  saving: boolean;
  dirty?: boolean;
  canRestore?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onRolledBack: (agent: Agent) => void;
}) {
  const versions = useAgentVersions(agentId, active);
  const rollback = useRollbackAgent();
  const [pending, setPending] = useState<AgentVersionSummary | null>(null);
  const pendingDetail = useAgentVersion(agentId, pending?.version ?? 0, pending !== null);
  const rollbackDisabled =
    saving || pendingDetail.isPending || pendingDetail.isError || !pendingDetail.data;
  const pendingDiff =
    pending !== null && pendingDetail.data ? diffAgent(current, pendingDetail.data.snapshot) : null;

  return (
    <div className="flex flex-col gap-3">
      {versions.isPending ? <LoadingState rows={4} /> : null}
      {versions.isError ? (
        <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
      ) : null}
      {versions.data && versions.data.length === 0 ? (
        <InlineEmpty>还没有版本记录。修改配置并保存后，这里会留下第一份快照。</InlineEmpty>
      ) : null}
      {versions.data && versions.data.length > 0 ? (
        <ul className="divide-y divide-line border-y">
          {versions.data.map((item) => (
            <VersionRow
              key={item.id}
              agentId={agentId}
              item={item}
              current={current}
              rollbackDisabled={saving}
              canRestore={canRestore}
              onRollback={() => setPending(item)}
            />
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={`回滚到 v${pending?.version ?? ''}`}
        description={
          (dirty ? '当前未保存的更改会丢失。回滚失败时会保留当前草稿。' : '') +
          (pendingDetail.isError
            ? '无法读取该版本，请重试后再回滚。'
            : pendingDiff === null
              ? '正在读取该版本的差异…'
              : pendingDiff.length === 0
                ? '该版本与当前配置一致，回滚不会改变字段。仍会生成一个新版本。'
                : `将把 ${pendingDiff.length} 个字段改为该版本的值：${pendingDiff
                    .map((entry) => entry.label)
                    .join('、')}。当前配置会被覆盖，并生成一个新版本。`)
        }
        confirmLabel="回滚"
        confirmDisabled={rollbackDisabled}
        onConfirm={async () => {
          if (!pending || rollbackDisabled) return;
          onPendingChange?.(true);
          try {
            const agent = await rollback.mutateAsync({ id: agentId, version: pending.version });
            onRolledBack(agent);
            toastSuccess(`已回滚到 v${pending.version}`);
          } finally {
            onPendingChange?.(false);
          }
        }}
      >
        {pendingDetail.isError ? (
          <ErrorState error={pendingDetail.error} onRetry={() => void pendingDetail.refetch()} />
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

function VersionRow({
  agentId,
  item,
  current,
  rollbackDisabled,
  canRestore,
  onRollback,
}: {
  agentId: string;
  item: AgentVersionSummary;
  current: Agent;
  rollbackDisabled: boolean;
  canRestore: boolean;
  onRollback: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detail = useAgentVersion(agentId, item.version, open);
  const diff = detail.data ? diffAgent(current, detail.data.snapshot) : null;

  return (
    <li className="py-2.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-medium tabular-nums text-fg">
                v{item.version}
              </span>
              {item.note ? (
                <span className="truncate rounded-tag bg-chip px-1.5 py-0.5 text-2xs text-muted-foreground">
                  {item.note}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 font-mono text-2xs tabular-nums text-muted-foreground">
              {formatDateTime(item.createdAt)}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <CollapsibleTrigger
              render={
                <Button variant="ghost" size="sm">
                  <ChevronRight
                    className={cn('transition-transform', open && 'rotate-90')}
                    aria-hidden="true"
                  />
                  {open ? '收起差异' : '查看差异'}
                </Button>
              }
            />
            {canRestore ? (
              <Button variant="outline" size="sm" disabled={rollbackDisabled} onClick={onRollback}>
                <RotateCcw /> 回滚
              </Button>
            ) : null}
          </div>
        </div>
        <CollapsibleContent animated>
          <div className="mt-2">
            {detail.isPending ? <LoadingState rows={2} /> : null}
            {detail.isError ? (
              <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
            ) : null}
            {diff && diff.length === 0 ? (
              <p className="text-2xs text-muted-foreground">与当前配置一致。</p>
            ) : null}
            {diff && diff.length > 0 ? (
              <ul className="divide-y divide-line border-y">
                {diff.map((entry) => (
                  <li
                    key={entry.label}
                    className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 py-1.5 text-2xs"
                  >
                    <span className="text-muted-foreground">{entry.label}</span>
                    <span className="whitespace-pre-wrap break-all text-fg">
                      <span className="text-muted-foreground">{entry.from}</span>
                      <span className="mx-1 text-muted-foreground" aria-hidden="true">
                        →
                      </span>
                      <span>{entry.to}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
