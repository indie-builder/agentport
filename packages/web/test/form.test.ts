import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldErrors } from '../src/lib/form.js';

describe('fieldErrors', () => {
  it.each([
    ['positive budget', z.number().positive(), 0, '必须大于 0，请调整后再保存'],
    ['positive timeout', z.number().int().positive(), 0, '必须大于 0，请调整后再保存'],
    ['inclusive lower bound', z.number().min(0), -1, '必须大于或等于 0，请调整后再保存'],
    ['exclusive lower bound', z.number().gt(0.5), 0.5, '必须大于 0.5，请调整后再保存'],
    ['inclusive upper bound', z.number().max(10), 11, '必须小于或等于 10，请调整后再保存'],
    ['exclusive upper bound', z.number().lt(10), 10, '必须小于 10，请调整后再保存'],
    ['bigint lower bound', z.bigint().min(1n), 0n, '必须大于或等于 1，请调整后再保存'],
    ['bigint upper bound', z.bigint().max(1n), 2n, '必须小于或等于 1，请调整后再保存'],
    ['required binding', z.array(z.string()).min(1), [], '至少需要 1 项，请补充后再保存'],
    ['multiple bindings', z.array(z.string()).min(2), ['a'], '至少需要 2 项，请补充后再保存'],
    ['too many bindings', z.array(z.string()).max(1), ['a', 'b'], '最多 1 项，请减少后再保存'],
    ['no bindings allowed', z.array(z.string()).max(0), ['a'], '最多 0 项，请减少后再保存'],
    ['required text', z.string().min(1), '', '不能为空，请填写后再保存'],
    ['short text', z.string().min(3), 'ab', '至少需要 3 个字符，请补充后再保存'],
    ['long text', z.string().max(2), 'abc', '最多 2 个字符，请精简后再保存'],
    ['unsupported size origin', z.set(z.string()).min(1), new Set(), '请检查这项内容后重试'],
  ])('localizes %s', (_name, schema, input, expected) => {
    const result = z.object({ value: schema }).safeParse({ value: input });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid input');
    expect(fieldErrors(result.error.issues)).toEqual({ value: expected });
  });

  it('keeps the first error at each nested field path', () => {
    const result = z
      .object({ bindings: z.array(z.object({ name: z.string().min(3).regex(/^a/) })) })
      .safeParse({ bindings: [{ name: '' }] });
    if (result.success) throw new Error('Expected invalid input');
    expect(fieldErrors(result.error.issues)).toEqual({
      'bindings.0.name': '至少需要 3 个字符，请补充后再保存',
    });
  });

  it('uses form for root errors', () => {
    const result = z.number().positive().safeParse(0);
    if (result.success) throw new Error('Expected invalid input');
    expect(fieldErrors(result.error.issues)).toEqual({ form: '必须大于 0，请调整后再保存' });
  });
});
