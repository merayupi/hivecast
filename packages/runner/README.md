# @hivecast/runner

Durable autonomous runner for HiveCast. Real NEAR RPC + ed25519 signing, the
canonical commitment encoding, private SQLite persistence, the exact
Binance/Open-Meteo source fetchers, and the public runtime interface the
Forecast Access server (ticket #5) will consume.

There is exactly **one** execution implementation: `NearChainClient` (real RPC
+ signing). A "real sandbox" is an actual `near-sandbox` RPC endpoint + WASM,
reached by pointing `rpcUrl` at it — there is no in-process duplicate of the
contract and no mock-success chain.

## Public entrypoint

```ts
import {
  Runner, LiveSourceProvider, Runtime, Store, NearChainClient,
  commitmentHash, generateSalt, loadConfig,
  computePriceSchedule, computeWeatherSchedule,
  sourceDefinition, questionText, parseSourceSpec,
  fetchCompletedCandles, fetchPriceResolution,
  fetchWeatherForecast, fetchWeatherResolution, fetchWeatherHistoryDay,
} from '@hivecast/runner';
```

## Chain interface (`src/chain/types.ts`)

```ts
interface ChainClient {
  readonly contractId: string;
  nowNs(): bigint;   // UTC ns wall clock

  // Views (read-only; money/timestamps are decimal strings)
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
  // from `credentialDirectory/<account>.json` (near CLI layout).
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

**Execution semantics.** Transactions wait for `FINAL`; a mutation is `success`
only when a proven `SuccessValue` is parsed. A definitive `Failure` is an
error; an included transaction with no observed `SuccessValue` returns
`success: false` with its `txHash` preserved so the journal reconciles by
re-verifying against the chain before any resend. A rejected broadcast (no
txHash) is `failed`, but the journal still reconciles before resending.

**Wire shape.** `create_question` takes `{ "spec": { …QuestionSpec } }`
(nested), matching `lib.rs` `create_question(&mut self, spec: QuestionSpec)`.

## Runtime interface (`src/runtime.ts`) — for ticket #5

- `getPublicConfig()` → network/contract/operator/resolver/rpc/seed/mins. No
  credential dir, db path, keys, salts, or private forecasts.
- `getPublicQuestion(id)`, `listPublicQuestions(from, limit)`,
  `listLeaderboard(id)` → finalized public chain views.
- `getSnapshotDto(id)` → **private** frozen aggregate only
  (`aggregateBps`, `totalStakeYocto`, `participantCount`, `snapshotId`). Caller
  MUST authenticate the buyer before returning it. Per-agent probabilities and
  salts are never in the DTO.
- `toOwnerSafeQuestionDto(q)`, `getLifecycleStatus(id)`,
  `listLocalQuestions()`, `resume()`, `tick()`.

## HTTP interface (`src/service.ts`, entry `src/service-entry.ts`)

Public endpoints only; never administrative signing, private forecasts, salts,
signing keys, or the private database. Claim/withdraw remain buyer-wallet-signed
contract calls; the service never impersonates a buyer.

| Route | Method | Response |
| --- | --- | --- |
| `/health` | GET | `{ status: "ok", domain: "hivecast-runner" }` |
| `/config` | GET | public config (no keys) |
| `/disclosure` | GET | operator trust disclosure + delivery limits |
| `/auth/challenge` | POST | mint a one-use NEP-413 challenge (body `{ account_id }`) |
| `/auth/verify` | POST | verify signature → `Set-Cookie` HttpOnly session (body `{ challenge_id, account_id, public_key, signature }`) |
| `/auth/logout` | POST | clear session cookie |
| `/forecast/:id` | GET | frozen Forecast Snapshot (requires session cookie + finalized `has_bought`) |
| `/account/:id/balance` | GET | finalized `get_balance` (claimable/pending/received) |
| `/account/:id/pending-withdrawals` | GET | finalized pending withdrawals |
| `/questions/:id/buyers` | GET | finalized buyer receipts |
| `/questions/:id/receipt/:account` | GET | finalized buyer receipt |
| `/questions?from_index&limit` | GET | `{ questions: QuestionView[] }` |
| `/questions/:id` | GET | `QuestionView` or 404 |
| `/questions/:id/leaderboard` | GET | `{ question_id, entries: [{accountId, stake, revealed}] }` |

### Forecast Access auth (ticket #5)

Ownership is a one-use, expiring NEP-413 challenge bound to the account,
service domain, network, contract, challenge identity, and expiry. The server
reconstructs the exact signed bytes (`SHA-256(LE32(2147484061) ++ Borsh(payload))`,
`callbackUrl = None`) from durable challenge state + config — never from the
client — then verifies the Ed25519 signature and checks the claimed key is a
finalized **FullAccess** key of the account before issuing a session. A public
account id or transaction hash is never proof. Errors are `{ error, message }`
with stable codes: `challenge_not_found`, `challenge_expired`,
`challenge_consumed`, `account_mismatch`, `invalid_signature`,
`not_full_access`, `unauthenticated`, `not_purchased`,
`snapshot_unavailable`.

Delivery serves the exact frozen Forecast Snapshot only after a session AND a
finalized `has_bought(questionId, accountId)`; the frozen snapshot id must equal
the on-chain `snapshot_id`. Repeat access returns the same payload with no new
charge. A lost private snapshot or RPC failure returns `snapshot_unavailable`
(503) — never fabricated data, never an automatic delivery refund.

### Access proof surface

- **`test/access.test.ts`** — boundary tests for the auth/delivery semantics
  (replay, expiry, wrong context, function-call key, concurrency,
  honest-unavailable) at the HTTP seam. They use a controllable chain adapter
  and genuine near-api-js Ed25519 NEP-413 signatures; they do **not** claim a
  real contract purchase or a real FullAccess key on a live chain.
- **`harness/access-sandbox.ts`** (`npm run sandbox:access`, Linux only) — the
  real purchase proof. It deploys the actual contract WASM to a real
  `near-sandbox` node and drives `create_question → commit → publish_snapshot →
  buy_forecast → NEP-413 login → frozen snapshot delivery` with ephemeral keys.
- **`harness/auth-smoke.ts`** (`npm run smoke:auth`) — real-testnet NEP-413
  FullAccess login only; it does **not** purchase anything and reports the
  honest `not_purchased` result (no fabricated purchase proof).

## SQLite schema (`src/store.ts`, `node:sqlite`)

Private database (never committed). The database is **bound to one
(network, contract)** at open and refuses to mix deployments, so a bare
question_id cannot be reused across contracts. Tables:

- `meta` — deployment binding.
- `questions` — locally-tracked Questions (schedule, source, participants).
- `forecasts` — forecast + CSPRNG salt, **written before the commit tx**.
- `reservations` — per-(account, round) capital reservation (released once the
  commit is confirmed, since the deposit then left the wallet).
- `snapshots` — immutable Forecast Snapshots (CSPRNG id persisted once).
- `journal` — idempotent send log (`pending` → `submitted` → `confirmed` /
  `failed`), keyed by a stable dedup key; intent is written **before**
  broadcast and reconciled against the chain before any resend.
- `evidence` — exact source evidence (raw response, request URL, model, grid,
  timezone, units, hash) per input/resolve stage.
- `withdraw_attempts` — per-(account, amount) attempt counter.
- `access_challenges` — one-use NEP-413 challenges (nonce, bound account/network/
  contract/domain, expiry, atomic consume).
- `access_sessions` — authenticated buyer sessions (HttpOnly cookie value).

## Config (`hivecast.config.example.json`)

Strict JSON (no comments). Copy to `hivecast.config.json` (git-ignored) and
fill account ids + credential directory. Keys are referenced by path only.
`access` controls the auth/delivery surface: `sessionTtlMs`, `challengeTtlMs`,
`cookieName`, `cookieSecure` (set true when served over https), `serviceDomain`,
and `allowedOrigins` (CORS + CSRF binding for the Vite proxy).

## Package scripts

```sh
npm run test --workspace @hivecast/runner          # seam tests (CLI/HTTP/real RPC + Forecast Access boundary)
npm run typecheck --workspace @hivecast/runner
npm run cli --workspace @hivecast/runner -- create-price <hourStartMs>
npm run cli --workspace @hivecast/runner -- create-weather <YYYY-MM-DD>
npm run cli --workspace @hivecast/runner -- tick
npm run cli --workspace @hivecast/runner -- run      # autonomous scheduler (graceful stop)
npm run cli --workspace @hivecast/runner -- status
npm run cli --workspace @hivecast/runner -- snapshot <questionId>   # private aggregate
npm run service --workspace @hivecast/runner                          # public HTTP
npm run harness:testnet --workspace @hivecast/runner -- price         # real-chain lifecycle
npm run smoke:auth --workspace @hivecast/runner                       # real-testnet NEP-413 login (no purchase)
npm run sandbox:access --workspace @hivecast/runner                   # Linux: real near-sandbox purchase + delivery proof
```

## Exact source semantics (`src/source.ts`)

- **Price** — Binance spot `NEARUSDT`, interval `1h`, UTC. Only completed
  candles (`closeTime < cutoff`); resolution validates the target hour
  (`openTime == target`, `closeTime == openTime + 1h − 1ms`, the INCLUSIVE
  Binance interval end) and completed status before deriving `close > open`
  (ties/lower = NO) with exact decimal strings.
- **Weather** — Open-Meteo `ecmwf_ifs` (ECMWF IFS 9 km; `ecmwf_ifs04` is a
  0.04° cut and returns `null` — it is NOT used), Kudus
  (`-6.8049,110.8397`), `Asia/Jakarta`; forecast `precipitation_sum` fetched
  before the cutoff (per-run publication time not documented → availability
  `inference`, disclosed); resolution from `archive-api.open-meteo.com/v1/archive`;
  outcome `precipitation_sum >= 1.0 mm`.
- **No silent substitution.** The model/instrument/grid/timezone is parsed from
  the Question's pinned on-chain `source_json` (`parseSourceSpec`), never from
  mutable global config after creation. A missing source waits until
  `resolve_deadline`, then the Round is cancelled; missing history days are
  recorded in the input disclosure, not silently dropped. Every fetch persists
  exact evidence (raw response + hash + model/grid/units/timestamp).
