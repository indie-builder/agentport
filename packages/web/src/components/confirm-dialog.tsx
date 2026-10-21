import { AlertTriangle } from 'lucide-react';
import type { ComponentProps } from 'react';
import { type ReactNode, useState } from 'react';
import { toastError } from '../lib/toast.js';
import { DialogShell } from './dialog-shell.js';
import { Button } from './ui/button.js';
import { Dialog, DialogDescription } from './ui/dialog.js';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  children?: ReactNode;
  confirmDisabled?: boolean;
  onConfirm: () => Promise<unknown>;
  finalFocus?: ComponentProps<typeof DialogShell>['finalFocus'];
}

/** 破坏性操作的统一二次确认；确认按钮在请求完成前保持 pending。 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel = '删除',
  children,
  confirmDisabled = false,
  onConfirm,
  finalFocus,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);

  const confirm = async (): Promise<void> => {
    setPending(true);
    try {
      await onConfirm();
      onClose();
    } catch (error) {
      toastError(error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) onClose();
      }}
    >
      <DialogShell
        title={title}
        className="max-w-md sm:max-w-md"
        closeDisabled={pending}
        finalFocus={finalFocus}
      >
        <div className="flex gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-item bg-danger-soft text-danger">
            <AlertTriangle className="size-4" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
            <DialogDescription className="leading-relaxed">{description}</DialogDescription>
            {children}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            aria-busy={pending}
            disabled={pending || confirmDisabled}
            onClick={() => void confirm()}
          >
            {pending ? '处理中…' : confirmLabel}
          </Button>
        </div>
      </DialogShell>
    </Dialog>
  );
}
