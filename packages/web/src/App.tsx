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
              // Sonner 自带的 [data-sonner-toast][data-styled] 规则特异性更高，只保留中性外观所需的覆盖。
              toast:
                'rounded-[var(--radius-card)]! border-line! bg-surface! text-fg! shadow-content-overlay! focus-visible:border-ring! focus-visible:outline-none!',
              description: 'text-muted-foreground!',
              actionButton: buttonVariants({
                variant: 'outline',
                className:
                  'border! border-solid! border-line! bg-surface! text-fg! hover:bg-hover! active:bg-hover! focus-visible:border-ring! focus-visible:outline-none! focus-visible:ring-0! focus-visible:shadow-none!',
              }),
              closeButton:
                'bg-surface! border-line! text-muted-foreground! hover:bg-hover! hover:text-fg! focus-visible:border-ring! focus-visible:outline-none! focus-visible:shadow-none!',
            },
          }}
        />
      </QueryClientProvider>
    </LucideProvider>
  );
}
