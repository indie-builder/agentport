export function startSingleFlight(run: () => Promise<void>): {
  run: () => Promise<void>;
  idle: () => Promise<void>;
} {
  let inFlight: Promise<void> | null = null;
  const runOnce = (): Promise<void> => {
    if (inFlight === null) {
      inFlight = run().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
  return {
    run: runOnce,
    idle: async () => {
      await inFlight;
    },
  };
}
