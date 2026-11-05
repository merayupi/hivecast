/**
 * Private SQLite persistence (node:sqlite).
 *
 * Responsibilities (all durable, none derived at restart):
 *   - forecasts + salts, written BEFORE the commit transaction is sent
 *   - capital reservations (per account per round)
 *   - immutable Forecast Snapshots
 *   - a transaction journal for idempotent sends and restart reconciliation
 *
 * Monetary values are stored as decimal strings (yoctoNEAR); timestamps as
 * decimal strings (UTC ns) or epoch ms where noted.
 */

import { DatabaseSync } from 'node:sqlite';
import type {
  ForecastRecord,
  JournalEntry,
  JournalKind,
  JournalStatus,
  LocalQuestion,
  SnapshotRecord,
} from './types.js';

export interface JournalRow {
  dedupKey: string;
  kind: JournalKind;
  questionId: number | null;
  accountId: string | null;
  payloadJson: string;
  status: JournalStatus;
  txHash: string | null;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ReservationRow {
  accountId: string;
  questionId: number;
  amountYocto: bigint;
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string, networkId?: string, contractId?: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
    if (networkId !== undefined && contractId !== undefined) {
      try {
        this.bind(networkId, contractId);
      } catch (err) {
        this.db.close();
        throw err;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Bind this database to one (network, contract). Refuses to open a database
   * that belongs to a different deployment so a bare question_id can never be
   * reused across contracts/networks.
   */
  bind(networkId: string, contractId: string): void {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('binding') as { value: string } | undefined;
    const expected = JSON.stringify({ networkId, contractId });
    if (row && row.value !== expected) {
      throw new Error(
        `database is bound to ${row.value} but requested ${expected}; refusing to mix deployments`,
      );
    }
    if (!row) {
      this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('binding', expected);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS questions (
        question_id INTEGER PRIMARY KEY,
        domain TEXT NOT NULL,
        text TEXT NOT NULL,
        event_definition TEXT NOT NULL,
        source_json TEXT NOT NULL,
        source_label TEXT NOT NULL,
        resolver TEXT NOT NULL,
        open_time TEXT NOT NULL,
        close_time TEXT NOT NULL,
        observation_start TEXT NOT NULL,
        observation_end TEXT NOT NULL,
        resolve_time TEXT NOT NULL,
        resolve_deadline TEXT NOT NULL,
        reveal_window TEXT NOT NULL,
        access_price TEXT NOT NULL,
        min_stake TEXT NOT NULL,
        target_key TEXT NOT NULL UNIQUE,
        participants_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS forecasts (
        question_id INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        prob_bps INTEGER NOT NULL,
        salt TEXT NOT NULL,
        stake_yocto TEXT NOT NULL,
        commitment_hash TEXT NOT NULL,
        committed_at INTEGER NOT NULL,
        PRIMARY KEY (question_id, account_id)
      );

      CREATE TABLE IF NOT EXISTS reservations (
        account_id TEXT NOT NULL,
        question_id INTEGER NOT NULL,
        amount_yocto TEXT NOT NULL,
        PRIMARY KEY (account_id, question_id)
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        question_id INTEGER PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        aggregate_bps INTEGER NOT NULL,
        total_stake_yocto TEXT NOT NULL,
        participant_count INTEGER NOT NULL,
        entries_json TEXT NOT NULL,
        frozen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedup_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        question_id INTEGER,
        account_id TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_journal_status ON journal(status);
      CREATE INDEX IF NOT EXISTS idx_forecasts_qid ON forecasts(question_id);
      CREATE INDEX IF NOT EXISTS idx_reservations_account ON reservations(account_id);

      CREATE TABLE IF NOT EXISTS evidence (
        question_id INTEGER NOT NULL,
        stage TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (question_id, stage, hash)
      );
    `);
  }

  /** Persist exact source evidence (raw response, request, model/grid/units/hash). */
  saveEvidence(questionId: number, stage: 'input' | 'resolve', evidenceJson: string, hash: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO evidence (question_id, stage, evidence_json, hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(questionId, stage, evidenceJson, hash, Date.now());
  }

  getEvidence(questionId: number, stage: 'input' | 'resolve'): string[] {
    const rows = this.db
      .prepare('SELECT evidence_json FROM evidence WHERE question_id = ? AND stage = ? ORDER BY created_at ASC')
      .all(questionId, stage) as { evidence_json: string }[];
    return rows.map((r) => r.evidence_json);
  }

  // -------------------------------------------------------------------------
  // Questions
  // -------------------------------------------------------------------------

  saveQuestion(q: LocalQuestion, targetKey: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO questions
         (question_id, domain, text, event_definition, source_json, source_label, resolver,
          open_time, close_time, observation_start, observation_end, resolve_time,
          resolve_deadline, reveal_window, access_price, min_stake, target_key, participants_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        q.questionId,
        q.domain,
        q.text,
        q.eventDefinition,
        q.sourceJson,
        q.sourceLabel,
        q.resolver,
        q.openTimeNs.toString(),
        q.closeTimeNs.toString(),
        q.observationStartNs.toString(),
        q.observationEndNs.toString(),
        q.resolveTimeNs.toString(),
        q.resolveDeadlineNs.toString(),
        q.revealWindowNs.toString(),
        q.accessPrice.toString(),
        q.minStake.toString(),
        targetKey,
        JSON.stringify(q.participants),
      );
  }

  getQuestion(questionId: number): LocalQuestion | null {
    const row = this.db.prepare('SELECT * FROM questions WHERE question_id = ?').get(questionId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToQuestion(row);
  }

  getQuestionByTargetKey(targetKey: string): LocalQuestion | null {
    const row = this.db.prepare('SELECT * FROM questions WHERE target_key = ?').get(targetKey) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToQuestion(row);
  }

  listQuestions(): LocalQuestion[] {
    const rows = this.db.prepare('SELECT * FROM questions ORDER BY question_id ASC').all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToQuestion(r));
  }

  private rowToQuestion(row: Record<string, unknown>): LocalQuestion {
    return {
      questionId: Number(row.question_id),
      domain: row.domain as LocalQuestion['domain'],
      text: row.text as string,
      eventDefinition: row.event_definition as string,
      sourceJson: row.source_json as string,
      sourceLabel: row.source_label as string,
      resolver: row.resolver as string,
      openTimeNs: BigInt(row.open_time as string),
      closeTimeNs: BigInt(row.close_time as string),
      observationStartNs: BigInt(row.observation_start as string),
      observationEndNs: BigInt(row.observation_end as string),
      resolveTimeNs: BigInt(row.resolve_time as string),
      resolveDeadlineNs: BigInt(row.resolve_deadline as string),
      revealWindowNs: BigInt(row.reveal_window as string),
      accessPrice: BigInt(row.access_price as string),
      minStake: BigInt(row.min_stake as string),
      participants: JSON.parse(row.participants_json as string) as LocalQuestion['participants'],
    };
  }

  // -------------------------------------------------------------------------
  // Forecasts (persisted BEFORE commit)
  // -------------------------------------------------------------------------

  saveForecast(f: ForecastRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO forecasts
         (question_id, agent_id, account_id, prob_bps, salt, stake_yocto, commitment_hash, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.questionId,
        f.agentId,
        f.accountId,
        f.probBps,
        f.salt,
        f.stakeYocto.toString(),
        f.commitmentHash,
        Date.now(),
      );
  }

  getForecast(questionId: number, accountId: string): ForecastRecord | null {
    const row = this.db
      .prepare('SELECT * FROM forecasts WHERE question_id = ? AND account_id = ?')
      .get(questionId, accountId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      questionId: Number(row.question_id),
      agentId: row.agent_id as ForecastRecord['agentId'],
      accountId: row.account_id as string,
      probBps: Number(row.prob_bps),
      salt: row.salt as string,
      stakeYocto: BigInt(row.stake_yocto as string),
      commitmentHash: row.commitment_hash as string,
    };
  }

  listForecasts(questionId: number): ForecastRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM forecasts WHERE question_id = ? ORDER BY account_id ASC')
      .all(questionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      questionId: Number(r.question_id),
      agentId: r.agent_id as ForecastRecord['agentId'],
      accountId: r.account_id as string,
      probBps: Number(r.prob_bps),
      salt: r.salt as string,
      stakeYocto: BigInt(r.stake_yocto as string),
      commitmentHash: r.commitment_hash as string,
    }));
  }

  // -------------------------------------------------------------------------
  // Reservations
  // -------------------------------------------------------------------------

  reserve(accountId: string, questionId: number, amountYocto: bigint): void {
    this.db
      .prepare('INSERT OR REPLACE INTO reservations (account_id, question_id, amount_yocto) VALUES (?, ?, ?)')
      .run(accountId, questionId, amountYocto.toString());
  }

  getReservation(accountId: string, questionId: number): bigint {
    const row = this.db
      .prepare('SELECT amount_yocto FROM reservations WHERE account_id = ? AND question_id = ?')
      .get(accountId, questionId) as { amount_yocto: string } | undefined;
    return row ? BigInt(row.amount_yocto) : 0n;
  }

  /** Sum of all outstanding reservations for an account (across rounds). */
  totalReserved(accountId: string): bigint {
    const rows = this.db
      .prepare('SELECT amount_yocto FROM reservations WHERE account_id = ?')
      .all(accountId) as { amount_yocto: string }[];
    return rows.reduce((sum, r) => sum + BigInt(r.amount_yocto), 0n);
  }

  listReservations(accountId: string): ReservationRow[] {
    const rows = this.db
      .prepare('SELECT account_id, question_id, amount_yocto FROM reservations WHERE account_id = ?')
      .all(accountId) as Record<string, unknown>[];
    return rows.map((r) => ({
      accountId: r.account_id as string,
      questionId: Number(r.question_id),
      amountYocto: BigInt(r.amount_yocto as string),
    }));
  }

  releaseReservation(accountId: string, questionId: number): void {
    this.db.prepare('DELETE FROM reservations WHERE account_id = ? AND question_id = ?').run(accountId, questionId);
  }

  // -------------------------------------------------------------------------
  // Withdraw attempt sequencing (idempotent per (account, amount) attempt)
  // -------------------------------------------------------------------------

  /** Increment and return the next withdrawal attempt index for (account, amount). */
  nextWithdrawAttempt(accountId: string, amountYocto: bigint): number {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS withdraw_attempts (
        account_id TEXT NOT NULL,
        amount_yocto TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        PRIMARY KEY (account_id, amount_yocto)
      );
    `);
    const row = this.db
      .prepare('SELECT attempt FROM withdraw_attempts WHERE account_id = ? AND amount_yocto = ?')
      .get(accountId, amountYocto.toString()) as { attempt: number } | undefined;
    const next = (row?.attempt ?? 0) + 1;
    this.db
      .prepare('INSERT OR REPLACE INTO withdraw_attempts (account_id, amount_yocto, attempt) VALUES (?, ?, ?)')
      .run(accountId, amountYocto.toString(), next);
    return next;
  }

  // -------------------------------------------------------------------------
  // Snapshots (immutable once written)
  // -------------------------------------------------------------------------

  saveSnapshot(s: SnapshotRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO snapshots
         (question_id, snapshot_id, aggregate_bps, total_stake_yocto, participant_count, entries_json, frozen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.questionId,
        s.snapshotId,
        s.aggregateBps,
        s.totalStakeYocto.toString(),
        s.participantCount,
        JSON.stringify(s.entries),
        Date.now(),
      );
  }

  getSnapshot(questionId: number): SnapshotRecord | null {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE question_id = ?').get(questionId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      questionId: Number(row.question_id),
      snapshotId: row.snapshot_id as string,
      aggregateBps: Number(row.aggregate_bps),
      totalStakeYocto: BigInt(row.total_stake_yocto as string),
      participantCount: Number(row.participant_count),
      entries: JSON.parse(row.entries_json as string) as SnapshotRecord['entries'],
    };
  }

  // -------------------------------------------------------------------------
  // Journal
  // -------------------------------------------------------------------------

  getJournal(dedupKey: string): JournalRow | null {
    const row = this.db.prepare('SELECT * FROM journal WHERE dedup_key = ?').get(dedupKey) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToJournal(row);
  }

  /**
   * Record (or fetch) a journal entry for a logical action. Returns the entry
   * and whether it was already confirmed (caller should skip the send).
   */
  upsertJournal(entry: {
    dedupKey: string;
    kind: JournalKind;
    questionId: number | null;
    accountId: string | null;
    payloadJson: string;
  }): { row: JournalRow; alreadyConfirmed: boolean } {
    const existing = this.getJournal(entry.dedupKey);
    if (existing) {
      return { row: existing, alreadyConfirmed: existing.status === 'confirmed' };
    }
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO journal
         (dedup_key, kind, question_id, account_id, payload_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(entry.dedupKey, entry.kind, entry.questionId, entry.accountId, entry.payloadJson, now, now);
    return { row: this.getJournal(entry.dedupKey)!, alreadyConfirmed: false };
  }

  markSubmitted(dedupKey: string, txHash: string): void {
    this.db
      .prepare(`UPDATE journal SET status = 'submitted', tx_hash = ?, error = NULL, updated_at = ? WHERE dedup_key = ?`)
      .run(txHash, Date.now(), dedupKey);
  }

  markConfirmed(dedupKey: string): void {
    this.db
      .prepare(`UPDATE journal SET status = 'confirmed', updated_at = ? WHERE dedup_key = ?`)
      .run(Date.now(), dedupKey);
  }

  markFailed(dedupKey: string, error: string): void {
    this.db
      .prepare(`UPDATE journal SET status = 'failed', error = ?, updated_at = ? WHERE dedup_key = ?`)
      .run(error, Date.now(), dedupKey);
  }

  listSubmittedJournal(): JournalRow[] {
    const rows = this.db.prepare(`SELECT * FROM journal WHERE status = 'submitted'`).all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToJournal(r));
  }

  listJournal(kind?: JournalKind): JournalRow[] {
    const rows = kind
      ? (this.db.prepare('SELECT * FROM journal WHERE kind = ? ORDER BY id ASC').all(kind) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM journal ORDER BY id ASC').all() as Record<string, unknown>[]);
    return rows.map((r) => this.rowToJournal(r));
  }

  private rowToJournal(row: Record<string, unknown>): JournalRow {
    return {
      dedupKey: row.dedup_key as string,
      kind: row.kind as JournalKind,
      questionId: row.question_id === null ? null : Number(row.question_id),
      accountId: row.account_id as string | null,
      payloadJson: row.payload_json as string,
      status: row.status as JournalStatus,
      txHash: row.tx_hash as string | null,
      error: row.error as string | null,
      createdAtMs: Number(row.created_at),
      updatedAtMs: Number(row.updated_at),
    };
  }
}

/** A JournalEntry (public type) from a JournalRow. */
export function toJournalEntry(row: JournalRow): JournalEntry {
  return {
    id: 0, // internal autoincrement id is not persisted on the row shape
    nonce: row.dedupKey,
    kind: row.kind,
    questionId: row.questionId,
    accountId: row.accountId,
    payloadJson: row.payloadJson,
    status: row.status,
    txHash: row.txHash,
    error: row.error,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}
