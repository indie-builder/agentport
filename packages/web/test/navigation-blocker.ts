import {
  type AnyRoute,
  type createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';

type BrowserHistory = ReturnType<typeof createBrowserHistory>;

/**
 * 记录每次真实 history.block 调用产生的拦截 Promise。
 * 测试用它判断被 POP 拦下的导航最终是否结算，而不是断言某个 reset 函数被调用。
 */
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

/** 等 Promise 结算；未结算返回 'timeout'，避免测试挂到全局超时。 */
export async function settled(
  promise: Promise<boolean>,
  timeoutMs = 100,
): Promise<boolean | 'timeout'> {
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ]);
}
