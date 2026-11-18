import { fail } from '@agentport/core';
import type { IntegrationScope, WebhookEventType } from '@agentport/shared';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../client.js';
import { newId } from '../id.js';
import { agents, apiTokens, authUsers, webhookDeliveries, webhookEndpoints } from '../schema.js';
import { lockAdminMutation } from './access.js';

interface IntegrationOwner {
  authUserId: string;
  ownerBusinessId: string;
}

async function lockActiveIntegrationOwner(tx: Transaction, owner: IntegrationOwner) {
  await lockAdminMutation(tx);
  const [row] = await tx
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(
      and(
        eq(authUsers.id, owner.authUserId),
        eq(authUsers.businessId, owner.ownerBusinessId),
        eq(authUsers.disabled, false),
      ),
    );
  if (!row) fail('UNAUTHORIZED', '账户已删除或停用');
}

const apiTokenColumns = {
  id: apiTokens.id,
  name: apiTokens.name,
  tokenPrefix: apiTokens.tokenPrefix,
  scopes: apiTokens.scopes,
  expiresAt: apiTokens.expiresAt,
  revokedAt: apiTokens.revokedAt,
  lastUsedAt: apiTokens.lastUsedAt,
  createdAt: apiTokens.createdAt,
};

export async function listApiTokens(db: DbHandle, businessId: string) {
  return db
    .select(apiTokenColumns)
    .from(apiTokens)
    .where(eq(apiTokens.ownerBusinessId, businessId))
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id));
}

export interface CreateApiTokenInput extends IntegrationOwner {
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  scopes: IntegrationScope[];
  expiresAt?: Date | null;
}

export async function createApiToken(db: Database, input: CreateApiTokenInput) {
  return db.transaction(async (tx) => {
    const { authUserId, ...values } = input;
    await lockActiveIntegrationOwner(tx, { authUserId, ownerBusinessId: values.ownerBusinessId });
    const [row] = await tx
      .insert(apiTokens)
      .values({ id: newId('apiToken'), ...values, expiresAt: values.expiresAt ?? null })
      .returning(apiTokenColumns);
    if (!row) throw new Error('api token insert returned no row');
    return row;
  });
}

export async function revokeApiToken(
  db: Database,
  businessId: string,
  id: string,
): Promise<boolean> {
  const [row] = await db
    .update(apiTokens)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(apiTokens.id, id),
        eq(apiTokens.ownerBusinessId, businessId),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning({ id: apiTokens.id });
  return row !== undefined;
}

export interface ApiTokenAuthRow {
  id: string;
  ownerBusinessId: string;
  scopes: IntegrationScope[];
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export async function getApiTokenByHash(
  db: DbHandle,
  tokenHash: string,
): Promise<ApiTokenAuthRow | null> {
  const [row] = await db
    .select({
      id: apiTokens.id,
      ownerBusinessId: apiTokens.ownerBusinessId,
      scopes: apiTokens.scopes,
      expiresAt: apiTokens.expiresAt,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function touchApiToken(db: Database, id: string): Promise<void> {
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, id));
}

const webhookEndpointColumns = {
  id: webhookEndpoints.id,
  name: webhookEndpoints.name,
  direction: webhookEndpoints.direction,
  agentId: webhookEndpoints.agentId,
  agentName: agents.name,
  url: webhookEndpoints.url,
  events: webhookEndpoints.events,
  enabled: webhookEndpoints.enabled,
  createdAt: webhookEndpoints.createdAt,
  updatedAt: webhookEndpoints.updatedAt,
};

async function findWebhookEndpoint(db: DbHandle, id: string) {
  const [row] = await db
    .select(webhookEndpointColumns)
    .from(webhookEndpoints)
    .leftJoin(agents, eq(agents.id, webhookEndpoints.agentId))
    .where(eq(webhookEndpoints.id, id))
    .limit(1);
  return row ?? null;
}

export async function listWebhookEndpoints(db: DbHandle, businessId: string) {
  return db
    .select(webhookEndpointColumns)
    .from(webhookEndpoints)
    .leftJoin(agents, eq(agents.id, webhookEndpoints.agentId))
    .where(eq(webhookEndpoints.ownerBusinessId, businessId))
    .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id));
}

export interface CreateWebhookEndpointInput extends IntegrationOwner {
  name: string;
  direction: 'inbound' | 'outbound';
  agentId?: string | null;
  url?: string | null;
  events?: WebhookEventType[];
  secretEncrypted: string;
}

export async function createWebhookEndpoint(db: Database, input: CreateWebhookEndpointInput) {
  return db.transaction(async (tx) => {
    await lockActiveIntegrationOwner(tx, input);
    const [inserted] = await tx
      .insert(webhookEndpoints)
      .values({
        id: newId('webhookEndpoint'),
        name: input.name,
        direction: input.direction,
        agentId: input.agentId ?? null,
        url: input.url ?? null,
        events: input.events ?? [],
        secretEncrypted: input.secretEncrypted,
        ownerBusinessId: input.ownerBusinessId,
      })
      .returning({ id: webhookEndpoints.id });
    if (!inserted) throw new Error('webhook endpoint insert returned no row');
    const row = await findWebhookEndpoint(tx, inserted.id);
    if (!row) throw new Error('webhook endpoint insert returned no row');
    return row;
  });
}

