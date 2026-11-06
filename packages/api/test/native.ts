const stubs = new Map<string, { present: boolean; value: unknown }>();

export function stubGlobal(name: string, value: unknown): void {
  if (!stubs.has(name)) {
    stubs.set(name, { present: name in globalThis, value: Reflect.get(globalThis, name) });
  }
  Reflect.set(globalThis, name, value);
}

export function unstubAllGlobals(): void {
  for (const [name, entry] of stubs) {
    if (entry.present) Reflect.set(globalThis, name, entry.value);
    else Reflect.deleteProperty(globalThis, name);
  }
  stubs.clear();
}

export async function waitForAssertion(
  check: () => void | Promise<void>,
  timeoutMs = 5_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (error) {
      failure = error;
    }
    await Bun.sleep(intervalMs);
  }
  if (failure !== undefined) throw failure;
  throw new Error('condition was never met');
}
