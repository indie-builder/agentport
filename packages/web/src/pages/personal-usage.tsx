import type { PersonalRun, PersonalRunListQuery, PersonalUsageSummary } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Activity } from 'lucide-react';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { FilterSelect } from '../components/filter-select.js';
import { Page, PageHeader, PageNote, PageSection, PageToolbar } from '../components/page.js';
import { RunStatusBadge } from '../components/run-status-badge.js';
import { ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { can } from '../lib/access.js';
import type { RunStatus } from '../lib/api.js';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  runStatusLabel,
  shortId,
} from '../lib/format.js';
import { agentsQuery, meQuery, usePersonalRuns, usePersonalUsage } from '../lib/queries.js';

const triggers = ['chat', 'mcp', 'schedule', 'event', 'review'] as const;
type Trigger = (typeof triggers)[number];

const triggerLabel: Record<Trigger, string> = {
  chat: '对话',
  mcp: '连接器',
  schedule: '定时任务',
  event: '事件',
  review: '历史回顾',
};

const statuses: RunStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'];

// 汇总窗口是 UTC 日界，固定按 UTC 显示，不跟随浏览器本地时区。
const utcDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

function formatUtcDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : utcDateTimeFormatter.format(date);
}

function usageRows(summary: PersonalUsageSummary): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['运行次数', String(summary.runCount)],
    ['成功', String(summary.succeeded)],
    ['失败', String(summary.failed)],
    ['已取消', String(summary.cancelled)],
    ['超时', String(summary.timeout)],
    ['排队中', String(summary.queued)],
    ['运行中', String(summary.running)],
    [
      '已记录 Token',
      `${formatTokens(summary.inputTokens)} 输入 / ${formatTokens(summary.outputTokens)} 输出`,
    ],
  ];
  const cost =
    summary.costUsd === null
      ? '未记录'
      : `${formatCost(summary.costUsd)} · ${summary.costRecordedRuns}/${summary.runCount} 次运行`;
  rows.push(['已记录成本', cost]);
  if (summary.costUsd !== null && summary.costMissingRuns > 0) {
    rows.push(['成本覆盖', `${summary.costMissingRuns} 次运行未记录成本`]);
  }
  return rows;
}

function runDestination(
  run: PersonalRun,
  options: { canReadMemory: boolean; canReadConversations: boolean },
): 'review' | 'chat' | 'detail' {
  if (run.trigger === 'review' && options.canReadMemory) return 'review';
  if (run.trigger === 'chat' && run.conversationId && options.canReadConversations) return 'chat';
  return 'detail';
}

