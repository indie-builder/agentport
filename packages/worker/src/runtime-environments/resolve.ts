import type { ResolvedRuntimeEnvironment } from '@agentport/shared';

/** `environmentId` 为 null 时查平台默认环境的线上版本。 */
export type ResolveOnlineRuntimeEnvironment = (
  environmentId: string | null,
) => Promise<ResolvedRuntimeEnvironment | null>;

export type RuntimeEnvironmentResolver = (
  environmentId: string | null,
) => Promise<ResolvedRuntimeEnvironment>;

/**
 * 只在真实创建容器时调用：复用存活容器不读线上版本，发布/回退不会替换它。
 * 没有线上版本时明确失败，不回落其他环境或镜像。
 */
export function createRuntimeEnvironmentResolver(
  resolveOnline: ResolveOnlineRuntimeEnvironment,
): RuntimeEnvironmentResolver {
  return async (environmentId) => {
    const resolved = await resolveOnline(environmentId);
    if (resolved === null) {
      throw new Error(
        environmentId === null
          ? '平台默认运行环境还没有可用的线上版本，无法创建沙盒'
          : `运行环境 ${environmentId} 没有可用的线上版本，无法创建沙盒`,
      );
    }
    return resolved;
  };
}
