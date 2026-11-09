"""Gate 2: flats + 1 px inner ink outline, painted onto the approved silhouettes.

Spans: (rows, cols, letter[, flags]) applied in order. Rows/cols are inclusive
(a, b) tuples. Flags: 'fill' also paints transparent pixels (filling a hole),
'keep' exempts the painted pixels from the auto outline (thin glowing tips).
"""
import json, sys

import os
HERE = os.path.dirname(os.path.abspath(__file__))
SCR = os.environ.get('ART_OUT', HERE)
sys.path.insert(0, HERE)
from silhouettes import S as SIL
ORDER = ['meteo','climatology','persistence','momentum','meanrev','noisy-trend','yolo','coinflip','llm-news']

PAL = {
 'O': '#0b0a10', 'D': '#241b3a', 'V': '#3b2d5c', 'U': '#5a4a7a', 'H': '#f2b134', 'A': '#e07a1f',
 'W': '#fff1c1', 'C': '#f7e9d0', 'G': '#5bd16b', 'S': '#8a8399', 'R': '#e24b4b', 'K': '#5fb3e8',
 'N': '#3a6fb0', 'L': '#2f8f5b', 'T': '#ffffff',
}
ALL = (0, 23)

PAINT = {
 'meteo': ('C', [
   ((1, 1), (16, 18), 'K', 'keep'), ((2, 2), (15, 19), 'K', 'keep'),  # umbrella canopy (lit top, ink rim below)
   ((3, 3), (18, 18), 'O'),                  # umbrella shaft meets the canopy
   ((10, 11), ALL, 'A'), ((10, 11), (6, 8), 'K'), ((10, 11), (12, 14), 'K'),  # brass goggles + lenses
 ]),
 'climatology': ('L', [
   ((3, 7), ALL, 'N'), ((5, 5), (9, 15), 'C'),           # thick book: cover + page block
   ((8, 17), (5, 20), 'U'),                               # dome shell
 ]),
 'persistence': ('L', [
   ((1, 3), (5, 11), 'H'),                                # curled crest
   ((3, 9), (12, 21), 'W'), ((10, 10), (11, 12), 'W'),    # speech bubble
   ((5, 5), (14, 19), 'O', 'fill'), ((7, 7), (14, 19), 'O', 'fill'),  # "=" in the bubble
   ((6, 9), (3, 5), 'R', 'keep'),                         # red beak (no outline: too small)
   ((12, 16), (10, 12), 'H'),                             # wing
   ((18, 22), (11, 17), 'H'),                             # tail feathers
   ((19, 22), (6, 9), 'S'),                               # legs
 ]),
 'momentum': ('C', [
   ((20, 21), ALL, 'K'), ((22, 22), ALL, 'N'),            # small wave
   ((18, 19), (19, 21), 'W'),                             # foam curl
 ]),
 'meanrev': ('V', [
   ((7, 9), (8, 11), 'W'),                                # muzzle
   ((15, 21), (9, 14), 'W'),                              # belly
   ((14, 18), (1, 5), 'H'), ((16, 16), (3, 3), 'W', 'fill'),  # pocket clock + face
 ]),
 'noisy-trend': ('S', [
   ((1, 2), ALL, 'H', 'keep'),                            # flickering antenna tip
   ((9, 11), (6, 16), 'K'),                               # screen face
   ((15, 18), (8, 14), 'N'),                              # chest panel
 ]),
 'yolo': ('G', [
   ((2, 4), (2, 4), 'W', 'keep', 'fill'), ((2, 4), (16, 18), 'W', 'keep', 'fill'),  # dice faces (lit)
   ((2, 5), (5, 5), 'S', 'keep'), ((2, 5), (19, 19), 'S', 'keep'),  # shaded right sides
   ((5, 5), (2, 5), 'S', 'keep'), ((5, 5), (16, 19), 'S', 'keep'),  # shaded undersides
   ((2, 2), (2, 2), 'O', 'keep'), ((4, 4), (4, 4), 'O', 'keep'),    # two pips
   ((2, 2), (18, 18), 'O', 'keep'), ((4, 4), (16, 16), 'O', 'keep'),
   ((6, 8), (4, 4), 'G', 'keep'), ((6, 8), (17, 17), 'G', 'keep'),   # arms keep a green core
   ((12, 12), (5, 16), 'R'),                              # wide grin
   ((14, 18), (7, 14), 'L'),                              # belly
   ((20, 22), ALL, 'L'),                                  # legs
 ]),
 'coinflip': ('S', [
   ((1, 2), ALL, 'H', 'keep'), ((2, 2), (16, 16), 'A', 'keep'), ((2, 2), (20, 20), 'A', 'keep'),
   ((3, 3), ALL, 'A', 'keep'),                            # coin mid-flip (amber rim)
   ((7, 8), (5, 16), 'U'),                                # bandit mask
   ((9, 10), (9, 13), 'W'),                               # muzzle
   ((14, 14), (2, 3), 'U', 'fill'), ((16, 16), (2, 3), 'U', 'fill'),  # tail stripes
   ((13, 18), (9, 13), 'W'),                              # belly
 ]),
 'llm-news': ('V', [
   ((6, 6), (10, 13), 'W'), ((7, 9), (9, 14), 'W'), ((10, 10), (10, 13), 'W'),  # face in the hood
   ((11, 11), (1, 4), 'H', 'keep'), ((18, 18), (1, 4), 'H', 'keep'),  # scroll rolls
   ((12, 17), (2, 3), 'W', 'keep'),                       # scroll paper
   ((13, 15), (9, 11), 'H'), ((14, 15), (10, 10), 'O', 'fill'),  # lock badge + keyhole
   ((21, 22), ALL, 'H'),                                  # talons
 ]),
}

