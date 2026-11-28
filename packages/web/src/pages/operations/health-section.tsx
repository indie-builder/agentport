import { useQuery } from '@tanstack/react-query';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  HeartPulse,
  ListChecks,
  LoaderCircle,
} from 'lucide-react';
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { InspectorSheet } from '../../components/inspector-sheet.js';
import { PageNote } from '../../components/page.js';
import { RecordRows } from '../../components/record-rows.js';
import { EmptyState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import { api, type HealthProbe, type HealthReady } from '../../lib/api.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { formatBytes, formatDuration, formatUptime } from '../../lib/format.js';
import { judgeQueue } from '../../lib/health.js';
import { healthLiveQuery, healthMetricsQuery, healthReadyQuery } from '../../lib/queries.js';

type CheckState = 'pending' | 'ok' | 'warn' | 'unknown' | 'error';

const stateLabel: Record<CheckState, string> = {
  pending: '检查中',
  ok: '正常',
  warn: '注意',
  unknown: '未知',
  error: '不可用',
};

const stateVariant = {
  pending: 'default',
  ok: 'success',
  warn: 'warn',
  unknown: 'danger',
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

function Reason({ tone = 'danger', children }: { tone?: 'warn' | 'danger'; children: ReactNode }) {
  const Icon = tone === 'warn' ? CircleAlert : CircleX;
  return (
    <div
      className={`flex items-start gap-1.5 text-sm ${
        tone === 'warn' ? 'text-warning' : 'text-danger'
      }`}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

function Unknown({ description }: { description?: string }) {
  return (
    <EmptyState
      variant="idle"
      scale="inline"
      icon={<CircleDashed className="size-4" aria-hidden="true" />}
      title="暂未采集到指标"
      description={description}
    />
  );
}

function readyPassed(probe: HealthProbe<HealthReady>): boolean {
  const body = probe.body;
  return (
    probe.reachable &&
    probe.httpStatus === 200 &&
    body !== null &&
    body.status === 'ok' &&
    body.db === 'ok' &&
    body.redis === 'ok'
  );
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
  if (readyPassed(probe)) return null;
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

function SmokeCheckSheet({
  open,
  onClosed,
  runTrigger,
  finalFocus,
}: {
  open: boolean;
  onClosed: () => void;
  runTrigger: number;
  finalFocus?: () => HTMLElement | null;
}) {
  const dialog = useDialogClose(onClosed, open);
  const [steps, setSteps] = useState<SmokeStep[]>([]);
  const [running, setRunning] = useState(false);
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);
  const lastTriggerRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runIdRef.current += 1;
    };
  }, []);

  const run = useCallback(async (): Promise<void> => {
    const runId = ++runIdRef.current;
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
      if (!mountedRef.current || runIdRef.current !== runId) return;
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
    if (!mountedRef.current || runIdRef.current !== runId) return;

    await record('GET /health/ready', async () => {
      const probe = await api.healthReady();
      if (!probe.reachable) return { ok: false, detail: probe.error ?? '请求失败' };
      const body = probe.body;
      return {
        ok: readyPassed(probe),
        detail: body
          ? `HTTP ${probe.httpStatus} · db=${body.db} · redis=${body.redis}`
          : `HTTP ${probe.httpStatus} · 响应体无法解析`,
      };
    });
    if (!mountedRef.current || runIdRef.current !== runId) return;

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
    if (!mountedRef.current || runIdRef.current !== runId) return;

    setRunning(false);
  }, []);

  useEffect(() => {
    if (runTrigger > 0 && runTrigger !== lastTriggerRef.current) {
      lastTriggerRef.current = runTrigger;
      void run();
    }
  }, [runTrigger, run]);

  return (
    <InspectorSheet
      size="sm"
      open={dialog.open}
      onOpenChange={(next) => {
        if (!next) dialog.close();
      }}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      title="冒烟检查"
      description="依次探测 live、ready 与 metrics 端点，不改动服务状态。"
      {...(finalFocus === undefined ? {} : { finalFocus })}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" disabled={running} onClick={() => void run()}>
            {running ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" aria-hidden="true" />
            ) : (
              <ListChecks data-icon="inline-start" aria-hidden="true" />
            )}
            重新运行
          </Button>
        </div>
      }
    >
      <div aria-live="polite" aria-relevant="additions text">
        {steps.length === 0 ? (
          running ? (
            <p className="text-sm text-muted-foreground">正在依次检查…</p>
          ) : (
            <EmptyState
              variant="idle"
              scale="inline"
              icon={<HeartPulse className="size-4" aria-hidden="true" />}
              title="就绪检查尚未运行"
              description="将在浏览器内依次探测 live、ready 与 metrics 端点，不改动服务状态。"
            />
          )
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
                <div className="flex min-w-0 flex-1 flex-col gap-1">
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
    </InspectorSheet>
  );
}

export interface HealthSectionProps {
  smokeOpen?: boolean | undefined;
  onSmokeOpenChange?: ((open: boolean) => void) | undefined;
  smokeRunTrigger?: number | undefined;
  smokeButtonRef?: RefObject<HTMLButtonElement | null> | undefined;
}

export function HealthSection({
  smokeOpen: controlledSmokeOpen,
  onSmokeOpenChange,
  smokeRunTrigger = 0,
  smokeButtonRef,
}: HealthSectionProps = {}) {
  const [internalSmokeOpen, setInternalSmokeOpen] = useState(false);
  const smokeOpen = controlledSmokeOpen ?? internalSmokeOpen;
  const setSmokeOpen = onSmokeOpenChange ?? setInternalSmokeOpen;

  const live = useQuery(healthLiveQuery);
  const ready = useQuery(healthReadyQuery);
  const metrics = useQuery({
    ...healthMetricsQuery,
    refetchInterval: 10_000,
  });

  const data = metrics.data ?? null;
  const queue = data?.queue ?? null;
  const queueHealth = judgeQueue(queue);
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
      ? 'unknown'
      : metrics.isError
        ? 'warn'
        : 'ok';
  const queueState: CheckState = metrics.isPending
    ? 'pending'
    : !data
      ? 'unknown'
      : queueHealth.condition === 'unavailable'
        ? 'error'
        : queueHealth.condition === 'ok' && !metrics.isError
          ? 'ok'
          : 'warn';
  const dbState: CheckState = metrics.isPending
    ? 'pending'
    : !data
      ? 'unknown'
      : !db?.connected
        ? 'error'
        : metrics.isError
          ? 'warn'
          : 'ok';
  const redisState: CheckState = metrics.isPending
    ? 'pending'
    : !data
      ? 'unknown'
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

  return (
    <>
      <Card size="sm" hover="static" className="min-w-0">
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-0 sm:divide-x sm:divide-line">
            <div className="flex min-w-0 items-start justify-between gap-3 sm:pr-5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium text-fg">存活检查</span>
                  <code className="break-all font-mono text-xs text-muted-foreground">
                    /health/live
                  </code>
                </div>
                {liveState === 'error' ? (
                  <p className="break-words text-xs text-danger [overflow-wrap:anywhere]">
                    {live.isError
                      ? '存活检查请求失败。'
                      : (live.data?.error ??
                        `HTTP ${live.data?.httpStatus ?? '未知'}，进程未返回 200。`)}
                  </p>
                ) : null}
              </div>
              <StatusPill state={liveState} />
            </div>

            <div className="flex min-w-0 items-start justify-between gap-3 sm:pl-5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium text-fg">就绪检查</span>
                  <code className="break-all font-mono text-xs text-muted-foreground">
                    /health/ready
                  </code>
                </div>
                {readyProblem ? (
                  <p className="break-words text-xs text-danger [overflow-wrap:anywhere]">
                    {readyProblem}
                  </p>
                ) : null}
              </div>
              <StatusPill state={readyState} />
            </div>
          </div>
        </CardContent>
      </Card>

      {metrics.isError ? (
        <PageNote
          tone="danger"
          title={data ? '指标刷新失败' : '指标读取失败'}
          description={
            data ? '以下保留上次成功读取的指标。' : '指标端点不可达或返回非 200，各区块显示为未知。'
          }
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

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Card size="sm" hover="static" className="min-w-0">
          <CardHeader>
            <CardTitle>
              <h2 className="text-sm font-medium text-fg">进程</h2>
            </CardTitle>
            <CardAction>
              <StatusPill state={processState} />
            </CardAction>
          </CardHeader>
          <CardContent>
            {data ? (
              <RecordRows
                rows={[
                  {
                    label: '运行时长',
                    value: formatUptime(data.process.uptimeSeconds),
                    mono: true,
                  },
                  {
                    label: '内存 RSS',
                    value: formatBytes(data.process.memoryRssBytes),
                    mono: true,
                  },
                  { label: 'Bun', value: data.process.bunVersion, mono: true },
                ]}
              />
            ) : metrics.isPending ? (
              <LoadingState rows={2} />
            ) : (
              <Unknown />
            )}
          </CardContent>
        </Card>

        <Card size="sm" hover="static" className="min-w-0">
          <CardHeader>
            <CardTitle>
              <h2 className="text-sm font-medium text-fg">队列 agent-runs</h2>
            </CardTitle>
            <CardAction>
              <StatusPill state={queueState} />
            </CardAction>
          </CardHeader>
          <CardContent>
            {queue ? (
              <RecordRows
                rows={[
                  { label: '等待', value: String(queue.waiting), mono: true },
                  { label: '运行中', value: String(queue.active), mono: true },
                  { label: '失败', value: String(queue.failed), mono: true },
                  { label: '延迟', value: String(queue.delayed), mono: true },
                ]}
              />
            ) : metrics.isPending ? (
              <LoadingState rows={2} />
            ) : data ? (
              <Reason>
                {queueHealth.message}
                {queueHealth.hint ? ` ${queueHealth.hint}` : ''}
              </Reason>
            ) : (
              <Unknown />
            )}
          </CardContent>
          {queue && queueHealth.condition !== 'ok' ? (
            <CardFooter>
              <Reason tone="warn">
                {queueHealth.message}
                {queueHealth.hint ? ` ${queueHealth.hint}` : ''}
              </Reason>
            </CardFooter>
          ) : null}
        </Card>

        <Card size="sm" hover="static" className="min-w-0">
          <CardHeader>
            <CardTitle>
              <h2 className="text-sm font-medium text-fg">数据库</h2>
            </CardTitle>
            <CardAction>
              <StatusPill state={dbState} />
            </CardAction>
          </CardHeader>
          <CardContent>
            {db ? (
              <RecordRows
                rows={[
                  { label: '连接', value: db.connected ? '正常' : '失败' },
                  {
                    label: 'Ping',
                    value: db.pingMs === null ? '未测得' : `${db.pingMs} ms`,
                    mono: true,
                  },
                  {
                    label: '连接上限',
                    value: db.maxConnections === null ? '未提供' : String(db.maxConnections),
                    mono: true,
                  },
                ]}
              />
            ) : metrics.isPending ? (
              <LoadingState rows={2} />
            ) : data ? (
              <Unknown description="指标端点未返回数据库数据。" />
            ) : (
              <Unknown />
            )}
          </CardContent>
          {db && !db.connected ? (
            <CardFooter>
              <Reason>数据库探测失败：检查 DATABASE_URL 与 PostgreSQL 服务。</Reason>
            </CardFooter>
          ) : null}
        </Card>

        <Card size="sm" hover="static" className="min-w-0">
          <CardHeader>
            <CardTitle>
              <h2 className="text-sm font-medium text-fg">Redis</h2>
            </CardTitle>
            <CardAction>
              <StatusPill state={redisState} />
            </CardAction>
          </CardHeader>
          <CardContent>
            {redis ? (
              <RecordRows
                rows={[
                  { label: 'Ping', value: `${redis.pingMs} ms`, mono: true },
                  { label: '状态', value: 'PONG', mono: true },
                ]}
              />
            ) : metrics.isPending ? (
              <LoadingState rows={2} />
            ) : data ? (
              <Reason>
                Ping 失败：检查 REDIS_URL 与 redis 容器；队列、会话和限流都会同时受影响。
              </Reason>
            ) : (
              <Unknown />
            )}
          </CardContent>
        </Card>
      </div>

      {smokeOpen ? (
        <SmokeCheckSheet
          open={smokeOpen}
          onClosed={() => setSmokeOpen(false)}
          runTrigger={smokeRunTrigger}
          {...(smokeButtonRef
            ? {
                finalFocus: () =>
                  smokeButtonRef.current?.isConnected ? smokeButtonRef.current : null,
              }
            : {})}
        />
      ) : null}
    </>
  );
}
