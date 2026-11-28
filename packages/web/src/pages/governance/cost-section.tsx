import type { CostGroupBy, CostSummary } from '@agentport/shared';
import { Activity, Coins, Cpu, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { type DataColumn, DataTable } from '../../components/data-table.js';
import { MetricCard, MetricGrid } from '../../components/metric-card.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { formatCost, formatDate, formatTokenCount, formatTokens } from '../../lib/format.js';
import { useCostSummary } from '../../lib/queries.js';

export const COST_GROUPS: readonly { value: CostGroupBy; label: string }[] = [
  { value: 'user', label: '按人' },
  { value: 'department', label: '按部门' },
  { value: 'model', label: '按模型' },
];

export const COST_WINDOWS = [7, 30, 90] as const;

type CostGroupRow = CostSummary['groups'][number];

export function CostSection({ days, groupBy }: { days: 7 | 30 | 90; groupBy: CostGroupBy }) {
  const summary = useCostSummary(days, groupBy);
  const groups = summary.data?.groups ?? [];

  const totals = useMemo(() => {
    let costUsd = 0;
    let runs = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const group of groups) {
      costUsd += group.costUsd;
      runs += group.runs;
      inputTokens += group.inputTokens;
      outputTokens += group.outputTokens;
    }
    return { costUsd, runs, inputTokens, outputTokens };
  }, [groups]);

  const groupHeader = groupBy === 'user' ? '用户' : groupBy === 'department' ? '部门' : '模型';

  const columns = useMemo<DataColumn<CostGroupRow>[]>(
    () => [
      {
        id: 'label',
        header: groupHeader,
        locked: true,
        width: 'minmax(180px,1.6fr)',
        sortValue: (group) => group.label || group.key,
        cell: (group) => (
          <span
            className="block overflow-hidden text-ellipsis whitespace-nowrap font-medium text-fg"
            title={group.label || group.key}
          >
            {group.label || '未记录'}
          </span>
        ),
      },
      {
        id: 'runs',
        header: '运行数',
        numeric: true,
        width: '100px',
        sortValue: (group) => group.runs,
        cell: (group) => formatTokenCount(group.runs),
      },
      {
        id: 'costUsd',
        header: '成本',
        numeric: true,
        width: '112px',
        sortValue: (group) => group.costUsd,
        cell: (group) => <span className="text-fg">{formatCost(group.costUsd)}</span>,
      },
      {
        id: 'inputTokens',
        header: '输入 token',
        numeric: true,
        width: '112px',
        sortValue: (group) => group.inputTokens,
        cell: (group) => formatTokens(group.inputTokens),
      },
      {
        id: 'outputTokens',
        header: '输出 token',
        numeric: true,
        width: '112px',
        sortValue: (group) => group.outputTokens,
        cell: (group) => formatTokens(group.outputTokens),
      },
    ],
    [groupHeader],
  );

  if (summary.isPending) return <LoadingState rows={4} />;
  if (summary.isError) {
    return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {summary.data ? (
        <MetricGrid columns={4}>
          <MetricCard
            label="总成本"
            value={formatCost(totals.costUsd)}
            hint={`${formatDate(summary.data.since)} 起`}
            icon={Coins}
          />
          <MetricCard
            label="运行次数"
            value={formatTokenCount(totals.runs)}
            hint={`近 ${days} 天`}
            icon={Activity}
          />
          <MetricCard
            label="Token 总量"
            value={formatTokens(totals.inputTokens + totals.outputTokens)}
            hint={`输入 ${formatTokens(totals.inputTokens)} · 输出 ${formatTokens(totals.outputTokens)}`}
            icon={Cpu}
          />
          <MetricCard
            label="统计对象数"
            value={formatTokenCount(groups.length)}
            hint={
              groupBy === 'user'
                ? '按人统计'
                : groupBy === 'department'
                  ? '按部门统计'
                  : '按模型统计'
            }
            icon={Layers}
          />
        </MetricGrid>
      ) : null}

      {summary.data && groups.length === 0 ? (
        <EmptyState
          variant="idle"
          scale="section"
          icon={<Coins className="size-5" aria-hidden="true" />}
          title="当前窗口内没有产生运行成本"
          description="专家运行后将按所选维度自动汇总。"
        />
      ) : null}

      {groups.length > 0 ? (
        <DataTable
          rows={groups}
          columns={columns}
          rowKey={(group) => group.key}
          rowLabel={(group) => group.label || group.key}
          label="成本汇总"
          storageKey="pace.governance.cost-columns"
          initialSorting={[{ id: 'costUsd', desc: true }]}
          hideRowCount
        />
      ) : null}
    </div>
  );
}
