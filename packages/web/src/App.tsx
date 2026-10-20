import { QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { AppShell } from './components/app-shell.js';
import { queryClient } from './lib/queries.js';
import { AgentsPage } from './pages/agents.js';
import { AuditPage } from './pages/audit.js';
import { ChatPage } from './pages/chat.js';
import { EvalPage } from './pages/eval.js';
import { LoginPage } from './pages/login.js';
import { NotFoundPage } from './pages/not-found.js';
import { OverviewPage } from './pages/overview.js';
import { RunDetailPage } from './pages/run-detail.js';
import { RunsPage } from './pages/runs.js';
import { ServersPage } from './pages/servers.js';
import { SkillsPage } from './pages/skills.js';
import { StatusPage } from './pages/status.js';

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

const serversRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/servers',
  component: ServersPage,
});

const agentsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/agents',
  component: AgentsPage,
});

const skillsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/skills',
  component: SkillsPage,
});

const chatRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/chat',
  component: ChatPage,
});

const auditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/audit',
  component: AuditPage,
});

const runsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/runs',
  component: RunsPage,
});

const runDetailRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/runs/$runId',
  component: RunDetailPage,
});

const evalRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/eval',
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
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster
        theme="dark"
        position="bottom-right"
        closeButton
        toastOptions={{
          duration: 4000,
          classNames: {
            toast: 'border border-line bg-surface text-fg',
            description: 'text-muted',
            actionButton: 'bg-ink text-white',
            closeButton: 'bg-surface border-line text-muted hover:text-fg',
          },
        }}
      />
    </QueryClientProvider>
  );
}
