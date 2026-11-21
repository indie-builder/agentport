type CapOptions = { onExceeded?: () => never; checkContentLength?: boolean };

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
  if (options.checkContentLength !== false) {
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
    total += chunk.byteLength;
    if (total > limit) return exceeded();
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
