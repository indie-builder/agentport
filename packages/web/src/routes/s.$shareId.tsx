import { createFileRoute } from '@tanstack/react-router';
import { PublicSharePage } from '../pages/public-share.js';

export const Route = createFileRoute('/s/$shareId')({
  component: PublicSharePage,
});
