import type { ResolvedRuntimeEnvironment } from '@agentport/shared';

/** `environmentId` 为 null 时查平台默认环境的线上版本。 */
type ResolveOnlineRuntimeEnvironment = (
  environmentId: string | null,
  versionId?: string | null,
) => Promise<ResolvedRuntimeEnvironment | null>;

export type RuntimeEnvironmentResolver = (
  environmentId: string | null,
  versionId?: string | null,
) => Promise<ResolvedRuntimeEnvironment>;

export function createRuntimeEnvironmentResolver(
  resolveOnline: ResolveOnlineRuntimeEnvironment,
): RuntimeEnvironmentResolver {
  return async (environmentId, versionId) => {
    const resolved =
      versionId === null
        ? null
        : versionId === undefined
          ? await resolveOnline(environmentId)
          : await resolveOnline(environmentId, versionId);
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
