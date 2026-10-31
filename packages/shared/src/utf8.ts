/**
 * shared 不带 Node/DOM lib；按码点手算 UTF-8 字节数，与 TextEncoder 结果一致，
 * 浏览器与 Node 都能用。校验的是编码后的字节，不是字符串长度。
 */
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}
