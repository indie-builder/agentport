import type {
  ModelProvider,
  ModelProviderCreate,
  ModelProviderTestResult,
  ModelProviderUpdate,
} from '@agentport/shared';
import { rpc } from '../orpc.js';

export default {
  modelProviders: (): Promise<ModelProvider[]> => rpc.modelProviders.list(),
  createModelProvider: (input: ModelProviderCreate): Promise<ModelProvider> =>
    rpc.modelProviders.create({ body: input }),
  updateModelProvider: (id: string, input: ModelProviderUpdate): Promise<ModelProvider> =>
    rpc.modelProviders.update({ params: { id }, body: input }),
  deleteModelProvider: (id: string): Promise<void> => rpc.modelProviders.remove({ params: { id } }),
  testModelProvider: (id: string): Promise<ModelProviderTestResult> =>
    rpc.modelProviders.test({ params: { id } }),
};
