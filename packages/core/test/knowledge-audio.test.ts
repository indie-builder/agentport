import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { inspectKnowledgeAudio } from '../src/knowledge-audio.js';

const read = (name: string): Promise<Uint8Array> =>
  readFile(new URL(`./fixtures/audio/${name}`, import.meta.url)).then(
    (buffer) => new Uint8Array(buffer),
  );

async function inspectFixture(
  name: string,
  mimeType: string,
  filename = name,
): Promise<Awaited<ReturnType<typeof inspectKnowledgeAudio>>> {
  return inspectKnowledgeAudio({ data: await read(name), filename, mimeType });
}

describe('inspectKnowledgeAudio formats', () => {
  it.each([
    ['tone.mp3', 'audio/mpeg', 'mp3', 'audio/mpeg'],
    ['tone.wav', 'audio/wav', 'wav', 'audio/wav'],
    ['tone.m4a', 'audio/mp4', 'm4a', 'audio/mp4'],
    ['tone.flac', 'audio/flac', 'flac', 'audio/flac'],
    ['tone.ogg', 'audio/ogg', 'ogg', 'audio/ogg'],
  ])('accepts %s and returns the canonical mime', async (name, mime, format, canonical) => {
    await expect(inspectFixture(name, mime)).resolves.toEqual({ format, mimeType: canonical });
  });

  it.each([
    ['tone.mp3', 'audio/mp3'],
    ['tone.wav', 'audio/x-wav'],
    ['tone.wav', 'audio/wave'],
    ['tone.m4a', 'audio/x-m4a'],
    ['tone.m4a', 'audio/m4a'],
    ['tone.flac', 'audio/x-flac'],
    ['tone.ogg', 'application/ogg'],
    ['tone.ogg', 'audio/ogg; codecs=opus'],
    ['tone.mp3', 'AUDIO/MPEG'],
  ])('accepts the declared mime alias %s as %s', async (name, mime) => {
    await expect(inspectFixture(name, mime)).resolves.not.toBeNull();
  });

  it('fills in a missing or generic mime from the actual bytes', async () => {
    await expect(inspectFixture('tone.m4a', '')).resolves.toMatchObject({ format: 'm4a' });
    await expect(inspectFixture('tone.flac', 'application/octet-stream')).resolves.toMatchObject({
      format: 'flac',
    });
  });

  it('accepts an uppercase suffix and a path-prefixed name', async () => {
    await expect(inspectFixture('tone.mp3', '', 'Meeting/Recording.MP3')).resolves.toMatchObject({
      format: 'mp3',
    });
  });

  it('returns null for ordinary non-audio files', async () => {
    await expect(inspectFixture('document.pdf', 'application/pdf')).resolves.toBeNull();
    await expect(inspectFixture('text.mp3', 'text/plain', 'notes.txt')).resolves.toBeNull();
  });

  it('returns null for an empty non-audio file', async () => {
    for (const [filename, mimeType] of [
      ['empty.txt', 'text/plain'],
      ['empty.md', 'text/markdown'],
      ['empty.pdf', 'application/pdf'],
      ['empty.bin', 'application/octet-stream'],
      ['empty', ''],
    ] as const) {
      await expect(
        inspectKnowledgeAudio({ data: new Uint8Array(), filename, mimeType }),
      ).resolves.toBeNull();
    }
  });

  it('returns null for plain text that merely starts with FORM', async () => {
    const data = new TextEncoder().encode('FORM is important\n');
    await expect(
      inspectKnowledgeAudio({ data, filename: 'notes.md', mimeType: 'text/markdown' }),
    ).resolves.toBeNull();
  });

  it('recognizes a header that is valid but whose payload is truncated', async () => {
    // 格式识别只证明容器头成立；截断的负载仍可能在转录端返回 400。
    await expect(inspectFixture('truncated.wav', 'audio/wav')).resolves.toMatchObject({
      format: 'wav',
    });
  });
});

describe('inspectKnowledgeAudio rejections', () => {
  it('rejects an empty file before detection', async () => {
    await expect(
      inspectKnowledgeAudio({
        data: new Uint8Array(),
        filename: 'empty.mp3',
        mimeType: 'audio/mpeg',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects an empty file that only declares audio by mime or suffix', async () => {
    for (const [filename, mimeType] of [
      ['empty.wav', 'audio/wav'],
      ['empty.txt', 'audio/mpeg'],
      ['empty.ogg', ''],
      ['empty.opus', 'application/octet-stream'],
    ] as const) {
      await expect(
        inspectKnowledgeAudio({ data: new Uint8Array(), filename, mimeType }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('enforces the 25,000,000 byte boundary', async () => {
    const header = await read('tone.wav');
    const atLimit = new Uint8Array(25_000_000);
    atLimit.set(header);
    await expect(
      inspectKnowledgeAudio({ data: atLimit, filename: 'big.wav', mimeType: 'audio/wav' }),
    ).resolves.toMatchObject({ format: 'wav' });

    const overLimit = new Uint8Array(25_000_001);
    overLimit.set(header);
    await expect(
      inspectKnowledgeAudio({ data: overLimit, filename: 'big.wav', mimeType: 'audio/wav' }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('still applies the 25 MB limit to audio the caller did not declare', async () => {
    const padded = new Uint8Array(25_000_001);
    padded.set(await read('tone.mp3'));
    await expect(
      inspectKnowledgeAudio({ data: padded, filename: 'big.bin', mimeType: '' }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('leaves oversized non-audio files to the existing upload limit', async () => {
    const padded = new Uint8Array(30_000_000);
    padded.set(await read('document.pdf'));
    await expect(
      inspectKnowledgeAudio({ data: padded, filename: 'big.pdf', mimeType: 'application/pdf' }),
    ).resolves.toBeNull();
  });

  it('rejects bytes that claim to be audio but have no recognizable signature', async () => {
    await expect(inspectFixture('text.mp3', 'audio/mpeg')).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  });

  it('rejects unrecognized bytes when the suffix claims audio', async () => {
    await expect(inspectFixture('text.mp3', '', 'renamed.mp3')).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  });

  it('rejects a detected audio format outside the five supported ones', async () => {
    await expect(inspectFixture('tone.caf', 'audio/x-caf')).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  });

  it('still rejects a structurally valid AIFF or AIFC container', async () => {
    for (const type of ['AIFF', 'AIFC'] as const) {
      const data = Buffer.concat([
        Buffer.from('FORM'),
        Buffer.from([0, 0, 0, 4]),
        Buffer.from(type),
        Buffer.alloc(8),
      ]);
      await expect(
        inspectKnowledgeAudio({
          data: new Uint8Array(data),
          filename: 'clip.aiff',
          mimeType: 'audio/aiff',
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
  });

  it('rejects WAV bytes declared as text', async () => {
    await expect(inspectFixture('tone.wav', 'text/plain', 'notes.txt')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects real audio disguised as text or pdf', async () => {
    await expect(inspectFixture('tone.mp3', 'text/plain', 'notes.txt')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(inspectFixture('tone.mp3', 'application/pdf')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects a video mp4 renamed as m4a', async () => {
    await expect(inspectFixture('video.mp4', 'audio/mp4', 'music.m4a')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects a theora ogg renamed as audio', async () => {
    await expect(inspectFixture('video.ogv', 'audio/ogg', 'music.ogg')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects a suffix that contradicts the detected format', async () => {
    await expect(inspectFixture('tone.mp3', 'audio/mpeg', 'music.wav')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
