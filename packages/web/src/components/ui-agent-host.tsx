import { createConfirm } from '@ui-sdk/react/alert-dialog';
import { useEffect, useState } from 'react';
import { registerTools, setUiAgentConfirmHandler, uiAgent } from '../lib/ui-agent.js';
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

export function UiAgentHost() {
  const [confirm] = useState(() => createConfirm<string>());

  useEffect(() => {
    let mounted = true;
    let queue = Promise.resolve();
    const clearHandler = setUiAgentConfirmHandler((message, signal) => {
      if (!mounted || signal.aborted) {
        return Promise.resolve(false);
      }
      let cancelWait: (() => void) | undefined;
      const waitAborted = new Promise<false>((resolve) => {
        const onAbort = () => resolve(false);
        signal.addEventListener('abort', onAbort, { once: true });
        cancelWait = () => signal.removeEventListener('abort', onAbort);
      });
      const run = queue.then(async () => {
        cancelWait?.();
        if (!mounted || signal.aborted) {
          return false;
        }
        const onAbort = () => {
          confirm.controller.close();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          return await confirm(message);
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      });
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return Promise.race([run, waitAborted]);
    });

    const unregister = registerTools(uiAgent, { allow: () => true });

    return () => {
      mounted = false;
      unregister();
      clearHandler();
      confirm.controller.close();
    };
  }, [confirm]);

  return (
    <AlertDialog controller={confirm.controller}>
      <AlertDialogBackdrop />
      <AlertDialogContent<string> data-agent-hidden>
        {(state) => (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>确认智能体操作</AlertDialogTitle>
              <AlertDialogDescription>{state.payload ?? ''}</AlertDialogDescription>
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
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
