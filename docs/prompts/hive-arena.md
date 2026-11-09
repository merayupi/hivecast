# HiveCast · "The Hive Arena" — full task brief for Claude Code

You are working in the HiveCast repo (this folder) on Windows. Read this whole
brief before touching code. Work phase by phase, keep a task list, commit at
the end of each phase, and STOP at every point marked **⏸ REVIEW** to show me
the result and wait for "ok".

Deadline: NEAR HACKATHON submissions close **2026-11-14 23:59 UTC**
(2026-11-15 06:59 WIB). Prefer a working, honest Arena with placeholder
sprites over unfinished polish.

---

## 0. What HiveCast is (current state, already built)

A forecasting-swarm demo on NEAR testnet (contract
`hivecast-market-6c4d.testnet`, operator `hivecast-1105-0548.testnet`).

- **Agents:** eight algorithmic agents (`meteo`, `climatology`, `persistence`,
  `momentum`, `meanrev`, `noisy-trend`, `yolo`, `coinflip`) plus one live-only
  LLM agent `llm-news`. The LLM agent uses DeepSeek V4.1 Flash on NEAR AI Cloud
  (private TEE inference), reads headlines published before cutoff plus the last
  24 candles, and its rationale is released only after its on-chain Reveal.
- **Questions:**
  - price: hourly NEAR/USDT, close > open;
  - weather: one Question per city per local day, ≥ 1.0 mm rain in Jakarta,
    Singapore, London, Dubai and Tokyo (`weatherCities` in the runner config).
- **Lifecycle:** commit–reveal → Brier score → weighted-score wagering payouts.
  Humans pay 0.01 NEAR to read the frozen stake-weighted swarm forecast before
  the event (NEP-413 login).
- **Packages:**
  - `contracts/hivecast` (Rust);
  - `packages/core` (strategies, exact accounting);
  - `packages/simulation` (offline deterministic replay, `npm run sim`);
  - `packages/runner` (agent daemon + public HTTP service on :8787);
  - `packages/dashboard` (Vite + React + TS + Tailwind "ruled ledger" UI with
    Live, Leaderboard, Agents, Simulation and Trust views, plus bankroll and
    accuracy charts).
- **Docs:** `README.md`, `RULES.md`, `PRODUCT.md`,
  `packages/dashboard/DESIGN.md`, `packages/runner/README.md`,
  `deploy/DEPLOY.md`.

Read those docs plus `packages/dashboard/src/lib/{api,types,format}.ts` and
`contracts/hivecast/docs/contract-interface.md` first.

## Hard rules (apply to every phase)

1. **Never fabricate.** Every number, probability, Outcome, payout, hash and
   transaction shown or animated comes from the runner API or the chain. An
   animation only replays something that really happened. Missing data → an
   explicit "NO DATA YET" state, never a placeholder value.
2. **Private stays private.** No forecast, aggregate or LLM rationale appears
   unless the API returns it (Forecast Access for buyers; reveal-gated
   rationale).
3. **Label environments.** Live testnet, sandbox and simulation are always
   labelled differently.
4. **Secrets.** Never print, log, commit or copy
   `packages/runner/hivecast.config.json` (contains the NEAR AI key) or
   anything in `~/.near-credentials`.
5. **Stay green.** `npm run build` and `npm test` pass at the end of every
   phase. No new runtime dependencies except the Google Font below.
6. **Leave the ledger alone.** Keep today's dashboard views working unchanged
   as the LEDGER tab.

---

## Phase 0 — Orient (no code changes)

- `git status`; create branch `feat/hive-arena`.
- `npm install`, `npm run build`, `npm test`, `npm run sim`. Report results.
- Delete the leftover test file `art/sprites/_test.aseprite` if it exists.
- Write a short plan (task list) for phases 1–5.

## Phase 1 — Runner data the Arena needs

