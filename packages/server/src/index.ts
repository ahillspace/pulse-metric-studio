import { buildApp } from './app.js';
import { config, migrateSavedSecrets } from '@pulse-metric-studio/core';
import { authorOps, registerPulseRoutes } from '@pulse-metric-studio/pulse';
import { readDesktopStartup, superviseDesktop } from './desktop.js';

async function main() {
  const startup = await readDesktopStartup();
  const app = buildApp({ authorOps, registerPulseRoutes }, { desktopToken: startup?.token });
  superviseDesktop(app, startup);
  // Runs beside the server: a Keychain prompt must not hold up the window.
  void migrateSavedSecrets({ broker: startup?.broker }).catch((error: unknown) => {
    console.warn(`Saved secrets were not moved yet and will be tried again at the next launch. ${error instanceof Error ? error.message : ''}`.trim());
  });
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`pulse-metric-studio server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
