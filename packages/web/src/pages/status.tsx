import { useQuery } from '@tanstack/react-query';
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  ListChecks,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Page, PageHeader, PageNote, PageSection } from '../components/page.js';
import { StatusBadge } from '../components/status-badge.js';
import { Button } from '../components/ui/button.js';
import { api, type HealthProbe, type HealthReady } from '../lib/api.js';
import { formatBytes, formatDuration } from '../lib/format.js';
import { healthLiveQuery, healthMetricsQuery, healthReadyQuery } from '../lib/queries.js';

type CheckState = 'pending' | 'ok' | 'warn' | 'error';

const stateLabel: Record<CheckState, string> = {
  pending: '检查中',
  ok: '正常',
  warn: '注意',
  error: '不可用',
};

const stateVariant = {
  pending: 'default',
  ok: 'success',
  warn: 'warn',
  error: 'danger',
} as const satisfies Record<CheckState, 'default' | 'success' | 'warn' | 'danger'>;

function StatusPill({ state }: { state: CheckState }) {
  const Icon =
    state === 'pending'
      ? LoaderCircle
      : state === 'ok'
        ? CircleCheck
        : state === 'warn'
          ? CircleAlert
          : CircleX;
  return (
    <StatusBadge tone={stateVariant[state]}>
      <Icon className={state === 'pending' ? 'size-3 animate-spin' : 'size-3'} aria-hidden="true" />
      {stateLabel[state]}
    </StatusBadge>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="break-words font-mono text-md tabular-nums text-fg">{value}</div>
    </div>
  );
}

function Reason({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 border-t pt-2 text-sm leading-relaxed text-danger">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function readyReason(ready: {
  isPending: boolean;
  isError: boolean;
  data: HealthProbe<HealthReady> | undefined;
}): string | null {
  if (ready.isPending) return null;
  if (ready.isError || !ready.data) return '就绪检查请求失败。';
  const probe = ready.data;
  if (!probe.reachable) return probe.error ?? '就绪检查端点不可达。';
  const body = probe.body;
  if (probe.httpStatus === 200 && body?.status === 'ok' && body.db === 'ok' && body.redis === 'ok')
    return null;
  if (body && (body.db === 'error' || body.redis === 'error')) {
    const failed = [body.db === 'error' ? '数据库' : null, body.redis === 'error' ? 'Redis' : null]
      .filter(Boolean)
      .join('、');
    return `就绪检查返回 HTTP ${probe.httpStatus ?? '未知'}：${failed} 不可用。`;
  }
  return `就绪检查返回 HTTP ${probe.httpStatus ?? '未知'}，响应体无法解析。`;
}

interface SmokeStep {
  label: string;
  state: 'ok' | 'error';
  detail: string;
  ms: number;
}

