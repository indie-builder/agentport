import type { SSEStreamingApi } from 'hono/streaming';
import type { Logger } from 'pino';
import { subscribeRun } from '../../queue/producer.js';
import { terminalRunEvent, writeChatEvent } from './events.js';

const TERMINAL_RECHECK_MS = 2000;
const STREAM_INTERRUPTED = '事件流中断，请刷新页面或重试';

type TerminalRun = Parameters<typeof terminalRunEvent>[0];

export type RelayLoadResult<TRun extends TerminalRun> =
  | { kind: 'run'; run: TRun }
  | { kind: 'unavailable'; reason: 'missing' | 'forbidden' };

export interface RunStreamDomain<TRun extends TerminalRun> {
  load: () => Promise<RelayLoadResult<TRun>>;
  writeUnavailable: (reason: 'missing' | 'forbidden') => Promise<void>;
  guard?: () => Promise<'ok' | 'forbidden' | 'error'>;
  labels: {
    recheckFailed: string;
    writeFailed: string;
    subscribeFailed: string;
    guardFailed?: string;
  };
}

export interface RelayRunEventsOptions<TRun extends TerminalRun> {
  stream: SSEStreamingApi;
  signal: AbortSignal;
  runId: string;
  initialRun: TRun;
  domain: RunStreamDomain<TRun>;
  log: Logger;
}

export async function relayRunEvents<TRun extends TerminalRun>(
  opts: RelayRunEventsOptions<TRun>,
): Promise<void> {
  const { stream, signal, runId, initialRun, domain, log } = opts;
  await stream.write('retry: 3000\n\n');
  let resolveClosed!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closed = false;
  let finishing = false;
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  const subscriptionAbort = new AbortController();
  let subscription:
    | {
        close: () => void;
      }
    | undefined;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    resolveClosed();
    signal.removeEventListener('abort', cleanup);
    if (recheckTimer !== undefined) clearTimeout(recheckTimer);
    subscriptionAbort.abort();
    subscription?.close();
  };
  const finish = (): void => {
    cleanup();
    void stream.close();
  };
  const scheduleRecheck = (): void => {
    if (closed || finishing) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = undefined;
      void recheck();
    }, TERMINAL_RECHECK_MS);
  };
  const recheck = async (): Promise<void> => {
    let current: RelayLoadResult<TRun>;
    try {
      current = await domain.load();
    } catch {
      log.warn({ runId }, domain.labels.recheckFailed);
      scheduleRecheck();
      return;
    }
    if (closed || finishing) return;
    if (current.kind === 'unavailable') {
      finishing = true;
      await domain.writeUnavailable(current.reason);
      finish();
      return;
    }
    const missed = terminalRunEvent(current.run);
    if (!missed) {
      scheduleRecheck();
      return;
    }
    finishing = true;
    try {
      await writeChatEvent(stream, { type: 'replay_truncated', reason: 'terminal_missing' });
      await writeChatEvent(stream, missed);
    } catch (err) {
      log.error({ err, runId }, domain.labels.writeFailed);
    }
    finish();
  };
  stream.onAbort(cleanup);
  if (signal.aborted) cleanup();
  else signal.addEventListener('abort', cleanup, { once: true });
  try {
    subscription = await subscribeRun(
      runId,
      async (event) => {
        if (closed || finishing) return;
        if (domain.guard) {
          let verdict: 'ok' | 'forbidden' | 'error';
          try {
            verdict = await domain.guard();
          } catch {
            verdict = 'error';
          }
          if (verdict === 'error') {
            finishing = true;
            log.error({ runId }, domain.labels.guardFailed ?? domain.labels.subscribeFailed);
            try {
              await writeChatEvent(stream, { type: 'error', message: STREAM_INTERRUPTED });
            } catch (writeErr) {
              log.error({ err: writeErr, runId }, domain.labels.writeFailed);
            }
            finish();
            return;
          }
          if (closed || finishing) return;
          if (verdict === 'forbidden') {
            finishing = true;
            await domain.writeUnavailable('forbidden');
            finish();
            return;
          }
        }
        const terminal =
          event.type === 'run_finished' ||
          event.type === 'error' ||
          event.type === 'run_unavailable';
        if (terminal) finishing = true;
        try {
          await writeChatEvent(stream, event);
        } catch (err) {
          log.error({ err, runId }, domain.labels.writeFailed);
          finish();
          return;
        }
        if (terminal) finish();
      },
      subscriptionAbort.signal,
    );
  } catch (err) {
    log.error({ err, runId }, domain.labels.subscribeFailed);
    try {
      await writeChatEvent(stream, { type: 'error', message: STREAM_INTERRUPTED });
    } catch {}
    finish();
    return;
  }
  if (closed) {
    subscription.close();
    return;
  }
  const finished = terminalRunEvent(initialRun);
  if (finished) {
    finishing = true;
    try {
      await writeChatEvent(stream, { type: 'replay_truncated', reason: 'terminal_missing' });
      await writeChatEvent(stream, finished);
    } catch (err) {
      log.error({ err, runId }, domain.labels.writeFailed);
    }
    finish();
    return;
  }
  scheduleRecheck();
  await ended;
}
