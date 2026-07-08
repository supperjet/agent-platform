/** Converts process termination signals into one graceful application close. */
export function registerShutdownHandlers(close: () => Promise<void>) {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= close().then(() => process.exit(0));
    return shutdownPromise;
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
