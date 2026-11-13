export interface HealthMetrics {
  process: { uptimeSeconds: number; memoryRssBytes: number; bunVersion: string };
  queue: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  } | null;
  db: { connected: boolean; pingMs: number | null; maxConnections: number | null };
  redis: { pingMs: number } | null;
}

export interface HealthLive {
  status: string;
}

export interface HealthReady {
  status: 'ok' | 'degraded';
  db: 'ok' | 'error';
  redis: 'ok' | 'error';
}

/** 健康端点在 /api 之外，且 503 也是有效结果；reachable 表示拿到了可解析的响应。 */
export interface HealthProbe<T> {
  reachable: boolean;
  httpStatus: number | null;
  body: T | null;
  error: string | null;
}

export async function probeHealth<T>(path: string): Promise<HealthProbe<T>> {
  try {
    const res = await fetch(path, { credentials: 'include' });
    const body = (await res.json().catch(() => null)) as T | null;
    return { reachable: true, httpStatus: res.status, body, error: null };
  } catch {
    return {
      reachable: false,
      httpStatus: null,
      body: null,
      error: '连不上 API 服务：进程未启动、端口未发布，或被反向代理拦截。',
    };
  }
}

export default {
  /** 指标端点不在 /api 下；不可用时返回 null，页面显示「不可用」。 */
  healthMetrics: async (): Promise<HealthMetrics | null> => {
    const probe = await probeHealth<HealthMetrics>('/health/metrics');
    return probe.reachable && probe.httpStatus === 200 ? probe.body : null;
  },
  healthLive: (): Promise<HealthProbe<HealthLive>> => probeHealth('/health/live'),
  healthReady: (): Promise<HealthProbe<HealthReady>> => probeHealth('/health/ready'),
};
