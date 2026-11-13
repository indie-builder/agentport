import { createFileRoute } from '@tanstack/react-router';
import { ChatPage } from '../../pages/chat/index.js';
import { chatSearchSchema } from '../-search.js';

export const Route = createFileRoute('/_shell/chat')({
  validateSearch: chatSearchSchema,
  component: ChatPage,
});
