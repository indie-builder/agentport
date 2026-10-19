import type { RunStatus } from '../lib/api.js';
import { runStatusLabel } from '../lib/format.js';
import { Badge } from './ui/badge.js';

const variant = {
  succeeded: 'success',
  running: 'warn',
  queued: 'default',
  failed: 'danger',
  timeout: 'danger',
  cancelled: 'outline',
} as const satisfies Record<RunStatus, 'success' | 'warn' | 'default' | 'danger' | 'outline'>;

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge variant={variant[status]}>
      {status === 'running' ? (
        <span className="size-1.5 animate-pulse rounded-full bg-warning" aria-hidden="true" />
      ) : null}
      {runStatusLabel[status]}
    </Badge>
  );
}
