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

/** One llm-news attempt for a Round (private until Reveal). */
export interface LlmRunRecord {
  questionId: number;
  accountId: string;
  model: string;
  promptSha256: string;
  headlines: { title: string; source: string; publishedAtMs: number }[];
  probBps: number | null;
  rationale: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  error: string | null;
  createdAtMs: number;
}
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

export interface AccessChallengeRow {
  challengeId: string;
  nonceHex: string;
  accountId: string;
  networkId: string;
  contractId: string;
  serviceDomain: string;
  expiresAtMs: number;
  consumedAtMs: number | null;
  createdAtMs: number;
}

export interface AccessSessionRow {
  sessionId: string;
  accountId: string;
  networkId: string;
  contractId: string;
  createdAtMs: number;
  expiresAtMs: number;
}

/**
 * A public-safe projection of one journal entry: transaction hash + kind +
 * account + question + status only. Never exposes `payloadJson` (forecasts/
 * salts/signed bytes), `dedupKey`, or `error` internals.
 */
export interface PublicJournalRow {
  txHash: string | null;
  kind: JournalKind;
  accountId: string | null;
  questionId: number | null;
  status: JournalStatus;
  createdAtMs: number;
  updatedAtMs: number;
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

      -- llm-news attempts (private until the agent's on-chain Reveal).
      CREATE TABLE IF NOT EXISTS llm_runs (
        question_id INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        model TEXT NOT NULL,
        prompt_sha256 TEXT NOT NULL,
        headlines_json TEXT NOT NULL,
        prob_bps INTEGER,
        rationale TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (question_id, account_id, attempt)
      );

      CREATE TABLE IF NOT EXISTS access_challenges (
        challenge_id TEXT PRIMARY KEY,
        nonce_hex TEXT NOT NULL,
        account_id TEXT NOT NULL,
        network_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        service_domain TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        consumed_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS access_sessions (
        session_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        network_id TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_access_challenges_account ON access_challenges(account_id);

      CREATE TABLE IF NOT EXISTS signed_txs (
        dedup_key TEXT PRIMARY KEY,
        signed_bytes_base64 TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retired_rounds (
        question_id INTEGER PRIMARY KEY,
        phase TEXT NOT NULL,
        retired_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public_terminal_rounds (
        question_id INTEGER PRIMARY KEY,
        phase TEXT NOT NULL,
        data_json TEXT NOT NULL,
        materialized_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public_questions (
        question_id INTEGER PRIMARY KEY,
        phase TEXT NOT NULL,
        data_json TEXT NOT NULL,
        observed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public_tx_gas (
        tx_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        final_status TEXT NOT NULL,
        success_value INTEGER NOT NULL,
        tokens_burnt TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public_tx_time (
        tx_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        block_hash TEXT NOT NULL,
        block_timestamp_ns TEXT NOT NULL,
        cached_at INTEGER NOT NULL
      );
    `);
  }

  // -------------------------------------------------------------------------
  // Public question view persistence (ALL discovered views, never dropped)
  // -------------------------------------------------------------------------

  savePublicQuestion(questionId: number, phase: string, dataJson: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO public_questions (question_id, phase, data_json, observed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(questionId, phase, dataJson, Date.now());
  }

  getPublicQuestion(questionId: number): { phase: string; dataJson: string } | null {
    const row = this.db
      .prepare('SELECT phase, data_json FROM public_questions WHERE question_id = ?')
      .get(questionId) as { phase: string; data_json: string } | undefined;
    return row ? { phase: row.phase, dataJson: row.data_json } : null;
  }

  listPublicQuestions(): { questionId: number; phase: string; dataJson: string }[] {
    const rows = this.db
      .prepare('SELECT question_id, phase, data_json FROM public_questions ORDER BY question_id ASC')
      .all() as { question_id: number; phase: string; data_json: string }[];
    return rows.map((r) => ({ questionId: r.question_id, phase: r.phase, dataJson: r.data_json }));
  }

  /** The highest question_id fetched so far (persistent cursor). */
  getPublicCursor(): number {
    const raw = this.getMeta('public_fetch_cursor');
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  setPublicCursor(n: number): void {
    this.setMeta('public_fetch_cursor', String(n));
  }

  getPublicObservedCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM public_questions')
      .get() as { c: number };
    return row.c;
  }

  // -------------------------------------------------------------------------
  // Generic metadata (reuses the `meta` binding table)
  // -------------------------------------------------------------------------

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  // -------------------------------------------------------------------------
  // Materialized terminal (settled/cancelled) rounds for the public read cache
  // -------------------------------------------------------------------------

  /** Persist an immutable terminal Round projection (question + commitments). */
  savePublicTerminalRound(questionId: number, phase: 'settled' | 'cancelled', dataJson: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO public_terminal_rounds (question_id, phase, data_json, materialized_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(questionId, phase, dataJson, Date.now());
  }

  getPublicTerminalRound(questionId: number): { phase: string; dataJson: string } | null {
    const row = this.db
      .prepare('SELECT phase, data_json FROM public_terminal_rounds WHERE question_id = ?')
      .get(questionId) as { phase: string; data_json: string } | undefined;
    return row ? { phase: row.phase, dataJson: row.data_json } : null;
  }

  listPublicTerminalRounds(): { questionId: number; phase: string; dataJson: string }[] {
    const rows = this.db
      .prepare('SELECT question_id, phase, data_json FROM public_terminal_rounds ORDER BY question_id ASC')
      .all() as { question_id: number; phase: string; data_json: string }[];
    return rows.map((r) => ({ questionId: r.question_id, phase: r.phase, dataJson: r.data_json }));
  }

  // -------------------------------------------------------------------------
  // Finalized tx receipt gas cache (immutable once FINAL)
  // -------------------------------------------------------------------------

  savePublicTxGas(txHash: string, accountId: string, finalStatus: string, successValue: boolean, tokensBurnt: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO public_tx_gas (tx_hash, account_id, final_status, success_value, tokens_burnt, cached_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(txHash, accountId, finalStatus, successValue ? 1 : 0, tokensBurnt, Date.now());
  }

  getPublicTxGas(txHash: string): { accountId: string; finalStatus: string; successValue: boolean; tokensBurnt: string } | null {
    const row = this.db
      .prepare('SELECT account_id, final_status, success_value, tokens_burnt FROM public_tx_gas WHERE tx_hash = ?')
      .get(txHash) as { account_id: string; final_status: string; success_value: number; tokens_burnt: string } | undefined;
    if (!row) return null;
    return { accountId: row.account_id, finalStatus: row.final_status, successValue: row.success_value === 1, tokensBurnt: row.tokens_burnt };
  }

  /** Cache the inclusion block time of a FINAL transaction (immutable once known). */
  savePublicTxTime(txHash: string, accountId: string, blockHash: string, timestampNs: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO public_tx_time (tx_hash, account_id, block_hash, block_timestamp_ns, cached_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(txHash, accountId, blockHash, timestampNs, Date.now());
  }

  getPublicTxTime(txHash: string): { blockHash: string; timestampNs: string } | null {
    const row = this.db
      .prepare('SELECT block_hash, block_timestamp_ns FROM public_tx_time WHERE tx_hash = ?')
      .get(txHash) as { block_hash: string; block_timestamp_ns: string } | undefined;
    return row ? { blockHash: row.block_hash, timestampNs: row.block_timestamp_ns } : null;
  }

  /**
   * Confirmed journal transactions (with a hash), newest first by journal id,
   * strictly before `beforeId` when given. Public-safe columns only: never the
   * payload, salt, signed bytes, dedup key, or error.
   */
  listConfirmedActivity(beforeId: number | null, limit: number): (PublicJournalRow & { id: number })[] {
    const sql =
      `SELECT id, tx_hash, kind, account_id, question_id, status, created_at, updated_at FROM journal
       WHERE status = 'confirmed' AND tx_hash IS NOT NULL AND account_id IS NOT NULL` +
      (beforeId === null ? '' : ' AND id < ?') +
      ' ORDER BY id DESC LIMIT ?';
    const params = beforeId === null ? [limit] : [beforeId, limit];
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      txHash: r.tx_hash as string,
      kind: r.kind as JournalKind,
      accountId: r.account_id as string | null,
      questionId: r.question_id === null ? null : Number(r.question_id),
      status: r.status as JournalStatus,
      createdAtMs: Number(r.created_at),
      updatedAtMs: Number(r.updated_at),
    }));
  }

  // -------------------------------------------------------------------------
  // Retired (terminal) round markers — durable, no time heuristic
  // -------------------------------------------------------------------------

  /** Mark a Round retired once its FINALIZED terminal phase was actually observed. */
  markRetired(questionId: number, phase: 'settled' | 'cancelled'): void {
    this.db
      .prepare('INSERT OR REPLACE INTO retired_rounds (question_id, phase, retired_at) VALUES (?, ?, ?)')
      .run(questionId, phase, Date.now());
  }

  isRetired(questionId: number): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM retired_rounds WHERE question_id = ?')
      .get(questionId);
    return row !== undefined;
  }

  // -------------------------------------------------------------------------
  // Prepared signed transactions (persisted BEFORE broadcast for crash safety)
  // -------------------------------------------------------------------------

  saveSignedTx(dedupKey: string, signedBytesBase64: string, txHash: string, nonce: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO signed_txs (dedup_key, signed_bytes_base64, tx_hash, nonce, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(dedupKey, signedBytesBase64, txHash, nonce, Date.now());
  }

  getSignedTx(dedupKey: string): { signedBytesBase64: string; txHash: string; nonce: string } | null {
    const row = this.db
      .prepare('SELECT signed_bytes_base64, tx_hash, nonce FROM signed_txs WHERE dedup_key = ?')
      .get(dedupKey) as { signed_bytes_base64: string; tx_hash: string; nonce: string } | undefined;
    if (!row) return null;
    return { signedBytesBase64: row.signed_bytes_base64, txHash: row.tx_hash, nonce: row.nonce };
  }

  deleteSignedTx(dedupKey: string): void {
    this.db.prepare('DELETE FROM signed_txs WHERE dedup_key = ?').run(dedupKey);
  }

  /**
   * All persisted prepared signed transactions (for the canonical-hash repair
   * migration and the parent's read-only oracle). Never returns secret keys;
   * the signed bytes are the ONLY material from which the canonical tx id can
   * be recomputed without re-signing or replaying a nonce.
   */
  listSignedTxs(): { dedupKey: string; signedBytesBase64: string; txHash: string; nonce: string }[] {
    const rows = this.db
      .prepare('SELECT dedup_key, signed_bytes_base64, tx_hash, nonce FROM signed_txs ORDER BY dedup_key ASC')
      .all() as { dedup_key: string; signed_bytes_base64: string; tx_hash: string; nonce: string }[];
    return rows.map((r) => ({
      dedupKey: r.dedup_key,
      signedBytesBase64: r.signed_bytes_base64,
      txHash: r.tx_hash,
      nonce: r.nonce,
    }));
  }

  /**
   * Idempotent canonical-hash repair: recompute `tx_hash` from each persisted
   * signed transaction's UNSIGNED bytes and update `signed_txs` AND the joined
   * `journal` row (same dedup_key) where it differs. Never re-signs, never
   * replays a nonce, never touches the signed bytes themselves. Confirmed
   * journal rows whose signed bytes were already deleted (deleted on success)
   * are NOT touched here — their historical hash is recoverable only from the
   * chain receipt (parent oracle), never by re-signing.
   * `computeCanonicalHash` is `canonicalTxHashFromSignedBytes` from the chain
   * module. Returns the number of signed_txs rows repaired.
   */
  repairSignedTxHashes(computeCanonicalHash: (signedBytesBase64: string) => string): number {
    let repaired = 0;
    const rows = this.db
      .prepare('SELECT dedup_key, signed_bytes_base64, tx_hash FROM signed_txs')
      .all() as { dedup_key: string; signed_bytes_base64: string; tx_hash: string }[];
    for (const r of rows) {
      let canonical: string;
      try {
        canonical = computeCanonicalHash(r.signed_bytes_base64);
      } catch {
        continue; // malformed signed bytes; leave untouched
      }
      if (canonical !== r.tx_hash) {
        this.db
          .prepare('UPDATE signed_txs SET tx_hash = ? WHERE dedup_key = ?')
          .run(canonical, r.dedup_key);
        // Propagate to the joined journal row (same dedup_key) if still present.
        this.db
          .prepare('UPDATE journal SET tx_hash = ? WHERE dedup_key = ?')
          .run(canonical, r.dedup_key);
        repaired++;
      }
    }
    return repaired;
  }

  /** Persist exact source evidence (raw response, request, model/grid/units/hash). */
  // -------------------------------------------------------------------------
  // llm-news runs (private; public only after Reveal via Runtime)
  // -------------------------------------------------------------------------

  countLlmRuns(questionId: number, accountId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM llm_runs WHERE question_id = ? AND account_id = ?')
      .get(questionId, accountId) as { n: number };
    return Number(row.n);
  }

  saveLlmRun(run: LlmRunRecord): void {
    const attempt = this.countLlmRuns(run.questionId, run.accountId) + 1;
    this.db
      .prepare(
        `INSERT INTO llm_runs (question_id, account_id, attempt, model, prompt_sha256, headlines_json, prob_bps,
           rationale, prompt_tokens, completion_tokens, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.questionId,
        run.accountId,
        attempt,
        run.model,
        run.promptSha256,
        JSON.stringify(run.headlines),
        run.probBps,
        run.rationale,
        run.promptTokens,
        run.completionTokens,
        run.error,
        run.createdAtMs,
      );
  }

  /** The successful run whose probability was committed (latest with a probability). */
  getLlmRun(questionId: number, accountId: string): LlmRunRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM llm_runs WHERE question_id = ? AND account_id = ? AND prob_bps IS NOT NULL ORDER BY attempt DESC LIMIT 1',
      )
      .get(questionId, accountId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      questionId: Number(row.question_id),
      accountId: row.account_id as string,
      model: row.model as string,
      promptSha256: row.prompt_sha256 as string,
      headlines: JSON.parse(row.headlines_json as string) as LlmRunRecord['headlines'],
      probBps: row.prob_bps === null ? null : Number(row.prob_bps),
      rationale: (row.rationale as string | null) ?? null,
      promptTokens: row.prompt_tokens === null ? null : Number(row.prompt_tokens),
      completionTokens: row.completion_tokens === null ? null : Number(row.completion_tokens),
      error: (row.error as string | null) ?? null,
      createdAtMs: Number(row.created_at),
    };
  }

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

  /** Confirm AND retain the finalized transaction hash (canonical). */
  markConfirmed(dedupKey: string, txHash?: string): void {
    if (txHash) {
      this.db
        .prepare(`UPDATE journal SET status = 'confirmed', tx_hash = ?, error = NULL, updated_at = ? WHERE dedup_key = ?`)
        .run(txHash, Date.now(), dedupKey);
    } else {
      this.db
        .prepare(`UPDATE journal SET status = 'confirmed', updated_at = ? WHERE dedup_key = ?`)
        .run(Date.now(), dedupKey);
    }
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

  /** Public-safe journal projection (no payload/salt/signed bytes/dedup key). */
  listPublicJournal(): PublicJournalRow[] {
    const rows = this.db
      .prepare(
        'SELECT tx_hash, kind, account_id, question_id, status, created_at, updated_at FROM journal ORDER BY id ASC',
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      txHash: r.tx_hash as string | null,
      kind: r.kind as JournalKind,
      accountId: r.account_id as string | null,
      questionId: r.question_id === null ? null : Number(r.question_id),
      status: r.status as JournalStatus,
      createdAtMs: Number(r.created_at),
      updatedAtMs: Number(r.updated_at),
    }));
  }

  // -------------------------------------------------------------------------
  // Forecast Access challenges + sessions (ticket #5)
  // -------------------------------------------------------------------------

  saveAccessChallenge(c: {
    challengeId: string;
    nonceHex: string;
    accountId: string;
    networkId: string;
    contractId: string;
    serviceDomain: string;
    expiresAtMs: number;
    createdAtMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO access_challenges
         (challenge_id, nonce_hex, account_id, network_id, contract_id, service_domain, expires_at_ms, consumed_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(c.challengeId, c.nonceHex, c.accountId, c.networkId, c.contractId, c.serviceDomain, c.expiresAtMs, c.createdAtMs);
  }

  getAccessChallenge(challengeId: string): AccessChallengeRow | null {
    const row = this.db.prepare('SELECT * FROM access_challenges WHERE challenge_id = ?').get(challengeId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      challengeId: row.challenge_id as string,
      nonceHex: row.nonce_hex as string,
      accountId: row.account_id as string,
      networkId: row.network_id as string,
      contractId: row.contract_id as string,
      serviceDomain: row.service_domain as string,
      expiresAtMs: Number(row.expires_at_ms),
      consumedAtMs: row.consumed_at_ms === null ? null : Number(row.consumed_at_ms),
      createdAtMs: Number(row.created_at_ms),
    };
  }

  /**
   * Atomically consume a challenge (single-use). Returns true only when this
   * call performed the one permitted consumption; a concurrent or replayed
   * consume returns false. Expiry is part of the conditional, so an expired
   * challenge can never be consumed.
   */
  consumeAccessChallenge(challengeId: string, nowMs: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE access_challenges SET consumed_at_ms = ?
         WHERE challenge_id = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?`,
      )
      .run(nowMs, challengeId, nowMs);
    return res.changes === 1;
  }

  saveAccessSession(s: {
    sessionId: string;
    accountId: string;
    networkId: string;
    contractId: string;
    createdAtMs: number;
    expiresAtMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO access_sessions (session_id, account_id, network_id, contract_id, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(s.sessionId, s.accountId, s.networkId, s.contractId, s.createdAtMs, s.expiresAtMs);
  }

  getAccessSession(sessionId: string): AccessSessionRow | null {
    const row = this.db.prepare('SELECT * FROM access_sessions WHERE session_id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id as string,
      accountId: row.account_id as string,
      networkId: row.network_id as string,
      contractId: row.contract_id as string,
      createdAtMs: Number(row.created_at_ms),
      expiresAtMs: Number(row.expires_at_ms),
    };
  }

  revokeAccessSession(sessionId: string): void {
    this.db.prepare('DELETE FROM access_sessions WHERE session_id = ?').run(sessionId);
  }

  pruneExpiredAccess(nowMs: number): void {
    this.db.prepare('DELETE FROM access_sessions WHERE expires_at_ms <= ?').run(nowMs);
    this.db
      .prepare('DELETE FROM access_challenges WHERE expires_at_ms <= ? OR consumed_at_ms IS NOT NULL')
      .run(nowMs);
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