1. **`GET /activity?limit=50&before=<cursor>`** in `packages/runner`:
   finalized transactions the runner already records (or can read from its
   store): `kind` (create | commit | snapshot | buy | resolve | reveal |
   settle | cancel | refund | withdraw), `question_id`, `account_id`,
   `tx_hash`, `finalized_at` (ns string). Paginated, newest first, no private
   data (no salts, no probabilities before reveal). Add it to the route table
   in `packages/runner/README.md`.
2. **Per-Round payouts** in `/questions/:id/comparison`: for SETTLED Rounds,
   add each participant's `base_payout` and `fee_payout` (yoctoNEAR decimal
   strings) from the contract's settlement data. Check
   `contract-interface.md` for an existing view. If none exists, compute from
   on-chain revealed values with the shared exact accounting in
   `packages/core` and label the field `computed: true`.
3. Unit tests for both. Commit: `feat(runner): activity feed and per-round payouts`.

## Phase 2 — The Arena (placeholder sprites)

Create `packages/dashboard/src/arena/` and make **ARENA the default tab**
(tabs: ARENA / LEDGER / SIMULATION / TRUST).

**Art direction**
- Cozy 16-bit night market inside a giant honeycomb ("the Hive"). Original
  art only.
- Palette (CSS tokens + JS array): night #14101f, deep #241b3a,
  violet #3b2d5c, dusk #5a4a7a, honey #f2b134, amber #e07a1f, wax #fff1c1,
  cream #f7e9d0, yes-green #5bd16b, ash #8a8399, alert-red #e24b4b,
  sky #5fb3e8, rain #3a6fb0, leaf #2f8f5b, ink #0b0a10, white #ffffff.
  Green only for YES/gains, red only for losses/bankrupt.
- Fonts: "Pixelify Sans" (Google Fonts) for titles/HUD only; numbers, hashes
  and accounts in ui-monospace; paragraphs in the system sans.

**Rendering**
- One `<canvas>` at a logical 320×180, scaled by the largest integer that
  fits; `imageSmoothingEnabled = false`; positions snapped to whole pixels.
- requestAnimationFrame loop; pause when the tab is hidden.
- `prefers-reduced-motion`: static poses, no particles, instant transitions.
- The canvas is `aria-hidden`; every fact on it also appears as DOM text.

**Sprites**
- `spriteSheet.ts` loads `/sprites/<id>.png` + `<id>.json` (Aseprite JSON,
  array format, `frameTags`, 24×24 frames), `props.png/json` and
  `arena-bg.png` (320×180).
- If a file is missing or invalid, fall back to a generated placeholder: a
  24×24 rounded square in the agent's main colour with its initial in the
  pixel font.
- The Arena must be fully usable with placeholders only.

**Characters** (`personas.ts`: name, motto, main colour; strategy text comes
from `/agents`)

| agentId | name | motto |
|---|---|---|
| meteo | Nimbus | "The model says…" |
| climatology | Almanac | "History repeats, mostly." |
| persistence | Echo | "Same as yesterday." |
| momentum | Rush | "Up begets up." |
| meanrev | Pendulum | "What rises, settles." |
| noisy-trend | Static | "Trend, plus a little chaos." |
| yolo | Yolo | "All in. Every time." |
| coinflip | Toss | "Heads, I guess." |
| llm-news | Herald | "I read the news so you don't." (LLM · live only) |

Agents not in the selected Round sit dimmed at the side with the reason from
data (domain not supported / abstained / out of capital).

**Layout**
- **HUD:** pixel wordmark HIVECAST, chip `TESTNET · <contractId>`, tabs,
  wallet button.
- **Stage:** the canvas.
- **Right rail — Round card:** question text, domain + city, phase, countdown
  in the event's time zone (`sourceTimeZone`), participants, total stake, and
  the Buy button when the snapshot is on sale.
- **Below the stage:**
  - Hall of Fame: Brier ranking (lower is better), bankroll, rounds joined,
    bankrupt skull;
  - Herald's Scroll: latest revealed LLM rationale and its headlines;
  - On NEAR feed: from `/activity`, explorer links.
