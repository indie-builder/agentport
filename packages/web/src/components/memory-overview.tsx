import type { AgentMemoryAssembly, AgentMemoryOverview, MemoryHealth } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { FileText, Gauge, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatBytes, formatDateTime } from '../lib/format.js';
import { agentMemoryAssemblyQuery, agentMemoryOverviewQuery } from '../lib/queries.js';
import { EmptyState, ErrorState, LoadingState } from './states.js';
import { StatusBadge } from './status-badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js';

const HEALTH_TONE: Record<MemoryHealth['level'], 'success' | 'warn' | 'danger'> = {
  ok: 'success',
  warn: 'warn',
  danger: 'danger',
};

/** 状态不只靠颜色：徽章同时给出文字档位。 */
const HEALTH_LABEL: Record<MemoryHealth['level'], string> = {
  ok: '正常',
  warn: '注意',
  danger: '异常',
};

const TRIGGER_LABEL: Record<AgentMemoryAssembly['blocks'][number]['trigger'], string> = {
  'every-run': '每轮加载',
  'on-demand': '按需加载',
  skipped: '已跳过',
};

/** 概览只列最近 3 条变更，其余交给文件视图的版本区。 */
const RECENT_CHANGE_LIMIT = 3;

function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: typeof FileText;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          <span className="text-sm font-normal text-muted-foreground">{label}</span>
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <span className="min-w-0 break-words text-xl font-medium tabular-nums text-fg [overflow-wrap:anywhere]">
          {value}
        </span>
        <CardDescription className="tabular-nums">{hint}</CardDescription>
      </CardContent>
    </Card>
  );
}

function SectionHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="text-sm font-medium text-fg">
      {children}
    </h2>
  );
}

