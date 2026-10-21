import { toast } from 'sonner';
import { errorMessage } from './api.js';

export function toastError(error: unknown): void {
  toast.error(errorMessage(error));
}

export function toastSuccess(message: string): void {
  toast.success(message);
}
