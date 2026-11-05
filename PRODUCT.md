# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vite + React + TypeScript + Tailwind CSS + Lucide (decided in the approved implementation plan; no SSR). Wallet integration via `@hot-labs/near-connect@0.12.0` and `near-api-js@7.4.0` against real NEAR testnet; a Vite dev proxy forwards browser requests (with cookies) to the runner public HTTP service. This section is delegated per the approved plan, not a user interview.

## Users

- **Forecast buyer** — reads a Question's exact event, source, schedule, and price; buys Forecast Access exactly once; proves account ownership with a NEP-413 wallet signature; re-reads the frozen snapshot without a second charge; claims eligible refunds and withdraws claimable funds.
- **Agent operator / demo evaluator** — inspects the eight algorithmic identities, public Commitment/Reveal status, Brier leaderboard, and the separation of live testnet / sandbox / simulation, gas, wagering profit, and Query-Fee income.

## Product Purpose

HiveCast is a non-commercial educational forecast-wagering demo on NEAR testnet. Eight algorithmic agents stake NEAR on binary-Outcome probability forecasts (price and weather), buyers pay a fixed Query Fee for early access to the frozen stake-weighted Aggregated Forecast, and Outcomes resolve against pinned sources (Binance NEARUSDT 1h candles; Open-Meteo ECMWF IFS 9 km Kudus precipitation). The dashboard is the buyer-facing surface for buying/reading/claiming, plus the evaluator-facing surface for leaderboard, comparison, provenance, and trust-disclosure.

## Positioning

Forecast wagering, not outcome-share trading: agents compete on Brier score against a frozen stake-weighted aggregate, with Query Fees distributed by Stake (never score) so fee incentives do not distort probability reporting. The product is honest about the trusted Operator (private-forecast knowledge, resolver, delivery, testnet deploy key) — it does not claim decentralized oracles, trustless delivery, or Sybil resistance.

## Operating Context

- A demo evaluator drives the real wallet (Meteor web on testnet), the real contract (`hivecast-market-6c4d.testnet`), the real runner HTTP service (default `http://127.0.0.1:8787`, Vite proxy `http://localhost:5173`), and the offline replay CLI.
- Money is yoctoNEAR decimal strings; timestamps are UTC nanoseconds decimal strings; probability is integer bps (0..=10000). TypeScript never uses `number` for money or nanosecond timestamps.
- Gas is reported separately from wagering profit and Query-Fee income.

## Capabilities and Constraints

- One dated Question has exactly one Round; phases OPEN → CLOSED → RESOLVED → SETTLED, with CANCELLED as an alternate terminal phase (never an Outcome value).
- 1–64 participants per Question; a single participant is labelled **Single-agent Forecast**.
- Aggregated Forecast is the Stake-weighted probability mean, frozen once before sales; sales open only after cutoff and before observation start.
- Query Fee is exactly 0.01 NEAR per Question (default); wrong amount, duplicate, or out-of-window purchases are rejected.
- Ownership proof is a one-use, expiring NEP-413 challenge bound to service domain, network, contract, and account; a public account ID or transaction hash is never proof.
- Claimable / pending / received balances are distinct; Settlement is not proof of received funds.
- Automatic fee refunds cover Cancellation and zero Valid Revealer only; there is no automatic endpoint-failure refund.
- All eight identities exist with six relevant strategies per domain; unsupported specialists abstain.
- Simulation runs two separate 100-NEAR experiments (price 1440 hourly candles, weather 60 daily) over 2026-08-01..09-29, seed 42, with a labelled log-odds comparison; no fabricated historical data, no forced swarm win.
- Terminology: Question, Round, Commitment, Stake, Reveal, Valid Revealer, Aggregated Forecast, Forecast Snapshot, Forecast Access, Query Fee, Outcome, Cancellation, Settlement, Bankroll, Available Balance, Claimable Balance, Single-agent Forecast.

## Brand Commitments

No name beyond "HiveCast" and no visual identity are established. The wordmark and any aesthetic choices are the implementer's, labelled as such — not a user-approved brand.

## Evidence on Hand

- Approved spec (issue #1), implementation plan, glossary, two ADRs, and source-research notes (Binance / Open-Meteo / NEAR constraints).
- Real testnet contract `hivecast-market-6c4d.testnet`, operator/resolver `hivecast-1105-0548.testnet`, eight agent accounts `<id>.hivecast-1105-0548.testnet`, buyer `buyer.hivecast-1105-0548.testnet`.
- Real runner HTTP service (health/config verified by parent at `127.0.0.1:8787`); a real Question `question_id=2` (11–12 UTC today) and `question_id=1` (closed, 6 participants, snapshot ready) exist on-chain.
- No purchased-lifecycle or received-withdrawal proof yet; those are ticket #7 and must not be fabricated here.

## Product Principles

1. **Real chain, honest unavailable** — render actual finalized chain state or an explicit unavailable/empty state; never fabricate an Outcome, a probability, a score, or a fake chart row.
2. **Money is exact, labels are exact** — yoctoNEAR as decimal strings (BigInt), integer-rescaled only for charts; Binance NEAR/USDT is not fiat USD; Kudus IFS is a 9 km model/grid, not a weather station.
3. **Separate the things the spec separates** — live / sandbox / simulation; gas vs wagering profit vs Query-Fee income; Claimable vs pending vs received; public-after-Reveal vs private-before.
4. **Disclose the trust boundary** — Operator privacy/resolver/delivery/deploy-key powers and delivery limits are visible, not hidden.
5. **Brier lower better, no forced win** — report coverage and cohorts with honest denominators; a swarm losing is a valid result.

## Accessibility & Inclusion

Keyboard-operable controls, visible focus states, and a responsive layout from desktop to 390px mobile are required. No specific assistive-technology requirement beyond standard web accessibility was established.
