"""Gate 6: arena-bg.aseprite -- 320x180, static, three layers:
  wall     far honeycomb wall (centre-top 160x40 kept clear for the banner)
  hall     ledge, floor, side pillars and nine dim hex pedestals on the arc the
           renderer uses (pedestal art identical to props 'pedestal-dim')
  lanterns hanging lanterns with dithered glow and bulb garlands

Usage: python bg.py <out.lua> <aseprite_path> <png_path>
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from flats import PAL  # noqa: E402
from props import pedestal  # noqa: E402

W, H = 320, 180
COL = dict(PAL, B='#14101f')  # B = night
BANNER = (80, 0, 239, 39)
WALL_BOTTOM = 103
LANTERNS = [24, 68, 252, 296]


def layer():
    return [['.'] * W for _ in range(H)]


def cell_of(x, y):
    """Nearest centre of a honeycomb lattice (pointy rows, 16 x 14)."""
    best, bid = None, None
    j0 = round((y + 4) / 14)
    for j in (j0 - 1, j0, j0 + 1):
        off = (j % 2) * 8
        i0 = round((x - off) / 16)
        for i in (i0 - 1, i0, i0 + 1):
            cx, cy = i * 16 + off, j * 14 - 4
            d = (x - cx) ** 2 + ((y - cy) * 1.15) ** 2
            if best is None or d < best:
                best, bid = d, (i, j, cx, cy)
    return bid


def h(i, j):
    return (i * 73856093 ^ j * 19349663) % 100


def cleared(cx, cy):
    """Cells whose centre is in the banner zone stay empty (clear night window)."""
    x0, y0, x1, y1 = BANNER
    return x0 + 4 <= cx <= x1 - 4 and cy <= y1 - 2


def wall():
    g = layer()
    ids = [[cell_of(x, y) for x in range(W)] for y in range(WALL_BOTTOM + 2)]
    for y in range(WALL_BOTTOM + 1):
        for x in range(W):
            i, j, cx, cy = ids[y][x]
            here_clear = cleared(cx, cy)
            nb = [ids[y][x + 1] if x + 1 < W else None, ids[y + 1][x]]
            edge = any(n is not None and n[:2] != (i, j) and not (here_clear and cleared(n[2], n[3])) for n in nb)
            kind = h(i, j)
            if edge:
                c = 'D'
            elif here_clear:
                c = 'B'
            elif kind < 16 and y >= cy - 1:         # stored honey: dim amber dither
                c = 'A' if (y == cy - 1 and x % 2 == 0) or (x % 2 == 0 and y % 2 == 0) else 'V'
            elif 16 <= kind < 26:                   # wax-capped cell
                c = 'V'
            else:
                c = 'B'
            g[y][x] = c
    return g


def actor_anchor(s, n=9):
    d = s - (n - 1) / 2
    return round(160 + d * 34), round(142 + 0.8 * d * d)


def hall():
    g = layer()
    # Ledge where the wall meets the floor.
    for x in range(W):
        g[104][x] = 'U'
        g[105][x] = 'V'
        g[106][x] = 'H' if x % 4 else 'A'
        g[107][x] = 'V'
        g[108][x] = 'V'
        g[109][x] = 'D'
        g[110][x] = 'O'
    # Floor: deep planks with violet joints (running bond).
    for y in range(111, H):
        row = (y - 111) // 9
        for x in range(W):
            joint = (y - 111) % 9 == 0 or (x + (row % 2) * 16) % 32 == 0
            g[y][x] = 'V' if joint else 'D'
    # Side pillars.
    for y in range(H):
        for x0, mirror in ((0, False), (310, True)):
            for k in range(10):
                x = x0 + k
                kk = 9 - k if mirror else k
                g[y][x] = 'O' if kk == 9 else 'U' if kk == 1 else 'D' if kk == 8 else 'V'
        if y < 5 or 98 <= y <= 101:
            for x in list(range(0, 12)) + list(range(308, 320)):
                g[y][x] = 'H' if y in (2, 99) else 'A' if y in (3, 100) else 'O'
    # Nine dim pedestals at the renderer's slot anchors (prop drawn at x-16, y-2).
    ped = pedestal(False)
    for s in range(9):
        ax, ay = actor_anchor(s)
        for dy, r in enumerate(ped):
            for dx, c in enumerate(r):
                if c != '.':
                    xx, yy = ax - 16 + dx, ay - 2 + dy
                    if 0 <= xx < W and 0 <= yy < H:
                        g[yy][xx] = c
    return g


LANTERN = [".OOOOO.", "OAHHHAO", "OHWWWHO", "OHWWWHO", "OHWWWHO", "OAHHHAO", ".OOOOO.", "..OAO..", "...A..."]


def lanterns():
    g = layer()
    for lx in LANTERNS:
        for y in range(0, 13):
            g[y][lx] = 'U'
        cx, cy = lx, 17
        for y in range(cy - 10, cy + 11):           # dithered glow ring
            for x in range(cx - 10, cx + 11):
                r2 = (x - cx) ** 2 + (y - cy) ** 2
                if not (0 <= x < W and 0 <= y < H) or (BANNER[0] <= x <= BANNER[2] and y <= BANNER[3]):
                    continue
                if 20 <= r2 <= 40 and (x + y) % 4 == 0:
                    g[y][x] = 'A'
                elif 40 < r2 <= 64 and (x + y) % 2 == 0:
                    g[y][x] = 'V'
        for dy, r in enumerate(LANTERN):
            for dx, c in enumerate(r):
                if c != '.':
                    g[13 + dy][lx - 3 + dx] = c
    # Garlands between the paired lanterns, outside the banner zone.
    for a, b in ((LANTERNS[0], LANTERNS[1]), (LANTERNS[2], LANTERNS[3])):
        for x in range(a + 4, b - 3):
            t = (x - a) / (b - a)
            y = round(30 + 8 * 4 * t * (1 - t))
            g[y][x] = 'U'
            if (x - a) % 6 == 3:
                g[y + 1][x] = 'H'
                g[y + 2][x] = 'A'
    return g


def lua(ase, png):
    layers = [('wall', wall()), ('hall', hall()), ('lanterns', lanterns())]
    used = sorted({c for _, g in layers for r in g for c in r if c != '.'})
    out = [f'local spr = Sprite({W}, {H}, ColorMode.RGB)', 'local C = {}']
    for c in used:
        hx = COL[c]
        out.append(f'C["{c}"] = app.pixelColor.rgba({int(hx[1:3], 16)}, {int(hx[3:5], 16)}, {int(hx[5:7], 16)}, 255)')
    out.append('local L = {')
    for name, g in layers:
        out.append(f'  {{"{name}", {{')
        out += [f'    "{"".join(r)}",' for r in g]
        out.append('  }},')
    out.append('}')
    out += [
        'for li, ldef in ipairs(L) do',
        '  local layer = (li == 1) and spr.layers[1] or spr:newLayer()',
        '  layer.name = ldef[1]',
        f'  local img = Image({W}, {H}, ColorMode.RGB)',
        '  for y, row in ipairs(ldef[2]) do',
        '    for x = 1, #row do',
        '      local ch = row:sub(x, x)',
        '      if ch ~= "." then img:drawPixel(x - 1, y - 1, C[ch]) end',
        '    end',
        '  end',
        '  spr:newCel(layer, spr.frames[1], img, Point(0, 0))',
        'end',
        f'spr:saveAs([[{ase}]])',
        f'spr:saveCopyAs([[{png}]])',
        'print("layers", #spr.layers, spr.width, spr.height)',
    ]
    return '\n'.join(out), used


if __name__ == '__main__':
    out_lua, ase, png = sys.argv[1:4]
    script, used = lua(ase, png)
    open(out_lua, 'w').write(script)
    print('colours:', ' '.join(used))
