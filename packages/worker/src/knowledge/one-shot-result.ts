import type { OneShotSdkOutcome } from '../one-shot-sdk.js';
import { KnowledgeCancelled } from './ingestion.js';

export function requireOneShotSuccess(outcome: OneShotSdkOutcome): void {
  if (outcome.status === 'aborted') throw new KnowledgeCancelled();
  if (outcome.status === 'no_result') throw new Error('SDK 没有返回结果');
  if (outcome.status === 'failure') throw new Error(outcome.message);
}
