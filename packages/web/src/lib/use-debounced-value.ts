import { useEffect, useState } from 'react';

/** 输入停顿 `delayMs` 后才返回新值；防抖期间沿用上一次的值，请求不会随每个字符发出。 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
