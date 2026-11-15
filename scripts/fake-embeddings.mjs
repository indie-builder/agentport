import { createHash } from 'node:crypto';

const PORT = Number(process.env.FAKE_EMBEDDINGS_PORT ?? 4599);
const MODEL = 'local-deterministic';
const DIMENSIONS = 1024;

function embed(text) {
  let state = createHash('sha256').update(text).digest().readUInt32LE(0) || 1;
  const vector = [];
  let norm = 0;
  for (let index = 0; index < DIMENSIONS; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const value = (state / 0xffffffff) * 2 - 1;
    vector.push(value);
    norm += value * value;
  }
  const scale = 1 / Math.sqrt(norm);
  return vector.map((value) => value * scale);
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return Response.json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/embeddings') {
      return Response.json({ error: { message: 'not found' } }, { status: 404 });
    }
    const body = await request.json().catch(() => null);
    const input = body?.input;
    const inputs =
      typeof input === 'string'
        ? [input]
        : Array.isArray(input) && input.every((text) => typeof text === 'string')
          ? input
          : null;
    if (inputs === null) {
      return Response.json(
        { error: { message: 'input must be a string or an array of strings' } },
        { status: 400 },
      );
    }
    const tokens = inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
    return Response.json({
      object: 'list',
      model: typeof body?.model === 'string' ? body.model : MODEL,
      data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: embed(text) })),
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  },
});

console.log(`fake embeddings: http://127.0.0.1:${server.port}/v1`);
