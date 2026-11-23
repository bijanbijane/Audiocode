/**
 * API-only development entrypoint.
 *
 * The browser UI is started by the independent Vite process (npm run dev:web).
 * Keep the legacy combined entrypoint (npm run dev) unchanged for compatibility.
 */
process.env.DISABLE_EMBEDDED_VITE = 'true';

await import('../server.ts');
