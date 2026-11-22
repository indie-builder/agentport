import { type MemoryPolicy, memoryWritable } from '@agentport/shared';

interface MemoryRuntimeSettings {
  autoMemoryEnabled: boolean;
  installPersonalHook: boolean;
  allowMemoryWrite: boolean;
}

export function memoryRuntimeSettings(policy: MemoryPolicy): MemoryRuntimeSettings {
  const nativeAuto = memoryWritable(policy);
  return {
    autoMemoryEnabled: nativeAuto,
    installPersonalHook: policy.injectPersonalMemory,
    allowMemoryWrite: nativeAuto,
  };
}
