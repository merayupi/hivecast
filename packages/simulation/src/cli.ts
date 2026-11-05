/**
 * HiveCast offline replay CLI.
 *
 * Runs entirely from the committed local bundle. No network, no API key, no
 * LLM. Usage:
 *
 *   npm run sim [-- --seed 42] [-- --json] [-- --json-only]
 *
 * `--json`        print the JSON summary after the terminal table.
 * `--json-only`   print only the JSON summary (machine readable).
 */

import { loadBundle } from './bundle.js';
import { runReplay, defaultConfig, DEFAULT_SEED } from './replay.js';
import { renderTable, toJson } from './report.js';

interface CliArgs {
  seed: number;
  json: boolean;
  jsonOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let seed = DEFAULT_SEED;
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
    } else if (a === '--json') {
      json = true;
    } else if (a === '--json-only') {
      jsonOnly = true;
      json = true;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: npm run sim [-- --seed N] [-- --json] [-- --json-only]\n');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { seed, json, jsonOnly };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const bundle = loadBundle();
  const report = runReplay(bundle, defaultConfig(args.seed));

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