export function PersonalUsagePage() {
  const me = useQuery(meQuery);
  const search = useSearch({ from: '/_shell/personal/usage' });
  const navigate = useNavigate({ from: '/personal/usage' });
  const canOverview = can(me.data, 'overview.read');
  const canRuns = can(me.data, 'runs.read');
  const canAgents = can(me.data, 'agents.read');
  const canReadMemory = can(me.data, 'personal_memory.read');
  const canReadConversations = can(me.data, 'conversations.read');
  const days = search.days ?? 30;
  const cursor = search.cursor ?? null;
  const usage = usePersonalUsage(days, canOverview);
  const agents = useQuery({ ...agentsQuery, enabled: canAgents });
  const query: PersonalRunListQuery = {
    days,
    limit: 50,
    ...(search.agent ? { agentId: search.agent } : {}),
    ...(search.status ? { status: search.status } : {}),
    ...(search.trigger ? { trigger: search.trigger } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const runs = usePersonalRuns(query, canRuns);

  const patchSearch = (patch: {
    days?: number;
    agent?: string | undefined;
    status?: RunStatus | undefined;
    trigger?: Trigger | undefined;
    cursor?: string | undefined;
  }): void => {
    void navigate({
      to: '/personal/usage',
      search: (current) => ({ ...current, ...patch }),
    });
  };

  const agentOptions = [
    { value: '', label: '全部专家' },
    ...(agents.data ?? []).map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const columns: DataColumn<PersonalRun>[] = [
    {
      id: 'id',
      header: '运行 ID',
      locked: true,
      width: '112px',
      cell: (run) => (
        <code className="font-mono text-xs text-muted-foreground" title={run.id}>
          {shortId(run.id)}
        </code>
      ),
    },
    {
      id: 'agent',
      header: '专家',
      width: 'minmax(120px,1fr)',
      cell: (run) => <span className="block truncate text-fg">{run.agentName ?? '已删除'}</span>,
    },
    {
      id: 'status',
      header: '状态',
      width: '96px',
      cell: (run) => <RunStatusBadge status={run.status} />,
    },
    {
      id: 'trigger',
      header: '来源',
      width: '88px',
      cell: (run) => (
        <span className="text-sm text-muted-foreground">{triggerLabel[run.trigger]}</span>
      ),
    },
    {
      id: 'startedAt',
      header: '开始',
      width: '110px',
      cell: (run) => (
        <span className="text-sm text-muted-foreground" title={run.startedAt ?? run.createdAt}>
          {formatDateTime(run.startedAt ?? run.createdAt)}
        </span>
      ),
    },
    {
      id: 'latency',
      header: '耗时',
      numeric: true,
      width: '76px',
      cell: (run) => formatDuration(run.latencyMs),
    },
    {
      id: 'cost',
      header: '成本',
      numeric: true,
      width: '84px',
      cell: (run) => formatCost(run.costUsd),
    },
    {
      id: 'tokens',
      header: 'Token',
      numeric: true,
      width: '116px',
      cell: (run) => `${formatTokens(run.inputTokens)} / ${formatTokens(run.outputTokens)}`,
    },
  ];

  return (
    <Page>
      <PageHeader title="使用记录" />

      <PageToolbar>
        <FilterSelect
          value={String(days)}
          onValueChange={(next) => patchSearch({ days: Number(next), cursor: undefined })}
          options={[
            { value: '7', label: '最近 7 天' },
            { value: '30', label: '最近 30 天' },
            { value: '90', label: '最近 90 天' },
          ]}
          label="统计窗口"
          className="w-full sm:w-32"
        />
        {canAgents ? (
          <FilterSelect
            value={search.agent ?? ''}
            onValueChange={(next) => patchSearch({ agent: next || undefined, cursor: undefined })}
            options={agentOptions}
            label="按专家筛选"
            className="w-full sm:w-36"
          />
        ) : null}
        <FilterSelect
          value={search.status ?? ''}
          onValueChange={(next) =>
            patchSearch({
              status: (next || undefined) as RunStatus | undefined,
              cursor: undefined,
            })
          }
          options={[
            { value: '', label: '全部状态' },
            ...statuses.map((status) => ({ value: status, label: runStatusLabel[status] })),
          ]}
          label="按状态筛选"
          className="w-full sm:w-32"
        />
        <FilterSelect
          value={search.trigger ?? ''}
          onValueChange={(next) =>
            patchSearch({
              trigger: (next || undefined) as Trigger | undefined,
              cursor: undefined,
            })
          }
          options={[
            { value: '', label: '全部来源' },
            ...triggers.map((trigger) => ({ value: trigger, label: triggerLabel[trigger] })),
          ]}
          label="按来源筛选"
          className="w-full sm:w-32"
        />
      </PageToolbar>

      {canOverview ? (
        <PageSection
          title="使用汇总"
          description={
            usage.data
              ? `${formatUtcDateTime(usage.data.since)} – ${formatUtcDateTime(usage.data.until)}（UTC，按运行创建时间）`
              : `最近 ${days} 天（UTC，按运行创建时间）`
          }
        >
          {usage.isPending ? <LoadingState rows={3} /> : null}
          {usage.isError ? (
            <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
          ) : null}
          {usage.data ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>指标</TableHead>
                  <TableHead className="text-right">数值</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usageRows(usage.data).map(([label, value]) => (
                  <TableRow key={label}>
                    <TableCell className="text-muted-foreground">{label}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-fg">
                      {value}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </PageSection>
      ) : null}

      {canRuns ? (
        <PageSection
          title="运行"
          description="汇总不随下面的筛选和分页变化。"
          actions={
            cursor || runs.data?.nextCursor ? (
              <div className="flex items-center gap-2">
                {cursor ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => patchSearch({ cursor: undefined })}
                  >
                    回到最新
                  </Button>
                ) : null}
                {runs.data?.nextCursor ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => patchSearch({ cursor: runs.data?.nextCursor ?? undefined })}
                  >
                    下一页
                  </Button>
                ) : null}
              </div>
            ) : undefined
          }
        >
          {runs.isError ? (
            <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
          ) : runs.data && runs.data.items.length === 0 ? (
            <PageNote
              icon={<Activity className="size-4" aria-hidden="true" />}
              title="这个窗口还没有运行记录"
              action={
                <Link to="/chat" className="text-sm text-primary underline underline-offset-4">
                  新建对话
                </Link>
              }
            />
          ) : (
            <DataTable
              rows={runs.data?.items ?? []}
              columns={columns}
              rowKey={(run) => run.id}
              label="我的运行"
              loading={runs.isPending}
              empty="没有运行记录"
              onRowClick={(run) => {
                const destination = runDestination(run, {
                  canReadMemory,
                  canReadConversations,
                });
                if (destination === 'review') {
                  void navigate({ to: '/personal/reviews', search: { run: run.id } });
                  return;
                }
                if (destination === 'chat' && run.conversationId) {
                  void navigate({
                    to: '/chat',
                    search: { agent: run.agentId, conversation: run.conversationId },
                  });
                  return;
                }
                void navigate({ to: '/runs/$runId', params: { runId: run.id } });
              }}
            />
          )}
        </PageSection>
      ) : null}
    </Page>
  );
}
