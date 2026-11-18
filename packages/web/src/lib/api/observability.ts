import type { ObservabilitySnapshot, SloSettings } from '@agentport/shared';
import { rpc } from '../orpc.js';

export default {
  observabilitySnapshot: (windowMinutes: number): Promise<ObservabilitySnapshot> =>
    rpc.observability.snapshot({ query: { windowMinutes } }),
  sloSettings: (): Promise<SloSettings> => rpc.observability.slo.get(),
  updateSloSettings: (input: SloSettings): Promise<SloSettings> =>
    rpc.observability.slo.update({ body: input }),
};
