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
| `/agents` | GET | the eight algorithmic identities (id, account, supported domains, role) |
| `/analytics/leaderboard` | GET | global Brier leaderboard (lower better, coverage = valid Reveals; no per-account balances) |
| `/analytics/economics` | GET | live account economics: bankroll/available/locked/claimable/pending/received, wagering P&L, Query-Fee income, actual gas — all separate |
| `/questions/:id/comparison` | GET | per-Question comparison (probabilities/scores public only after final Outcome). For SETTLED Rounds each participant also carries `base_payout` / `fee_payout` (yoctoNEAR strings) and the response has `payouts: { computed: true, method }`: the contract has no per-Round settlement view, so payouts are recomputed from on-chain stakes, Reveals, Outcome and `fee_pool` with the shared exact core `settle()`. `null` in every other phase |
| `/questions/:id/rationale` | GET | `llm-news` headlines + rationale, only after that agent's on-chain Reveal (403 `not_revealed` before; 404 when not configured / not a participant) |
| `/activity?limit=50&before=<cursor>` | GET | `{ items: [{ kind, question_id, account_id, tx_hash, finalized_at }], next_cursor, coverage_note }` — finalized transactions the runner signed (`create` · `commit` · `snapshot` · `resolve` · `reveal` · `settle` · `cancel` · `withdraw`), newest first by submission order; `limit` 1–100; pass `next_cursor` as `before` for older pages. `finalized_at` is the including block's `timestamp_nanosec` (cached once known; `null` while the RPC is unavailable). Buyer-signed `buy`/`refund` txs come from buyer wallets and are not recorded by the runner, so they never appear. No salts, payloads, or unrevealed probabilities |
| `/simulation/report` | GET | deterministic offline replay report (reused from `@hivecast/simulation`) |

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

Forecast Access is verified at the approved public product-lifecycle seam only
— no fake contract/mock-chain class exists in the test suite.

- **`harness/access-sandbox.ts`** (`npm run sandbox:access`, Linux only) — the
  real purchase + auth proof. It deploys the actual contract WASM to a real
  `near-sandbox` node and, over the public HTTP service with ephemeral keys,
  proves: `create_question → commit → publish_snapshot → buy_forecast` (real
  purchase) → NEP-413 login → frozen Snapshot delivery, plus the fail-closed
  negatives: non-purchasing account (403), no session (401), replay (401),
  expiry (401), wrong service context (401), wrong recipient/invalid signature
  (401), function-call key (401), concurrent single-consumption, and missing
  private snapshot (503).
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
- `signed_txs` — prepared signed transactions (canonical id + signed bytes)
  persisted BEFORE broadcast for crash-safe rebroadcast.
- `retired_rounds` — durable markers of a Round's observed terminal phase.
- `public_questions` / `public_terminal_rounds` / `public_tx_gas` — materialized
  public read cache (terminal rows and FINAL tx receipts are immutable).

## Transaction resumption and the nonce/expiry guard

Every financial mutation is a durable intent journaled BEFORE broadcast; the
signed bytes (canonical `base58(sha256(unsigned tx))` id) are persisted before
the network send, so a restart never re-signs a fresh nonce for a transaction
that is still in flight.

On restart/tick, `runOnce` reconciles in this order (no blind re-sign):

1. **Business postcondition** — if the on-chain state already reflects the
   intent, confirm and stop.
2. **Old canonical receipt** — `viewTxFinalStatus(oldCanonicalHash, signer)`:
   - `FINAL` + `success_value` → the original landed via a lost response →
     confirm, never re-sign.
   - `FINAL` + failure → definitive failure → safe to re-prepare fresh.
   - non-`FINAL` (included/pending) → preserve the exact signed bytes and wait.
   - definitively unknown (`UnknownTransactionError`) → rebroadcast the SAME
     signed tx to learn the status.
   - RPC unavailable / malformed status → preserve unknown, never re-sign.
3. **Definitive pre-inclusion rejection** (`InvalidNonceError` → `nonceStale`,
   `TransactionExpiredError` → `txExpired`): the tx was NOT included and can
   never be accepted; evict the nonce cache and re-prepare a FRESH signed tx
   (new nonce/blockHash) for the SAME intent, persisted before broadcast.
4. **Network uncertainty** keeps the same signed tx and rebroadcasts it — never
   a fresh sign on a mere timeout.

`createQuestion` uses the same guard, recovering the on-chain spec match (by
`targetKey` + full source/schedule spec) instead of double-creating.

## Config (`hivecast.config.example.json`)

Strict JSON (no comments). Copy to `hivecast.config.json` (git-ignored) and
fill account ids + credential directory. Keys are referenced by path only.
`access` controls the auth/delivery surface: `sessionTtlMs`, `challengeTtlMs`,
`cookieName`, `cookieSecure` (set true when served over https), `serviceDomain`,
and `allowedOrigins` (CORS + CSRF binding for the Vite proxy).

## Package scripts

