# @hivecast/runner

Durable autonomous runner for HiveCast. Real NEAR RPC + ed25519 signing, the
canonical commitment encoding, private SQLite persistence, the exact
Binance/Open-Meteo source fetchers, and the public runtime interface the
Forecast Access server (ticket #5) will consume.

Nothing here is a mock-success stub: `EmulatedChainClient` is a faithful
in-process re-implementation of the contract state machine (phase windows,
one-commit-per-account, reveal hash matching, exactly-once withdrawal) used to
exercise lifecycle/restart scenarios on any platform. Real chain proof uses
`NearChainClient` against a corrected testnet deployment (tracked by #7).

## Public entrypoint

```ts
import {
  Runner, LiveSourceProvider, Runtime, Store,
  NearChainClient, EmulatedChainClient,
  commitmentHash, generateSalt,
  loadConfig, computePriceSchedule, computeWeatherSchedule,
  sourceDefinition, questionText,
  fetchCompletedCandles, fetchPriceResolution,
  fetchWeatherForecast, fetchWeatherResolution,
} from '@hivecast/runner';
```

## Chain interface (`src/chain/types.ts`)

The runner depends on a single `ChainClient`:

```ts
interface ChainClient {
  readonly contractId: string;
  readonly mode: 'rpc' | 'emulated';
  nowNs(): bigint;                       // UTC ns (emulated clock or wall clock)

  // Views (read-only, decimal strings for money/timestamps)
  getContractState(): Promise<ContractState>;
  getQuestion(id: number): Promise<QuestionView | null>;
  listQuestions(from: number, limit: number): Promise<QuestionView[]>;
  getCommitment(qid: number, account: string): Promise<CommitmentView | null>;
  listCommitments(qid: number, from: number, limit: number): Promise<CommitmentView[]>;
  getBalance(account: string): Promise<BalanceView>;
  hasBought(qid: number, account: string): Promise<boolean>;
  getBuyerReceipt(qid: number, account: string): Promise<BuyerReceiptView | null>;
  listBuyers(qid: number, from: number, limit: number): Promise<BuyerReceiptView[]>;
  getPendingWithdrawal(nonce: number): Promise<PendingWithdrawalView | null>;
  listPendingWithdrawals(account: string, from: number, limit: number): Promise<PendingWithdrawalView[]>;
  viewAccountBalance(account: string): Promise<bigint>;

  // Mutations (sign + send). `signer` is an account id whose key is loaded
  // from `credentialDirectory/<account>.json` (near CLI layout) or the
  // in-memory `credentials` map supplied by the caller.
  createQuestion(spec: QuestionSpecArgs, signer: string): Promise<CallOutcome>;
  commit(qid: number, hash: string, stakeYocto: bigint, signer: string): Promise<CallOutcome>;
  publishSnapshot(qid: number, snapshotId: string, signer: string): Promise<CallOutcome>;
  buyForecast(qid: number, priceYocto: bigint, signer: string): Promise<CallOutcome>;
  resolve(qid: number, outcome: boolean, signer: string): Promise<CallOutcome>;
  reveal(qid: number, probBps: number, salt: string, signer: string): Promise<CallOutcome>;
  settle(qid: number, signer: string): Promise<CallOutcome>;
  cancel(qid: number, signer: string): Promise<CallOutcome>;
  claimBuyerRefund(qid: number, signer: string): Promise<CallOutcome>;
  withdraw(amountYocto: bigint, signer: string): Promise<CallOutcome>;
}
```

> **Wire correction.** `create_question` takes `{ "spec": { …QuestionSpec } }`
> (nested), per the actual `lib.rs` signature `create_question(&mut self,
> spec: QuestionSpec)`. `NearChainClient` and `EmulatedChainClient` both send
> this shape. The flattened shape shown in an earlier interface draft is wrong
> and was corrected on the integration branch.

## Runtime interface (`src/runtime.ts`)

The seam the access server consumes. No secrets reach any of these surfaces:

- `getPublicConfig()` → network/contract/operator/resolver/rpc/seed/mins. No
  credential dir, db path, keys, salts, or private forecasts.
- `getPublicQuestion(id)`, `listPublicQuestions(from, limit)`,
  `listLeaderboard(id)` → finalized public chain views.
- `getSnapshotDto(id)` → **private** frozen aggregate only
  (`aggregateBps`, `totalStakeYocto`, `participantCount`, `snapshotId`). The
  caller MUST authenticate the buyer (ticket #5) before returning this.
  Per-agent probabilities and salts are never in the DTO.
- `toOwnerSafeQuestionDto(q)`, `getLifecycleStatus(id)`,
  `listLocalQuestions()`, `resume()`, `tick()`.

## HTTP interface (`src/service.ts`, entry `src/service-entry.ts`)

Deliberately narrow public endpoints. Administrative signing and private
forecasts are never routed through HTTP:

| Route | Method | Response |
| --- | --- | --- |
| `/health` | GET | `{ status: "ok", domain: "hivecast-runner" }` |
| `/config` | GET | public config (no keys) |
| `/questions?from_index&limit` | GET | `{ questions: QuestionView[] }` |
| `/questions/:id` | GET | `QuestionView` or 404 |
| `/questions/:id/leaderboard` | GET | `{ question_id, entries: [{accountId, stake, revealed}] }` |

## RPC interface

- Views: NEAR `query` `call_function` with decimal-string args, JSON return.
- Mutations: signed `FunctionCall` transactions, `waitUntil: INCLUDED_FINAL`,
  `throwOnFailure: false`; success/failure is derived from the transaction
  `status` (`SuccessValue` vs `Failure`) and parsed `SuccessValue` bytes.
- Money (`stake`, `deposit`, `amount`, `price`) and timestamps cross the JSON
  boundary as **decimal strings** — never `number`.

## SQLite schema (`src/store.ts`, `node:sqlite`)

Private database (never committed). Tables:

- `questions` — locally-tracked Questions (schedule, source, participants).
- `forecasts` — forecast + CSPRNG salt, **written before the commit tx**.
- `reservations` — per-(account, round) capital reservation.
- `snapshots` — immutable Forecast Snapshots (aggregate + per-entry stake, but
  entries are private; only the aggregate is ever serialized to a DTO).
- `journal` — idempotent send log (`pending` → `submitted` → `confirmed` /
  `failed`), keyed by a stable dedup key so a restart reconciles against the
  chain instead of re-sending or regenerating a salt.
- `withdraw_attempts` — per-(account, amount) attempt counter so a failed
  transfer (pending → restored) can be retried without double-withdrawing.

## Config (`hivecast.config.example.json`)

Copy to `hivecast.config.json` (git-ignored) and fill account ids + credential
directory. Keys are referenced by path only. `chainMode: "emulated"` needs no
keys or network; `"rpc"` signs real testnet transactions.

## Package scripts

```sh
npm run test --workspace @hivecast/runner            # 25 tests (commitment/lifecycle/store/schedule/runtime)
npm run typecheck --workspace @hivecast/runner
npm run cli --workspace @hivecast/runner -- create-price <hourStartMs>
npm run cli --workspace @hivecast/runner -- create-weather <YYYY-MM-DD>
npm run cli --workspace @hivecast/runner -- tick
npm run cli --workspace @hivecast/runner -- status
npm run cli --workspace @hivecast/runner -- snapshot <questionId>   # private aggregate
npm run service --workspace @hivecast/runner                         # public HTTP
npm run harness:testnet --workspace @hivecast/runner -- price        # real-chain lifecycle
```

## Exact source semantics (`src/source.ts`)

- **Price** — Binance spot `NEARUSDT`, interval `1h`, UTC. Only completed
  candles (`closeTime < cutoff`); outcome `close > open` (ties/lower = NO),
  compared with exact decimal strings.
- **Weather** — Open-Meteo `ecmwf_ifs04` (IFS 9 km), Kudus
  (`-6.8049,110.8397`), `Asia/Jakarta`; forecast `precipitation_sum` fetched
  before the cutoff (per-run publication time is not documented by Open-Meteo →
  availability `inference`, disclosed in evidence); resolution from
  `archive-api.open-meteo.com/v1/archive`; outcome `precipitation_sum >= 1.0 mm`.
- **No silent substitution.** A missing/failed source waits until
  `resolve_deadline`, then the Round is cancelled (timeout), never resolved
  from a different model/instrument.
