import { bootstrapBackendServer } from './server';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

async function main(): Promise<void> {
  const runtime = await bootstrapBackendServer();
  let shutdownStarted = false;

  const handleShutdown = (signal: ShutdownSignal): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;

    void runtime.shutdown(signal).then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('PLATFORM_API_SHUTDOWN_FAILED:', message);
        process.exitCode = 1;
      },
    );
  };

  process.once('SIGINT', () => handleShutdown('SIGINT'));
  process.once('SIGTERM', () => handleShutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('PLATFORM_API_START_FAILED:', message);
  process.exitCode = 1;
});
