const { version }: { version: string } = await Bun.file(
  new URL('../../../package.json', import.meta.url),
).json();

export { version };
