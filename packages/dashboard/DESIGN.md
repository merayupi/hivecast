# Design

<!-- impeccable:design-schema 1 -->

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

No raster/illustration assets; all graphics are CSS hairlines and Lucide-free text/chips (the wordmark is a ruled "HC" square). No image generation was available for this surface.
