"""Contact sheet: every character x every frame, read from the exported
sheets in packages/dashboard/public/sprites, on the night background, 4x
nearest-neighbour. Usage: python contact.py  ->  art/previews/all-4x.png
"""
import json, os
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SPRITES = os.path.join(ROOT, 'packages', 'dashboard', 'public', 'sprites')
OUT = os.path.join(ROOT, 'art', 'previews', 'all-4x.png')
ORDER = ['meteo', 'climatology', 'persistence', 'momentum', 'meanrev', 'noisy-trend', 'yolo', 'coinflip', 'llm-news']
NIGHT, DEEP, GAP = (20, 16, 31), (36, 27, 58), 2

rows = []
for a in ORDER:
    meta = json.load(open(os.path.join(SPRITES, f'{a}.json')))
    sheet = Image.open(os.path.join(SPRITES, f'{a}.png')).convert('RGBA')
    rows.append((meta, sheet))

n = max(len(m['frames']) for m, _ in rows)
tag_starts = {t['from'] for t in rows[0][0]['meta']['frameTags']} - {0}
cell = 24 + GAP
W = n * cell + GAP + len(tag_starts) * GAP
H = len(rows) * cell + GAP
img = Image.new('RGBA', (W, H), NIGHT + (255,))
for r, (meta, sheet) in enumerate(rows):
    x = GAP
    for i, f in enumerate(meta['frames']):
        if i in tag_starts:
            for yy in range(H):
                img.putpixel((x, yy), DEEP + (255,))
            x += GAP
        fr = f['frame']
        tile = sheet.crop((fr['x'], fr['y'], fr['x'] + 24, fr['y'] + 24))
        img.alpha_composite(tile, (x, GAP + r * cell))
        x += cell
img = img.resize((W * 4, H * 4), Image.NEAREST)
img.convert('RGB').save(OUT)
print(OUT, img.size)
