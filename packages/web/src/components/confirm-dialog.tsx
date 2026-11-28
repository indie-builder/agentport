import { AlertTriangle } from 'lucide-react';
import { type ComponentProps, type ReactNode, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { useDialogClose } from '../lib/dialog-guard.js';
import { toastError } from '../lib/toast.js';
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog.js';
import { Button, buttonVariants } from './ui/button.js';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  children?: ReactNode;
  confirmDisabled?: boolean;
  tone?: 'danger' | 'default';
  onConfirm: () => Promise<unknown>;
  onError?: (error: unknown) => void;
  onCancel?: () => void;
  finalFocus?: ComponentProps<typeof AlertDialogContent>['finalFocus'];
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel = '删除',
  children,
  confirmDisabled = false,
  tone = 'danger',
  onConfirm,
  onError,
  onCancel,
  finalFocus,
}: ConfirmDialogProps) {
  const dialog = useDialogClose(onClose, open);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const confirm = async (): Promise<void> => {
    if (confirmDisabled || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await onConfirm();
      dialog.close();
    } catch (error) {
      if (onError) onError(error);
      else toastError(error);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <AlertDialog
      open={dialog.open}
      dismissible={!pending}
      onOpenChange={(next, details) => {
        if (pendingRef.current) {
          details.cancel();
          return;
        }
        if (!next) {
          onCancel?.();
          dialog.close();
        }
      }}
      onOpenChangeComplete={dialog.onOpenChangeComplete}
    >
      <AlertDialogBackdrop />
      <AlertDialogContent
        padding="none"
        gap="none"
        className="flex max-h-[80dvh] w-[calc(100%-2rem)] max-w-md flex-col overflow-hidden sm:max-w-md"
        {...(finalFocus === undefined ? {} : { finalFocus })}
      >
        <AlertDialogHeader bordered padding="md" className="shrink-0">
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <div className="flex gap-3">
            <div
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-full',
                tone === 'default'
                  ? 'bg-sunken text-muted-foreground'
                  : 'bg-danger-soft text-danger',
              )}
            >
              <AlertTriangle className="size-5" aria-hidden="true" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
              <AlertDialogDescription leading="relaxed">{description}</AlertDialogDescription>
              {children}
            </div>
          </div>
          <AlertDialogFooter className="mt-5">
            <AlertDialogClose
              disabled={pending}
              data-disabled={pending ? '' : undefined}
              className={buttonVariants({ variant: 'ghost' })}
              data-variant="ghost"
              data-size="default"
            >
              取消
            </AlertDialogClose>
            <Button
              variant={tone === 'default' ? 'default' : 'destructive'}
              disabled={pending || confirmDisabled}
              aria-busy={pending}
              {...(!pending && !confirmLabel.startsWith('确认')
                ? { 'aria-label': `确认${confirmLabel}` }
                : {})}
              data-agent-confirm={description}
              onClick={() => void confirm()}
            >
              {pending ? '处理中…' : confirmLabel}
            </Button>
          </AlertDialogFooter>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
