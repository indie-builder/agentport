export function diffLines(from: string, to: string): { added: string[]; removed: string[] } {
  const counts = (lines: string[]): Map<string, number> => {
    const result = new Map<string, number>();
    for (const line of lines) result.set(line, (result.get(line) ?? 0) + 1);
    return result;
  };
  const fromLines = from.split('\n');
  const toLines = to.split('\n');
  const remainingFrom = counts(fromLines);
  const added: string[] = [];
  for (const line of toLines) {
    const count = remainingFrom.get(line) ?? 0;
    if (count > 0) remainingFrom.set(line, count - 1);
    else added.push(line);
  }
  const remainingTo = counts(toLines);
  const removed: string[] = [];
  for (const line of fromLines) {
    const count = remainingTo.get(line) ?? 0;
    if (count > 0) remainingTo.set(line, count - 1);
    else removed.push(line);
  }
  return { added, removed };
}

export function diffLinesOrdered(from: string, to: string): { added: string[]; removed: string[] } {
  const fromLines = from.split('\n');
  const toLines = to.split('\n');
  if (fromLines.length * toLines.length > 4_000_000) {
    // shortcut: very large docs (>~2000 lines each) fall back to unordered multiset diff; upgrade to Myers if it matters
    return diffLines(from, to);
  }
  const rows = fromLines.length;
  const cols = toLines.length;
  const width = cols + 1;
  const lcs = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        fromLines[i] === toLines[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (fromLines[i] === toLines[j]) {
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      removed.push(fromLines[i] ?? '');
      i += 1;
    } else {
      added.push(toLines[j] ?? '');
      j += 1;
    }
  }
  while (i < rows) {
    removed.push(fromLines[i] ?? '');
    i += 1;
  }
  while (j < cols) {
    added.push(toLines[j] ?? '');
    j += 1;
  }
  return { added, removed };
}