function SmokeChecklist() {
  const [steps, setSteps] = useState<SmokeStep[]>([]);
  const [running, setRunning] = useState(false);

  const run = async (): Promise<void> => {
    setRunning(true);
    setSteps([]);
    const results: SmokeStep[] = [];
    const record = async (
      label: string,
      check: () => Promise<{ ok: boolean; detail: string }>,
    ): Promise<void> => {
      const started = performance.now();
      let outcome: { ok: boolean; detail: string };
      try {
        outcome = await check();
      } catch (err) {
        outcome = { ok: false, detail: err instanceof Error ? err.message : '未知错误' };
      }
      results.push({
        label,
        state: outcome.ok ? 'ok' : 'error',
        detail: outcome.detail,
        ms: Math.round(performance.now() - started),
      });
      setSteps([...results]);
    };

    await record('GET /health/live', async () => {
      const probe = await api.healthLive();
      if (!probe.reachable) return { ok: false, detail: probe.error ?? '请求失败' };
      return {
        ok: probe.httpStatus === 200,
        detail: `HTTP ${probe.httpStatus} · ${probe.body?.status ?? '无响应体'}`,
      };
    });

    await record('GET /health/ready', async () => {
      const probe = await api.healthReady();
      if (!probe.reachable) return { ok: false, detail: probe.error ?? '请求失败' };
      const body = probe.body;
      return {
        ok:
          probe.httpStatus === 200 &&
          body?.status === 'ok' &&
          body.db === 'ok' &&
          body.redis === 'ok',
        detail: body
          ? `HTTP ${probe.httpStatus} · db=${body.db} · redis=${body.redis}`
          : `HTTP ${probe.httpStatus} · 响应体无法解析`,
      };
    });

    await record('GET /health/metrics', async () => {
      const metrics = await api.healthMetrics();
      if (!metrics) return { ok: false, detail: '指标端点不可达或返回非 200' };
      const missing = [
        metrics.db ? null : '数据库',
        metrics.queue ? null : '队列',
        metrics.redis ? null : 'Redis',
      ].filter(Boolean);
      return {
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? `队列 waiting=${metrics.queue?.waiting ?? 0} · Redis ${metrics.redis?.pingMs ?? 0} ms`
            : `部分指标缺失：${missing.join('、')}`,
      };
    });

    setRunning(false);
  };

  return (
    <PageSection
      title="冒烟检查"
      actions={
        <Button variant="outline" size="sm" disabled={running} onClick={() => void run()}>
          {running ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" aria-hidden="true" />
          ) : (
            <ListChecks data-icon="inline-start" aria-hidden="true" />
          )}
          运行冒烟检查
        </Button>
      }
    >
      <div aria-live="polite" aria-relevant="additions text">
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {running
              ? '正在依次检查…'
              : '依次请求 live、ready、metrics 三个端点，只在这个浏览器里执行，不会改动服务。'}
          </p>
        ) : (
          <ul>
            {steps.map((step) => (
              <li
                key={step.label}
                className="flex flex-wrap items-start gap-3 border-b py-3 text-sm last:border-b-0"
              >
                <StatusBadge tone={step.state === 'ok' ? 'success' : 'danger'}>
                  {step.state === 'ok' ? '通过' : '失败'}
                </StatusBadge>
                <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-3">
                  <span className="min-w-0 break-all font-mono text-xs text-fg">{step.label}</span>
                  <span
                    className={
                      step.state === 'ok'
                        ? 'min-w-0 break-words text-muted-foreground [overflow-wrap:anywhere]'
                        : 'min-w-0 break-words text-danger [overflow-wrap:anywhere]'
                    }
                  >
                    {step.detail}
                  </span>
                </div>
                <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {formatDuration(step.ms)}
                </span>
              </li>
            ))}
            {running ? (
              <li className="flex items-center gap-2 border-b py-3 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                下一项检查中…
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </PageSection>
  );
}

export function StatusPage() {
  const live = useQuery(healthLiveQuery);
  const ready = useQuery(healthReadyQuery);
  // 与概览页共用缓存键，但状态页需要 10 秒粒度。
  const metrics = useQuery({ ...healthMetricsQuery, refetchInterval: 10_000 });

  const data = metrics.data ?? null;
  const queue = data?.queue ?? null;
  const redis = data?.redis ?? null;
  const db = data?.db ?? null;

  const liveState: CheckState = live.isPending
    ? 'pending'
    : live.isError || !live.data.reachable || live.data.httpStatus !== 200
      ? 'error'
      : 'ok';
  const processState: CheckState = metrics.isPending
    ? 'pending'
    : !data
      ? 'error'
      : metrics.isError
        ? 'warn'
        : 'ok';
  const queueState: CheckState = metrics.isPending
    ? 'pending'
    : !queue
      ? 'error'
      : metrics.isError || queue.waiting > 10 || (queue.waiting > 0 && queue.active === 0)
        ? 'warn'
        : 'ok';
  const dbState: CheckState = metrics.isPending
    ? 'pending'
    : !db
      ? 'error'
      : metrics.isError || db.waiting > 5
        ? 'warn'
        : 'ok';
  const redisState: CheckState = metrics.isPending
    ? 'pending'
    : !redis
      ? 'error'
      : metrics.isError
        ? 'warn'
        : 'ok';

  const readyProblem = readyReason(ready);
  const readyState: CheckState = ready.isPending
    ? 'pending'
    : readyProblem === null
      ? 'ok'
      : 'error';

  const isFetching = live.isFetching || ready.isFetching || metrics.isFetching;

  const refresh = (): void => {
    void live.refetch();
    void ready.refetch();
    void metrics.refetch();
  };

  return (
    <Page>
      <PageHeader
        title="健康"
        actions={
          <Button variant="outline" onClick={refresh} disabled={isFetching}>
            <RefreshCw
              data-icon="inline-start"
              className={isFetching ? 'animate-spin' : undefined}
              aria-hidden="true"
            />
            {isFetching ? '刷新中…' : '刷新'}
          </Button>
        }
      />
      <p className="text-xs text-muted-foreground">运行指标每 10 秒自动刷新。</p>

      <PageSection title="端点诊断">
        <div className="flex flex-wrap items-start gap-3 border-b pb-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 className="text-sm text-fg">
              存活检查{' '}
              <code className="break-all font-mono text-xs text-muted-foreground">
                /health/live
              </code>
            </h3>
            {liveState === 'error' ? (
              <p className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {live.isError
                  ? '存活检查请求失败。'
                  : (live.data?.error ??
                    `HTTP ${live.data?.httpStatus ?? '未知'}，进程未返回 200。`)}
              </p>
            ) : null}
          </div>
          <StatusPill state={liveState} />
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 className="text-sm text-fg">
              就绪检查{' '}
              <code className="break-all font-mono text-xs text-muted-foreground">
                /health/ready
              </code>
            </h3>
            {readyProblem ? (
              <p className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {readyProblem}
              </p>
            ) : null}
            {!ready.isPending && !ready.isError && ready.data?.body ? (
              <div className="flex flex-wrap gap-2">
                <StatusBadge tone={ready.data.body.db === 'ok' ? 'success' : 'danger'}>
                  数据库 {ready.data.body.db === 'ok' ? '正常' : '不可用'}
                </StatusBadge>
                <StatusBadge tone={ready.data.body.redis === 'ok' ? 'success' : 'danger'}>
                  Redis {ready.data.body.redis === 'ok' ? '正常' : '不可用'}
                </StatusBadge>
              </div>
            ) : null}
          </div>
          <StatusPill state={readyState} />
        </div>
      </PageSection>

      {metrics.isError ? (
        <PageNote
          tone="danger"
          title="指标刷新失败"
          description={data ? '以下保留上次成功读取的指标。' : '暂时无法读取运行指标。'}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={metrics.isFetching}
              onClick={() => void metrics.refetch()}
            >
              重试
            </Button>
          }
        />
      ) : null}

      <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2">
        <PageSection title="进程" actions={<StatusPill state={processState} />}>
          {data ? (
            <div className="grid grid-cols-3 gap-4">
              <Metric label="运行时长" value={formatUptime(data.process.uptimeSeconds)} />
              <Metric label="内存 RSS" value={formatBytes(data.process.memoryRssBytes)} />
              <Metric label="Node" value={data.process.nodeVersion} />
            </div>
          ) : (
            <>
              <div className="text-sm text-muted-foreground">
                {metrics.isPending ? '正在请求 /health/metrics…' : '读不到进程指标。'}
              </div>
              {!metrics.isPending ? (
                <Reason>
                  指标端点不可达或返回非 200；先确认 API 进程与反向代理，再看{' '}
                  <code className="font-mono">docker compose logs api</code>。
                </Reason>
              ) : null}
            </>
          )}
        </PageSection>

        <PageSection title="队列 agent-runs" actions={<StatusPill state={queueState} />}>
          {queue ? (
            <>
              <div className="grid grid-cols-4 gap-4">
                <Metric label="等待" value={String(queue.waiting)} />
                <Metric label="运行中" value={String(queue.active)} />
                <Metric label="失败" value={String(queue.failed)} />
                <Metric label="延迟" value={String(queue.delayed)} />
              </div>
              {queue.waiting > 10 ? (
                <Reason>
                  队列等待超过 10：worker 可能未运行、并发（AGENT_MAX_CONCURRENT）太低，或单个 run
                  卡住。
                </Reason>
              ) : null}
              {queue.waiting > 0 && queue.active === 0 ? (
                <Reason>有排队任务但没有运行中的任务：检查 worker 容器是否存活。</Reason>
              ) : null}
            </>
          ) : (
            <>
              <div className="text-sm text-muted-foreground">
                {metrics.isPending ? '正在请求…' : '队列计数不可用。'}
              </div>
              {!metrics.isPending ? (
                <Reason>BullMQ 查询失败或超过 1.5 秒：Redis 不可用，或队列键被阻塞。</Reason>
              ) : null}
            </>
          )}
        </PageSection>

        <PageSection title="数据库连接池" actions={<StatusPill state={dbState} />}>
          {db ? (
            <>
              <div className="grid grid-cols-3 gap-4">
                <Metric label="总数" value={String(db.total)} />
                <Metric label="空闲" value={String(db.idle)} />
                <Metric label="等待" value={String(db.waiting)} />
              </div>
              {db.waiting > 5 ? (
                <Reason>
                  连接池在排队（waiting &gt; 5）：调大 DB_POOL_MAX，或先减少单请求的 SQL 条数。
                </Reason>
              ) : null}
            </>
          ) : (
            <div className="text-sm text-muted-foreground">
              {metrics.isPending ? '正在请求…' : '读不到连接池指标。'}
            </div>
          )}
        </PageSection>

        <PageSection title="Redis" actions={<StatusPill state={redisState} />}>
          {redis ? (
            <div className="grid grid-cols-2 gap-4">
              <Metric label="Ping" value={`${redis.pingMs} ms`} />
              <Metric label="状态" value="PONG" />
            </div>
          ) : (
            <>
              <div className="text-sm text-muted-foreground">
                {metrics.isPending ? '正在请求…' : 'Redis 不可用。'}
              </div>
              {!metrics.isPending ? (
                <Reason>
                  Ping 失败：检查 REDIS_URL 与 redis 容器；队列、会话和限流都会同时受影响。
                </Reason>
              ) : null}
            </>
          )}
        </PageSection>
      </div>

      <PageNote
        title="处置步骤"
        description={
          <>
            见 <code className="font-mono text-muted-foreground">docs/RUNBOOK.md</code>
            ；指标字段与观测入口见{' '}
            <code className="font-mono text-muted-foreground">docs/OPERATIONS.md</code>。
          </>
        }
      />
      <SmokeChecklist />
    </Page>
  );
}
