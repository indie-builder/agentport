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
              // shadow-overlay! 会覆盖 Sonner 的 :focus-visible 阴影，焦点改由单层中性 outline 表达。
              toast:
                'border-line! bg-surface! text-fg! shadow-overlay! focus-visible:outline-2! focus-visible:outline-ring! focus-visible:outline-offset-2!',
              description: 'text-muted-foreground!',
              // Sonner 的 [data-button] 规则特异性高于 Tailwind，important 仅用于让操作按钮保持中性 outline。
              actionButton: buttonVariants({
                variant: 'outline',
                className:
                  // 按钮基类的 outline-none 会把 --tw-outline-style 置为 none，outline-solid! 才能让焦点轮廓真正可见；
                  // ring-0!/shadow-none! 同时压掉基类 ring-2 与 Sonner 的 focus box-shadow，焦点只留单层 outline。
                  'border! border-solid! border-line! bg-surface! text-fg! hover:bg-hover! active:bg-hover! focus-visible:outline-2! focus-visible:outline-solid! focus-visible:outline-ring! focus-visible:outline-offset-2! focus-visible:ring-0! focus-visible:shadow-none!',
              }),
              closeButton:
                'bg-surface border-line text-muted-foreground hover:text-fg focus-visible:outline-2! focus-visible:outline-ring! focus-visible:outline-offset-2! focus-visible:shadow-none!',
            },
          }}
        />
      </QueryClientProvider>
    </LucideProvider>
  );
}
