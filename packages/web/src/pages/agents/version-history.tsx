import type { Agent, AgentDefinition } from '@agentport/shared';
import { ChevronRight, Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../components/motion-collapsible.js';
import { ErrorState, InlineEmpty, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import type { AgentVersionSummary } from '../../lib/api.js';
import { cn } from '../../lib/cn.js';
import { formatDateTime } from '../../lib/format.js';
import {
  useAgentVersion,
  useAgentVersions,
  useRollbackAgent,
  useStartEvalRun,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';

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
  ['monthlyBudgetUsd', '月度预算上限'],
  ['budgetAlertRatio', '预算告警阈值'],
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

function definitionRows(definition: AgentDefinition): Array<[string, string]> {
  const names = (items: ReadonlyArray<{ name: string }>): string =>
    items.length === 0 ? '空' : items.map((item) => item.name).join('、');
  const { hooks, memoryPolicy, resources } = definition;
  const bindings = [
    resources.servers.length > 0 ? `Servers：${names(resources.servers)}` : null,
    resources.skills.length > 0 ? `技能：${names(resources.skills)}` : null,
    resources.plugins.length > 0 ? `插件：${names(resources.plugins)}` : null,
    resources.subAgents.length > 0 ? `子智能体：${names(resources.subAgents)}` : null,
    resources.runtimeEnvironment ? `运行环境：${resources.runtimeEnvironment.name}` : null,
  ].filter((item): item is string => item !== null);
  return [
    ['规则', `${definition.rules.length} 条`],
    [
      '输出风格',
      `${definition.outputStyles.length} 个${
        definition.outputStyles.some((style) => style.isSelected) ? '（已选中）' : ''
      }`,
    ],
    ['工作流', `${definition.workflows.length} 个`],
    ['Hooks', `${hooks.enabled ? '已启用' : '未启用'} · ${hooks.files.length} 个文件`],
    [
      '记忆策略',
      `${memoryPolicy.enabled ? '启用' : '停用'} · ${
        memoryPolicy.writeMode === 'proposal_only' ? '仅提案' : '模型自动写入'
      } · 主题上限 ${memoryPolicy.topicLimit}`,
    ],
    ['资源绑定', bindings.length === 0 ? '未绑定资源' : bindings.join('；')],
  ];
}

export function VersionHistory({
  agentId,
  current,
  active,
  saving,
  dirty = false,
  canRestore = true,
  canEvaluate = false,
  onPendingChange,
  onRolledBack,
}: {
  agentId: string;
  current: Agent;
  active: boolean;
  saving: boolean;
  dirty?: boolean;
  canRestore?: boolean;
  canEvaluate?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onRolledBack: (agent: Agent) => void;
}) {
  const versions = useAgentVersions(agentId, active);
  const rollback = useRollbackAgent();
  const regression = useStartEvalRun();
  const [pending, setPending] = useState<AgentVersionSummary | null>(null);
  const pendingDetail = useAgentVersion(agentId, pending?.version ?? 0, pending !== null);
  const rollbackDisabled =
    saving || pendingDetail.isPending || pendingDetail.isError || !pendingDetail.data;
  const pendingDiff =
    pending !== null && pendingDetail.data ? diffAgent(current, pendingDetail.data.snapshot) : null;
  const restoreScope =
    pendingDetail.data?.definitionState === 'legacy'
      ? '该版本没有完整定义，回滚只恢复基本字段与绑定'
      : '回滚仍会按完整定义恢复规则、输出风格、工作流、Hooks、记忆策略与资源绑定';

  return (
    <div className="flex flex-col gap-3">
      {canEvaluate ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
          <p className="max-w-[42ch] text-sm text-muted-foreground">
            用已保存的当前草稿跑一遍评估用例，确认结果后再发布。
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={regression.isPending || saving}
            aria-busy={regression.isPending}
            onClick={() =>
              regression.mutate(
                { agentId, target: 'draft' },
                {
                  onSuccess: () => toastSuccess('已用当前草稿发起回归评估，可在「评估」页查看'),
                  onError: toastError,
                },
              )
            }
          >
            <Play /> {regression.isPending ? '启动中…' : '发布前回归'}
          </Button>
        </div>
      ) : null}
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
                ? `该版本与当前配置的基本字段一致；${restoreScope}，并生成一个新版本设为线上。`
                : `将把 ${pendingDiff.length} 个字段改为该版本的值：${pendingDiff
                    .map((entry) => entry.label)
                    .join('、')}。当前配置会被覆盖；${restoreScope}，并生成一个新版本设为线上。`)
        }
        confirmLabel="回滚"
        confirmDisabled={rollbackDisabled}
        onConfirm={async () => {
          if (!pending || rollbackDisabled) return;
          onPendingChange?.(true);
          try {
            const result = await rollback.mutateAsync({ id: agentId, version: pending.version });
            if (result.kind === 'detail') onRolledBack(result.agent);
            const publishedVersion =
              result.kind === 'detail' ? result.agent.publishedVersion : null;
            toastSuccess(`已恢复并发布 v${publishedVersion ?? pending.version}`);
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
              {item.version === current.publishedVersion ? (
                <StatusBadge tone="success">线上</StatusBadge>
              ) : null}
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
            {detail.data?.definition ? (
              <div className="mt-2 border-t pt-2">
                <p className="text-2xs font-medium text-muted-foreground">完整定义</p>
                <ul className="mt-1 flex flex-col gap-1 text-2xs">
                  {definitionRows(detail.data.definition).map(([label, value]) => (
                    <li key={label} className="flex gap-2">
                      <span className="w-[6.5rem] shrink-0 text-muted-foreground">{label}</span>
                      <span className="min-w-0 flex-1 break-all text-fg">{value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {detail.data?.definitionState === 'legacy' ? (
              <p className="mt-2 text-2xs text-muted-foreground">
                该版本记录于完整定义上线之前，回滚只能恢复基本字段与绑定；规则、输出风格、工作流、Hooks
                与记忆策略不会随该版本恢复。
              </p>
            ) : null}
            {detail.data?.definitionState === 'forbidden' ? (
              <p className="mt-2 text-2xs text-muted-foreground">
                没有查看该版本完整定义的权限，只能按字段差异查看；回滚仍会按该版本的完整定义恢复。
              </p>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
