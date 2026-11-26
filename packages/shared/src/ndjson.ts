import { SUPERVISOR_INPUT_MAX_BYTES } from './sandbox-session.js';
import { utf8Bytes } from './utf8.js';

export interface NdjsonReaderOptions {
  maxBytes?: number;
  onLine: (line: string) => void;
  onOversize?: (maxBytes: number) => void;
}

export interface NdjsonReader {
  push(chunk: string): void;
  flush(): void;
}

export function createNdjsonReader(options: NdjsonReaderOptions): NdjsonReader {
  const maxBytes = options.maxBytes ?? SUPERVISOR_INPUT_MAX_BYTES;
  let pending = '';
  let pendingBytes = 0;
  let discarding = false;

  const emit = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length > 0) options.onLine(trimmed);
  };

  const overflow = (): void => {
    discarding = true;
    pending = '';
    pendingBytes = 0;
    options.onOversize?.(maxBytes);
  };

  const push = (chunk: string): void => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start);
      if (newline === -1) {
        if (!discarding) {
          const piece = chunk.slice(start);
          const nextBytes = pendingBytes + utf8Bytes(piece);
          if (nextBytes > maxBytes) {
            overflow();
          } else {
            pending += piece;
            pendingBytes = nextBytes;
          }
        }
        return;
      }
      const piece = chunk.slice(start, newline);
      start = newline + 1;
      if (discarding) {
        discarding = false;
        pending = '';
        pendingBytes = 0;
        continue;
      }
      const totalBytes = pendingBytes + utf8Bytes(piece);
      const line = pending + piece;
      pending = '';
      pendingBytes = 0;
      if (totalBytes > maxBytes) {
        options.onOversize?.(maxBytes);
        continue;
      }
      emit(line);
    }
  };

  const flush = (): void => {
    if (discarding) {
      discarding = false;
      pending = '';
      pendingBytes = 0;
      return;
    }
    if (pending.length === 0) return;
    const line = pending;
    pending = '';
    pendingBytes = 0;
    emit(line);
  };

  return { push, flush };
}
