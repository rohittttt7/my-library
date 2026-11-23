import { existsSync } from 'node:fs';

if (process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_URL) {
  const { startRender } = await import('./render-server.mjs');
  await startRender();
} else {
  if (existsSync('.env')) process.loadEnvFile('.env');
  await import('./server.mjs');
}
