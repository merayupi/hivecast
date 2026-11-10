# HiveCast market rules

The rules the contract (`contracts/hivecast`) and runner (`packages/runner`)
enforce. The full design rationale is in [HIVECAST_PLAN.md](HIVECAST_PLAN.md)
(Indonesian), [GLOSSARY.md](GLOSSARY.md), and the two ADRs in `docs/adr/`.

## 1. What is traded

**Forecast wagering**, not YES/NO share trading. Each **Question** is a dated
binary event with exactly one **Round**. Agents stake NEAR on a probability
(integer basis points, `0..=10000`). Better-than-average forecasters gain stake;
worse ones lose it.

| Domain | Event (Outcome YES when…) | Source |
| --- | --- | --- |
| Price | the completed 1h candle closes above its open (ties = NO) | Binance spot `NEARUSDT` 1h |
| Weather | daily `precipitation_sum >= 1.0 mm` on the city's local calendar date; one Question per city per day: Jakarta, Singapore, London, Dubai, Tokyo (`weatherCities` in the runner config) | Open-Meteo ECMWF IFS 9 km, grid cell nearest the city's pinned coordinates |

Outcomes come from model/exchange output recorded at resolution, not a weather
station or fiat USD.

## 2. Round lifecycle

```
OPEN ──► CLOSED ──► RESOLVED ──► SETTLED
  │         │
  └─────────┴──► CANCELLED   (no commitments at close, or no Outcome by the deadline)
```

| Phase | Allowed |
| --- | --- |
| OPEN (`open_time <= now < close_time`) | `commit` |
| CLOSED | snapshot sale between `close_time` and `observation_start`, once the snapshot is ready |
| RESOLVED (`resolve_time <= now < resolve_deadline`) | the pinned resolver records one Outcome; agents `reveal` until `resolved_at + reveal_window` |
| SETTLED (`now >= reveal_deadline`) | anyone may `settle`; payouts become Claimable Balances |
| CANCELLED | all stakes and fees become refund claims; no scoring |

Deadlines are half-open: actions are rejected *at* their deadline; settle/cancel
by timeout are accepted *from* it. Default timing:

| | Price | Weather (local time of each city) |
| --- | --- | --- |
| Commitments open | 45 min before observation | 18:00 local the day before |
| Commitments close | 30 min before observation | 23:55 local the day before |
| Forecast on sale | the 30 min before observation | the 5 min before observation |
| Observation | one UTC hour | one local day (00:00–24:00 in the city's IANA time zone) |
| Resolve deadline | 15 min after observation | 48 h after observation |
| Reveal window | 15 min after resolution | 15 min after resolution |

A price forecast is on sale for half of every hour (HH:30–HH:00 UTC), so a
buyer can almost always find one. Closing price commitments 30 minutes early
costs the agents no input: the last completed 1h candle is the same at HH:30
and HH:55. Timing is fixed per Question at creation; Questions created under
an earlier default keep their own schedule.

## 3. Commitments and reveals

- 1 to 64 commitments per Question, one final commitment per account: no
  overwrite, top-up, or withdrawal while the Round is active.
- The attached deposit is the whole stake. Minimum 0.1 NEAR; at most 1M NEAR
  total per Question.
- Commitment = SHA-256 over a versioned, length-framed encoding of
  `(domain/version, contract, question, account, stake, probability_bps, salt)`.
  The salt is CSPRNG-generated and stored before the commit is sent.
- A reveal must come from the committing account, match the hash, arrive in
  RESOLVED before the reveal deadline, and happen once. No valid reveal = score 0
  (the stake still counts in the pool; it is not confiscated outright).
- One participant is allowed and labelled **Single-agent Forecast**.

## 4. Scoring and payouts (exact integers)

With `S = 100_000_000`, outcome `o ∈ {0, 10000}`, stake `w_i`, probability `p_i`:

```
score     s_i = S − (p_i − o)²          (0 for no valid reveal)
pool      W   = Σ w_i                   (all accepted commitments)
weighted  A   = Σ w_i · s_i
payout    base_i = w_i · (W·S + W·s_i − A) / (W·S)
```

This is weighted-score wagering: score above the stake-weighted average and
you profit; below it and you lose; you can never lose more than your stake;
reporting your true belief maximises expected payout. `Σ base_i = W` exactly.

**Query fees** `F` are split by **stake** among valid revealers
(`fee_i = F · w_i / V`, `V = Σ w_i` over valid revealers), never by score, so
fees do not distort probability reporting. If nobody reveals validly, buyers are
refunded.

Rounding: floor each share, then hand out the remaining yoctoNEAR by largest
remainder, ties by account ID ascending. Stake and fee pots are rounded
separately. No dust goes to the operator. Products use checked U256 arithmetic;
`W, F <= 10^30` yoctoNEAR.

## 5. Forecast Access (what buyers pay for)

- Product: the **stake-weighted mean probability**
  `Σ w_i · p_i / Σ w_i`, frozen once after commitments close.
- Price: exactly **0.01 NEAR** per Question. Wrong amount, duplicate purchase,
  snapshot not ready, or out-of-window purchases are rejected.
- Sales run from `close_time` until `observation_start`.
- Reading requires a one-use, expiring NEP-413 wallet signature bound to the
  service domain, network, contract, and account. Knowing an account ID or a
  transaction hash is not enough. Re-reading the same snapshot is free.
- Access is *earlier* information, not exclusivity: buyers may share it, and
  reveals make forecasts public later.

## 6. Agents

Eight algorithmic identities plus one optional live-only LLM identity, each on
its own sub-account `<id>.hivecast-1105-0548.testnet`, all controlled by one
operator.

| Agent | Domains | Strategy |
| --- | --- | --- |
| `meteo` | weather | logistic map of the pre-cutoff IFS precipitation forecast |
| `climatology` | weather | event frequency over the trailing 365 days |
| `persistence` | both | repeat the last known outcome (80/20) |
| `momentum` | price | continue the 24h trend |
| `meanrev` | price | revert toward the 24h mean |
| `noisy-trend` | both | trend signal plus seeded noise |
| `yolo` | both | always 0% or 100% |
| `coinflip` | both | seeded random probability |
| `llm-news` | price, **live only** | LLM on NEAR AI Cloud (private TEE) reads headlines published before cutoff + last 24 candles; returns `{probability 0–100, rationale}`; abstains on timeout/invalid output; max 3 calls per Round. Rationale is published only after its Reveal. Not in the offline replay. |

Stake = floor(10% of Available Balance). An agent below the 0.1 NEAR minimum
skips the Round instead of raising its stake.

## 7. Trust boundary (stated, not hidden)

The operator knows private forecasts before reveal, records Outcomes through the
pinned resolver, serves delivery, and holds the testnet deploy key. The contract
verifies commitments and money; it does not prove the source or the delivery.
There is no Sybil-resistance claim and no automatic refund for a failed delivery
endpoint (automatic refunds cover Cancellation and zero valid revealers only).
