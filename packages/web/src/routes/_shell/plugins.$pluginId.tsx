import { noop } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { pluginQuery, queryClient } from '../../lib/queries.js';
import { PluginDetailPage } from '../../pages/plugins/plugin-detail.js';
import { pluginDetailSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/plugins/$pluginId')({
  validateSearch: pluginDetailSearchSchema,
  loader: async ({ params }) => {
    await queryClient.query({ ...pluginQuery(params.pluginId), staleTime: 'static' }).catch(noop);
  },
  component: PluginDetailPage,
});
