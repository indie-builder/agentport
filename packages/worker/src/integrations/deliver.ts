import { decryptSecrets, isAppError } from '@agentport/core';
import { assertServerEndpoint } from '@agentport/core/net-guard';
import { type Database, repo } from '@agentport/db';
import type { Logger } from 'pino';
import { startIntervalTicker } from '../interval-ticker.js';

const TICK_MS = 1_000;
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 300_000;

type DeliveryClaim = Awaited<ReturnType<typeof repo.integrations.claimWebhookDeliveries>>[number];

interface DeliveryDeps {
  db: Database;
  logger: Logger;
  secretKey: string;
  nodeEnv: string | undefined;
  allowlist: string;
}

function sign(secret: string, timestamp: number, payload: string): string {
  return `sha256=${new Bun.CryptoHasher('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`;
}

function retryDelayMs(attempts: number): number {
  return Math.min(2 ** attempts * 1_000, MAX_BACKOFF_MS);
}

async function deliverOne(deps: DeliveryDeps, row: DeliveryClaim): Promise<void> {
  if (!row.enabled) {
    await repo.integrations.failWebhookDelivery(deps.db, row.id, 'endpoint disabled', null);
    return;
  }
  if (row.url === null) {
    await repo.integrations.failWebhookDelivery(deps.db, row.id, 'endpoint url missing', null);
    return;
  }
  try {
    await assertServerEndpoint(row.url, {
      nodeEnv: deps.nodeEnv,
      allowlist: deps.allowlist,
      allowDevLocal: false,
    });
  } catch (err) {
    const retryable = isAppError(err) && err.retryable;
    await repo.integrations.failWebhookDelivery(
      deps.db,
      row.id,
      retryable ? 'endpoint url resolution failed' : 'endpoint url rejected',
      retryable && row.attempts < MAX_ATTEMPTS
        ? new Date(Date.now() + retryDelayMs(row.attempts))
        : null,
    );
    return;
  }
  let secret: string;
  try {
    secret = (await decryptSecrets(row.secretEncrypted, deps.secretKey)).secret ?? '';
  } catch {
    secret = '';
  }
  if (secret === '') {
    await repo.integrations.failWebhookDelivery(deps.db, row.id, 'secret unavailable', null);
    return;
  }
  const timestamp = Date.now();
  let error: string;
  try {
    const response = await fetch(row.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'X-Agentport-Event': row.eventType,
        'X-Agentport-Delivery': row.id,
        'X-Agentport-Timestamp': String(timestamp),
        'X-Agentport-Signature': sign(secret, timestamp, row.payload),
      },
      body: row.payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) {
      await repo.integrations.completeWebhookDelivery(deps.db, row.id);
      return;
    }
    error = `HTTP ${response.status}`;
  } catch (err) {
    error = err instanceof Error ? err.name : 'network error';
  }
  deps.logger.warn(
    { deliveryId: row.id, eventType: row.eventType, error },
    'webhook delivery failed',
  );
  await repo.integrations.failWebhookDelivery(
    deps.db,
    row.id,
    error,
    row.attempts < MAX_ATTEMPTS ? new Date(Date.now() + retryDelayMs(row.attempts)) : null,
  );
}

async function deliverBatch(deps: DeliveryDeps): Promise<void> {
  const rows = await repo.integrations.claimWebhookDeliveries(deps.db, BATCH_SIZE);
  await Promise.all(
    rows.map((row) =>
      deliverOne(deps, row).catch((err: unknown) => {
        deps.logger.warn(
          { err, deliveryId: row.id, eventType: row.eventType },
          'webhook delivery errored',
        );
      }),
    ),
  );
}

export function startWebhookDeliveryReconciler(deps: DeliveryDeps): () => Promise<void> {
  return startIntervalTicker(
    () =>
      deliverBatch(deps).catch((err: unknown) => {
        deps.logger.warn({ err }, 'webhook delivery tick failed');
      }),
    TICK_MS,
  );
}
