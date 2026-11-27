import { conversationRenameSchema } from '@agentport/shared';
import { type ComponentProps, type FormEvent, useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { DialogShell } from '../../components/dialog-shell.js';
import { RequiredMark } from '../../components/required-mark.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Field, FieldError, FieldLabel } from '../../components/ui/field.js';
import { Input } from '../../components/ui/input.js';
import { useDialogClose } from '../../lib/dialog-guard.js';
import { fieldErrors, useFormBlocker } from '../../lib/form.js';

export function useRenameBlocker(dirty: boolean, pending: boolean) {
  return useFormBlocker(dirty, pending, {
    allowNavigation: ({ current, next }) =>
      current.pathname === next.pathname &&
      'agent' in current.search &&
      'agent' in next.search &&
      current.search.agent === next.search.agent &&
      'conversation' in current.search &&
      'conversation' in next.search &&
      current.search.conversation === next.search.conversation,
  });
}

export function RenameDialog({
  title,
  dirty,
  pending,
  blocker,
  onTitleChange,
  onClose: onClosed,
  onRename,
  finalFocus,
}: {
  title: string;
  dirty: boolean;
  pending: boolean;
  blocker: ReturnType<typeof useRenameBlocker>;
  onTitleChange: (title: string) => void;
  onClose: () => void;
  onRename: (title: string) => Promise<unknown>;
  finalFocus: ComponentProps<typeof DialogShell>['finalFocus'];
}) {
  const dialog = useDialogClose(onClosed);
  const onClose = dialog.close;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const parsed = conversationRenameSchema.safeParse({ title });
  const error = parsed.success
    ? null
    : (fieldErrors(parsed.error.issues).title ?? '请检查标题后重试');
  const saveDisabled = !parsed.success || !dirty || pending;
  const close = (): void => {
    if (pending) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (saveDisabled || !parsed.success) return;
    void onRename(parsed.data.title).then(
      () => dialog.finish(onClosed),
      () => {},
    );
  };

  const leaving = blocker.status === 'blocked';
  const discardOpen = confirmDiscard || leaving;

  return (
    <Dialog
      open={dialog.open}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogShell title="重命名会话" closeDisabled={pending} finalFocus={finalFocus}>
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <Field className="gap-1.5" data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="conversation-title">
              标题 <RequiredMark />
            </FieldLabel>
            <Input
              id="conversation-title"
              value={title}
              disabled={pending}
              aria-required="true"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'conversation-title-error' : undefined}
              onChange={(event) => onTitleChange(event.target.value)}
            />
            <FieldError id="conversation-title-error">{error}</FieldError>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close} disabled={pending}>
              取消
            </Button>
            <Button type="submit" disabled={saveDisabled} aria-busy={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
        <ConfirmDialog
          open={discardOpen}
          onClose={() => {
            if (leaving) blocker.reset?.();
            setConfirmDiscard(false);
          }}
          title="放弃未保存的更改？"
          description={
            pending
              ? '正在保存，请等待请求完成。'
              : leaving
                ? '离开后这次修改的标题会丢失。'
                : '关闭后这次修改的标题会丢失。'
          }
          confirmLabel={leaving ? '放弃并离开' : '放弃并关闭'}
          confirmDisabled={pending}
          onConfirm={async () => {
            if (pending) return;
            if (leaving) {
              dialog.finish(() => {
                onClosed();
                blocker.proceed();
              });
            } else onClose();
          }}
        />
      </DialogShell>
    </Dialog>
  );
}
