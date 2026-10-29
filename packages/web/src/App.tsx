import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { LucideProvider } from 'lucide-react';
import { Toaster } from 'sonner';
import { buttonVariants } from './components/ui/button.js';
import { queryClient } from './lib/queries.js';
import { router } from './router.js';

export function App() {
  return (
    <LucideProvider strokeWidth={1.75} size={16}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster
          theme="light"
          position="bottom-right"
          closeButton
          toastOptions={{
            duration: 4000,
            classNames: {
              toast: 'border border-line bg-surface text-fg',
              description: 'text-muted-foreground',
              // Sonner 的 [data-button] 规则特异性高于 Tailwind，important 仅用于这条 toast 操作按钮覆盖
              actionButton: buttonVariants({
                className:
                  'bg-background! text-primary! border! border-solid! border-primary! hover:bg-selected! active:bg-selected! active:border-primary-hover! active:text-primary-hover! focus-visible:border-transparent!',
              }),
              closeButton: 'bg-surface border-line text-muted-foreground hover:text-fg',
            },
          }}
        />
      </QueryClientProvider>
    </LucideProvider>
  );
}
