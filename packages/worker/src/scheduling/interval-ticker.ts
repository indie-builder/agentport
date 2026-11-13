export function startIntervalTicker(
  run: () => Promise<void>,
  intervalMs: number,
): () => Promise<void> {
  let busy = false;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = (): void => {
    if (busy) return;
    busy = true;
    inFlight = run().finally(() => {
      busy = false;
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}
