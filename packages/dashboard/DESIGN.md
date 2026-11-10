# Design

<!-- impeccable:design-schema 1 -->

## Two surfaces

The dashboard has two visual worlds under one pixel HUD (wordmark HIVECAST,
`TESTNET · <contract>` chip, tabs, "? How it works", wallet): the **Hive
Arena** (ARENA, AGENTS and the REPLAY race) and the **ruled ledger** (ROUNDS
and GUIDE, plus the replay's charts and table under the race). The ledger
keeps its own light paper theme and is shown as a sheet inside the Arena's
night frame, so every tab shares one surface. Everything below "World"
describes the ledger and is unchanged.

Tabs are named for what a visitor finds there; hash ids stay stable for old
links: ARENA, ROUNDS (`#ledger`), AGENTS (`#agents`), REPLAY (`#simulation`),
GUIDE (`#trust`).

## Orientation

A visitor does not bet; the agents do. Three things say so without a click:

- **Tour:** a five-step modal on the first visit (remembered in
  `localStorage`), reopened from "? How it works".
- **Arena lead:** one sentence above the stage with the visitor's role.
- **Sale strip:** the next forecast sale with a countdown; while a forecast is
  on sale it carries the primary **Buy forecast** button, which opens that
  Round in ROUNDS.

Under the stage, the **Round steps** bar shows Commit → Forecast on sale →
Event → Reveal → Payout with a NOW line and a YOU CAN line, derived only from
the Round's on-chain schedule and phase (`guide.ts`).

## The Hive Arena

- **World:** a cozy 16-bit night market inside a giant honeycomb, the Hive.
  Original art only (`art/`, Aseprite).
- **Palette** (CSS `--hive-*` tokens and `palette.ts`): night `#14101f`, deep
  `#241b3a`, violet `#3b2d5c`, dusk `#5a4a7a`, honey `#f2b134`, amber
  `#e07a1f`, wax `#fff1c1`, cream `#f7e9d0`, yes-green `#5bd16b`, ash
  `#8a8399`, alert-red `#e24b4b`, sky `#5fb3e8`, rain `#3a6fb0`, leaf
  `#2f8f5b`, ink `#0b0a10`, white `#ffffff`. Green only for YES and gains,
  red only for losses and out-of-capital. Sprites use at most 7 of these each.
- **Type:** Pixelify Sans (Google Fonts) for titles and HUD only; numbers,
  hashes and accounts in ui-monospace; paragraphs in the system sans.
- **Stage:** one `<canvas>` at a logical 320×180, drawn at a whole number of
  *device* pixels per logical pixel (no resampling on 125%/150% displays),
  smoothing off, positions on whole pixels. requestAnimationFrame, paused while
  the tab is hidden. `prefers-reduced-motion` shows the final frame of each
  story: static poses, no particles. The canvas is `aria-hidden`; every fact on
  it is repeated in the DOM (caption, *Agents in this Round* table, Round card).
- **Layout:** stage + right-rail Round card (question, topic, phase,
  countdown in the event's own time zone, agents in, total stake) and *Pick a
  Round*; below, Hall of Fame, Herald's Scroll (the LLM agent's revealed
  rationale and headlines) and the On NEAR feed (six rows, then "Show all").
  Under 1100px everything stacks and the question moves above the stage; at
  390px there is no page-level horizontal scroll (tables scroll in their own
  frame).
- **Cast:** nine characters, one fixed pedestal each on the background's arc
  (roster order). Participants stand on a lit pedestal; agents sitting a Round
  out stand dimmed on their own dim pedestal, with the reason in the DOM.
- **Scene state machine** (`scene.ts`, pure, unit-tested): OPEN (agents seal
  envelopes into the Lockbox, SEALED n/m), CLOSED (freezing → the Oracle Stone
  pulses while the forecast is on sale → observing: an empty candle frame for
  price, the city's real local day/night for weather → awaiting the resolver),
  RESOLVED (Outcome icon drops, revealed probabilities land as darts on a
  0–100% track, non-revealers wait, then show NO REVEAL · score 0), SETTLED
  (win/lose poses, coins from losers to winners sized by the real per-agent
  payout), CANCELLED (refund tokens float back). Each story plays once per view;
  "Play again" replays it. Missing data is an explicit NO DATA YET state.
- **Season Replay** (REPLAY): lanes race on bankroll (log scale) from the
  replay series; play/pause, 1×/4×/16×, scrub; the leader wears a crown, an
  agent below 10× the minimum stake collapses into its bankrupt ghost. Always
  labelled "OFFLINE REPLAY · not live chain activity".
- **Sprites:** `public/sprites/<id>.png/.json` (Aseprite JSON array, untrimmed
  24×24 frames, tags idle/seal/reveal/win/lose/bankrupt), `props.png/.json`,
  `arena-bg.png`. A missing or invalid file falls back to a generated
  placeholder (a rounded square in the agent's colour with its initial), so the
  Arena works with placeholders only.

## World

A ruled ledger: iron-black ink and one rubric vermilion on unbleached bone. Every panel, table, and detent is drawn with 1px hairline rules; the surface reads as a printed working record, not a marketing page. The single signature move is the **Round phase ladder** — a horizontal detent track where scheduled → opening → cutoff → snapshot sale → observation → resolution → reveal deadlines are ruled marks, and "now" sits as a vermilion detent; a deadline is a mark on a track, never a countdown tile.

## Ground & Palette

- **Bone ground** — `#faf7f0` (50) with `#f4f0e6` (100), `#e8e1d2` (200), `#d7cdb8` (300) stepped surfaces.
- **Iron-black ink** — `#191510` (900), `#2b261d` (700), `#5c5345` (500), `#8a8070` (300) for text/rules/muted.
- **Rubric vermilion** — `#c2372b` (600) / `#9f2c22` (700) / `#f6e6e3` (50). One accent, used for: selection, focus rings, the active phase detent, price-domain chips, and negative P&L. Never gradient, never decorative fill.
- **State colours** (only where they carry meaning): ok `#2f7d4f`, warn `#a87814`, bad `#b0322a` — live/degraded/critical and terminal phase chips.
- Light mode only (`color-scheme: light`) — the scene is an operator/evaluator reading ledger rows at a desk.

## Type

- **Display/headings**: Iowan Old Style → Palatino → Georgia → serif stack (`--font-display`), 600 weight, −0.02em tracking, max ~1.4rem on-screen.
- **Body/UI**: system sans stack (`--font-sans`).
- **Data/money/measurement**: `SFMono-Regular` → ui-monospace → monospace (`--font-mono`) with `font-variant-numeric: tabular-nums` — yoctoNEAR figures, timestamps, hashes, Brier numbers. The mono face is for data, not "technical" costume.
- Apparatus labels (`.small-caps`: uppercase, 0.68rem, 600, +0.08em) for column heads and section kickers. Plain uppercase rather than `font-variant-caps`, because synthesized small caps render with mixed letter sizes on fonts without real small-cap glyphs. Long notes stay in sentence case.
- Money is written `0.01 NEAR`, not with a currency glyph.

## Component Language

- **Rules, not boxes**: hairlines (`rule-t/b/l/r/a`) instead of card borders or rounded rectangles. No radius anywhere.
- **Buttons**: square iron-black filled (`btn`), ghost (`btn-ghost`), vermilion primary (`btn-vermilion`); 1px border, no radius, no shadow.
- **Chips**: uppercase 0.7rem labels with 1px currentColor border — phase/domain/single-agent/snapshot-ready/status.
- **Tables**: `.ledger-table` with hairline bottom rules, small-caps th, right-aligned `.num` columns.
- **Stats**: label (small-caps) over value (mono, 600) with a muted hint.
- **Panels**: `Panel` = a titled block with a hairline top rule and head rule, no enclosing card.
- **Phase ladder** (signature): 6-column detent track; done = iron, now = vermilion with a square pointer; collapses to 3 columns under 720px.
- **Focus/selection/browser-drawn parts**: 1.5px vermilion focus outline, vermilion text selection, square (unrounded) scrollbar thumbs tinted from ink. The browser chrome is themed, not left default.

- **Charts** (`SimCharts.tsx`, plain SVG): the bankroll race draws every agent in ink with direct end labels, the richest agent as the one vermilion line, and agents that can no longer stake dashed; identity never depends on colour. The accuracy chart puts the paid swarm forecast in vermilion and the naive baselines as dashed outlines. Both have a hover readout.
- **Intro**: a one-sentence display-serif pitch above the live view; with no Round selected, the detail column explains a Round, how to try it on testnet, and the replay scoreboard.

## Density & Layout

- Max width 1280px, 1.5rem gutters; live view = list (min 340px) + detail grid, collapsing to single column under 900px. Detail/balance/forecast grids collapse to 1 column under 480px. Mobile 390px has no page-level horizontal overflow; wide ledgers and charts scroll inside their own frame.
- Tight groups, generous separation; more space above a heading than below.

## Motion

One authored moment, not scattered effects: hover is a 120ms ink-fill on buttons/rows. No transform/opacity entrances; countdowns re-render via a 1s wall-clock tick, not animation.

## Assets

The ledger views use no raster assets: all graphics are CSS hairlines and text/chips. The Arena's raster art lives in `public/sprites` and is drawn only on the Arena canvas.
