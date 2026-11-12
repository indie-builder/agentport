export function matchesQuery(values: string[], term: string): boolean {
  return values.some((value) => value.toLocaleLowerCase().includes(term));
}