function HealthSection({
  items,
  onOpenFiles,
}: {
  items: MemoryHealth[];
  onOpenFiles?: (() => void) | undefined;
}) {
  // 缺索引时直接给出下一步动作，而不是只留一条提示。
  const needIndex = items.some((item) => item.code === 'index_missing');
  return (
    <section aria-labelledby="memory-health-title" className="flex flex-col gap-2">
      <SectionHeading id="memory-health-title">健康检查</SectionHeading>
      <ul className="divide-y border-y">
        {items.map((item) => (
          <li key={item.code} className="flex items-start gap-3 py-2.5">
            <StatusBadge tone={HEALTH_TONE[item.level]} className="mt-0.5 shrink-0">
              {HEALTH_LABEL[item.level]}
            </StatusBadge>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-fg">{item.title}</div>
              <div className="mt-0.5 break-words text-xs text-muted-foreground">{item.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      {needIndex && onOpenFiles ? (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onOpenFiles}>
            去文件视图初始化
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function AssemblySection({ agentId }: { agentId: string }) {
  const assembly = useQuery(agentMemoryAssemblyQuery(agentId));

  return (
    <section aria-labelledby="memory-assembly-title" className="flex flex-col gap-2">
      <SectionHeading id="memory-assembly-title">装配预览</SectionHeading>
      {assembly.isPending ? <LoadingState rows={3} /> : null}
      {assembly.data === undefined && !assembly.isPending ? (
        <ErrorState error={assembly.error} onRetry={() => void assembly.refetch()} />
      ) : null}
      {assembly.data ? (
        <>
          {assembly.isError ? (
            <ErrorState error={assembly.error} onRetry={() => void assembly.refetch()} />
          ) : null}
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>对象</TableHead>
                <TableHead>触发方式</TableHead>
                <TableHead className="text-right">大小</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assembly.data.blocks.map((block) => {
                const skipped = block.trigger === 'skipped';
                return (
                  <TableRow
                    key={`${block.kind}-${block.path}`}
                    className={skipped ? 'opacity-60 hover:bg-transparent' : 'hover:bg-transparent'}
                  >
                    <TableCell className="whitespace-normal">
                      <div className="break-all font-mono text-xs" title={block.path}>
                        {block.name}
                      </div>
                      {skipped && block.reason ? (
                        <div className="mt-0.5 break-words text-xs text-muted-foreground">
                          {block.reason}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {TRIGGER_LABEL[block.trigger]}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {/* 已跳过的块本次装配没有内容，不给大小，避免被读成已加载。 */}
                      {skipped ? (
                        <span aria-hidden="true">—</span>
                      ) : block.kind === 'personal' ? (
                        // 个人记忆按码点计数，其余文件是 UTF-8 字节数，单位不能混用。
                        `${block.chars} 字符`
                      ) : (
                        formatBytes(block.chars)
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {/* 四项口径各不相同：个人记忆按码点，其余按 UTF-8 字节，只换算字节项。 */}
          <p className="text-xs tabular-nums text-muted-foreground">
            {`个人 ${assembly.data.totals.personalChars} 字符 · 索引 ${formatBytes(assembly.data.totals.indexBytes)} · 规则 ${formatBytes(assembly.data.totals.rulesBytes)} · 主题 ${formatBytes(assembly.data.totals.topicBytes)}`}
          </p>
          {assembly.data.notes.length > 0 ? (
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {assembly.data.notes.map((note) => (
                <li key={note} className="break-words">
                  {note}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

type RecentChange = AgentMemoryOverview['recentChanges'][number];

function RecentChanges({
  changes,
  changesTotal,
  onOpenFiles,
}: {
  changes: RecentChange[];
  changesTotal: number;
  onOpenFiles?: (() => void) | undefined;
}) {
  // 只渲染前 3 条，真实总数由后端给出，避免把截断后的条数当总数。
  const visible = changes.slice(0, RECENT_CHANGE_LIMIT);
  const remaining = changesTotal - visible.length;
  return (
    <section aria-labelledby="memory-recent-title" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SectionHeading id="memory-recent-title">最近变更</SectionHeading>
        {changesTotal > 0 ? (
          <span className="text-xs tabular-nums text-muted-foreground">共 {changesTotal} 条</span>
        ) : null}
      </div>
      {changesTotal === 0 ? (
        <EmptyState title="尚无记忆变更" description="保存记忆或采纳记忆提案后会写入版本账本。" />
      ) : (
        <>
          <ul className="divide-y border-y">
            {visible.map((change) => (
              <li
                // 摘要没有独立 id，用文件与时间戳组合；同一条变更只出现一次。
                key={`${change.createdAt}-${change.name}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5"
              >
                <span className="min-w-0 truncate font-mono text-xs text-fg">{change.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatDateTime(change.createdAt)}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  title={change.summary}
                >
                  {change.summary}
                </span>
              </li>
            ))}
          </ul>
          {remaining > 0 && onOpenFiles ? (
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={onOpenFiles}>
                其余 {remaining} 条在文件视图查看
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** 专家记忆概览：统计、健康提示、运行期装配与最近账本；停用后统计仍保留。 */
export function MemoryOverview({
  agentId,
  onOpenFiles,
}: {
  agentId: string;
  /** 切到「文件」子视图；由父级把子视图写进路由 search。 */
  onOpenFiles?: (() => void) | undefined;
}) {
  const overview = useQuery(agentMemoryOverviewQuery(agentId));

  if (overview.isPending) return <LoadingState rows={4} />;
  if (overview.data === undefined) {
    return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />;
  }

  const data = overview.data;
  const indexShare = Math.round(
    Math.max(data.index.lines / data.index.maxLines, data.index.bytes / data.index.maxBytes) * 100,
  );

  return (
    <div className="flex flex-col gap-5">
      {overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <KpiCard
            label="主题文件数"
            value={`${data.topics.count} 个`}
            hint={`共 ${formatBytes(data.topics.bytes)}`}
            icon={FileText}
          />
          <KpiCard
            label="索引占用"
            value={`${data.index.lines} 行`}
            hint={`占上限 ${indexShare}% · 上限 ${data.index.maxLines} 行 / ${formatBytes(data.index.maxBytes)}`}
            icon={Gauge}
          />
          <KpiCard
            label="当前个人记忆"
            value={`${data.personal.chars} 字符`}
            hint={`上限 ${data.personal.maxChars} 字符`}
            icon={UserRound}
          />
        </div>
        {/* 停用只在 KPI 区用一句中性说明，状态细节留给健康检查。 */}
        {data.policy.enabled ? null : (
          <p className="text-xs text-muted-foreground">
            专家主会话记忆已停用，运行期不加载也不写入；子智能体记忆不受此开关影响
          </p>
        )}
      </div>
      <HealthSection items={data.health} onOpenFiles={onOpenFiles} />
      <AssemblySection agentId={agentId} />
      <RecentChanges
        changes={data.recentChanges}
        changesTotal={data.changesTotal}
        onOpenFiles={onOpenFiles}
      />
    </div>
  );
}
