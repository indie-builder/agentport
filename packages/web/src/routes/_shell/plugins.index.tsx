import { createFileRoute } from '@tanstack/react-router';
import { PluginsPage } from '../../pages/plugins/index.js';
import { pluginsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/plugins/')({
  validateSearch: pluginsSearchSchema,
  component: PluginsPage,
});
