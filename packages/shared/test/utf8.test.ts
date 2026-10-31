import { describe, expect, it } from 'vitest';
import { utf8Bytes } from '../src/utf8.js';

describe('utf8Bytes', () => {
  it('counts empty and ASCII strings by encoded bytes', () => {
    expect(utf8Bytes('')).toBe(0);
    expect(utf8Bytes('abc')).toBe(3);
  });

  it('counts the 1/2-byte boundary from U+007F to U+0080', () => {
    expect(utf8Bytes(String.fromCodePoint(0x7f))).toBe(1);
    expect(utf8Bytes(String.fromCodePoint(0x80))).toBe(2);
    expect(utf8Bytes(String.fromCodePoint(0x7ff))).toBe(2);
  });

  it('counts the 2/3-byte boundary from U+0800 to U+FFFF', () => {
    expect(utf8Bytes(String.fromCodePoint(0x800))).toBe(3);
    expect(utf8Bytes(String.fromCodePoint(0xffff))).toBe(3);
  });

  it('counts the 3/4-byte boundary and emoji as 4 bytes', () => {
    expect(utf8Bytes(String.fromCodePoint(0x10000))).toBe(4);
    expect(utf8Bytes('😀')).toBe(4);
  });

  it('counts a lone surrogate as 3 bytes, matching its replacement encoding', () => {
    expect(utf8Bytes(String.fromCharCode(0xd800))).toBe(3);
  });
});
