"""Gate 3: shading + faces on top of the approved flats.

Light comes from the top-left. Per material: a highlight on its lit top edge
(and its left edge in the upper half of the figure), a shadow on its bottom /
right edge and under overhangs (a different material directly above). A pixel
that is both lit and in shadow (1 px wide parts) keeps its base colour, so
there is no pillow shading. Outline pixels that face up or left become deep
(selective lighter outline). Eyes are explicit 1x2 / 2x2 pixels with a
highlight, drawn last.

Usage: python shade.py [out.json]  -> prints colour counts, writes cells/rows.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from flats import build, ORDER, PAL  # noqa: E402

# material -> (highlight or None, shadow or None), per character
RAMP = {
    'meteo':       {'C': ('W', 'S')},
    'climatology': {'L': (None, 'D'), 'U': ('S', 'D')},
    'persistence': {'L': (None, 'D')},   # no amber: ash is reserved for the bankrupt ghost
    'momentum':    {'C': ('W', 'S'), 'K': (None, 'N')},
    'meanrev':     {'V': ('U', 'D')},   # no amber: ash is reserved for the bankrupt ghost
    'noisy-trend': {'S': (None, 'U'), 'K': (None, 'N')},
    'yolo':        {'G': ('W', 'L'), 'L': (None, 'D')},
    'coinflip':    {'S': ('W', 'U')},
    'llm-news':    {'V': ('U', 'D')},   # no amber: ash is reserved for the bankrupt ghost (7-colour cap)
}

# Faces: (x, y, letter), drawn last.
FACE = {
    'meteo': [(7, 11, 'O'), (13, 11, 'O'), (6, 10, 'W'), (12, 10, 'W'),           # pupils + lens glints
              (9, 13, 'O'), (10, 14, 'O'), (11, 14, 'O'), (12, 13, 'O')],           # smile
    'climatology': [(3, 13, 'C'), (3, 14, 'O')],                                     # 1x2 eye
    'persistence': [(8, 5, 'W'), (8, 6, 'O')],
    'momentum': [(15, 7, 'W'), (15, 8, 'O')],
    'meanrev': [(8, 7, 'H'), (8, 8, 'O'), (11, 7, 'H'), (11, 8, 'O'), (9, 8, 'H'), (10, 8, 'H')],
    'noisy-trend': [(9, 9, 'H'), (9, 10, 'O'), (13, 9, 'H'), (13, 10, 'O')],
    'yolo': [(8, 8, 'W'), (8, 9, 'O'), (13, 8, 'W'), (13, 9, 'O')],
    'coinflip': [(8, 7, 'W'), (8, 8, 'O'), (12, 7, 'W'), (12, 8, 'O'), (11, 9, 'O')],
    'llm-news': [(10, 7, 'W'), (11, 7, 'O'), (10, 8, 'O'), (11, 8, 'O'),
                 (12, 7, 'W'), (13, 7, 'O'), (12, 8, 'O'), (13, 8, 'O'),
                 (11, 9, 'H'), (12, 9, 'H'), (11, 10, 'H'), (12, 10, 'H')],
}


def shade(agent):
    flat, keep = build(agent)
    g = [list(r) for r in flat]
    inside = lambda x, y: 0 <= x < 24 and 0 <= y < 24 and flat[y][x] != '.'
    ys = [y for y in range(24) if flat[y].strip('.')]
    mid = (min(ys) + max(ys)) / 2
    ramp = RAMP[agent]
    for y in range(24):
        for x in range(24):
            c = flat[y][x]
            if c == '.' or c == 'O' or keep[y][x] or c not in ramp:
                continue
            hi, sh = ramp[c]
            edge = lambda xx, yy: not inside(xx, yy) or flat[yy][xx] == 'O'
            lit = edge(x, y - 1) or (edge(x - 1, y) and y < mid)
            above = flat[y - 1][x] if y > 0 else '.'
            overhang = above not in ('.', 'O', c) and not keep[y - 1][x]
            dark = edge(x, y + 1) or edge(x + 1, y) or overhang
            if lit and dark:
                continue
            if lit and hi:
                g[y][x] = hi
            elif dark and sh:
                g[y][x] = sh
    # Selective lighter outline: outline facing up/left (not down/right) -> deep.
    for y in range(24):
        for x in range(24):
            if flat[y][x] != 'O' or keep[y][x]:
                continue
            out_up = not inside(x, y - 1)
            out_left = not inside(x - 1, y)
            out_down = not inside(x, y + 1)
            out_right = not inside(x + 1, y)
            if (out_up or out_left) and not (out_down or out_right):
                g[y][x] = 'D'
    # Cleanup: a shade/lit-outline pixel with no same-colour 4-neighbour is a
    # stray (orphan) pixel -> back to its flat colour. Repeat until stable.
    changed = True
    while changed:
        changed = False
        for y in range(24):
            for x in range(24):
                if g[y][x] == flat[y][x]:
                    continue
                same = any(
                    0 <= x + dx < 24 and 0 <= y + dy < 24 and g[y + dy][x + dx] == g[y][x]
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                )
                if not same:
                    g[y][x] = flat[y][x]
                    changed = True
    for x, y, c in FACE[agent]:
        g[y][x] = c
    return [''.join(r) for r in g]


if __name__ == '__main__':
    cells = {a: shade(a) for a in ORDER}
    ok = True
    for a in ORDER:
        used = sorted({c for r in cells[a] for c in r if c != '.'})
        flag = '' if len(used) <= 7 else '  >7 COLOURS'
        ok &= len(used) <= 7
        print(f'{a:12s} {len(used)}: {" ".join(used)}{flag}')
    W, H = 2 + 9 * 26, 28
    sheet = [['.'] * W for _ in range(H)]
    for i, a in enumerate(ORDER):
        for y, r in enumerate(cells[a]):
            for x, c in enumerate(r):
                if c != '.':
                    sheet[2 + y][2 + i * 26 + x] = c
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'shaded.json')
    json.dump({'rows': [''.join(r) for r in sheet][2:26], 'cells': cells, 'legend': PAL}, open(out, 'w'))
    sys.exit(0 if ok else 1)
