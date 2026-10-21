import type { RunStatus } from '../lib/api.js';
import { runStatusLabel, runStatusVariant } from '../lib/format.js';
import { StatusBadge } from './status-badge.js';

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <StatusBadge tone={runStatusVariant[status]}>
      {status === 'running' ? (
        <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
      ) : null}
      {runStatusLabel[status]}
    </StatusBadge>
  );
}
