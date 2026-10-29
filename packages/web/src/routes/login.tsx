import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { LoginPage } from '../pages/login.js';

const loginSearchSchema = z.object({
  returnTo: z.string().optional().catch(undefined),
  // 只有会话失效的 401 跳转才带原因；首次登录没有失效文案。
  reason: z.enum(['expired']).optional().catch(undefined),
});

export const Route = createFileRoute('/login')({
  validateSearch: loginSearchSchema,
  component: LoginPage,
});
