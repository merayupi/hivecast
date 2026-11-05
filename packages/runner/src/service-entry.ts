#!/usr/bin/env node
/**
 * Public HTTP service entrypoint (no admin, no private forecasts).
 *
 * Usage: HIVECAST_CONFIG=... tsx src/service-entry.ts
 */

import { NearChainClient } from './chain/index.js';
import { loadConfig } from './config.js';
import { Runner } from './runner.js';
import { Runtime } from './runtime.js';
import { createPublicService } from './service.js';
import { Store } from './store.js';

const config = loadConfig(process.env.HIVECAST_CONFIG ?? 'hivecast.config.json');
const chain = new NearChainClient(config);
const store = new Store(config.databasePath, config.networkId, config.contractId);
const runner = new Runner(config, chain, store);
const runtime = new Runtime(config, chain, store, runner);
const server = createPublicService(runtime);

server.listen(config.http.port, config.http.host, () => {
  process.stdout.write(`hivecast-runner service listening on http://${config.http.host}:${config.http.port}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
