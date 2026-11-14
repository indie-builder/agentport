import { useCallback, useRef, useState } from 'react';

type DialogCloseDetails = { cancel: () => void };

export function useDialogClose(onClose: () => void, open = true) {
  const [closing, setClosing] = useState(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const close = useCallback(() => setClosing(true), []);
  const finish = useCallback((action: () => void) => {
    afterClose.current = action;
    setClosing(true);
  }, []);
  if (!open && closing) setClosing(false);
  return {
    open: open && !closing,
    close,
    finish,
    onOpenChangeComplete: (next: boolean) => {
      if (next || !closing) return;
      const action = afterClose.current;
      afterClose.current = undefined;
      if (action) action();
      else onClose();
    },
  };
}

export function guardedOpenChange(
  pending: boolean,
  close: () => void,
): (next: boolean, details: DialogCloseDetails) => void {
  return (next, details) => {
    if (pending) {
      details.cancel();
      return;
    }
    if (!next) close();
  };
}
