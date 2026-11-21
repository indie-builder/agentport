import { fail, readCappedText as readCoreCappedText } from '@agentport/core';

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

export function readCappedText(response: Response, tooLargeMessage: string): Promise<string> {
  return readCoreCappedText(response, MAX_RESPONSE_BYTES, 'market', {
    onExceeded: () => fail('INVALID_INPUT', tooLargeMessage),
    checkContentLength: false,
  });
}
