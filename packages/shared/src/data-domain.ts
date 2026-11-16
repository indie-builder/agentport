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
