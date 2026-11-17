import { createFileRoute } from '@tanstack/react-router';
import { NotificationsPage } from '../../pages/notifications.js';
import { notificationsSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/notifications')({
  validateSearch: notificationsSearchSchema,
  component: NotificationsPage,
});
