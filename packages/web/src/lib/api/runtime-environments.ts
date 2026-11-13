import type {
  RuntimeEnvironment,
  RuntimeEnvironmentInput,
  RuntimeEnvironmentPatch,
  RuntimeEnvironmentVersion,
  RuntimeEnvironmentVersionSummary,
} from '@agentport/shared';
import { rpc } from '../orpc.js';

export default {
  runtimeEnvironments: (): Promise<RuntimeEnvironment[]> => rpc.runtimeEnvironments.list(),
  runtimeEnvironment: (id: string): Promise<RuntimeEnvironment> =>
    rpc.runtimeEnvironments.detail({ params: { id } }),
  createRuntimeEnvironment: (input: RuntimeEnvironmentInput): Promise<RuntimeEnvironment> =>
    rpc.runtimeEnvironments.create({ body: input }),
  updateRuntimeEnvironment: (
    id: string,
    patch: RuntimeEnvironmentPatch,
  ): Promise<RuntimeEnvironment> => rpc.runtimeEnvironments.update({ params: { id }, body: patch }),
  deleteRuntimeEnvironment: (id: string): Promise<void> =>
    rpc.runtimeEnvironments.remove({ params: { id } }),
  runtimeEnvironmentVersions: (id: string): Promise<RuntimeEnvironmentVersionSummary[]> =>
    rpc.runtimeEnvironments.versions({ params: { id } }),
  runtimeEnvironmentVersion: (id: string, versionId: string): Promise<RuntimeEnvironmentVersion> =>
    rpc.runtimeEnvironments.versionDetail({ params: { id, versionId } }),
  buildRuntimeEnvironment: (id: string): Promise<RuntimeEnvironmentVersion> =>
    rpc.runtimeEnvironments.build({ params: { id } }),
  publishRuntimeEnvironment: (id: string, versionId: string): Promise<RuntimeEnvironment> =>
    rpc.runtimeEnvironments.publish({ params: { id }, body: { versionId } }),
};
