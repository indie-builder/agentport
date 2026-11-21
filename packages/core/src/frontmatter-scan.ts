export function stripBom(text: string): string {
  return text.replace(/^﻿/, '');
}

export function splitFrontmatter(
  text: string,
):
  | { kind: 'ok'; frontmatter: string; body: string }
  | { kind: 'missingOpen' }
  | { kind: 'missingClose' } {
  const openingEnd = text.indexOf('\n');
  const opening = (openingEnd === -1 ? text : text.slice(0, openingEnd)).replace(/\r$/, '');
  if (!/^---[ \t]*$/.test(opening)) return { kind: 'missingOpen' };

  let lineStart = openingEnd + 1;
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(lineStart, end).replace(/\r$/, '');
    if (/^---[ \t]*$/.test(line)) {
      return {
        kind: 'ok',
        frontmatter: text.slice(openingEnd + 1, lineStart),
        body: lineEnd === -1 ? '' : text.slice(lineEnd + 1),
      };
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return { kind: 'missingClose' };
}
