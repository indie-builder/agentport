import { type MemoryPolicy, memoryWritable } from '@agentport/shared';

/** 记忆策略在容器运行期的三个开关；runner 只消费这份结果，不重复解释策略字段。 */
interface MemoryRuntimeSettings {
  /** 是否开启 SDK auto-memory（同时决定是否传 autoMemoryDirectory）。 */
  autoMemoryEnabled: boolean;
  installPersonalHook: boolean;
  allowMemoryWrite: boolean;
}

/**
 * 策略 → 运行时开关：
 * - 关闭专家记忆或选择 proposal_only 时都不开启 auto-memory，也不放行记忆写入；
 * - 个人记忆 hook 只由 injectPersonalMemory 独立控制，与专家记忆开关无关。
 */
export function memoryRuntimeSettings(policy: MemoryPolicy): MemoryRuntimeSettings {
  const nativeAuto = memoryWritable(policy);
  return {
    autoMemoryEnabled: nativeAuto,
    installPersonalHook: policy.injectPersonalMemory,
    allowMemoryWrite: nativeAuto,
  };
}
