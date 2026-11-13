import type { Overview, OverviewTimeseriesPoint } from '@agentport/shared';
import { rpc } from '../orpc.js';

export type {
  Overview,
  OverviewAgentRow,
  OverviewTimeseriesPoint,
  RecentRun,
} from '@agentport/shared';

export default {
  overview: (): Promise<Overview> => rpc.overview.snapshot({ query: {} }),
  overviewTimeseries: (days = 14): Promise<OverviewTimeseriesPoint[]> =>
    rpc.overview.timeseries({ query: { days } }),
};
