import { describe, expect, it } from 'vitest';
import { errorText, hasErrorCode } from '../src/errors.js';

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

describe('hasErrorCode', () => {
  it('Error 且 code 匹配返回 true', () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    expect(hasErrorCode(error, 'ENOENT')).toBe(true);
  });

  it('code 不匹配返回 false', () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    expect(hasErrorCode(error, 'EEXIST')).toBe(false);
  });

  it('普通对象带 code（非 Error）返回 false', () => {
    expect(hasErrorCode({ code: 'ENOENT' }, 'ENOENT')).toBe(false);
  });

  it('无 code 的 Error 返回 false', () => {
    expect(hasErrorCode(new Error('boom'), 'ENOENT')).toBe(false);
  });

  it('字符串返回 false', () => {
    expect(hasErrorCode('ENOENT', 'ENOENT')).toBe(false);
  });

  it('null / undefined 返回 false', () => {
    expect(hasErrorCode(null, 'ENOENT')).toBe(false);
    expect(hasErrorCode(undefined, 'ENOENT')).toBe(false);
  });
});
