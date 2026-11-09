#!/usr/bin/env node
/**
 * One-time setup for the live-only LLM agent on testnet.
 *
 * Creates `llm-news.<operatorId>` as a sub-account of the operator, funds it,
 * and writes its key to `<credentialDirectory>/<account>.json` (near CLI
 * layout), so the runner can sign its commits and reveals.
 *
 *   HIVECAST_CONFIG=./hivecast.config.json npm run setup:llm-account -- 20
 *
 * The argument is the NEAR to fund (default 20). Refuses to overwrite an
 * existing key file or to run on anything but testnet. Prints the account id;
 * never prints a private key.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPair, nearToYocto } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';

const configPath = process.env.HIVECAST_CONFIG ?? 'hivecast.config.json';
const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
  networkId: string;
  operatorId: string;
  rpcUrl: string;
  credentialDirectory: string;
};
if (raw.networkId !== 'testnet') {
  throw new Error(`refusing to run on ${raw.networkId}: this setup script is for testnet only`);
}

const amount = process.argv[2] ?? '20';
if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`invalid NEAR amount: ${amount}`);

const operatorId = raw.operatorId;
const accountId = `llm-news.${operatorId}`;
const keyFile = path.join(raw.credentialDirectory, `${accountId}.json`);
if (existsSync(keyFile)) {
  throw new Error(`${keyFile} already exists; the account is probably set up already`);
}

const operatorKeyFile = path.join(raw.credentialDirectory, `${operatorId}.json`);
const operatorKey = (JSON.parse(readFileSync(operatorKeyFile, 'utf8')) as { private_key: string }).private_key;

const provider = new JsonRpcProvider({ url: raw.rpcUrl });
const operator = new Account(operatorId, provider, operatorKey as KeyPairString);
const keyPair = KeyPair.fromRandom('ed25519');

// Persist the key BEFORE creating the account, so a crash after creation never loses it.
mkdirSync(raw.credentialDirectory, { recursive: true });
writeFileSync(
  keyFile,
  JSON.stringify({ account_id: accountId, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() }),
  { mode: 0o600 },
);

try {
  await operator.createAccount({
    newAccountId: accountId,
    publicKey: keyPair.getPublicKey(),
    nearToTransfer: nearToYocto(amount as `${number}`),
  });
} catch (err) {
  // The account was not created with this key: drop the unused key file so a rerun can proceed.
  const exists = await provider.viewAccount({ accountId }).then(() => true, () => false);
  if (!exists) unlinkSync(keyFile);
  throw err;
}

process.stdout.write(
  `created ${accountId} with ${amount} NEAR\nkey saved to ${keyFile}\n` +
    `next: add "llm-news": "${accountId}" to agentAccounts and an "llm" block to ${configPath}\n`,
);
