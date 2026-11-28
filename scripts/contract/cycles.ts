function findStronglyConnectedComponents(
  nodes: readonly string[],
  adj: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const sccs: string[][] = [];

  function strongConnect(v: string): void {
    indices.set(v, nextIndex);
    lowlink.set(v, nextIndex);
    nextIndex += 1;
    stack.push(v);
    onStack.add(v);

    const neighbors = [...(adj.get(v) ?? [])].sort();
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v) ?? nextIndex, lowlink.get(w) ?? nextIndex));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) ?? nextIndex, indices.get(w) ?? nextIndex));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const comp: string[] = [];
      while (true) {
        const w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length > 1) sccs.push(comp.sort());
    }
  }

  for (const node of [...nodes].sort()) {
    if (!indices.has(node)) strongConnect(node);
  }
  return sccs.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
}

function findCyclePath(
  comp: readonly string[],
  adj: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const members = new Set(comp);
  const start = comp[0];
  if (start === undefined) return [];
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i += 1) {
    const cur = queue[i];
    if (cur === undefined) continue;
    const neighbors = [...(adj.get(cur) ?? [])].filter((n) => members.has(n)).sort();
    for (const next of neighbors) {
      if (next === start) {
        const cycle = [start];
        let cursor: string | null = cur;
        while (cursor !== null) {
          cycle.unshift(cursor);
          cursor = parent.get(cursor) ?? null;
        }
        return cycle;
      }
      if (!parent.has(next)) {
        parent.set(next, cur);
        queue.push(next);
      }
    }
  }
  return [...comp, start];
}

export function findCycles(
  nodes: readonly string[],
  adj: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  return findStronglyConnectedComponents(nodes, adj).map((comp) => findCyclePath(comp, adj));
}
