import { createFileRoute } from '@tanstack/react-router';
import { PluginDetailPage } from '../../pages/plugin-detail.js';
import { pluginDetailSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/plugins/$pluginId')({
  validateSearch: pluginDetailSearchSchema,
  component: PluginDetailPage,
});
