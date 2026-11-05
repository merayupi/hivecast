# Dashboard surface brief — HiveCast buyer/evaluator dashboard

Scope: `packages/dashboard/` — the single-page Operate surface for buying/reading Forecast Access, inspecting Rounds, and withdrawing, plus the evaluator's leaderboard/comparison/simulation/provenance views.

Visitor mode: **Operate** (get a job done). Mode rules from `mode-operate.md` govern.

## Direction contract

THESIS: A forecast-wagering dashboard whose every view is a ruled ledger — Questions, Commitments, Reveals, balances, and Brier scores are tabular facts on a bone ground — and whose one signature move is the Round lifecycle drawn as a ruled detent ladder (scheduled → open → closed → resolved → settled/cancelled), so a deadline is a mark on a track, never a marketing countdown tile.

OWN-WORLD: Iron-black ink and one rubric vermilion on unbleached bone; hairline (1px) rules drawn by a real CSS ruling system; dense two-zone tables; small-caps labels. YES/up carries the vermilion; NO/down and cancelled carry a struck/void mark. Live/degraded/critical state colours (green/amber/red) sit on top only where they carry meaning.

STORY: The buyer sees the Question's exact event, source, schedule, and price; buys once; proves ownership with the wallet; re-reads the frozen snapshot. The evaluator sees the eight identities, public Commitment/Reveal status, Brier leaderboard (lower better), coverage, and gas-versus-profit separation — with live/sandbox/simulation never blurred.

FIRST VIEWPORT: Top bar (wordmark, network/contract chip, wallet account + connect/logout). Below it a mode strip (LIVE TESTNET vs SIMULATION, honestly labelled). The primary work area is the Question list as a ruled table: domain chip, event text, phase detent ladder with countdown, participant count (Single-agent marker), snapshot-ready mark; a detail panel opens beside it. Wallet action and balances live in a right rail.

FORM: `rw-centre-rail-reference-setting` — iron-black/vermilion/bone, hairline rules, small-caps apparatus; signature move is the phase-ladder detent track. seed:f80b2b9ecf9856dd

SEED: seed:f80b2b9ecf9856dd (direction contract FORM; aesthetic is the implementer's choice, not a user-approved brand).

## Audience, job, task, proof, constraints

Audience: forecast buyers and demo evaluators on NEAR testnet. Job: buy/read/claim and verify leaderboard/comparison/provenance honestly. Proof: real finalized chain views and the real runner HTTP service; no fabricated Outcome/score/probability/chart row. Constraints: money = yoctoNEAR decimal strings (BigInt), timestamps = ns decimal strings, probability = bps; no private forecasts/salts/keys in payloads; gas never netted into profit.

## Unresolved

No DESIGN.md exists yet (written at finish by the documenter). No image generation; code-led build. Mobile breakpoint 390px.
