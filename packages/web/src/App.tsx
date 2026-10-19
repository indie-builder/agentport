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
import { ChatPage } from './pages/chat.js';
import { LoginPage } from './pages/login.js';
import { OverviewPage } from './pages/overview.js';
import { ServersPage } from './pages/servers.js';

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

const chatRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/chat',
  component: ChatPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([indexRoute, serversRoute, agentsRoute, chatRoute]),
  loginRoute,
]);

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster theme="dark" position="bottom-right" />
    </QueryClientProvider>
  );
}
