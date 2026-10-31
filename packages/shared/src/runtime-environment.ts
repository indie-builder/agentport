import { z } from 'zod';

/** BullMQ 队列名；jobId = versionId，并发 1。 */
export const RUNTIME_ENVIRONMENT_BUILDS_QUEUE = 'runtime-environment-builds';

/** 默认环境的固定名称；worker 首次启动时登记平台基座。 */
export const DEFAULT_RUNTIME_ENVIRONMENT_NAME = '默认环境';

/**
 * 默认 Dockerfile：从平台 runner 基座派生，只承载运行内容。
 * 额外系统包在 USER root 段安装并清理缓存；需要编译时用多阶段构建，
 * 最终层保持 uid 1000 的 node 用户与 /app 工作目录。
 */
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
  /** 当前线上版本；null 表示尚未发布会话不可创建容器。 */
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
  /** 仅用于定位本地镜像；容器创建用 imageId。 */
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

/** 列表不返回快照 Dockerfile 与完整日志；详情用 RuntimeEnvironmentVersion。 */
export const runtimeEnvironmentVersionSummarySchema = runtimeEnvironmentVersionSchema.omit({
  dockerfile: true,
  buildLog: true,
});
export type RuntimeEnvironmentVersionSummary = z.infer<
  typeof runtimeEnvironmentVersionSummarySchema
>;

/** 构建任务载荷；BullMQ 的 jobId 也是 versionId。 */
export const runtimeEnvironmentBuildJobSchema = z.object({ versionId: z.string().min(1) });
export type RuntimeEnvironmentBuildJob = z.infer<typeof runtimeEnvironmentBuildJobSchema>;

/** 发布/回退共用：把某个已完成版本设为线上版本。 */
export const runtimeEnvironmentOnlineVersionInputSchema = z.object({
  versionId: z.string().min(1),
});
/** 真实创建容器时使用的环境身份；存活容器不因线上指针变化而替换。 */
export const resolvedRuntimeEnvironmentSchema = z.object({
  environmentId: z.string(),
  environmentName: z.string(),
  versionId: z.string(),
  imageId: z.string(),
});
export type ResolvedRuntimeEnvironment = z.infer<typeof resolvedRuntimeEnvironmentSchema>;
