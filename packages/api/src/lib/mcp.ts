import type { CallToolResult } from '@modelcontextprotocol/server';

export function toolError(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
}
