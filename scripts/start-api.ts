/**
 * API-only development entrypoint.
 *
 * The browser UI is started by the independent Vite process (npm run dev:web).
 * Keep the legacy combined entrypoint (npm run dev) unchanged for compatibility.
 */
import { env } from 'node:process';

env.DISABLE_EMBEDDED_VITE = 'true';
env.DISABLE_WEB_HOST = 'true';

await import('../server.ts');
