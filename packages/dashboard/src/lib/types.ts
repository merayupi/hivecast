/**
 * Wire DTOs mirroring the runner public HTTP service and the contract views.
 * Money = yoctoNEAR decimal strings; timestamps = UTC ns decimal strings;
 * probability = bps (number). Only counts/bps/ids are JSON numbers.
 */

export type Domain = 'price' | 'weather';
export type Phase = 'open' | 'closed' | 'resolved' | 'settled' | 'cancelled';

export interface PublicConfig {
  networkId: string;
  contractId: string;
  operatorId: string;
  resolverId: string;
  rpcUrl: string;
  seed: number;
  minStakeYocto: string;
  accessPriceYocto: string;
  domain: 'runner';
}

export interface AgentRosterEntry {
  agentId: string;
  accountId: string;
  domains: string[];
  role: 'weather' | 'price' | 'both';
}

export interface TrustDisclosure {
  operator_powers: string[];
  delivery_limits: string[];
  claim_withdrawal: string[];
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

export interface ChallengeDto {
  challenge_id: string;
  nonce: string;
  message: string;
  recipient: string;
  account_id: string;
  network_id: string;
  contract_id: string;
  expires_at: string;
}

export interface SessionDto {
  account_id: string;
  network_id: string;
  contract_id: string;
  expires_at: string;
}

export interface ForecastDeliveryDto {
  question_id: number;
  snapshot_id: string;
  aggregate_bps: number;
  total_stake_yocto: string;
  participant_count: number;
  single_agent: boolean;
  domain: Domain;
  text: string;
  event_definition: string;
  source: string;
  source_label: string;
  observation_start: string;
  observation_end: string;
  access_price: string;
}

export interface BalanceView {
  account_id: string;
  claimable: string;
  pending: string;
  received: string;
}

export interface BuyerReceiptView {
  question_id: number;
  account_id: string;
  price: string;
  refunded: boolean;
}

export interface PendingWithdrawalView {
  nonce: number;
  account_id: string;
  amount: string;
  status: 'pending' | 'delivered' | 'restored';
}

export interface ComparisonParticipant {
  account_id: string;
  stake: string;
  commitment_hash: string;
  revealed_prob_bps: number | null;
  valid_revealer: boolean;
  brier: number | null;
}

export interface QuestionComparison {
  question_id: number;
  phase: Phase;
  outcome: boolean | null;
  resolved_at: string | null;
  reveal_deadline: string | null;
  scores_public: boolean;
  participant_count: number;
  total_stake: string;
  single_agent: boolean;
  participants: ComparisonParticipant[];
}

export interface LeaderboardEntry {
  account_id: string;
  rounds_participated: number;
  rounds_revealed: number;
  brier_mean: number | null;
  brier_sum_sq: string;
  total_stake: string;
  locked_stake: string;
}

export interface GlobalLeaderboard {
  network_id: string;
  contract_id: string;
  generated_at: string;
  total_questions: number;
  resolved_questions: number;
  gas_disclosure: string;
  entries: LeaderboardEntry[];
}

export interface AccountEconomics {
  account_id: string;
  bankroll: string | null;
  available: string | null;
  locked_stake: string;
  claimable: string;
  pending: string;
  received: string;
  wagering_pnl: string;
  fee_income: string;
  gas_burnt: string;
  participated: boolean;
}

export interface EconomicsReport {
  network_id: string;
  contract_id: string;
  generated_at: string;
  separation_note: string;
  accounts: AccountEconomics[];
}

export interface AgentRoundRecord {
  roundKey: string;
  probabilityBps: number;
  stake: string;
  basePayout: string;
  feePayout: string;
  outcome: 0 | 10_000;
  brier: number;
}

export interface AgentSummary {
  agentId: string;
  domain: Domain;
  roundsForecast: number;
  roundsParticipated: number;
  roundsAbstained: number;
  roundsSkippedBelowMin: number;
  finalBankroll: string;
  totalStaked: string;
  wageringPnl: string;
  feeIncome: string;
  brierMean: number | null;
  brierRounds: number;
}

export interface AggregateSummary {
  domain: Domain;
  kind: 'equal-weight' | 'stake-weighted';
  rounds: number;
  brierMean: number;
  logOddsBrierMean: number;
  logOddsClip: string;
}

export interface DomainResult {
  domain: Domain;
  seed: number;
  totalRounds: number;
  roundsWithParticipants: number;
  initialCapital: string;
  peakLockedStake: string;
  agents: AgentSummary[];
  aggregates: AggregateSummary[];
  participants: string[];
}

export interface ReplayReport {
  seed: number;
  config: {
    initialCapitalNear: string;
    stakeFloor: string;
    minStakeNear: string;
    queryFeeNear: string;
    evalPeriod: { start: string; end: string };
    priceRounds: number;
    weatherRounds: number;
  };
  availability: Array<{ id: string; availability: string; availableAt: string | null; note: string }>;
  price: DomainResult;
  weather: DomainResult;
}

export interface ApiError {
  error: string;
  message?: string;
}
