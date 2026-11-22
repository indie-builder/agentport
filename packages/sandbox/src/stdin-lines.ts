export function createStdinLines(): {
  next(): Promise<string | null>;
  close(): void;
} {
  const reader = Bun.stdin.stream().getReader();
  process.stdin.unref?.();
  const decoder = new TextDecoder();
  const queue: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let buffer = '';
  let closed = false;

  const deliver = (line: string): void => {
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(line);
    else waiter(line);
  };
  const end = (): void => {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  };

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
          deliver(buffer.slice(0, index).replace(/\r$/, ''));
          buffer = buffer.slice(index + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer.length > 0) deliver(buffer.replace(/\r$/, ''));
    } finally {
      end();
    }
  })().catch(() => undefined);

  return {
    next() {
      const line = queue.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      queue.length = 0;
      end();
    },
  };
}
