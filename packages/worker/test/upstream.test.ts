import { describe, expect, it } from 'vitest';
import { modelProxyUpstream } from '../src/upstream.js';

describe('model proxy upstream', () => {
  it('keeps loopback when the worker itself runs on the host', () => {
    expect(modelProxyUpstream('http://127.0.0.1:3425', false)).toBe('http://127.0.0.1:3425');
  });

  it('rewrites loopback to the host alias when the worker runs in a container', () => {
    expect(modelProxyUpstream('http://127.0.0.1:3425', true)).toBe(
      'http://host.docker.internal:3425',
    );
    expect(modelProxyUpstream('http://localhost:3425/v1', true)).toBe(
      'http://host.docker.internal:3425/v1',
    );
  });

  it('defaults to the public API and leaves external hosts alone', () => {
    expect(modelProxyUpstream(undefined, false)).toBe('https://api.anthropic.com');
    expect(modelProxyUpstream('https://gateway.example.com', true)).toBe(
      'https://gateway.example.com',
    );
  });
});
