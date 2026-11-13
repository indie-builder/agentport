import { createFileRoute } from '@tanstack/react-router';
import { ChannelsPage } from '../../pages/channels/index.js';
import { channelsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/channels/')({
  validateSearch: channelsSearchSchema,
  component: ChannelsPage,
});
