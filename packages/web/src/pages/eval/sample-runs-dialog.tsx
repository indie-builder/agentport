import { History } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { DialogShell } from '../../components/dialog-shell.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/states.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import type { EvalSampleCandidate } from '../../lib/api.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { formatDateTime } from '../../lib/format.js';
import { useSampleEvalCandidates } from '../../lib/queries.js';

export function SampleRunsDialog({
  agentId,
  onConvert,
  onClose,
  finalFocus,
}: {
  agentId: string;
  onConvert: (candidate: EvalSampleCandidate) => void;
  onClose: () => void;
  finalFocus?: ComponentProps<typeof DialogShell>['finalFocus'];
}) {
  const dialog = useDialogClose(onClose);
  const candidates = useSampleEvalCandidates(agentId);
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(() => new Set());
  const visible = candidates.data?.filter((candidate) => !ignored.has(candidate.runId)) ?? [];

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={(next) => {
        if (!next) dialog.close();
      }}
    >
      <DialogShell
        title="从运行抽样"
        description="从近期成功的生产运行中随机抽取，人工确认后转为评估用例。"
        finalFocus={finalFocus}
      >
        {candidates.isPending ? <LoadingState rows={3} /> : null}
        {candidates.isError ? (
          <ErrorState error={candidates.error} onRetry={() => void candidates.refetch()} />
        ) : null}
        {candidates.isSuccess && visible.length === 0 ? (
          <EmptyState
            variant="idle"
            scale="inline"
            icon={<History aria-hidden="true" />}
            title="近期没有可抽样的运行"
          />
        ) : null}
        {visible.length > 0 ? (
          <ul>
            {visible.map((candidate) => (
              <li
                key={candidate.runId}
                className="flex items-start gap-3 border-b px-2.5 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-sm font-medium text-fg [overflow-wrap:anywhere]">
                      {candidate.title}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(candidate.endedAt)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {candidate.prompt.split('\n')[0]}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`忽略：${candidate.title}`}
                    onClick={() => setIgnored((current) => new Set(current).add(candidate.runId))}
                  >
                    忽略
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`转为用例：${candidate.title}`}
                    onClick={() => onConvert(candidate)}
                  >
                    转为用例
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </DialogShell>
    </Dialog>
  );
}
