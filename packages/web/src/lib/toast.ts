import { createToaster } from '@ui-sdk/react/toast';
import { errorMessage } from './api.js';

export const toaster = createToaster({ duration: 4000 });
export const toast = toaster;

export function toastError(error: unknown): void {
  toast.error(errorMessage(error), { duration: Number.POSITIVE_INFINITY });
}

export function toastSuccess(message: string): void {
  toast.success(message);
}
