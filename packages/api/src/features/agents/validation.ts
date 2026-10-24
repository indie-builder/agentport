import { unsupportedAllowedTool } from '@agentport/core';
import { z } from 'zod';

export const allowedToolsSchema = z.array(z.string()).superRefine((tools, ctx) => {
  const message = unsupportedAllowedTool(tools);
  if (message) ctx.addIssue({ code: 'custom', message });
});
