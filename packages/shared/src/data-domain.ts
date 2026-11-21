import { z } from 'zod';

export const DATA_DOMAIN_BUILDS_QUEUE = 'data-domain-builds';

export const dataDomainBuildJobSchema = z.object({
  dataDomainId: z.string().min(1),
  versionId: z.string().min(1),
});
export type DataDomainBuildJob = z.infer<typeof dataDomainBuildJobSchema>;

export function dataDomainBuildEnqueueOptions(versionId: string) {
  return {
    jobId: versionId,
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 200,
  };
}

export const DATA_DOMAIN_ENRICHMENTS_QUEUE = 'data-domain-enrichments';

export const dataDomainEnrichmentJobSchema = z.object({
  dataDomainId: z.string().min(1),
  proposalId: z.string().min(1),
});
export type DataDomainEnrichmentJob = z.infer<typeof dataDomainEnrichmentJobSchema>;

export function dataDomainEnrichmentEnqueueOptions(proposalId: string) {
  return { jobId: proposalId, attempts: 1, removeOnComplete: 100, removeOnFail: 200 };
}

export const dataDomainEnrichmentOutputSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  updatedFiles: z.record(z.string().min(1).max(512), z.string()),
  removedPaths: z.array(z.string().min(1).max(512)).default([]),
});
export type DataDomainEnrichmentOutput = z.infer<typeof dataDomainEnrichmentOutputSchema>;

export const dataDomainQueryApprovalModeSchema = z.enum(['off', 'all']);

export type DataDomainQueryApprovalMode = z.infer<typeof dataDomainQueryApprovalModeSchema>;
