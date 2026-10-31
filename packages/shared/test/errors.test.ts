import { describe, expect, it } from 'vitest';
import { errorText } from '../src/errors.js';

describe('errorText', () => {
  it('Error 实例取 message（含子类）', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText(new TypeError('bad type'))).toBe('bad type');
  });

  it('普通字符串原样返回', () => {
    expect(errorText('plain')).toBe('plain');
  });

  it('number / boolean 走 String()', () => {
    expect(errorText(42)).toBe('42');
    expect(errorText(false)).toBe('false');
  });

  it('普通对象得到 [object Object]', () => {
    expect(errorText({ message: 'nope' })).toBe('[object Object]');
  });

  it('null / undefined 分别得到 "null" / "undefined"', () => {
    expect(errorText(null)).toBe('null');
    expect(errorText(undefined)).toBe('undefined');
  });
});
