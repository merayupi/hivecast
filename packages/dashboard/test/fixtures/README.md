# Recorded runner responses

Real responses from the runner public HTTP service (`packages/runner`,
read-only `service-entry.ts`), recorded on 2026-11-09 against NEAR testnet
contract `hivecast-market-6c4d.testnet`. Nothing here is hand-written.

| File | Route |
| --- | --- |
| `config.json` | `/config` |
| `agents.json` | `/agents` |
| `disclosure.json` | `/disclosure` |
| `questions.json` | `/questions?from_index=0&limit=100` (q0–q5) |
| `comparison-<id>.json` | `/questions/<id>/comparison` (settled Rounds carry `payouts.computed`) |
| `rationale-<id>.json` | `/questions/<id>/rationale` (all `404 no_commitment`: Herald has not joined a Round yet) |
| `leaderboard.json` | `/analytics/leaderboard` |
| `economics.json` | `/analytics/economics` |
| `activity.json` | `/activity?limit=50` (empty: this runner's local journal has no recorded transactions) |

Check: the six computed payouts of q4 sum to `732563162558815544300000`
yoctoNEAR, the W+F that PRODUCT.md records as received on chain.

At recording time every Round on chain was terminal (q1, q3, q4 settled;
q0, q2, q5 cancelled), so OPEN / CLOSED / snapshot-sale / observing /
RESOLVED have no recorded response yet. Unit tests cover those phases with
synthetic Rounds in the recorded shape; screenshots exist only for the
recorded states (`npm run screenshots`, output in `../screenshots/`).