```sh
npm run test --workspace @hivecast/runner          # seam tests (CLI/HTTP/real RPC)
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
npm run sandbox:recovery --workspace @hivecast/runner                # Linux: real near-sandbox restart/recovery proof (stale nonce + expired blockHash + lost response, single payout)
npm run sandbox:source --workspace @hivecast/runner                  # Linux: real near-sandbox source-boundary proof (equal-close NO, threshold precipitation, missing-source wait/cancel)
```

> **Reviewed-head runtime evidence (integration `77d3fb1`).** The Linux runtime
> matrix (https://github.com/merayupi/hivecast/actions/runs/42062812264) at the
> exact reviewed head passed all three sandbox harnesses: access `2m04s`,
> recovery `2m28s`, source `2m44s` — production WASM/Runner/HTTP access checks,
> real accepted-response loss + same SQLite restart/canonical tx hash/same
> commitment/snapshot/exact one payout, a separate signer consuming the cached
> nonce → one recovered Question, production source parsers over external HTTP
> fixtures (full WIB-day precipitation `<1mm` NO, `=1` YES, `>1` YES; valid
> Commit then resolution-source outage through the full 48h grace →
> Cancellation; completed candle equality → NO). The large Sandbox genesis epoch
> avoids physical tiny-epoch boundary stalls and never shortens product windows
> or testnet time. This is Linux-only; Windows rebuilds are not byte-identical
> to the deployed WASM and the matrix is not claimed to have run on Windows.

## Exact source semantics (`src/source.ts`)

- **Price** — Binance spot `NEARUSDT`, interval `1h`, UTC. Only completed
  candles (`closeTime < cutoff`); resolution validates the target hour
  (`openTime == target`, `closeTime == openTime + 1h − 1ms`, the INCLUSIVE
  Binance interval end) and completed status before deriving `close > open`
  (ties/lower = NO) with exact decimal strings.
- **Weather** — Open-Meteo `ecmwf_ifs` (ECMWF IFS 9 km), one Question per
  city per local day for every entry in `weatherCities` (default Jakarta,
  Singapore, London, Dubai, Tokyo); each Question pins the city's coordinates
  and IANA time zone in its `source_json`; forecast `precipitation_sum` fetched
  before the cutoff (per-run publication time not documented → availability
  `inference`, disclosed); resolution from `archive-api.open-meteo.com/v1/archive`;
  outcome `precipitation_sum >= 1.0 mm`.
- **No silent substitution.** The model/instrument/grid/timezone is parsed from
  the Question's pinned on-chain `source_json` (`parseSourceSpec`), never from
  mutable global config after creation. A missing source waits until
  `resolve_deadline`, then the Round is cancelled; missing history days are
  recorded in the input disclosure, not silently dropped. Every fetch persists
  exact evidence (raw response + hash + model/grid/units/timestamp).

## RPC endpoints and failover

`rpcUrl` is the primary NEAR RPC endpoint. `rpcFallbackUrls` (optional) lists
further endpoints, tried in order when the active one is unavailable: an HTTP
429 / 5xx / 408 answer, a network error, an unsupported method. The endpoint
that answered stays active; the primary is tried again after five minutes.

- Only availability failures fail over. A definitive answer from the chain
  (stale nonce, expired transaction, unknown transaction, missing account) is
  passed through unchanged, because the runner branches on those errors.
- Re-sending the same signed transaction to another endpoint cannot execute it
  twice: the chain identifies a transaction by its hash.
- Each endpoint is retried briefly (3 attempts, about 2 s) on 5xx / 408 before
  the next one is used.
- Logs (`[rpc] hostA -> hostB: reason`) and public 503 bodies name hosts only,
  so an API key in an RPC URL is not disclosed.

## Live-only LLM agent (`llm-news`)

Optional. Create and fund the sub-account once (testnet only; writes its key to
`credentialDirectory`, never prints it):

```bash
npm run setup:llm-account -- 20     # 20 NEAR from the operator
```

Then add the account and an `llm` block to `hivecast.config.json`:

```json
"agentAccounts": { "...": "...", "llm-news": "llm-news.hivecast-1105-0548.testnet" },
"llm": {
  "baseUrl": "https://cloud-api.near.ai/v1",
  "model": "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "apiKeyEnv": "NEARAI_API_KEY",
  "providerLabel": "NEAR AI Cloud · private TEE inference"
}
```

- The key comes from the env var named by `apiKeyEnv` (default `NEARAI_API_KEY`),
  or `llm.apiKey` in the git-ignored config. It is never logged or served.
- Price domain only. Per Round: fetch headlines published before now from the
  RSS feeds in `llm.newsFeeds` (CoinDesk, Cointelegraph, Decrypt by default),
  summarise the last 24 completed candles, ask the model for
  `{"probability": 0-100, "rationale": "..."}`, validate strictly.
- Stake is sized before the call, so an agent below the minimum never spends
  credits. At most `llm.maxAttempts` (default 3) calls per Round; a timeout or
  invalid reply is an abstention, never a guessed number.
- Every attempt (model, prompt SHA-256, headlines, reply, token usage) is stored
  privately before the commit and released through `/questions/:id/rationale`
  only after the on-chain Reveal.
- Not part of `npm run sim`: the replay is offline and deterministic by design.
