import { CircleAlert } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { memo } from 'react';
import type { ApprovalRequest } from '../../../lib/api.js';
import { Button } from '../../ui/button.js';

const EXPAND = { duration: 0.15, ease: 'easeOut' } as const;
const STILL = { duration: 0 } as const;

export const ApprovalCard = memo(function ApprovalCard({
  item,
  pending,
  denying = null,
  onApprove,
  onDeny,
}: {
  item: ApprovalRequest;
  pending: string | null;
  denying?: string | null;
  onApprove: (item: ApprovalRequest) => void;
  onDeny?: (item: ApprovalRequest) => void;
}) {
  const busy = pending === item.id;
  const denyingThis = denying === item.id;
  const deciding = pending !== null || denying !== null;
  const isPending = item.waiting && item.approvedAt === null && item.deniedAt === null;
  const reduce = useReducedMotion();
  return (
    <motion.div
      role="alert"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduce ? STILL : EXPAND}
      data-hover="shadow"
      className="cds-card-surface flex flex-wrap items-center gap-2 rounded-card bg-surface px-3 py-2"
    >
      <CircleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
      {isPending ? (
        <span className="shrink-0 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
          等待授权
        </span>
      ) : null}
      <div className="min-w-0 flex-1 basis-48 text-sm text-fg [overflow-wrap:anywhere]">
        工具 <code className="font-mono text-xs">{item.toolName}</code>
        <span className="text-muted-foreground"> @ {item.serverName ?? item.serverId}</span>{' '}
        {item.waiting
          ? '调用仍在等待，批准后可继续本次调用，无需重发'
          : '审批已失效，请让智能体重新发起。'}{' '}
        {isPending ? (
          <span className="text-muted-foreground">批准仅对本次运行的当前判定有效。</span>
        ) : null}
      </div>
      {isPending ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {onDeny ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto min-h-7 max-w-full whitespace-normal py-1"
              disabled={deciding}
              aria-busy={denyingThis}
              aria-label={`拒绝 ${item.serverName ?? item.serverId} / ${item.toolName}`}
              onClick={() => onDeny(item)}
            >
              {denyingThis ? '拒绝中…' : '拒绝'}
            </Button>
          ) : null}
          <Button
            size="sm"
            className="h-auto min-h-7 max-w-full whitespace-normal py-1"
            disabled={deciding}
            aria-busy={busy}
            aria-label={`批准 ${item.serverName ?? item.serverId} / ${item.toolName}`}
            onClick={() => onApprove(item)}
          >
            {busy ? '批准中…' : '批准本次调用'}
          </Button>
        </div>
      ) : null}
    </motion.div>
  );
});
