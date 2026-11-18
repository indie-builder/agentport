import { authenticatedFetch, responseApiError } from '../orpc.js';

export type ApiOutput<T extends (...args: never[]) => unknown> = Awaited<ReturnType<T>>;

export function clientOptions(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

export async function nativeRequest<T>(
  path: string,
  {
    method = 'GET',
    body,
    signal,
    responseType = 'json',
    onResponse,
  }: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal | undefined;
    responseType?: 'json' | 'blob' | 'text';
    onResponse?: (response: Response) => void;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['content-type'] =
      body instanceof Blob ? body.type || 'application/zip' : 'application/json';
  }
  const res = await authenticatedFetch(`/api${path}`, {
    method,
    ...(signal === undefined ? {} : { signal }),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body === undefined ? {} : { body: body instanceof Blob ? body : JSON.stringify(body) }),
  });
  if (!res.ok) throw await responseApiError(res);

  if (res.status === 204) return undefined as T;
  onResponse?.(res);
  if (responseType === 'text') return (await res.text()) as T;
  return (responseType === 'blob' ? await res.blob() : await res.json()) as T;
}
