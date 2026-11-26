import { z } from 'zod';
import { DEFAULT_JOB_RETENTION } from './run-stream.js';

export const RUNTIME_ENVIRONMENT_BUILDS_QUEUE = 'runtime-environment-builds';
export const RUNTIME_ENVIRONMENT_BUILD_CONCURRENCY = 1;

export const RUNTIME_ENVIRONMENT_BUILD_LOG_LIMIT = 64 * 1024;

export const DEFAULT_RUNTIME_ENVIRONMENT_NAME = '默认环境';

export const DEFAULT_RUNTIME_DOCKERFILE = `# syntax=docker/dockerfile:1
ARG RUNTIME_BASE_IMAGE=agentport/sandbox:dev
FROM \${RUNTIME_BASE_IMAGE}

USER root
# 在下面安装额外系统包；安装归档与缓存要及时清理。
# RUN apk add --no-cache <package> && rm -rf /var/cache/apk/*

USER node
WORKDIR /app
`;

export const runtimeEnvironmentVersionStatusSchema = z.enum([
  'queued',
  'building',
  'ready',
  'failed',
]);
export type RuntimeEnvironmentVersionStatus = z.infer<typeof runtimeEnvironmentVersionStatusSchema>;

export const runtimeEnvironmentInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  dockerfile: z.string().min(1).max(200_000).default(DEFAULT_RUNTIME_DOCKERFILE),
});
export type RuntimeEnvironmentInput = z.infer<typeof runtimeEnvironmentInputSchema>;

export const runtimeEnvironmentPatchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  dockerfile: z.string().min(1).max(200_000).optional(),
});
export type RuntimeEnvironmentPatch = z.infer<typeof runtimeEnvironmentPatchSchema>;

export const runtimeEnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  dockerfile: z.string(),
  isDefault: z.boolean(),
  onlineVersionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;

export const runtimeEnvironmentVersionSchema = z.object({
  id: z.string(),
  environmentId: z.string(),
  dockerfile: z.string(),
  baseImageId: z.string(),
  status: runtimeEnvironmentVersionStatusSchema,
  imageTag: z.string().nullable(),
  imageId: z.string().nullable(),
  buildLog: z.string(),
  logTruncated: z.boolean(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type RuntimeEnvironmentVersion = z.infer<typeof runtimeEnvironmentVersionSchema>;

export const runtimeEnvironmentVersionSummarySchema = runtimeEnvironmentVersionSchema.omit({
  dockerfile: true,
  buildLog: true,
});
export type RuntimeEnvironmentVersionSummary = z.infer<
  typeof runtimeEnvironmentVersionSummarySchema
>;

export function runtimeBuildEnqueueOptions(versionId: string) {
  return {
    jobId: versionId,
    attempts: 1,
    ...DEFAULT_JOB_RETENTION,
  };
}

export const runtimeEnvironmentBuildJobSchema = z.object({
  versionId: z.string().min(1),
  autoPublishIfOnlineVersionId: z.string().min(1).optional(),
});
export type RuntimeEnvironmentBuildJob = z.infer<typeof runtimeEnvironmentBuildJobSchema>;

export const runtimeEnvironmentOnlineVersionInputSchema = z.object({
  versionId: z.string().min(1),
});
export const resolvedRuntimeEnvironmentSchema = z.object({
  environmentId: z.string(),
  environmentName: z.string(),
  versionId: z.string(),
  imageId: z.string(),
});
export type ResolvedRuntimeEnvironment = z.infer<typeof resolvedRuntimeEnvironmentSchema>;
