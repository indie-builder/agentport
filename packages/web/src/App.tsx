import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { LucideProvider } from 'lucide-react';
import { Toaster } from 'sonner';
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
              actionButton: 'bg-ink text-white',
              closeButton: 'bg-surface border-line text-muted-foreground hover:text-fg',
            },
          }}
        />
      </QueryClientProvider>
    </LucideProvider>
  );
}
