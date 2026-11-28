import { useQueryClient } from '@tanstack/react-query';
import { Button as ButtonPrimitive } from '@ui-sdk/react/button';
import { History } from 'lucide-react';
import { useState } from 'react';
import type { KnowledgeFaqSummary } from '../../../lib/api.js';
import { guardedOpenChange, useDialogClose } from '../../../lib/dialog-guard.js';
import {
  knowledgeKeys,
  useKnowledgeDocumentVersions,
  useRollbackKnowledgeDocument,
} from '../../../lib/queries.js';
import { toastError, toastSuccess } from '../../../lib/toast.js';
import { DialogShell } from '../../dialog-shell.js';
import { EmptyState, ErrorState, LoadingState } from '../../states.js';
import { StatusBadge } from '../../status-badge.js';
import { Button } from '../../ui/button.js';
import { Dialog } from '../../ui/dialog.js';
import { versionLabel } from '../knowledge-shared.js';

export function FaqHistoryDialog({
  baseId,
  canPublish,
  item,
  onClose: onClosed,
}: {
  baseId: string;
  canPublish: boolean;
  item: KnowledgeFaqSummary;
  onClose: () => void;
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const versions = useKnowledgeDocumentVersions(item.id);
  const rollback = useRollbackKnowledgeDocument(baseId);
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = versions.versions.find((version) => version.id === selectedId) ?? null;
  const blockedImport =
    selected !== null &&
    selected.metadata.faqImport !== undefined &&
    selected.metadata.publication !== 'published';
  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={guardedOpenChange(rollback.isPending, onClose)}
    >
      <DialogShell
        title="FAQ 版本历史"
        closeDisabled={rollback.isPending}
        className="max-w-170 sm:max-w-170"
      >
        {versions.isPending ? <LoadingState rows={3} /> : null}
        {versions.isError ? (
          <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
        ) : null}
        {versions.isSuccess ? (
          <div className="flex flex-col gap-3">
            {versions.versions.length === 0 ? (
              <EmptyState
                variant="idle"
                scale="inline"
                icon={<History aria-hidden="true" />}
                title="还没有历史版本"
              />
            ) : (
              <ul className="flex max-h-[50vh] flex-col overflow-auto">
                {versions.versions.map((version) => (
                  <li key={version.id} className="border-b py-2 last:border-b-0">
                    <ButtonPrimitive
                      className="flex w-full flex-col gap-1 text-left"
                      aria-pressed={selectedId === version.id}
                      onClick={() => setSelectedId(version.id)}
                    >
                      <span className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium text-fg">{versionLabel(version)}</span>
                        {version.id === item.currentVersionId ? (
                          <StatusBadge tone="success">当前发布</StatusBadge>
                        ) : null}
                        <span className="ml-auto text-2xs text-muted-foreground">
                          {new Date(version.createdAt).toLocaleString('zh-CN')}
                        </span>
                      </span>
                      {version.faq ? (
                        <span className="text-sm text-fg">{version.faq.question}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">没有 FAQ 正文</span>
                      )}
                      {version.faq?.answers.map((answer) => (
                        <span
                          key={`${version.id}-${answer}`}
                          className="line-clamp-2 text-xs text-muted-foreground"
                        >
                          {answer}
                        </span>
                      ))}
                    </ButtonPrimitive>
                  </li>
                ))}
              </ul>
            )}
            {!canPublish || versions.versions.length === 0 ? null : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {blockedImport
                    ? '导入批次草稿需整批发布，不能逐条上线'
                    : selected === null
                      ? '选择要回退的版本'
                      : ''}
                </span>
                <div className="ml-auto flex gap-2">
                  <Button variant="outline" onClick={onClose} disabled={rollback.isPending}>
                    取消
                  </Button>
                  <Button
                    disabled={
                      selected === null ||
                      selected.id === item.currentVersionId ||
                      blockedImport ||
                      rollback.isPending
                    }
                    aria-busy={rollback.isPending}
                    data-agent-confirm={
                      selected
                        ? `将 FAQ「${item.faq?.question ?? item.title}」回退到版本 ${versionLabel(selected)}`
                        : `将 FAQ「${item.faq?.question ?? item.title}」回退到所选历史版本`
                    }
                    onClick={() => {
                      if (!selected) return;
                      rollback.mutate(
                        {
                          documentId: item.id,
                          versionId: selected.id,
                          expectedVersionId: item.currentVersionId,
                        },
                        {
                          onSuccess: () => {
                            void client.invalidateQueries({ queryKey: knowledgeKeys.faq(item.id) });
                            void client.invalidateQueries({ queryKey: knowledgeKeys.faqs(baseId) });
                            toastSuccess('FAQ 已回退');
                            onClose();
                          },
                          onError: toastError,
                        },
                      );
                    }}
                  >
                    {rollback.isPending ? '回退中…' : '回退到所选版本'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </DialogShell>
    </Dialog>
  );
}
