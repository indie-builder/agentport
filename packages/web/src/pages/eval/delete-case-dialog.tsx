import type { ComponentProps } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import type { EvalCase } from '../../lib/api.js';
import { useDeleteEvalCase } from '../../lib/queries.js';
import { toastSuccess } from '../../lib/toast.js';

export function DeleteCaseDialog({
  testCase,
  onClose,
  finalFocus,
}: {
  testCase: EvalCase;
  onClose: () => void;
  finalFocus: ComponentProps<typeof ConfirmDialog>['finalFocus'];
}) {
  const remove = useDeleteEvalCase();
  return (
    <ConfirmDialog
      open
      title="删除用例"
      description={`将删除「${testCase.name}」，后续评估不再执行此用例；已有的历史评估结果会保留。`}
      onClose={onClose}
      finalFocus={finalFocus}
      onConfirm={async () => {
        await remove.mutateAsync(testCase.id);
        toastSuccess('用例已删除');
      }}
    />
  );
}
