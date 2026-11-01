import { createFileRoute } from '@tanstack/react-router';
import { ChannelsPage } from '../../pages/channels.js';

export const Route = createFileRoute('/_shell/channels/')({
  component: ChannelsPage,
});
