import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  type ConfirmRequest,
  registerTools,
  setUiAgentConfirmHandler,
  uiAgent,
} from '../lib/ui-agent.js';
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
import { buttonVariants } from './ui/button.js';

interface PendingConfirm extends ConfirmRequest {
  id: number;
  signal: AbortSignal;
  cleanupAbort: () => void;
}

function rejectQueued(queue: PendingConfirm[], count?: number): void {
  const removed = count === undefined ? queue.splice(0) : queue.splice(0, count);
  removed.forEach((item) => {
    item.resolve(false);
  });
}

export function UiAgentHost() {
  const nextIdRef = useRef(0);
  const activeRef = useRef<PendingConfirm | null>(null);
  const currentRef = useRef<PendingConfirm | null>(null);
  const queueRef = useRef<PendingConfirm[]>([]);
  const renderedOpenRef = useRef(false);
  const [current, setCurrent] = useState<PendingConfirm | null>(null);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    renderedOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    const clearHandler = setUiAgentConfirmHandler((message, signal) => {
      if (signal.aborted) {
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolvePromise) => {
        let settled = false;
        const id = ++nextIdRef.current;
        const cleanupAbort = () => signal.removeEventListener('abort', onAbort);
        const resolve = (allowed: boolean) => {
          if (settled) return;
          settled = true;
          cleanupAbort();
          resolvePromise(allowed);
        };
        const entry: PendingConfirm = {
          id,
          message,
          signal,
          resolve,
          cleanupAbort,
        };
        function onAbort() {
          resolve(false);
          if (activeRef.current?.id === id) {
            activeRef.current = null;
            setOpen(false);
            if (!renderedOpenRef.current) {
              currentRef.current = null;
              setCurrent(null);
            }
            return;
          }
          const index = queueRef.current.findIndex((item) => item.id === id);
          if (index !== -1) {
            queueRef.current.splice(index, 1);
          }
        }
        signal.addEventListener('abort', onAbort, { once: true });

        if (activeRef.current === null && currentRef.current === null) {
          activeRef.current = entry;
          currentRef.current = entry;
          setCurrent(entry);
          setOpen(true);
          return;
        }
        queueRef.current.push(entry);
      });
    });

    const unregister = registerTools(uiAgent, { allow: () => true });

    return () => {
      unregister();
      clearHandler();
      activeRef.current?.resolve(false);
      activeRef.current = null;
      currentRef.current = null;
      rejectQueued(queueRef.current);
      setOpen(false);
      setCurrent(null);
    };
  }, []);

  useEffect(() => {
    if (open || current !== null || activeRef.current !== null) {
      return;
    }
    const index = queueRef.current.findIndex((item) => !item.signal.aborted);
    if (index === -1) {
      rejectQueued(queueRef.current);
      return;
    }
    rejectQueued(queueRef.current, index);
    const [next] = queueRef.current.splice(0, 1);
    if (!next) return;
    activeRef.current = next;
    currentRef.current = next;
    setCurrent(next);
    setOpen(true);
  }, [open, current]);

  const settleActive = (allowed: boolean): void => {
    const active = activeRef.current;
    activeRef.current = null;
    setOpen(false);
    if (!renderedOpenRef.current) {
      currentRef.current = null;
      setCurrent(null);
    }
    active?.resolve(allowed);
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next, details) => {
        if (!next) {
          settleActive(details.returnValue === 'confirm');
        }
      }}
      onOpenChangeComplete={(next) => {
        if (!next && activeRef.current === null) {
          currentRef.current = null;
          setCurrent(null);
        }
      }}
    >
      <AlertDialogBackdrop />
      <AlertDialogContent data-agent-hidden>
        <AlertDialogHeader>
          <AlertDialogTitle>确认智能体操作</AlertDialogTitle>
          <AlertDialogDescription>{current?.message ?? ''}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            className={buttonVariants({ variant: 'ghost' })}
            data-variant="ghost"
            data-size="default"
          >
            拒绝
          </AlertDialogClose>
          <AlertDialogClose
            value="confirm"
            className={buttonVariants()}
            data-variant="default"
            data-size="default"
          >
            允许执行
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
