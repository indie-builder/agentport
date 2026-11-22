import { ONE_SHOT_NO_RESULT_MESSAGE, type OneShotSdkOutcome } from '../one-shot-sdk.js';
import { KnowledgeCancelled } from './ingestion.js';

export function requireOneShotSuccess(outcome: OneShotSdkOutcome): void {
  if (outcome.status === 'aborted') throw new KnowledgeCancelled();
  if (outcome.status === 'no_result') throw new Error(ONE_SHOT_NO_RESULT_MESSAGE);
  if (outcome.status === 'failure') throw new Error(outcome.message);
}
