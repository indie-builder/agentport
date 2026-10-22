import { QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { LucideProvider } from 'lucide-react';
import { Toaster } from 'sonner';
import { z } from 'zod';
import { AppShell } from './components/app-shell.js';
import { queryClient } from './lib/queries.js';

// 按路由拆包：首屏只加载外壳与登录页，其余页面点进来再取。
const AgentsPage = lazyRouteComponent(() => import('./pages/agents.js'), 'AgentsPage');
const AuditPage = lazyRouteComponent(() => import('./pages/audit.js'), 'AuditPage');
const ChatPage = lazyRouteComponent(() => import('./pages/chat.js'), 'ChatPage');
const EvalPage = lazyRouteComponent(() => import('./pages/eval.js'), 'EvalPage');
const LoginPage = lazyRouteComponent(() => import('./pages/login.js'), 'LoginPage');
const NotFoundPage = lazyRouteComponent(() => import('./pages/not-found.js'), 'NotFoundPage');
const OverviewPage = lazyRouteComponent(() => import('./pages/overview.js'), 'OverviewPage');
const RunDetailPage = lazyRouteComponent(() => import('./pages/run-detail.js'), 'RunDetailPage');
const RunsPage = lazyRouteComponent(() => import('./pages/runs.js'), 'RunsPage');
const ServersPage = lazyRouteComponent(() => import('./pages/servers.js'), 'ServersPage');
const SkillsPage = lazyRouteComponent(() => import('./pages/skills.js'), 'SkillsPage');
const StatusPage = lazyRouteComponent(() => import('./pages/status.js'), 'StatusPage');

const rootRoute = createRootRoute({ component: Outlet });

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: OverviewPage,
});

const resourceSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  sort: z.enum(['newest', 'name']).optional().catch(undefined),
});

const serversRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/servers',
  validateSearch: resourceSearchSchema.extend({
    kind: z.enum(['stdio', 'http', 'generated']).optional().catch(undefined),
  }),
  component: ServersPage,
});

const agentsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/agents',
  validateSearch: resourceSearchSchema.extend({
    status: z.enum(['enabled', 'disabled']).optional().catch(undefined),
  }),
  component: AgentsPage,
});

const skillsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/skills',
  validateSearch: resourceSearchSchema.extend({
    usage: z.enum(['bound', 'unbound']).optional().catch(undefined),
  }),
  component: SkillsPage,
});

const chatRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/chat',
  validateSearch: z.object({
    agent: z.string().min(1).optional().catch(undefined),
    conversation: z.string().min(1).optional().catch(undefined),
  }),
  component: ChatPage,
});

const auditSearchSchema = z.object({
  action: z.string().optional().catch(undefined),
  status: z.enum(['ok', 'error', 'denied']).optional().catch(undefined),
  target: z.string().optional().catch(undefined),
});

const auditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/audit',
  validateSearch: auditSearchSchema,
  component: AuditPage,
});

const runsSearchSchema = z.object({
  agent: z.string().optional().catch(undefined),
  status: z
    .enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'])
    .optional()
    .catch(undefined),
});

const runsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/runs',
  validateSearch: runsSearchSchema,
  component: RunsPage,
});

const runDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/runs/$runId',
  validateSearch: z.object({
    step: z.coerce.number().int().nonnegative().optional().catch(undefined),
  }),
  component: RunDetailPage,
});

const evalSearchSchema = z.object({
  agent: z.string().optional().catch(undefined),
});

const evalRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/eval',
  validateSearch: evalSearchSchema,
  component: EvalPage,
});

const statusRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/status',
  component: StatusPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const notFoundRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '$',
  component: NotFoundPage,
});

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    indexRoute,
    serversRoute,
    agentsRoute,
    skillsRoute,
    chatRoute,
    auditRoute,
    runsRoute,
    runDetailRoute,
    evalRoute,
    statusRoute,
    notFoundRoute,
  ]),
  loginRoute,
]);

const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

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
