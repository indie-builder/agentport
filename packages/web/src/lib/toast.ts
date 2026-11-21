import { createToaster } from '@ui-sdk/react/toast';
import { describeError } from './api.js';

export const toaster = createToaster({ duration: 4000 });
export const toast = toaster;

export function toastError(error: unknown): void {
  const { message, requestId } = describeError(error);
  toast.error(message, {
    duration: Number.POSITIVE_INFINITY,
    ...(requestId ? { description: `请求 ID: ${requestId}` } : {}),
  });
}

export function toastSuccess(message: string): void {
  toast.success(message);
}
