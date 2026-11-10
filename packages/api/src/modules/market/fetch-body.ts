import { fail } from '@agentport/core';

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

export async function readCappedText(response: Response, tooLargeMessage: string): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail('INVALID_INPUT', tooLargeMessage);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
