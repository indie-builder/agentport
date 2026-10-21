import type { RunStatus } from '../lib/api.js';
import { runStatusLabel, runStatusVariant } from '../lib/format.js';
import { Badge } from './ui/badge.js';

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge variant={runStatusVariant[status]}>
      {status === 'running' ? (
        <span className="size-1.5 animate-pulse rounded-full bg-warning" aria-hidden="true" />
      ) : null}
      {runStatusLabel[status]}
    </Badge>
  );
}
