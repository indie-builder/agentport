import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen.js';

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  // Let Query own freshness; Router's 30s preload cache would otherwise skip the loader.
  defaultPreloadStaleTime: 0,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
