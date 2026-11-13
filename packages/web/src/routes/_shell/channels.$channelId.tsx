import { createFileRoute } from '@tanstack/react-router';
import { ChannelPage } from '../../pages/channels/channel.js';

function ChannelRoute() {
  const { channelId } = Route.useParams();
  return <ChannelPage channelId={channelId} />;
}

export const Route = createFileRoute('/_shell/channels/$channelId')({
  component: ChannelRoute,
});
