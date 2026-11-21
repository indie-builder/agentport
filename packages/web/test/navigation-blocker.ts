import {
  type AnyRoute,
  type createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';

type BrowserHistory = ReturnType<typeof createBrowserHistory>;

export function captureBlockedNavigations(history: BrowserHistory): Array<Promise<boolean>> {
  const promises: Array<Promise<boolean>> = [];
  const block = history.block.bind(history);
  history.block = (blocker) =>
    block({
      ...blocker,
      blockerFn: (args) => {
        const pending = blocker.blockerFn(args);
        promises.push(pending);
        return pending;
      },
    });
  return promises;
}

export function routerFor(history: BrowserHistory, children: (shell: AnyRoute) => AnyRoute[]) {
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => rootRoute, id: '_shell', component: Outlet });
  return createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren(children(shell))]),
    history,
  });
}

export async function settled(
  promise: Promise<boolean>,
  timeoutMs = 100,
): Promise<boolean | 'timeout'> {
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ]);
}
