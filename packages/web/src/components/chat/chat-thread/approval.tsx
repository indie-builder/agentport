import { CircleAlert } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { memo } from 'react';
import type { ApprovalRequest } from '../../../lib/api.js';
import { Button } from '../../ui/button.js';

/** 设计规范 §9：只有展开折叠这类状态切换，150ms、ease-out、不加位移。 */
const EXPAND = { duration: 0.15, ease: 'easeOut' } as const;
const STILL = { duration: 0 } as const;

/** 等待中的调用可继续，已结束的调用仅记录后续许可。 */
export const ApprovalCard = memo(function ApprovalCard({
  item,
  pending,
  onApprove,
}: {
  item: ApprovalRequest;
  pending: string | null;
  onApprove: (item: ApprovalRequest) => void;
}) {
  const busy = pending === item.id;
  const isPending = item.waiting && item.approvedAt === null && item.deniedAt === null;
  const reduce = useReducedMotion();
  return (
    <motion.div
      role="alert"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduce ? STILL : EXPAND}
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
          : '本次调用已结束等待，批准仅对后续调用生效，不会恢复已结束的调用。'}{' '}
        <span className="text-muted-foreground">批准在本会话内有效，8 小时后需重新批准。</span>
      </div>
      <Button
        size="sm"
        className="h-auto min-h-7 max-w-full whitespace-normal py-1"
        disabled={pending !== null}
        aria-busy={busy}
        aria-label={`批准 ${item.serverName ?? item.serverId} / ${item.toolName}`}
        onClick={() => onApprove(item)}
      >
        {busy ? '批准中…' : item.waiting ? '批准本次调用' : '批准后续调用'}
      </Button>
    </motion.div>
  );
});
