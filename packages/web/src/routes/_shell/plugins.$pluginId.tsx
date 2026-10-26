import { noop } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { pluginQuery, queryClient } from '../../lib/queries.js';
import { PluginDetailPage } from '../../pages/plugin-detail.js';
import { pluginDetailSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/plugins/$pluginId')({
  validateSearch: pluginDetailSearchSchema,
  loader: async ({ params }) => {
    // Prefetch through the shared cache and keep failures owned by the page's query state.
    await queryClient.query({ ...pluginQuery(params.pluginId), staleTime: 'static' }).catch(noop);
  },
  component: PluginDetailPage,
});
