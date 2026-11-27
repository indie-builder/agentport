import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastRegion,
  ToastTitle,
} from '@ui-sdk/react/toast';
import { CircleAlert, CircleCheck, Info, LucideProvider, TriangleAlert, X } from 'lucide-react';
import { queryClient } from './lib/queries.js';
import { toaster } from './lib/toast.js';
import { router } from './router.js';

export function App() {
  return (
    <LucideProvider strokeWidth={1.75} size={16}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <ToastRegion toaster={toaster} side="bottom" align="end" aria-label="通知" className="p-6">
          {() => (
            <Toast className="not-first:mt-2 flex w-88 select-none items-start gap-2.5 rounded-[var(--radius-card)] border border-line bg-surface p-4 text-fg shadow-overlay [--toast-tx:0px] [--toast-ty:0px] [translate:calc(var(--toast-swipe-x,0px)+var(--toast-tx))_calc(var(--toast-swipe-y,0px)+var(--toast-ty))] transition-[opacity,translate] duration-200 ease-out-soft focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2 data-starting-style:opacity-0 data-starting-style:[--toast-ty:12px] data-ending-style:opacity-0 data-ending-style:[--toast-ty:8px] data-ending-style:duration-150 data-[swipe-direction=right]:data-ending-style:[--toast-tx:100%] data-[swipe-direction=left]:data-ending-style:[--toast-tx:-100%] data-[swipe-direction=down]:data-ending-style:[--toast-ty:100%] data-[swipe-direction=up]:data-ending-style:[--toast-ty:-100%] data-swiping:transition-none motion-reduce:transition-none">
              {(state) => (
                <>
                  {state.type === 'success' && (
                    <CircleCheck
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-success"
                    />
                  )}
                  {state.type === 'info' && (
                    <Info
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                  )}
                  {state.type === 'warning' && (
                    <TriangleAlert
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-warning"
                    />
                  )}
                  {state.type === 'error' && (
                    <CircleAlert
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-danger"
                    />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <ToastTitle className="text-sm font-medium" />
                    <ToastDescription className="text-sm text-muted-foreground" />
                  </div>
                  <ToastAction className="inline-flex shrink-0 items-center border border-line bg-surface rounded-[var(--radius-tag)] px-2 py-1 text-sm font-medium text-fg outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2 disabled:opacity-50" />
                  <ToastClose
                    aria-label="关闭"
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-tag)] text-muted-foreground outline-none hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2"
                  >
                    <X aria-hidden="true" className="size-4" />
                  </ToastClose>
                </>
              )}
            </Toast>
          )}
        </ToastRegion>
      </QueryClientProvider>
    </LucideProvider>
  );
}
