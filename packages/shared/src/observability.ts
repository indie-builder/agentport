import { z } from 'zod';

export const sloSettingsSchema = z.object({
  enabled: z.boolean(),
  windowMinutes: z.number().int().min(5).max(1440),
  runSuccessTarget: z.number().min(0).max(1),
  runP95LatencyMs: z.number().int().min(1),
  queueOldestWaitMs: z.number().int().min(1),
  providerErrorRateTarget: z.number().min(0).max(1),
});
export type SloSettings = z.infer<typeof sloSettingsSchema>;

export const SLO_DEFAULTS = {
  enabled: true,
  windowMinutes: 60,
  runSuccessTarget: 0.95,
  runP95LatencyMs: 120_000,
  queueOldestWaitMs: 60_000,
  providerErrorRateTarget: 0.05,
} as const satisfies SloSettings;

export const queueSnapshotSchema = z.object({
  name: z.string(),
  waiting: z.number().int(),
  active: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
  delayed: z.number().int(),
  oldestWaitingMs: z.number().int().nullable(),
});
export type QueueSnapshot = z.infer<typeof queueSnapshotSchema>;

export const providerMetricSchema = z.object({
  providerId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  priority: z.number().int(),
  requests: z.number().int(),
  errors: z.number().int(),
  errorRate: z.number(),
  costUsd: z.number(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
});
export type ProviderMetric = z.infer<typeof providerMetricSchema>;

export const sloStatusSchema = z.object({
  key: z.enum(['run_success', 'run_p95_latency', 'queue_oldest_wait', 'provider_error_rate']),
  label: z.string(),
  target: z.number(),
  actual: z.number().nullable(),
  ok: z.boolean().nullable(),
  sampleSize: z.number().int(),
});
export type SloStatus = z.infer<typeof sloStatusSchema>;

export function evaluateSloStatuses(input: {
  settings: SloSettings;
  finishedRuns: number;
  successRate: number;
  p95LatencyMs: number | null;
  latencySamples: number;
  queueOldestWaitMs: number | null;
  queueSamples: number;
  providerRequests: number;
  providerErrors: number;
}): SloStatus[] {
  const { settings } = input;
  const providerActual =
    input.providerRequests > 0 ? input.providerErrors / input.providerRequests : null;
  return [
    {
      key: 'run_success',
      label: '运行成功率',
      target: settings.runSuccessTarget,
      actual: input.finishedRuns > 0 ? input.successRate : null,
      ok: input.finishedRuns > 0 ? input.successRate >= settings.runSuccessTarget : null,
      sampleSize: input.finishedRuns,
    },
    {
      key: 'run_p95_latency',
      label: '运行 P95 延迟',
      target: settings.runP95LatencyMs,
      actual: input.p95LatencyMs,
      ok: input.p95LatencyMs === null ? null : input.p95LatencyMs <= settings.runP95LatencyMs,
      sampleSize: input.latencySamples,
    },
    {
      key: 'queue_oldest_wait',
      label: '队列最长等待',
      target: settings.queueOldestWaitMs,
      actual: input.queueOldestWaitMs,
      ok:
        input.queueOldestWaitMs === null
          ? null
          : input.queueOldestWaitMs <= settings.queueOldestWaitMs,
      sampleSize: input.queueSamples,
    },
    {
      key: 'provider_error_rate',
      label: '模型供应商错误率',
      target: settings.providerErrorRateTarget,
      actual: providerActual,
      ok: providerActual === null ? null : providerActual <= settings.providerErrorRateTarget,
      sampleSize: input.providerRequests,
    },
  ];
}

export const observabilitySnapshotSchema = z.object({
  window: z.object({ minutes: z.number().int(), since: z.string() }),
  sloWindowMinutes: z.number().int(),
  sloEnabled: z.boolean(),
  generatedAt: z.string(),
  runs: z.object({
    total: z.number().int(),
    finished: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    timeout: z.number().int(),
    cancelled: z.number().int(),
    running: z.number().int(),
    successRate: z.number(),
    errorRate: z.number(),
    p50LatencyMs: z.number().nullable(),
    p95LatencyMs: z.number().nullable(),
    p99LatencyMs: z.number().nullable(),
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
  queues: z.array(queueSnapshotSchema),
  providers: z.array(providerMetricSchema),
  slo: z.array(sloStatusSchema),
  alerts: z.object({
    openViolations: z.number().int(),
    pendingApprovals: z.number().int(),
    recentOpsAlerts: z.number().int(),
  }),
});
export type ObservabilitySnapshot = z.infer<typeof observabilitySnapshotSchema>;
