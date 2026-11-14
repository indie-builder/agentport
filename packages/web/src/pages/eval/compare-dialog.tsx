import type { ComponentProps } from 'react';
import { DialogShell } from '../../components/dialog-shell.js';
import { FilterSelect } from '../../components/filter-select.js';
import { ErrorState, LoadingState } from '../../components/states.js';
import { StatusBadge } from '../../components/status-badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import type { EvalRun } from '../../lib/api.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import {
  evalComparisonStatusLabel,
  evalComparisonStatusVariant,
  evalStatusLabel,
  formatDateTime,
  shortId,
} from '../../lib/format.js';
import { useEvalComparison } from '../../lib/queries.js';
import { CompareSide } from './compare-side.js';
import type { EvalSearchPatch } from './shared.js';

export function CompareDialog({
  baseId,
  headId,
  runs,
  onChange,
  onClose: onClosed,
  finalFocus,
}: {
  baseId: string;
  headId: string;
  runs: EvalRun[];
  onChange: (patch: EvalSearchPatch) => void;
  onClose: () => void;
  finalFocus: ComponentProps<typeof DialogShell>['finalFocus'];
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const comparison = useEvalComparison(baseId, headId);

  const runLabel = (run: EvalRun): string =>
    `${shortId(run.id)} · ${evalStatusLabel[run.status]} · ${formatDateTime(run.createdAt)}`;
  const withSelected = (
    options: { value: string; label: string }[],
    selectedId: string,
  ): { value: string; label: string }[] =>
    options.some((option) => option.value === selectedId)
      ? options
      : [{ value: selectedId, label: `${shortId(selectedId)} · 不在当前列表` }, ...options];
  // 两侧都排除对方已选中的运行，从源头上避免自己和自己比较。
  const baseOptions = withSelected(
    runs.filter((run) => run.id !== headId).map((run) => ({ value: run.id, label: runLabel(run) })),
    baseId,
  );
  const headOptions = withSelected(
    runs.filter((run) => run.id !== baseId).map((run) => ({ value: run.id, label: runLabel(run) })),
    headId,
  );

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogShell
        title="比较评估运行"
        description="只比较相同冻结输入的结果；单边记录也可能是批次未执行完成，不代表用例增删。专家配置未固定，不构成完整可复现的结论。"
        finalFocus={finalFocus}
        className="sm:max-w-225"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">基准运行</span>
            <FilterSelect
              value={baseId}
              onValueChange={(next) => onChange({ base: next })}
              options={baseOptions}
              label="基准运行"
              className="w-full"
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">对比运行</span>
            <FilterSelect
              value={headId}
              onValueChange={(next) => onChange({ head: next })}
              options={headOptions}
              label="对比运行"
              className="w-full"
            />
          </div>
        </div>

        <div className="mt-4 border-t pt-4">
          {comparison.isPending ? <LoadingState rows={3} /> : null}
          {comparison.isError ? (
            <>
              <ErrorState error={comparison.error} onRetry={() => void comparison.refetch()} />
              <div className="mt-2 flex justify-end">
                <Button variant="outline" size="sm" onClick={onClose}>
                  返回历史
                </Button>
              </div>
            </>
          ) : null}
          {comparison.isSuccess && comparison.data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">两次运行都没有结果记录，无法比较。</p>
          ) : null}
          {comparison.isSuccess && comparison.data.rows.length > 0 ? (
            <ul className="flex flex-col gap-4">
              {comparison.data.rows.map((row) => (
                <li key={row.key} className="border-b pb-4 last:border-b-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={evalComparisonStatusVariant[row.status]}>
                      {evalComparisonStatusLabel[row.status]}
                    </StatusBadge>
                    <span className="min-w-0 truncate text-md font-medium text-fg">
                      {row.base?.name ?? row.head?.name ?? '—'}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
                    <CompareSide
                      title="基准"
                      result={row.base}
                      showPass={row.status !== 'changed_inputs' && row.status !== 'unverified'}
                    />
                    <CompareSide
                      title="对比"
                      result={row.head}
                      showPass={row.status !== 'changed_inputs' && row.status !== 'unverified'}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </DialogShell>
    </Dialog>
  );
}
