import type { Agent, AgentSummary, MemoryHealth, PermissionId } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../../lib/api.js';
import type {
  AgentInstruction,
  AgentSection,
  AgentTab,
  MemoryView,
} from '../../lib/detail-tabs.js';
import { formatDateTime } from '../../lib/format.js';
import {
  agentMemoryOverviewQuery,
  agentOutputStylesQuery,
  agentRulesQuery,
  useKnowledgeBases,
  useRuns,
} from '../../lib/queries.js';
import { HEALTH_LABEL, HEALTH_TONE } from '../memory/health-status.js';
import { PageSection } from '../page.js';
import { RunStatusBadge } from '../run/run-status-badge.js';
import { LoadingState } from '../states.js';
import { StatusBadge } from '../status-badge.js';
import { Button, buttonVariants } from '../ui/button.js';
import { Skeleton } from '../ui/skeleton.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';

/** 概览只需要摘要的一部分；完整配置另行传入，没有配置读权时保持 null。 */
type OverviewSummary = Pick<AgentSummary, 'description' | 'enabled'> & {
  updatedAt?: string | undefined;
};

export type AgentOverviewTarget = {
  tab: AgentTab;
  instruction?: AgentInstruction | undefined;
  section?: AgentSection | undefined;
  view?: MemoryView | undefined;
};

const TRIGGER_LABEL: Record<string, string> = {
  chat: '对话',
  mcp: '连接器',
  schedule: '定时任务',
  event: '事件',
  review: '记忆提案',
  channel: '频道',
};

const RECENT_RUN_LIMIT = 5;

/** 概览只报最差一档，逐条细节留在专家记忆页。 */
function worstHealth(items: readonly MemoryHealth[]): MemoryHealth['level'] | null {
  if (items.some((item) => item.level === 'danger')) return 'danger';
  if (items.some((item) => item.level === 'warn')) return 'warn';
  return items.length > 0 ? 'ok' : null;
}

function PendingRow({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-3 px-2 py-2.5"
      role="status"
      aria-label={`${label}加载中`}
    >
      <span className="w-20 shrink-0 text-sm text-fg">{label}</span>
      <Skeleton className="h-4 w-40" />
    </div>
  );
}

