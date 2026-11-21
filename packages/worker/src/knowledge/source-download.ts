import { errorText } from '@agentport/shared';
import {
  fetchChecked,
  readBytesCapped,
  redactUrls,
  SourceAuthError,
  safeDownloadHeaders,
  sourceNetworkOptions,
  validateSourceUrl,
} from './source-http.js';
import type { SourceConfig } from './source-types.js';
import { isAbort, signalOption } from './source-utils.js';

export async function fetchDownload(
  config: SourceConfig,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<{ bytes: Buffer; contentType: string | null }> {
  try {
    const target = await validateSourceUrl(url, sourceNetworkOptions(config));
    const response = await fetchChecked(target.href, {
      headers: safeDownloadHeaders(headers),
      authOrigin: target.origin,
      authFailure: 'item',
      ...sourceNetworkOptions(config),
      ...signalOption(signal),
    });
    return {
      bytes: await readBytesCapped(response, label),
      contentType: response.headers.get('content-type'),
    };
  } catch (err) {
    if (err instanceof SourceAuthError || isAbort(err, signal)) throw err;
    throw new Error(redactUrls(errorText(err)));
  }
}
