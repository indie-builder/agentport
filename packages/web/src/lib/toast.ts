import { createToaster } from '@ui-sdk/react/toast';
import { describeError } from './api.js';

export const toast = createToaster({ duration: 4000 });

function errorToastPayload(error: unknown) {
  const { message, requestId } = describeError(error);
  return {
    title: message,
    duration: Number.POSITIVE_INFINITY,
    ...(requestId ? { description: `请求 ID: ${requestId}` } : {}),
  };
}

export function toastError(error: unknown): void {
  const { title, ...options } = errorToastPayload(error);
  toast.error(title, options);
}

export function toastSuccess(message: string): void {
  toast.success(message);
}

export function toastPromise<Value>(
  promise: Promise<Value> | (() => Promise<Value>),
  messages: Parameters<typeof toast.promise<Value>>[1],
  options?: Parameters<typeof toast.promise<Value>>[2],
): Promise<Value> {
  let running: Promise<Value>;
  try {
    running = typeof promise === 'function' ? promise() : promise;
  } catch (error) {
    running = Promise.reject(error);
  }
  toast.promise(
    running,
    {
      ...messages,
      error: messages.error ?? errorToastPayload,
    },
    options,
  );
  return running;
}
