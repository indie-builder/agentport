import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { Toast, ToastClose, ToastDescription, ToastRegion, ToastTitle } from '@ui-sdk/react/toast';
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
            <Toast className="not-first:mt-2 flex w-88 items-start gap-2.5 rounded-[var(--radius-card)] border border-line bg-surface p-4 text-fg shadow-overlay focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2">
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
