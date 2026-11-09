"""Gate 5: props.aseprite -- one 32x32 canvas, one frame per prop state, each
prop drawn at the frame's top-left at its native size (the Arena draws frame
rects from the top-left). Tag names are the ones the renderer looks up.

Usage: python props.py <out.lua> <aseprite_path> <sheet_png> <sheet_json> [dump]
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from flats import PAL  # noqa: E402

N = 32


def canvas():
    return [['.'] * N for _ in range(N)]


def art(rows, x=0, y=0, g=None):
    g = g or canvas()
    for dy, r in enumerate(rows):
        for dx, c in enumerate(r):
            if c != '.':
                g[y + dy][x + dx] = c
    return g


def rect(g, x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            g[y][x] = c


# ---- 8x8 props --------------------------------------------------------------
ENV_SEALED = ["........", "OOOOOOOO", "OWCCCCWO", "OCWCCWCO", "OCCHACCO", "OCCAACCO", "OOOOOOOO", "........"]
ENV_OPEN = ["..OOOO..", "OOWWWWOO", "OWOCCOWO", "OCCOOCCO", "OCCCCCCO", "OCCCCCCO", "OOOOOOOO", "........"]
COIN = [
    ["..OOOO..", ".OHHHHO.", "OHWHHHAO", "OHHHHHAO", "OHHHHHAO", "OHHHHAAO", ".OAAAAO.", "..OOOO.."],
    ["...OO...", "..OHHO..", ".OHWHAO.", ".OHHHAO.", ".OHHHAO.", ".OHHAAO.", "..OAAO..", "...OO..."],
    ["...OO...", "...HA...", "...WA...", "...HA...", "...HA...", "...HA...", "...AA...", "...OO..."],
    ["...OO...", "..OHHO..", ".OAHWHO.", ".OAHHHO.", ".OAHHHO.", ".OAAHHO.", "..OAAO..", "...OO..."],
]
DART = ["...U.U..", "...UWU..", "....W...", "....W...", "....W...", "....S...", "...OAO..", "....O..."]
REFUND = ["..OOOO..", ".OKKKKO.", "OKWWWKNO", "OKWKKKNO", "OWWWKKNO", "OKWKKKNO", ".ONNNNO.", "..OOOO.."]
SKULL = ["........", "..OOOO..", ".OWWWWO.", "OWOWWOWO", "OWWWWWWO", ".OWOOWO.", "..OWWO..", "...OO..."]
LOCK = ["..OOOO..", ".OSOOSO.", ".OS..SO.", "OOOOOOOO", "OHWHHHAO", "OHHOHHAO", "OAAOAAAO", "OOOOOOOO"]


# ---- 32x32 lockbox (drawn in rows 8..31, like the procedural 32x24 box) ------
def lockbox(glow):
    g = canvas()
    rect(g, 2, 9, 29, 31, 'O')               # outline block
    rect(g, 3, 10, 28, 15, 'V')              # lid
    rect(g, 3, 10, 28, 10, 'U')              # lit lid top edge
    rect(g, 3, 10, 3, 15, 'U')               # lit left edge
    rect(g, 3, 16, 28, 16, 'O')              # lid seam
    rect(g, 3, 17, 28, 30, 'V')              # body
    rect(g, 3, 17, 3, 29, 'U')
    rect(g, 3, 29, 28, 30, 'D')              # shadow at the bottom
    rect(g, 28, 17, 28, 30, 'D')
    for x in (8, 23):                        # honey bands
        rect(g, x, 10, x + 1, 30, 'H')
        rect(g, x + 1, 11, x + 1, 30, 'A')
    rect(g, 13, 13, 18, 21, 'O')             # lock plate
    rect(g, 14, 14, 17, 20, 'H')
    rect(g, 14, 14, 14, 20, 'W')
    rect(g, 17, 15, 17, 20, 'A')
    rect(g, 15, 16, 16, 17, 'O')             # keyhole
    rect(g, 15, 18, 15, 19, 'O')
    if glow:
        rect(g, 3, 16, 28, 16, 'W')          # light leaking from the seam
        for x in range(1, 31, 2):            # dithered honey halo on the lid
            g[8][x] = 'H'
        for y in range(9, 31, 2):
            g[y][0] = 'H'
            g[y][31] = 'H'
        for x in range(4, 28, 3):
            g[7][x] = 'W'
    return g


# ---- 32x32 oracle stone (4-frame pulse) --------------------------------------
def _stone_rows():
    """A tapered monolith: pointed top, widest at row 9, slight taper to the plinth."""
    rows = []
    for y in range(24):
        if y <= 8:
            hw = 1 + y           # pointed top widening
        elif y <= 19:
            hw = 9 - (y - 9) // 6
        else:
            hw = 0
        r = ['.'] * 32
        if y <= 19:
            x0, x1 = 15 - hw, 16 + hw
            for x in range(x0, x1 + 1):
                r[x] = 'U'
            r[x0] = r[x1] = 'O'
            if x1 - x0 > 3:
                r[x0 + 1] = 'S'                      # lit left face
                r[x1 - 1] = 'V'                      # shadow right face
                if x1 - x0 > 6:
                    r[x1 - 2] = 'V'
            if y == 0:
                r = ['.'] * 32
                r[15] = r[16] = 'O'
        elif y == 20:
            for x in range(5, 27):
                r[x] = 'O'
        elif y in (21, 22):
            for x in range(4, 28):
                r[x] = 'D'
            r[4] = r[27] = 'O'
            if y == 21:
                for x in range(6, 26):
                    r[x] = 'V'
        else:
            for x in range(4, 28):
                r[x] = 'O'
        rows.append(''.join(r))
    return rows


STONE = _stone_rows()
RUNE = [(15, 8), (16, 8), (15, 9), (16, 9), (15, 10), (16, 10), (15, 11), (16, 11), (15, 12), (16, 12),
        (13, 10), (14, 10), (17, 10), (18, 10), (14, 7), (17, 7), (14, 13), (17, 13)]


def stone(phase):
    g = art(STONE, 0, 6)  # stone in rows 6..29 (renderer draws it at stone.y - 4)
    rune = {0: 'A', 1: 'H', 2: 'W', 3: 'H'}[phase]
    for x, y in RUNE:
        g[y + 6][x] = rune
    if phase in (1, 2, 3):  # halo, widest at the peak
        r = {1: 1, 2: 2, 3: 1}[phase]
        pts = []
        for y in range(8, 27):
            for x in (5 - r, 26 + r):
                if (x + y) % 2 == 0:
                    pts.append((x, y))
        for k in range(1, 4 + r):                    # halo rays above the point
            pts += [(15 - k, 6 - k), (16 + k, 6 - k)]
        for x, y in pts:
            if 0 <= x < N and 0 <= y < N and g[y][x] == '.':
                g[y][x] = 'H' if phase == 2 else 'A'
    return g


# ---- pedestal (32x16, top face on row 2 = the character's feet line) ---------
def pedestal(lit):
    top, top_hi, front, shade = ('H', 'W', 'A', 'D') if lit else ('U', 'S', 'V', 'D')
    g = canvas()
    rows = [
        "....OOOOOOOOOOOOOOOOOOOOOOOO....",
        "..OO11111111111111111111111OOO..",
        ".O1TTTTTTTTTTTTTTTTTTTTTTTTTT1O.",
        ".OTTTTTTTTTTTTTTTTTTTTTTTTTTTTO.",
        "..OOTTTTTTTTTTTTTTTTTTTTTTTTOO..",
        "..OFFFFFFOFFFFFFFFFFFFOFFFFFFO..",
        "..OFFFFFFOFFFFFFFFFFFFOFFFFFSO..",
        "..OFFFFFFOFFFFFFFFFFFFOFFFFSSO..",
        "...OOOOOOOOOOOOOOOOOOOOOOOOOO...",
    ]
    m = {'1': top_hi, 'T': top, 'F': front, 'S': shade}
    return art([''.join(m.get(c, c) for c in r) for r in rows], 0, 1, g)


# ---- 16x16 outcome icons -----------------------------------------------------
CANDLE_UP = [
    ".......OO.......", ".......WO.......", "......OOOO......", ".....OGWGGO.....", ".....OGWGGO.....",
    ".....OGWGLO.....", ".....OGGGLO.....", ".....OGGGLO.....", ".....OGGGLO.....", ".....OGGLLO.....",
    ".....OGGLLO.....", ".....OOOOOO.....", ".......SO.......", ".......SO.......", ".......OO.......", "................",
]
CANDLE_DOWN = [
    ".......OO.......", ".......SO.......", ".......SO.......", "......OOOO......", ".....OKNNNO.....",
    ".....OKNNNO.....", ".....OKNNDO.....", ".....ONNNDO.....", ".....ONNNDO.....", ".....ONNDDO.....",
    ".....ONNDDO.....", ".....OOOOOO.....", ".......SO.......", ".......SO.......", ".......OO.......", "................",
]
RAIN_CLOUD = [
    "................", "......OOOO......", "....OOWWSSO.....", "...OWWSSSSSOO...", "..OWSSSSSSSSSO..",
    ".OWSSSSSSSSSSSO.", ".OSSSSSSSSSSSUO.", ".OSSSSSSSSSSUUO.", "..OOUUUUUUUUOO..", "....OOOOOOOO....",
    "...K...K...K....", "..K...K...K.....", "................", "....K...K...K...", "...K...K...K....", "................",
]
SUN = [
    ".......HH.......", ".......AA.......", "..H....OO....H..", "...A.OOHHOO.A...", ".....OHWWHHO....",
    "....OHWHHHHAO...", "....OHHHHHHAO...", "HAOOOHHHHHHAOOAH", "HAOOOHHHHHAAOOAH", "....OHHHHHAAO...",
    "....OHHHHAAAO...", ".....OHAAAAO....", "...A.OOAAOO.A...", "..H....OO....H..", ".......AA.......", ".......HH.......",
]

FRAMES = [
    ('envelope-sealed', [art(ENV_SEALED)], 100),
    ('envelope-open', [art(ENV_OPEN)], 100),
    ('coin-spin', [art(c) for c in COIN], 90),
    ('dart', [art(DART)], 100),
    ('refund-token', [art(REFUND)], 100),
    ('skull', [art(SKULL)], 100),
    ('lock', [art(LOCK)], 100),
    ('lockbox-closed', [lockbox(False)], 100),
    ('lockbox-glow', [lockbox(True)], 100),
    ('oracle-stone-idle', [stone(i) for i in range(4)], 200),
    ('pedestal-lit', [pedestal(True)], 100),
    ('pedestal-dim', [pedestal(False)], 100),
    ('candle-up', [art(CANDLE_UP)], 100),
    ('candle-down', [art(CANDLE_DOWN)], 100),
    ('rain-cloud', [art(RAIN_CLOUD)], 100),
    ('sun', [art(SUN)], 100),
]


def build_lua(ase_path, png, js):
    seq = [(tag, ms, ''.join(''.join(r) for r in fr)) for tag, frs, ms in FRAMES for fr in frs]
    used = sorted({c for _, _, px in seq for c in px if c != '.'})
    out = [f'local spr = Sprite({N}, {N}, ColorMode.RGB)', 'local layer = spr.layers[1]', 'layer.name = "props"', 'local C = {}']
    for c in used:
        h = PAL[c]
        out.append(f'C["{c}"] = app.pixelColor.rgba({int(h[1:3], 16)}, {int(h[3:5], 16)}, {int(h[5:7], 16)}, 255)')
    out.append('local F = {')
    out += [f'  {{"{px}", {ms}}},' for _, ms, px in seq]
    out.append('}')
    out += [
        'for i = 2, #F do spr:newEmptyFrame() end',
        'for i, fr in ipairs(F) do',
        f'  local img = Image({N}, {N}, ColorMode.RGB)',
        '  local s = fr[1]',
        '  for p = 1, #s do',
        '    local ch = s:sub(p, p)',
        f'    if ch ~= "." then img:drawPixel((p - 1) % {N}, (p - 1) // {N}, C[ch]) end',
        '  end',
        '  spr:newCel(layer, spr.frames[i], img, Point(0, 0))',
        '  spr.frames[i].duration = fr[2] / 1000',
        'end',
    ]
    start = 1
    for tag, frs, _ in FRAMES:
        out.append(f'do local t = spr:newTag({start}, {start + len(frs) - 1}); t.name = "{tag}" end')
        start += len(frs)
    out += [
        f'spr:saveAs([[{ase_path}]])',
        'app.command.ExportSpriteSheet{ ui = false, askOverwrite = false, type = SpriteSheetType.ROWS,',
        f'  textureFilename = [[{png}]], dataFilename = [[{js}]], dataFormat = SpriteSheetDataFormat.JSON_ARRAY,',
        '  filenameFormat = "{tag}-{tagframe}", borderPadding = 0, shapePadding = 1, innerPadding = 0,',
        '  trim = false, listTags = true, listLayers = false, listSlices = false }',
        'print("frames", #spr.frames, "tags", #spr.tags)',
    ]
    return '\n'.join(out), seq, used


if __name__ == '__main__':
    out_lua, ase, png, js = sys.argv[1:5]
    for tag, frs, _ in FRAMES:
        for fr in frs:
            assert len(fr) == N and all(len(r) == N for r in fr), tag
    script, seq, used = build_lua(ase, png, js)
    open(out_lua, 'w').write(script)
    print(len(seq), 'frames,', len(FRAMES), 'tags, colours:', ' '.join(used))