export async function deleteWebhookEndpoint(
  db: Database,
  businessId: string,
  id: string,
): Promise<boolean> {
  const [row] = await db
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.ownerBusinessId, businessId)))
    .returning({ id: webhookEndpoints.id });
  return row !== undefined;
}

export interface InboundWebhookEndpoint {
  id: string;
  name: string;
  agentId: string;
  secretEncrypted: string;
  enabled: boolean;
  ownerBusinessId: string;
}

export async function getInboundWebhookEndpoint(
  db: DbHandle,
  id: string,
): Promise<InboundWebhookEndpoint | null> {
  const [row] = await db
    .select({
      id: webhookEndpoints.id,
      name: webhookEndpoints.name,
      agentId: webhookEndpoints.agentId,
      secretEncrypted: webhookEndpoints.secretEncrypted,
      enabled: webhookEndpoints.enabled,
      ownerBusinessId: webhookEndpoints.ownerBusinessId,
    })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.direction, 'inbound')))
    .limit(1);
  if (!row || row.agentId === null) return null;
  return { ...row, agentId: row.agentId };
}

export interface EnqueueWebhookEventInput {
  eventType: WebhookEventType;
  sourceId: string;
  ownerBusinessId: string;
  payload: string;
}

export async function enqueueWebhookEvent(
  db: DbHandle,
  input: EnqueueWebhookEventInput,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const endpoints = await tx
      .select({ id: webhookEndpoints.id })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.enabled, true),
          eq(webhookEndpoints.direction, 'outbound'),
          eq(webhookEndpoints.ownerBusinessId, input.ownerBusinessId),
          sql`${webhookEndpoints.events} @> array[${input.eventType}]::text[]`,
        ),
      )
      .for('key share');
    if (endpoints.length === 0) return [];
    const rows = await tx
      .insert(webhookDeliveries)
      .values(
        endpoints.map((endpoint) => ({
          id: newId('webhookDelivery'),
          endpointId: endpoint.id,
          eventType: input.eventType,
          sourceId: input.sourceId,
          payload: input.payload,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.id });
    return rows.map((row) => row.id);
  });
}

export interface WebhookDeliveryClaim {
  id: string;
  endpointId: string;
  eventType: WebhookEventType;
  sourceId: string;
  payload: string;
  attempts: number;
  endpointName: string;
  url: string | null;
  secretEncrypted: string;
  enabled: boolean;
}

export async function claimWebhookDeliveries(
  db: Database,
  limit: number,
): Promise<WebhookDeliveryClaim[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: webhookDeliveries.id,
        endpointId: webhookDeliveries.endpointId,
        eventType: webhookDeliveries.eventType,
        sourceId: webhookDeliveries.sourceId,
        payload: webhookDeliveries.payload,
        attempts: webhookDeliveries.attempts,
        endpointName: webhookEndpoints.name,
        url: webhookEndpoints.url,
        secretEncrypted: webhookEndpoints.secretEncrypted,
        enabled: webhookEndpoints.enabled,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(
        or(
          and(
            eq(webhookDeliveries.status, 'pending'),
            sql`${webhookDeliveries.nextAttemptAt} <= now()`,
          ),
          and(
            eq(webhookDeliveries.status, 'delivering'),
            sql`${webhookDeliveries.updatedAt} < now() - interval '2 minutes'`,
          ),
        ),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
      .limit(limit)
      .for('update', { of: webhookDeliveries, skipLocked: true });
    if (rows.length === 0) return [];
    const claimed = await tx
      .update(webhookDeliveries)
      .set({
        status: 'delivering',
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        inArray(
          webhookDeliveries.id,
          rows.map((row) => row.id),
        ),
      )
      .returning({ id: webhookDeliveries.id, attempts: webhookDeliveries.attempts });
    const attemptsById = new Map(claimed.map((row) => [row.id, row.attempts]));
    return rows.map((row) => ({ ...row, attempts: attemptsById.get(row.id) ?? row.attempts + 1 }));
  });
}

export async function completeWebhookDelivery(db: Database, id: string): Promise<boolean> {
  const [row] = await db
    .update(webhookDeliveries)
    .set({
      status: 'succeeded',
      deliveredAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, 'delivering')))
    .returning({ id: webhookDeliveries.id });
  return row !== undefined;
}

export async function failWebhookDelivery(
  db: Database,
  id: string,
  error: string,
  nextAttemptAt: Date | null,
): Promise<boolean> {
  const [row] = await db
    .update(webhookDeliveries)
    .set(
      nextAttemptAt === null
        ? { status: 'failed', lastError: error, updatedAt: new Date() }
        : { status: 'pending', lastError: error, nextAttemptAt, updatedAt: new Date() },
    )
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, 'delivering')))
    .returning({ id: webhookDeliveries.id });
  return row !== undefined;
}
