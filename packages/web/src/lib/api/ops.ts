import type { Attention, Schedule, ScheduleInput, SchedulePatch } from '@agentport/shared';
import { rpc } from '../orpc.js';

export default {
  attention: (): Promise<Attention> => rpc.ops.attention(),
  schedules: (): Promise<Schedule[]> => rpc.ops.schedules.list(),
  createSchedule: (input: ScheduleInput): Promise<Schedule> =>
    rpc.ops.schedules.create({ body: input }),
  updateSchedule: (id: string, input: SchedulePatch): Promise<Schedule> =>
    rpc.ops.schedules.update({ params: { id }, body: input }),
  deleteSchedule: (id: string): Promise<void> => rpc.ops.schedules.remove({ params: { id } }),
};
