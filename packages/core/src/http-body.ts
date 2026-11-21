type CapOptions = {
  onExceeded?: () => never;
  checkContentLength?: boolean;
  truncate?: boolean;
  onTruncated?: () => void;
};

export async function readCappedBytes(
  response: Response,
  limit: number,
  label: string,
  options: CapOptions = {},
): Promise<Buffer> {
  const exceeded = (): never => {
    if (options.onExceeded) return options.onExceeded();
    throw new Error(`${label} response exceeds ${limit} bytes`);
  };
  if (options.checkContentLength !== false && options.truncate !== true) {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > limit) {
      await response.body?.cancel();
      return exceeded();
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    if (total + chunk.byteLength > limit) {
      if (options.truncate === true) {
        const room = limit - total;
        if (room > 0) chunks.push(chunk.subarray(0, room));
        total = limit;
        options.onTruncated?.();
        break;
      }
      return exceeded();
    }
    total += chunk.byteLength;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readCappedText(
  response: Response,
  limit: number,
  label: string,
  options: CapOptions = {},
): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(response, limit, label, options));
}
