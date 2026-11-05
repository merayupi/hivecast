/**
 * HiveCast offline replay CLI.
 *
 * Runs entirely from the committed local bundle. No network, no API key, no
 * LLM. Usage:
 *
 *   npm run sim [-- --seed 42] [-- --capital 100] [-- --json] [-- --json-only]
 *
 * `--capital`     initial NEAR per agent (decimal string, default 100).
 * `--json`        print the JSON summary after the terminal table.
 * `--json-only`   print only the JSON summary (machine readable).
 */

import { loadBundle } from './bundle.js';
import { runReplay, defaultConfig, DEFAULT_SEED } from './replay.js';
import { renderTable, toJson } from './report.js';
import { scaleDecimal } from '@hivecast/core';

interface CliArgs {
  seed: number;
  capital: string; // initial NEAR per agent (decimal string)
  json: boolean;
  jsonOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let seed = DEFAULT_SEED;
  let capital = '100';
  let json = false;
  let jsonOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--seed') {
      const v = argv[i + 1];
      if (v === undefined) throw new Error('--seed requires a value');
      seed = Number(v);
      if (!Number.isInteger(seed) || seed < 0) throw new Error(`invalid seed: ${v}`);
      i++;
    } else if (a === '--capital') {
      const v = argv[i + 1];
      if (v === undefined) throw new Error('--capital requires a value');
      if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`invalid capital: ${v}`);
      capital = v;
      i++;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--json-only') {
      jsonOnly = true;
      json = true;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: npm run sim [-- --seed N] [-- --capital NEAR] [-- --json] [-- --json-only]\n',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { seed, capital, json, jsonOnly };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const bundle = loadBundle();
  const config = defaultConfig(args.seed);
  config.initialCapital = scaleDecimal(args.capital, 24); // exact NEAR -> yocto
  const report = runReplay(bundle, config);

  if (args.jsonOnly) {
    process.stdout.write(toJson(report));
    return;
  }
  process.stdout.write(renderTable(report));
  if (args.json) {
    process.stdout.write('\n' + toJson(report));
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`sim: ${(err as Error).message}\n`);
  process.exit(1);
}
