/**
 * Runner domain types. Monetary amounts are `bigint` yoctoNEAR internally and
 * decimal strings at the JSON/RPC boundary (per the wire contract). Timestamps
 * are UTC nanoseconds, carried as `bigint` and serialized as decimal strings.
 */

import type { AgentId, Domain } from '@hivecast/core';

// ---------------------------------------------------------------------------
// Chain wire types (mirror of the contract JSON)
// ---------------------------------------------------------------------------

export type Phase = 'open' | 'closed' | 'resolved' | 'settled' | 'cancelled';

export interface ContractState {
  operator: string;
  next_question_id: number;
  next_nonce: number;
  question_count: number;
}

export interface QuestionView {
  question_id: number;
  text: string;
  event_definition: string;
  source: string;
  resolver: string;
  open_time: string;
  close_time: string;
  observation_start: string;
  observation_end: string;
  resolve_time: string;
  resolve_deadline: string;
  reveal_window: string;
  access_price: string;
  min_stake: string;
  phase: Phase;
  outcome: boolean | null;
  resolved_at: string | null;
  reveal_deadline: string | null;
  snapshot_ready: boolean;
  snapshot_id: string | null;
  total_stake: string;
  fee_pool: string;
  participant_count: number;
  buyer_count: number;
}

export interface CommitmentView {
  question_id: number;
  account_id: string;
  stake: string;
  hash: string;
  revealed: number | null;
}

export interface BuyerReceiptView {
  question_id: number;
  account_id: string;
  price: string;
  refunded: boolean;
}

export interface BalanceView {
  account_id: string;
  claimable: string;
  pending: string;
  received: string;
}

export interface PendingWithdrawalView {
  nonce: number;
  account_id: string;
  amount: string;
  status: 'pending' | 'delivered' | 'restored';
}

// ---------------------------------------------------------------------------
// Local (persisted) records
// ---------------------------------------------------------------------------

export interface SourceDefinition {
  kind: Domain;
  /** Machine-readable, contract-stored source payload (see schedule.ts). */
  json: string;
  /** Human-readable summary for `event_definition`. */
  label: string;
}

/** A locally-created Question plus its durable schedule. */
export interface LocalQuestion {
  questionId: number;
  domain: Domain;
  text: string;
  eventDefinition: string;
  sourceJson: string;
  sourceLabel: string;
  resolver: string;
  openTimeNs: bigint;
  closeTimeNs: bigint;
  observationStartNs: bigint;
  observationEndNs: bigint;
  resolveTimeNs: bigint;
  resolveDeadlineNs: bigint;
  revealWindowNs: bigint;
  accessPrice: bigint;
  minStake: bigint;
  /** Participating agent account ids, in deterministic order. */
  participants: { agentId: AgentId; accountId: string }[];
}

/** A persisted forecast + salt, written before the commit transaction. */
export interface ForecastRecord {
  questionId: number;
  agentId: AgentId;
  accountId: string;
  probBps: number;
  salt: string;
  stakeYocto: bigint;
  commitmentHash: string;
}

/** Immutable Forecast Snapshot (frozen once all forecasts match commitments). */
export interface SnapshotRecord {
  questionId: number;
  snapshotId: string;
  aggregateBps: number;
  totalStakeYocto: bigint;
  participantCount: number;
  entries: { accountId: string; probBps: number; stakeYocto: string }[];
}

// ---------------------------------------------------------------------------
// Transaction journal
// ---------------------------------------------------------------------------

export type JournalKind =
  | 'create_question'
  | 'commit'
  | 'publish_snapshot'
  | 'resolve'
  | 'reveal'
  | 'settle'
  | 'cancel'
  | 'withdraw';

export type JournalStatus = 'pending' | 'submitted' | 'confirmed' | 'failed';

export interface JournalEntry {
  id: number;
  nonce: string;
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

// ---------------------------------------------------------------------------
// Source evidence
// ---------------------------------------------------------------------------

export interface SourceEvidence {
  source: string;
  fetchedAtMs: number;
  availability: 'observed' | 'inference';
  note: string;
  attribution: string;
}
