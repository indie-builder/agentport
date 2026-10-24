import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '../pages/login.js';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});
