import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { LoginPage } from '../pages/login.js';

const loginSearchSchema = z.object({
  returnTo: z.string().optional().catch(undefined),
  reason: z.enum(['expired']).optional().catch(undefined),
});

export const Route = createFileRoute('/login')({
  validateSearch: loginSearchSchema,
  component: LoginPage,
});
