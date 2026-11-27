import { useState } from 'react';

export interface DraftCallbacks {
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  onPendingChange?: ((pending: boolean) => void) | undefined;
}

export function useSwitchGuard<T>(
  dirty: boolean,
  pending: boolean,
  onApply: (action: T) => unknown,
) {
  const [pendingAction, setPendingAction] = useState<T | null>(null);

  const request = (action: T, forceConfirm = false): void => {
    if (pending) return;
    if (dirty || forceConfirm) setPendingAction(action);
    else void onApply(action);
  };

  const cancel = (): void => {
    if (!pending) setPendingAction(null);
  };

  const confirm = async (): Promise<void> => {
    if (pending || pendingAction === null) return;
    const action = pendingAction;
    await onApply(action);
    setPendingAction(null);
  };

  return { pendingAction, request, cancel, confirm };
}
