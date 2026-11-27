import { useCallback, useEffect, useRef, useState } from 'react';

type PendingValue<T> = {
  source: T;
  current: T;
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

export function useOptimisticValue<T>(
  value: T,
): [T, (next: T, action?: () => unknown) => void, () => void] {
  const [pending, setPending] = useState<PendingValue<T> | null>(null);
  const tokenRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  if (pending !== null && !Object.is(pending.source, value)) {
    setPending(null);
  }

  const reset = useCallback(() => {
    tokenRef.current += 1;
    clearTimer();
    setPending(null);
  }, [clearTimer]);

  const commit = useCallback(
    (next: T, action?: () => unknown) => {
      const token = ++tokenRef.current;
      clearTimer();
      if (Object.is(next, value)) {
        setPending(null);
        action?.();
        return;
      }
      setPending({ source: value, current: next });
      const settle = () => {
        if (tokenRef.current === token) {
          clearTimer();
          setPending(null);
        }
      };
      timerRef.current = setTimeout(settle, 0);
      const result = action?.();
      if (isPromiseLike(result)) {
        void Promise.resolve(result).finally(settle);
      }
    },
    [clearTimer, value],
  );

  const current = pending !== null && Object.is(pending.source, value) ? pending.current : value;
  return [current, commit, reset];
}