function FailedRow({
  label,
  error,
  onRetry,
}: {
  label: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-2.5 text-sm">
      <CircleAlert className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
      <span className="text-danger">{label}没有加载出来</span>
      <span className="min-w-0 break-words text-muted-foreground">{errorMessage(error)}</span>
      <Button variant="link" size="xs" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

function LinkRow({
  label,
  detail,
  badge,
  onOpen,
}: {
  label: string;
  detail: string;
  badge?: ReactNode;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-item px-2 py-2.5 text-left transition-colors duration-150 ease-out-soft hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="w-20 shrink-0 text-sm text-fg">{label}</span>
      <span className="min-w-0 flex-1 break-words text-sm tabular-nums text-muted-foreground">
        {detail}
      </span>
      {badge}
      <ChevronRight className="size-4 shrink-0 text-subtle" aria-hidden="true" />
    </button>
  );
}

/**
 * 专家概览：用途、能力、知识状态与最近运行。
 * 所有区块只读已有查询结果，按权限逐项请求；没有数据的行整条省略，不补 0。
 */
export function AgentOverview({
  agentId,
  agent,
  config,
  permissions,
  canReadKnowledge = false,
  canViewRuns,
  onNavigate,
}: {
  agentId: string;
  agent: OverviewSummary;
  /** 完整配置；只有 `agents.config.read` 时才有。 */
  config: Agent | null;
  permissions: readonly PermissionId[];
  /** 知识库目录来自全局 `knowledge.read`，不在专家的权限求值结果里。 */
  canReadKnowledge?: boolean;
  canViewRuns: boolean;
  onNavigate: (next: AgentOverviewTarget) => void;
}) {
  const allow = (permission: PermissionId): boolean => permissions.includes(permission);
  const canReadConfig = allow('agents.config.read');
  const canReadMemory = allow('agents.memory.read');
  const canReadRules = allow('agents.rules.read');
  const canReadStyles = allow('agents.styles.read');
  // 没有任何读权时，「去配置」会是一个打不开的动作，说明改为一句权限边界。
  const hasReadGrant =
    canReadConfig || canReadMemory || canReadRules || canReadStyles || allow('agents.files.read');

  const knowledge = useKnowledgeBases(canReadConfig && canReadKnowledge);
  const memory = useQuery({ ...agentMemoryOverviewQuery(agentId), enabled: canReadMemory });
  const rules = useQuery({ ...agentRulesQuery(agentId), enabled: canReadRules });
  const styles = useQuery({ ...agentOutputStylesQuery(agentId), enabled: canReadStyles });
  const runs = useRuns({ agentId, limit: RECENT_RUN_LIMIT }, canViewRuns);

  // 概览只区分「连接器 / 知识库」，需要知识库目录才能把绑定拆开；
  // 读不到目录时「连接器」退回绑定总数，不猜测哪些 server 属于知识库。
  const knowledgeServerIds = new Set((knowledge.data ?? []).map((base) => base.serverId));
  const knowledgeBound = config
    ? config.serverIds.filter((id) => knowledgeServerIds.has(id)).length
    : 0;

  const capabilityRows: { label: string; value: string }[] = [];
  if (config) {
    if (config.model) capabilityRows.push({ label: '模型', value: config.model });
    capabilityRows.push({ label: '推理强度', value: config.effort ?? '默认' });
    const connectors = canReadKnowledge
      ? config.serverIds.length - knowledgeBound
      : config.serverIds.length;
    if (connectors > 0) capabilityRows.push({ label: '连接器', value: `${connectors} 个` });
    if (canReadKnowledge && knowledgeBound > 0) {
      capabilityRows.push({ label: '知识库', value: `${knowledgeBound} 个` });
    }
    if (config.skillIds.length > 0) {
      capabilityRows.push({ label: '技能', value: `${config.skillIds.length} 个` });
    }
    if (config.subAgentIds.length > 0) {
      capabilityRows.push({ label: '子智能体', value: `${config.subAgentIds.length} 个` });
    }
    if (config.pluginBindings.length > 0) {
      capabilityRows.push({ label: '插件', value: `${config.pluginBindings.length} 个` });
    }
  }

  const knowledgeRows: ReactNode[] = [];
  if (canReadMemory) {
    const level = memory.data ? worstHealth(memory.data.health) : null;
    knowledgeRows.push(
      <li key="memory">
        {memory.isPending ? (
          <PendingRow label="专家记忆" />
        ) : memory.data === undefined ? (
          <FailedRow label="专家记忆" error={memory.error} onRetry={() => void memory.refetch()} />
        ) : (
          <LinkRow
            label="专家记忆"
            detail={`${memory.data.topics.count} 个主题 · 索引 ${memory.data.index.lines} / ${memory.data.index.maxLines} 行`}
            badge={
              level ? (
                <StatusBadge tone={HEALTH_TONE[level]}>{HEALTH_LABEL[level]}</StatusBadge>
              ) : null
            }
            onOpen={() => onNavigate({ tab: 'memory', view: 'overview' })}
          />
        )}
      </li>,
    );
  }
  if (canReadRules) {
    knowledgeRows.push(
      <li key="rules">
        {rules.isPending ? (
          <PendingRow label="项目规则" />
        ) : rules.data === undefined ? (
          <FailedRow label="项目规则" error={rules.error} onRetry={() => void rules.refetch()} />
        ) : (
          <LinkRow
            label="项目规则"
            detail={`${rules.data.length} 条`}
            onOpen={() => onNavigate({ tab: 'instructions', instruction: 'rules' })}
          />
        )}
      </li>,
    );
  }
  if (canReadStyles) {
    const total = styles.data?.length ?? 0;
    const enabled = styles.data?.filter((style) => style.isSelected).length ?? 0;
    knowledgeRows.push(
      <li key="styles">
        {styles.isPending ? (
          <PendingRow label="输出风格" />
        ) : styles.data === undefined ? (
          <FailedRow label="输出风格" error={styles.error} onRetry={() => void styles.refetch()} />
        ) : (
          <LinkRow
            label="输出风格"
            detail={`${total} 个 · 已启用 ${enabled} 个`}
            onOpen={() => onNavigate({ tab: 'instructions', instruction: 'styles' })}
          />
        )}
      </li>,
    );
  }

  const recentRuns = runs.data?.items ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-5 cds-card-surface rounded-card bg-surface px-6 py-5">
      <PageSection
        divided={false}
        title="用途"
        // 身份与描述都归「配置 · 身份」，入口常驻，不依赖描述是否为空。
        actions={
          canReadConfig ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNavigate({ tab: 'config', section: 'identity' })}
            >
              编辑配置
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-3">
          {agent.description.trim() ? (
            <p className="max-w-[70ch] whitespace-pre-wrap break-words text-sm text-fg">
              {agent.description}
            </p>
          ) : (
            <span className="text-sm text-muted-foreground">尚未填写介绍</span>
          )}
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">状态</dt>
              <dd>
                <StatusBadge tone={agent.enabled ? 'success' : 'default'}>
                  {agent.enabled ? '已启用' : '已停用'}
                </StatusBadge>
              </dd>
            </div>
            {agent.updatedAt ? (
              <div className="flex items-center gap-1.5">
                <dt className="text-muted-foreground">更新于</dt>
                <dd className="text-fg">
                  <time dateTime={agent.updatedAt}>{formatDateTime(agent.updatedAt)}</time>
                </dd>
              </div>
            ) : null}
          </dl>
          {hasReadGrant ? null : (
            <p className="text-sm text-muted-foreground">
              当前账户只能使用这个专家，查看或修改配置需要对应的维护权限。
            </p>
          )}
        </div>
      </PageSection>

      {capabilityRows.length > 0 ? (
        <PageSection title="能力">
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-sm">
              {capabilityRows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="min-w-0 break-words font-mono text-xs tabular-nums text-fg [overflow-wrap:anywhere]">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onNavigate({ tab: 'config', section: 'capability' })}
              >
                管理能力
              </Button>
            </div>
          </div>
        </PageSection>
      ) : null}

      {knowledgeRows.length > 0 ? (
        <PageSection title="知识状态">
          <ul className="divide-y divide-line border-y">{knowledgeRows}</ul>
        </PageSection>
      ) : null}

      {canViewRuns ? (
        <PageSection title="最近运行">
          {runs.isPending ? <LoadingState rows={3} /> : null}
          {!runs.isPending && runs.data === undefined ? (
            <FailedRow label="最近运行" error={runs.error} onRetry={() => void runs.refetch()} />
          ) : null}
          {runs.data ? (
            recentRuns.length === 0 ? (
              <p className="text-sm text-muted-foreground">这个专家还没有运行记录。</p>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>时间</TableHead>
                      <TableHead>触发方式</TableHead>
                      <TableHead>状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentRuns.map((run) => (
                      <TableRow key={run.id} className="hover:bg-transparent">
                        <TableCell
                          className="text-muted-foreground"
                          title={run.startedAt ? formatDateTime(run.startedAt) : undefined}
                        >
                          {formatDateTime(run.startedAt)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {run.trigger ? (TRIGGER_LABEL[run.trigger] ?? run.trigger) : '—'}
                        </TableCell>
                        <TableCell>
                          <RunStatusBadge status={run.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="flex justify-end">
                  <Link
                    to="/runs"
                    search={{ agent: agentId }}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    查看全部运行
                  </Link>
                </div>
              </>
            )
          ) : null}
        </PageSection>
      ) : null}
    </div>
  );
}
