import { toast } from 'sonner';
import { errorMessage } from './api.js';

// loading → success/error 共用同一个 toast id，避免连续操作刷屏。
export function toastPending(message: string): string | number {
  return toast.loading(message);
}

export function toastDone(id: string | number, message: string): void {
  toast.success(message, { id });
}

export function toastFailed(id: string | number, error: unknown): void {
  toast.error(errorMessage(error), { id });
}

export function toastError(error: unknown): void {
  toast.error(errorMessage(error));
}

export function toastSuccess(message: string): void {
  toast.success(message);
}
