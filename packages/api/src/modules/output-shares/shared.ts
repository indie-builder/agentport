import { decryptSecrets, isAppError, sha256Hex } from '@agentport/core';
import { repo } from '@agentport/db';
import type { OutputFile, OutputShare } from '@agentport/shared';
import { bearerToken, tokenMatches } from '../../http/bearer.js';
import { actorOf, type RequestContext } from '../../http/context.js';
import { readWorkspaceOutput } from '../../lib/outputs.js';

export type OutputShareRow = repo.outputShares.OutputShareRow;

export async function toOutputShare(
  row: Pick<
    OutputShareRow,
    'id' | 'runId' | 'path' | 'sha256' | 'createdAt' | 'revokedAt' | 'tokenEncrypted'
  >,
  context: RequestContext,
): Promise<OutputShare> {
  return {
    id: row.id,
    runId: row.runId,
    path: row.path,
    sha256: row.sha256,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    urlPath: `/s/${row.id}#${(await decryptSecrets(row.tokenEncrypted, context.config.APP_SECRET_KEY)).token}`,
  };
}

export async function auditShareRevoked(
  context: RequestContext,
  row: OutputShareRow,
): Promise<void> {
  await repo.audit.writeAudit(context.db, context.log, {
    actor: actorOf(context),
    action: 'share.revoked',
    target: row.id,
    input: { conversationId: row.conversationId, runId: row.runId, path: row.path },
    status: 'ok',
    requestId: context.requestId,
  });
}

export async function resolveSharedFile(
  context: RequestContext,
  id: string,
): Promise<{ row: OutputShareRow; file: OutputFile; data: Buffer } | null> {
  const token = bearerToken(context.request.headers.get('authorization') ?? undefined);
  if (token === undefined) return null;
  const row = await repo.outputShares.findActiveById(context.db, id);
  if (row === null || !tokenMatches(row.tokenHash, token, sha256Hex)) return null;

  const conversation = await repo.chat.getConversation(context.db, row.conversationId);
  if (!conversation) return null;
  if (await repo.chat.isConversationDataDomainRestricted(context.db, conversation.id)) return null;
  const slug = await repo.agents.findAgentSlug(context.db, conversation.agentId);
  if (slug === null) return null;

  try {
    const { file, data } = await readWorkspaceOutput(context, {
      slug,
      conversationId: conversation.id,
      runId: row.runId,
      path: row.path,
    });
    return file.sha256 === row.sha256 && sha256Hex(data) === row.sha256
      ? { row, file, data }
      : null;
  } catch (err) {
    if (isAppError(err)) return null;
    throw err;
  }
}
