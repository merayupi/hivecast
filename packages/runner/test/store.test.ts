/**
 * Store persistence tests: durable forecast+salt before commit, reservations,
 * immutable snapshot, and journal idempotency — all surviving a close/reopen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';

import { Store } from '../src/store.js';
import type { ForecastRecord, LocalQuestion, SnapshotRecord } from '../src/types.js';

const ONE_NEAR = 10n ** 24n;

function tempDb(): string {
  return path.join(tmpdir(), `hc-store-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

function sampleQuestion(questionId = 1): LocalQuestion {
  return {
    questionId,
    domain: 'price',
    text: 'q',
    eventDefinition: 'e',
    sourceJson: '{}',
    sourceLabel: 's',
    resolver: 'resolver.testnet',
    openTimeNs: 1n,
    closeTimeNs: 2n,
    observationStartNs: 3n,
    observationEndNs: 4n,
    resolveTimeNs: 4n,
    resolveDeadlineNs: 5n,
    revealWindowNs: 6n,
    accessPrice: ONE_NEAR / 100n,
    minStake: ONE_NEAR / 10n,
    participants: [],
  };
}

test('forecast + salt + reservation persist across close/reopen', () => {
  const dbPath = tempDb();
  const store1 = new Store(dbPath);
  const forecast: ForecastRecord = {
    questionId: 1,
    agentId: 'coinflip',
    accountId: 'coinflip.testnet',
    probBps: 5000,
    salt: 'a'.repeat(64),
    stakeYocto: ONE_NEAR,
    commitmentHash: 'b'.repeat(64),
  };
  store1.saveForecast(forecast);
  store1.reserve('coinflip.testnet', 1, ONE_NEAR);
  store1.close();

  const store2 = new Store(dbPath);
  const f = store2.getForecast(1, 'coinflip.testnet');
  assert.ok(f);
  assert.equal(f.salt, 'a'.repeat(64));
  assert.equal(f.probBps, 5000);
  assert.equal(store2.getReservation('coinflip.testnet', 1), ONE_NEAR);
  assert.equal(store2.totalReserved('coinflip.testnet'), ONE_NEAR);
  store2.close();
  rmSync(dbPath, { force: true });
});

test('snapshot is immutable across reopen and stores string stakes', () => {
  const dbPath = tempDb();
  const store1 = new Store(dbPath);
  const snapshot: SnapshotRecord = {
    questionId: 1,
    snapshotId: 'snapshot-1-abc',
    aggregateBps: 5000,
    totalStakeYocto: 6n * ONE_NEAR,
    participantCount: 2,
    entries: [
      { accountId: 'a.testnet', probBps: 4000, stakeYocto: ONE_NEAR.toString() },
      { accountId: 'b.testnet', probBps: 6000, stakeYocto: (5n * ONE_NEAR).toString() },
    ],
  };
  store1.saveSnapshot(snapshot);
  store1.close();

  const store2 = new Store(dbPath);
  const s = store2.getSnapshot(1);
  assert.ok(s);
  assert.equal(s.snapshotId, 'snapshot-1-abc');
  assert.equal(s.aggregateBps, 5000);
  assert.equal(s.entries.length, 2);
  assert.equal(s.entries[0]?.stakeYocto, ONE_NEAR.toString());
  store2.close();
  rmSync(dbPath, { force: true });
});

test('journal: upsert is idempotent and statuses advance', () => {
  const dbPath = tempDb();
  const store = new Store(dbPath);
  const key = 'commit:1:agent.testnet';

  const first = store.upsertJournal({ dedupKey: key, kind: 'commit', questionId: 1, accountId: 'agent.testnet', payloadJson: '{}' });
  assert.equal(first.alreadyConfirmed, false);
  assert.equal(first.row.status, 'pending');

  store.markSubmitted(key, 'txhash123');
  const second = store.upsertJournal({ dedupKey: key, kind: 'commit', questionId: 1, accountId: 'agent.testnet', payloadJson: '{}' });
  assert.equal(second.alreadyConfirmed, false);
  assert.equal(second.row.status, 'submitted');

  store.markConfirmed(key);
  const third = store.upsertJournal({ dedupKey: key, kind: 'commit', questionId: 1, accountId: 'agent.testnet', payloadJson: '{}' });
  assert.equal(third.alreadyConfirmed, true);

  assert.equal(store.listSubmittedJournal().length, 0);
  assert.equal(store.listJournal('commit').length, 1);
  store.close();
  rmSync(dbPath, { force: true });
});

test('question persisted by target key is retrievable', () => {
  const dbPath = tempDb();
  const store = new Store(dbPath);
  const q = sampleQuestion(7);
  store.saveQuestion(q, 'price:123');
  assert.ok(store.getQuestion(7));
  assert.ok(store.getQuestionByTargetKey('price:123'));
  assert.equal(store.getQuestionByTargetKey('price:999'), null);
  assert.equal(store.listQuestions().length, 1);
  store.close();
  rmSync(dbPath, { force: true });
});
