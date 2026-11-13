import { useEffect } from 'react';

export function useEditStateNotify(
  dirty: boolean,
  pending: boolean,
  onDirtyChange?: (dirty: boolean) => void,
  onPendingChange?: (pending: boolean) => void,
): void {
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
}
