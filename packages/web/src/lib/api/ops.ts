import {
  type Attention,
  type RetentionSettings,
  type RetentionUpdate,
  type Schedule,
  type ScheduleInput,
  type SchedulePatch,
  type ScheduleRun,
} from '@agentport/shared';
import { rpc } from '../orpc.js';

export default {
  attention: (): Promise<Attention> => rpc.ops.attention(),
  retention: (): Promise<RetentionSettings> => rpc.ops.retention(),
  updateRetention: (input: RetentionUpdate): Promise<RetentionSettings> =>
    rpc.ops.updateRetention({ body: input }),
  agentStats: (id: string, days: number) => rpc.ops.agentStats({ params: { id }, query: { days } }),
  schedules: (): Promise<Schedule[]> => rpc.ops.schedules.list(),
  createSchedule: (input: ScheduleInput): Promise<Schedule> =>
    rpc.ops.schedules.create({ body: input }),
  updateSchedule: (id: string, input: SchedulePatch): Promise<Schedule> =>
    rpc.ops.schedules.update({ params: { id }, body: input }),
  deleteSchedule: (id: string): Promise<void> => rpc.ops.schedules.remove({ params: { id } }),
  scheduleRuns: (id: string, limit?: number): Promise<ScheduleRun[]> =>
    rpc.ops.schedules.runs({ params: { id }, query: limit === undefined ? {} : { limit } }),
  retryScheduleRun: (id: string, runId: string): Promise<ScheduleRun> =>
    rpc.ops.schedules.retry({ params: { id, runId } }),
};
