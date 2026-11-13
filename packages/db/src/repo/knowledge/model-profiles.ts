import { asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../client.js';
import { newId } from '../../id.js';
import { knowledgeModelProfiles } from '../../schema.js';
import type { KnowledgeModelProfileRow } from './shared.js';

// ---------------------------------------------------------------------------
// 模型 profile

export interface CreateModelProfileInput {
  kind: KnowledgeModelProfileRow['kind'];
  name: string;
  endpointUrl: string;
  model: string;
  dimensions: number | null;
  /** 缺省交给列默认值：openai / false。 */
  embeddingProtocol?: KnowledgeModelProfileRow['embeddingProtocol'];
  imageInputEnabled?: boolean;
  secretsEncrypted: string | null;
  enabled: boolean;
}

export async function createModelProfile(
  db: Database,
  input: CreateModelProfileInput,
): Promise<KnowledgeModelProfileRow> {
  const [row] = await db
    .insert(knowledgeModelProfiles)
    .values({ id: newId('knowledgeModelProfile'), ...input })
    .returning();
  if (!row) throw new Error('knowledge model profile insert returned no row');
  return row;
}

export type ModelProfileListRow = Omit<KnowledgeModelProfileRow, 'secretsEncrypted'> & {
  hasSecret: boolean;
};

/** 列表不带密文，只回 hasSecret；API 可直接返回。 */
export async function listModelProfiles(db: Database): Promise<ModelProfileListRow[]> {
  const rows = await db
    .select({
      id: knowledgeModelProfiles.id,
      kind: knowledgeModelProfiles.kind,
      name: knowledgeModelProfiles.name,
      endpointUrl: knowledgeModelProfiles.endpointUrl,
      model: knowledgeModelProfiles.model,
      dimensions: knowledgeModelProfiles.dimensions,
      embeddingProtocol: knowledgeModelProfiles.embeddingProtocol,
      imageInputEnabled: knowledgeModelProfiles.imageInputEnabled,
      enabled: knowledgeModelProfiles.enabled,
      createdAt: knowledgeModelProfiles.createdAt,
      updatedAt: knowledgeModelProfiles.updatedAt,
      hasSecret: sql<boolean>`${knowledgeModelProfiles.secretsEncrypted} is not null`,
    })
    .from(knowledgeModelProfiles)
    .orderBy(asc(knowledgeModelProfiles.kind), asc(knowledgeModelProfiles.name));
  return rows;
}

/** worker/API 内部解密用；永不直接回传。 */
export async function getModelProfileWithSecret(
  db: Database,
  id: string,
): Promise<KnowledgeModelProfileRow | null> {
  const [row] = await db
    .select()
    .from(knowledgeModelProfiles)
    .where(eq(knowledgeModelProfiles.id, id))
    .limit(1);
  return row ?? null;
}

export interface ModelProfilePatch {
  name?: string | undefined;
  endpointUrl?: string | undefined;
  model?: string | undefined;
  dimensions?: number | null | undefined;
  embeddingProtocol?: KnowledgeModelProfileRow['embeddingProtocol'] | undefined;
  imageInputEnabled?: boolean | undefined;
  secretsEncrypted?: string | null | undefined;
  enabled?: boolean | undefined;
}

export async function updateModelProfile(
  db: Database,
  id: string,
  patch: ModelProfilePatch,
): Promise<KnowledgeModelProfileRow | null> {
  const [row] = await db
    .update(knowledgeModelProfiles)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(knowledgeModelProfiles.id, id))
    .returning();
  return row ?? null;
}
