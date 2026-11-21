const EXIT_DELAY_MS = 100;

type ErrorLogger = { error: (obj: unknown, msg?: string) => void };

export function installProcessGuards(logger: ErrorLogger): void {
  let exiting = false;

  const fatal = (kind: string, err: unknown): void => {
    logger.error({ err, kind }, 'fatal process error, exiting');
    if (exiting) return;
    exiting = true;
    setTimeout(() => process.exit(1), EXIT_DELAY_MS).unref();
  };

  process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
  process.on('uncaughtException', (err) => fatal('uncaughtException', err));
}
