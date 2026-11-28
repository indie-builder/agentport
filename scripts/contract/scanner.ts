type TemplateExpression = {
  expr: string;
  index: number;
};

export type ScannedTemplateLiteral = {
  end: number;
  staticText: string;
  exprText: string;
  expressions: TemplateExpression[];
};

export function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

export function skipQuoted(src: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

export function skipBalancedBraces(src: string, start: number): number {
  let i = start;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      continue;
    }
    if (c === '`') {
      i = scanTemplateLiteral(src, i).end;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return i;
}

export function skipBalancedParens(src: string, start: number): number {
  let i = start;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(src, i, c);
      continue;
    }
    if (c === '`') {
      i = scanTemplateLiteral(src, i).end;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    i += 1;
  }
  return i;
}

export function scanTemplateLiteral(src: string, start: number): ScannedTemplateLiteral {
  let i = start + 1;
  let staticText = '';
  let exprText = '';
  const expressions: TemplateExpression[] = [];
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      staticText += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '`') {
      return { end: i + 1, staticText, exprText, expressions };
    }
    if (ch === '$' && src[i + 1] === '{') {
      i += 2;
      const exprStart = i;
      i = skipBalancedBraces(src, i);
      const expr = src.slice(exprStart, i - 1);
      expressions.push({ expr, index: exprStart });
      exprText += ` ${expr} `;
      staticText += ' ';
      continue;
    }
    staticText += ch ?? '';
    i += 1;
  }
  return { end: i, staticText, exprText, expressions };
}

export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '\\' && next === '/') {
      out += ch + next;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < src.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(src, i, ch);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '`') {
      const tpl = scanTemplateLiteral(src, i);
      out += src.slice(i, tpl.end);
      i = tpl.end;
      continue;
    }
    out += ch ?? '';
    i += 1;
  }
  return out;
}

export function stripCssComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(src, i, ch);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < src.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    out += ch ?? '';
    i += 1;
  }
  return out;
}
