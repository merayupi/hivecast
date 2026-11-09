"""Gate 4: animation frames for one character, built pose-to-pose from the
approved shaded still, plus an Aseprite Lua build script.

Tags (same names in every file): idle 4x160, seal 4x100, reveal 4x100,
win 4x110, lose 3x150, bankrupt 2x300. 24x24 frames; feet stay on row 22
except during the win hop.

Usage: python anim.py <agentId> <out.lua> <aseprite_path> <sheet_png> <sheet_json>
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from flats import PAL  # noqa: E402
from shade import shade  # noqa: E402

TAGS = [('idle', 4, 160), ('seal', 4, 100), ('reveal', 4, 100), ('win', 4, 110), ('lose', 3, 150), ('bankrupt', 2, 300)]

# Per-character anchors. eyes: (x, highlight_y, pupil_y); lid: colour of a closed lid;
# legs: first row that stays planted; chest: envelope top-left; card_x: card column.
CFG = {
    'meteo': dict(legs=20, eyes=[(7, 10, 11), (13, 10, 11)], lid='K', chest=(9, 14), card_x=10,
                  ghost='S', ghost_line='D', sparkle='W', skull=(8, 1), seal='A', paper='W', paper_shade='S'),
    'climatology': dict(legs=18, eyes=[(3, 13, 14)], lid='L', lid_wide=False, chest=(9, 12), card_x=17,
                        ghost='S', ghost_line='D', sparkle='C', skull=(10, 0), seal='N', paper='C', paper_shade='S'),
    'persistence': dict(legs=19, eyes=[(8, 5, 6)], lid='L', lid_wide=False, chest=(6, 12), card_x=7,
                        ghost='S', ghost_line='D', sparkle='H', skull=(1, 0), seal='R', paper='W', paper_shade='S'),
    'momentum': dict(legs=19, eyes=[(15, 7, 8)], lid='C', lid_wide=False, chest=(11, 12), card_x=12,
                     ghost='S', ghost_line='D', sparkle='W', skull=(17, 1), seal='N', paper='W', paper_shade='S'),
    'meanrev': dict(legs=21, eyes=[(8, 7, 8), (11, 7, 8)], lid='W', lid_wide=False, chest=(9, 13), card_x=9,
                    ghost='S', ghost_line='D', sparkle='H', skull=(1, 8), seal='H', paper='W', paper_shade='U'),
    'noisy-trend': dict(legs=20, eyes=[(9, 9, 10), (13, 9, 10)], lid='K', lid_wide=False, chest=(10, 15), card_x=14,
                        ghost='S', ghost_line='D', sparkle='H', skull=(5, 1), seal='H', paper='K', paper_shade='N'),
    'coinflip': dict(legs=20, eyes=[(8, 7, 8), (12, 7, 8)], lid='U', lid_wide=False, chest=(9, 13), card_x=9,
                     ghost='S', ghost_line='D', sparkle='H', skull=(1, 6), seal='A', paper='W', paper_shade='S',
                     arms=[(16, 1, 20, 8)]),
    'yolo': dict(legs=20, eyes=[(8, 8, 9), (13, 8, 9)], lid='G', chest=(9, 13), card_x=10,
                 ghost='S', ghost_line='D', sparkle='W', skull=(9, 1), seal='R', paper='W', paper_shade='S',
                 arms=[(1, 2, 5, 8), (16, 2, 20, 8)]),
    'llm-news': dict(legs=21, eyes=[(10, 7, 8), (11, 7, 8), (12, 7, 8), (13, 7, 8)], lid='W', lid_wide=False,
                     chest=(13, 12), card_x=14,
                     ghost='S', ghost_line='D', sparkle='H', skull=(10, 0), seal='H', paper='W', paper_shade='U'),
}

ENVELOPE = ["OOOOO", "OWWWO", "OWsWO", "OOOOO"]          # s = wax seal
ENVELOPE_OPEN = ["O...O", "OO.OO", "OWWWO", "OOOOO"]      # flap up, seal broken
CARD = ["OOOO", "OWWO", "OWpO", "OWWO", "OOOO"]           # p = paper shade mark
SKULL = [".WWW.", "WOWOW", "WWWWW", ".WOW."]


def blank():
    return [['.'] * 24 for _ in range(24)]


def copy(g):
    return [r[:] for r in g]


def stamp(g, art, x, y, cfg):
    out = copy(g)
    for dy, row in enumerate(art):
        for dx, c in enumerate(row):
            if c == '.':
                continue
            yy, xx = y + dy, x + dx
            if 0 <= yy < 24 and 0 <= xx < 24:
                out[yy][xx] = {'s': cfg['seal'], 'p': cfg['paper_shade'], 'W': cfg['paper']}.get(c, c)
    return out


def shift_all(g, dy):
    out = blank()
    for y in range(24):
        for x in range(24):
            if g[y][x] != '.' and 0 <= y + dy < 24:
                out[y + dy][x] = g[y][x]
    return out


def bob(g, cfg, dy, top_rows=None):
    """Move the body (rows above the planted legs) by dy; legs redrawn on top."""
    legs = cfg['legs']
    limit = legs if top_rows is None else top_rows
    out = blank()
    for y in range(24):
        for x in range(24):
            c = g[y][x]
            if c == '.':
                continue
            if y < limit:
                if 0 <= y + dy < 24:
                    out[y + dy][x] = c
            elif out[y][x] == '.':
                out[y][x] = c
    if dy < 0:  # stretched upward: re-fill the gap from the base rows
        for y in range(limit + dy, limit):
            for x in range(24):
                if out[y][x] == '.' and g[y][x] != '.':
                    out[y][x] = g[y][x]
    for y in range(legs, 24):  # planted legs/feet always on top
        for x in range(24):
            if g[y][x] != '.':
                out[y][x] = g[y][x]
    return out


def close_eyes(g, cfg, dy=0):
    out = copy(g)
    for x, hy, py in cfg['eyes']:
        out[hy + dy][x] = cfg['lid']
        for xx in ((x - 1, x, x + 1) if cfg.get('lid_wide', True) else (x,)):
            if out[py + dy][xx] != '.':
                out[py + dy][xx] = 'O'
    return out


def sparkle(g, pts, c):
    out = copy(g)
    for x, y, big in pts:
        cells = [(x, y)] + ([(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] if big else [])
        for xx, yy in cells:
            if 0 <= xx < 24 and 0 <= yy < 24 and out[yy][xx] == '.':
                out[yy][xx] = c
    return out


def drop_arms(g, cfg, dy):
    """Lower the raised arms/props (rects x0,y0,x1,y1) by dy, drawn in front."""
    out = copy(g)
    moved = []
    for x0, y0, x1, y1 in cfg.get('arms', []):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if g[y][x] != '.':
                    moved.append((x, y, g[y][x]))
                    out[y][x] = '.'
    for x, y, c in moved:
        if 0 <= y + dy < 24:
            out[y + dy][x] = c
    return out


def ghost(g, cfg, dy):
    out = blank()
    for y in range(24):
        for x in range(24):
            c = g[y][x]
            if c == '.' or not (0 <= y + dy < 24):
                continue
            if c in ('O', 'D'):
                out[y + dy][x] = cfg['ghost_line']
            elif (x + y) % 2 == 0:  # 50% dither
                out[y + dy][x] = cfg['ghost']
    sx, sy = cfg['skull']
    return stamp(out, SKULL, sx, max(0, sy + dy), cfg)  # never clip the skull at the top edge


def frames_for(agent):
    cfg = CFG[agent]
    base = [list(r) for r in shade(agent)]
    cx, cy = cfg['chest']
    f = {}
    f['idle'] = [base, bob(base, cfg, 1), close_eyes(bob(base, cfg, 1), cfg, 1), base]
    f['seal'] = [
        bob(base, cfg, 1),
        stamp(base, ENVELOPE, cx, cy, cfg),
        stamp(bob(base, cfg, 1), ENVELOPE, cx, cy + 3, cfg),
        stamp(base, ENVELOPE, cx, 19, cfg),
    ]
    f['reveal'] = [
        stamp(base, ENVELOPE, cx, cy, cfg),
        stamp(base, ENVELOPE_OPEN, cx, cy, cfg),
        stamp(stamp(base, ENVELOPE_OPEN, cx, cy, cfg), CARD, cfg['card_x'], cy - 8, cfg),
        stamp(stamp(bob(base, cfg, -1), ENVELOPE_OPEN, cx, cy - 1, cfg), CARD, cfg['card_x'], max(0, cy - 12), cfg),
    ]
    s = cfg['sparkle']
    f['win'] = [
        bob(base, cfg, 1),
        sparkle(shift_all(base, -2), [(1, 9, True), (21, 6, True), (22, 15, False)], s),
        sparkle(shift_all(base, -1), [(2, 12, False), (20, 4, True), (1, 4, False), (22, 12, True)], s),
        sparkle(base, [(21, 2, False), (1, 15, False)], s),
    ]
    f['lose'] = [
        bob(base, cfg, 1),
        close_eyes(bob(drop_arms(base, cfg, 4), cfg, 2), cfg, 2),
        close_eyes(bob(bob(drop_arms(base, cfg, 5), cfg, 2), cfg, 1, top_rows=cfg['eyes'][0][2] + 4), cfg, 3),
    ]
    f['bankrupt'] = [ghost(base, cfg, 0), ghost(base, cfg, -1)]
    seq = []
    for name, n, ms in TAGS:
        assert len(f[name]) == n, (name, len(f[name]))
        seq += [(name, i, ms, ''.join(''.join(r) for r in fr)) for i, fr in enumerate(f[name])]
    return seq


def lua(agent, seq, ase_path, png, js):
    used = sorted({c for _, _, _, px in seq for c in px if c != '.'})
    pal = {c: PAL[c] for c in used}
    lines = [
        'local spr = Sprite(24, 24, ColorMode.RGB)',
        'local layer = spr.layers[1]',
        'layer.name = "body"',
        'local C = {}',
    ]
    for c, hexv in pal.items():
        r, g, b = int(hexv[1:3], 16), int(hexv[3:5], 16), int(hexv[5:7], 16)
        lines.append(f'C["{c}"] = app.pixelColor.rgba({r}, {g}, {b}, 255)')
    lines.append('local F = {')
    for name, i, ms, px in seq:
        lines.append(f'  {{"{px}", {ms}}},')
    lines.append('}')
    lines += [
        'for i = 2, #F do spr:newEmptyFrame() end',
        'for i, fr in ipairs(F) do',
        '  local img = Image(24, 24, ColorMode.RGB)',
        '  local s = fr[1]',
        '  for p = 1, #s do',
        '    local ch = s:sub(p, p)',
        '    if ch ~= "." then img:drawPixel((p - 1) % 24, (p - 1) // 24, C[ch]) end',
        '  end',
        '  spr:newCel(layer, spr.frames[i], img, Point(0, 0))',
        '  spr.frames[i].duration = fr[2] / 1000',
        'end',
    ]
    start = 1
    for name, n, _ in TAGS:
        lines.append(f'do local t = spr:newTag({start}, {start + n - 1}); t.name = "{name}" end')
        start += n
    lines += [
        f'spr:saveAs([[{ase_path}]])',
        'app.command.ExportSpriteSheet{ ui = false, askOverwrite = false, type = SpriteSheetType.HORIZONTAL,',
        f'  textureFilename = [[{png}]], dataFilename = [[{js}]], dataFormat = SpriteSheetDataFormat.JSON_ARRAY,',
        '  filenameFormat = "{tag}-{tagframe}", borderPadding = 0, shapePadding = 1, innerPadding = 0,',
        '  trim = false, listTags = true, listLayers = false, listSlices = false }',
        'print("frames", #spr.frames, "tags", #spr.tags, "colours", ' + str(len(used)) + ')',
    ]
    return '\n'.join(lines), used


if __name__ == '__main__':
    agent, out_lua, ase_path, png, js = sys.argv[1:6]
    seq = frames_for(agent)
    script, used = lua(agent, seq, ase_path, png, js)
    open(out_lua, 'w').write(script)
    print(agent, len(seq), 'frames;', len(used), 'colours:', ' '.join(used))
    if len(sys.argv) > 6:  # optional: dump frames for inspection
        for name, i, ms, px in seq:
            print(f'--- {name}-{i} {ms}ms')
            print('\n'.join(px[r * 24:(r + 1) * 24] for r in range(24) if px[r * 24:(r + 1) * 24].strip('.')))