- **Mobile 390px:** stacked, no page-level horizontal scroll.

**Scene state machine** (`scene.ts`, pure function of Round + comparison +
rationale + now, unit-tested)
- **OPEN:** each agent with a commitment hash plays `seal` once; its envelope
  joins the Lockbox; counter "SEALED n/m"; hovering an envelope shows the
  truncated hash.
- **CLOSED + snapshot ready:** Oracle Stone pulses; banner "The swarm has
  spoken — read it before the event starts".
- **CLOSED + observing:**
  - price: a candle frame with "OBSERVING UNTIL hh:mm UTC" (no live candle);
  - weather: the city's real local day/night only (no fake weather).
- **RESOLVED:**
  - the Outcome icon drops (candle-up/candle-down, rain-cloud/sun);
  - revealed agents play `reveal`, their probability pops above them, and a
    dart lands on a 0–100% track at that value;
  - non-revealers show "NO REVEAL · score 0".
- **SETTLED:** winners `win`, losers `lose`; coins fly loser → winner sized by
  the real per-agent payout from Phase 1.
- **CANCELLED:** refund tokens float back; banner "Round cancelled — stakes and
  fees refunded".
- Each story plays once per view, and a "Replay" button replays it.
- Default Round: reveal in progress → snapshot on sale → most recent settled.
- A pixel schedule board lists upcoming and recent Rounds.

**Data:** existing endpoints plus the Phase 1 ones. Poll every 10–20 s; the
scene derives from data, not local timers.

**Finish the phase:**
- Write tests: phase → scene state, missing data → NO DATA YET, sprite JSON
  parsing, placeholder fallback.
- Take Playwright screenshots (1440×900 and 390×844) of every scene state
  from recorded real API responses saved as fixtures in
  `packages/dashboard/test/fixtures/`.
- Commit: `feat(dashboard): Hive Arena with placeholder sprites`.
- **⏸ REVIEW**

## Phase 3 — SIMULATION as "Season Replay"

- Agents race in lanes; x = bankroll on a log scale from
  `report.<domain>.series`.
- Controls: play / pause / 1× 4× 16× / scrub. The leader wears a crown; Yolo
  collapses into its `bankrupt` pose.
- Keep the existing accuracy chart and agent table below the race.
- Permanent label: "OFFLINE REPLAY · not live chain activity".
- Commit: `feat(dashboard): season replay`.

## Phase 4 — Sprites in Aseprite (aseprite MCP)

**Setup check:** confirm the `aseprite` MCP tools are available in this Claude
Code session. If they are not, tell me to run:

```
claude mcp add aseprite -e ASEPRITE_PATH="D:/Steam Library/steamapps/common/Aseprite/Aseprite.exe" -- uv --directory C:/Users/merac/Documents/Koding/aseprite-mcp run -m aseprite_mcp
```

Then stop until I confirm.

**Role:** act as a senior pixel artist. Use the dedicated tools; use
`run_lua_script` only with code you wrote in this task. Show every review
gate as a 4× nearest-neighbour preview PNG.

**Style rules**
- Use only the 16-colour palette above, max 7 colours per character.
- No anti-aliasing outside the palette, no gradients, no semi-transparent
  pixels (dither for ghosts).
- Frames are 24×24, never trimmed. The character is about 18–20 px wide and
  20–22 px tall, centred, with feet on row 22.
- 1 px outline (ink/deep), selective lighter outline on lit edges.
- Light from the top-left; 2–3 shade steps per material; no pillow shading.
- No orphan pixels; clean pixel-step curves. Eyes 1×2 or 2×2 with a
  highlight.
- Silhouette test: all nine must be distinguishable as solid black at 1×.

**Characters**