def build(agent):
    sil = SIL[agent]
    grid = [[c for c in r] for r in sil]
    mask = [[c == 'X' for c in r] for r in sil]
    keep = [[False] * 24 for _ in range(24)]
    base, spans = PAINT[agent]
    for y in range(24):
        for x in range(24):
            if mask[y][x]:
                grid[y][x] = base
    for span in spans:
        (r0, r1), (c0, c1), letter = span[:3]
        flags = span[3:] if len(span) > 3 else ()
        for y in range(r0, r1 + 1):
            for x in range(c0, c1 + 1):
                if mask[y][x] or 'fill' in flags:
                    if 'fill' in flags and not mask[y][x]:
                        mask[y][x] = True
                    grid[y][x] = letter
                    if 'keep' in flags:
                        keep[y][x] = True
    # Inner outline: any painted pixel with a transparent 4-neighbour.
    out = [row[:] for row in grid]
    for y in range(24):
        for x in range(24):
            if not mask[y][x] or keep[y][x]:
                continue
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                yy, xx = y + dy, x + dx
                if not (0 <= yy < 24 and 0 <= xx < 24) or not mask[yy][xx]:
                    out[y][x] = 'O'
                    break
    return [''.join(r) for r in out], keep

if __name__ != '__main__':
    pass
else:
  cells = {a: build(a)[0] for a in ORDER}
  ok = True
  for a in ORDER:
      used = sorted({c for r in cells[a] for c in r if c != '.'})
      names = [PAL[c] for c in used]
      flag = '' if len(used) <= 7 else '  ⚠ >7 colours'
      print(f'{a:12s} {len(used)} colours: {" ".join(used)}{flag}')
      if len(used) > 7: ok = False
  W, H = 2 + 9 * 26, 28
  sheet = [['.'] * W for _ in range(H)]
  for i, a in enumerate(ORDER):
      for y, r in enumerate(cells[a]):
          for x, c in enumerate(r):
              if c != '.':
                  sheet[2 + y][2 + i * 26 + x] = c
  legend = {k: v for k, v in PAL.items() if any(k in r for r in cells.values() for _ in [0] if any(k in row for row in r))}
  json.dump({'rows': [''.join(r) for r in sheet][2:26], 'legend': legend, 'cells': cells}, open(f'{SCR}/flats.json', 'w'))
  for a in ORDER:
      print('\n'.join(cells[a])); print()
  sys.exit(0 if ok else 1)
