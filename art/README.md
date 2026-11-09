# Hive Arena art

Original pixel art for the Arena, built in Aseprite through the aseprite MCP.
Palette: the 16 Arena colours in `packages/dashboard/src/arena/palette.ts`,
at most 7 per character.

| Path | What |
| --- | --- |
| `sprites/<agentId>.aseprite` | nine characters, 24x24, 21 frames, tags `idle` `seal` `reveal` `win` `lose` `bankrupt` |
| `sprites/props.aseprite` | envelope, coin, dart, refund token, skull, lock, lockbox, oracle stone, pedestals, Outcome icons (one tag per state) |
| `sprites/arena-bg.aseprite` | 320x180 background, layers `wall` `hall` `lanterns` |
| `sprites/silhouettes|flats|shaded.aseprite` | the review-gate sheets (silhouette, flats + outline, shading + faces) |
| `previews/` | 4x GIFs per character, `all-4x.png` contact sheet, props and background previews |
| `src/` | the generators: `silhouettes.py` → `flats.py` → `shade.py` → `anim.py`, plus `props.py`, `bg.py`, `contact.py` |

The Arena loads the exported sheets from `packages/dashboard/public/sprites/`
(`<id>.png/.json` Aseprite JSON array, untrimmed 24x24 frames, 1 px padding,
`{tag}-{frame}` names; `props.png/.json`; `arena-bg.png`). A missing or
invalid file falls back to a generated placeholder.

Rebuild a character: `python art/src/anim.py <agentId> out.lua <ase> <png> <json>`,
then run `dofile([[out.lua]])` in Aseprite (batch mode). Props and background
work the same way with `props.py` and `bg.py`.
