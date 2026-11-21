export function assertNever(value: never): never {
  throw new Error(`unhandled value: ${JSON.stringify(value)}`);
}
