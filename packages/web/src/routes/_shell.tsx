import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '../components/app-shell.js';

export const Route = createFileRoute('/_shell')({
  component: AppShell,
});