| id | look | colours | prop |
|---|---|---|---|
| meteo | puffy cloud body, brass goggles | cream, sky, amber | tiny umbrella |
| climatology | low wide tortoise, dome shell | leaf, dusk, cream | thick book |
| persistence | tall parrot, curled crest | leaf, honey, red beak | "=" speech bubble |
| momentum | hare, ears swept back | cream, sky | small wave |
| meanrev | sitting cat, upright tail | violet, wax | pocket clock |
| noisy-trend | boxy robot, zig-zag antenna | ash, sky | flickering tip |
| yolo | squat frog, wide grin | leaf, yes-green, red | two dice |
| coinflip | masked raccoon, striped tail | ash, dusk, honey | coin |
| llm-news | hooded owl scribe | violet, honey, wax | scroll + lock badge |

**Animation tags** (same names in every file; body anchored to the baseline
except hops)

| tag | frames | ms per frame | motion |
|---|---|---|---|
| idle | 4 | 160 | 1 px breathing bob, blink on frame 3 |
| seal | 4 | 100 | pull out a wax-sealed envelope, drop it |
| reveal | 4 | 100 | break the seal, raise a card |
| win | 4 | 110 | 2 px hop, honey sparkle |
| lose | 3 | 150 | slump, eyes closed |
| bankrupt | 2 | 300 | ash 50%-dither ghost, tiny skull |

**Props** (`props.aseprite`)
- envelope 8×8: tags `sealed`, `open`
- coin 8×8: `spin`, 4 frames
- dart 8×8, refund-token 8×8, skull 8×8, lock 8×8
- lockbox 32×32: `closed`, `glow`
- oracle-stone 32×32: `idle`, 4-frame pulse
- pedestal 32×16: `lit`, `dim`
- 16×16 icons: `candle-up`, `candle-down`, `rain-cloud`, `sun`

**Background** (`arena-bg.aseprite`, 320×180, static, 3 layers)
- far honeycomb wall;
- mid hall with nine hex pedestals in a shallow arc;
- lanterns;
- keep the centre-top 160×40 clear for the question banner.

**Process — stop at each gate (⏸ REVIEW)**
1. Silhouette sheet of all nine.
2. Flats + outline.
3. Shading + faces.
4. Animations, one character at a time: Yolo and Herald first.
5. Props.
6. Background.

**Export**
- Sources: `art/sprites/*.aseprite`.
- Sheets: PNG + JSON array, frame tags, no trim, 1 px padding,
  `{tag}-{frame}` names → `packages/dashboard/public/sprites/<id>.png/.json`,
  `props.png/.json`, `arena-bg.png`.
- Previews: `art/previews/<id>-4x.gif`, plus a contact sheet
  `art/previews/all-4x.png`.
- Verify the Arena picks the sheets up with no code change.
- Commit: `art: hive arena sprites`.

If time runs short, ship Yolo, Herald, envelope, coin and oracle-stone, and
leave the rest as placeholders.

## Phase 5 — Submission polish

1. **Jakarta replay data:**
   - run `npm run fetch-data --workspace @hivecast/simulation` (needs
     network);
   - run `npm run sim`;
   - fill the "Weather (Jakarta)" row and paragraph in `README.md` that are
     marked `rerun pending` / `TODO` with the real output (Brier for swarm,
     best agent, both baselines) and a one-sentence honest interpretation;
   - never invent numbers.
2. **README:**
   - add "Judge tour — 3 minutes": open Arena (live Round) → click an envelope
     (commitment hash) → click a feed item (explorer) → open a settled Round
     and press Replay → Hall of Fame → SIMULATION at 16× → LEDGER for exact
     numbers;
   - add 2–3 screenshots/GIFs from `art/previews` and the Phase 2 screenshots.
3. Update `packages/dashboard/DESIGN.md` to describe the Arena (and keep the
   ledger description).
4. Final check: `npm run build`, `npm test`, `npm run sim`; `git status` shows
   no secrets. Open a PR from `feat/hive-arena` to `main` with a summary and
   screenshots. Do not push or merge without asking me.
