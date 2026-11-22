import type { Logger } from 'pino';

interface DefaultEnvironmentStore {
  getDefault: () => Promise<{ id: string } | null>;
  register: (image: { imageTag: string; imageId: string }) => Promise<unknown>;
}

export interface DefaultEnvironmentDeps {
  store: DefaultEnvironmentStore;
  ensureDefaultAgentPublished: () => Promise<void>;
  ensureImage: (image: string, signal: AbortSignal) => Promise<void>;
  resolveImageId: (image: string) => Promise<string | null>;
  sandboxImage: string;
  signal: AbortSignal;
  logger: Logger;
}

const DEFAULT_ENVIRONMENT_RETRY_MS = 60_000;

export async function ensureDefaultEnvironment(
  deps: DefaultEnvironmentDeps,
): Promise<'exists' | 'registered'> {
  if ((await deps.store.getDefault()) !== null) {
    await deps.ensureDefaultAgentPublished();
    return 'exists';
  }
  await deps.ensureImage(deps.sandboxImage, deps.signal);
  const imageId = await deps.resolveImageId(deps.sandboxImage);
  if (imageId === null) {
    throw new Error(`sandbox image ${deps.sandboxImage} is not present locally after pull`);
  }
  await deps.store.register({ imageTag: deps.sandboxImage, imageId });
  await deps.ensureDefaultAgentPublished();
  deps.logger.info({ image: deps.sandboxImage, imageId }, 'default runtime environment registered');
  return 'registered';
}

export function startDefaultEnvironmentRetry(
  deps: DefaultEnvironmentDeps,
  retryMs: number = DEFAULT_ENVIRONMENT_RETRY_MS,
): () => Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let stopped = false;
  const attempt = (): void => {
    if (stopped || deps.signal.aborted) return;
    inFlight = ensureDefaultEnvironment(deps).then(
      () => undefined,
      (err: unknown) => {
        deps.logger.error(
          { err, image: deps.sandboxImage },
          'default runtime environment registration failed; retrying',
        );
        if (stopped || deps.signal.aborted) return;
        timer = setTimeout(attempt, retryMs);
        timer.unref();
      },
    );
  };
  timer = setTimeout(attempt, retryMs);
  timer.unref();
  return async () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    await inFlight;
  };
}
