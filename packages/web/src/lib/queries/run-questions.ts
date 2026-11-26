import type { PublicRunQuestion } from '@agentport/shared';
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

export function useRefetchWhenRunEnds(identity: string, active: boolean, queryKey: QueryKey): void {
  const client = useQueryClient();
  const previous = useRef({ identity, active });
  useEffect(() => {
    const wasActive = previous.current.identity === identity && previous.current.active;
    previous.current = { identity, active };
    if (!identity || active || !wasActive) return;
    void client.cancelQueries({ queryKey }).then(() => client.invalidateQueries({ queryKey }));
  }, [identity, active, client, queryKey]);
}

function mergeRunQuestion(
  previous: PublicRunQuestion,
  incoming: PublicRunQuestion,
): PublicRunQuestion {
  return previous.status !== 'pending' && incoming.status === 'pending' ? previous : incoming;
}

export function withRunQuestion(
  items: PublicRunQuestion[] | undefined,
  question: PublicRunQuestion,
): PublicRunQuestion[] {
  if (items === undefined) return [question];
  const index = items.findIndex((item) => item.requestId === question.requestId);
  if (index < 0) return [...items, question];
  const current = items[index];
  return current === undefined ? items : items.with(index, mergeRunQuestion(current, question));
}

export function mergeRunQuestions(
  previous: PublicRunQuestion[] | undefined,
  incoming: PublicRunQuestion[],
): PublicRunQuestion[] {
  const merged = [...incoming];
  for (const item of previous ?? []) {
    const index = merged.findIndex((question) => question.requestId === item.requestId);
    if (index < 0) merged.push(item);
    else {
      const current = merged[index];
      if (current !== undefined) merged[index] = mergeRunQuestion(item, current);
    }
  }
  return merged;
}
