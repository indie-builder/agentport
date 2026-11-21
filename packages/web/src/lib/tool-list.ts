export function parseToolList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((tool) => tool.trim())
        .filter(Boolean),
    ),
  ];
}
