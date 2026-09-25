import { buildApp } from './app.js';
import { config } from '@pulse-metric-studio/core';
import { authorOps, registerPulseRoutes } from '@pulse-metric-studio/pulse';

async function main() {
  const app = buildApp({ authorOps, registerPulseRoutes });
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`pulse-metric-studio server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
