"""Extract the four gpt-image-2.5-flare building sprites and assemble the v4 manifest.

Input: output/imagegen/world-v4/raw/buildings.png (native RGBA, 2x2 sheet).
Requires Pillow, numpy and opencv-python. Generation uses the imagegen skill CLI.
"""
from pathlib import Path
import json
import posixpath
import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/world/v4'
OUT.mkdir(parents=True, exist_ok=True)
sheet = Image.open(ROOT / 'output/imagegen/world-v4/raw/buildings.png').convert('RGBA')
manifest = json.loads((ROOT / 'public/world/v3/manifest.json').read_text(encoding='utf-8'))
manifest['assetVersion'] = 'world-4'
manifest['generatedAt'] = '2026-09-16T08:09:44.341Z'
for frame in manifest['frames'].values():
    frame['file'] = posixpath.normpath('../v3/' + frame['file'])

for index, name in enumerate(['cottage', 'cottage-stone', 'shop', 'barn']):
    cw, ch = sheet.width // 2, sheet.height // 2
    x, y = index % 2 * cw, index // 2 * ch
    rgba = np.array(sheet.crop((x, y, x + cw, y + ch)))
    # The model's low-alpha exterior glow is not part of the building silhouette.
    alpha = np.clip((rgba[:, :, 3].astype(np.float32) - 180) / 65, 0, 1)
    count, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > 0.75).astype(np.uint8))
    if count < 2:
        raise ValueError('Missing building silhouette: ' + name)
    largest = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
    keep = cv2.dilate((labels == largest).astype(np.uint8), np.ones((3, 3), np.uint8))
    rgba[:, :, 3] = (alpha * keep * 255).astype(np.uint8)
    cutout = Image.fromarray(rgba)
    cutout = cutout.crop(cutout.getbbox())
    cutout.thumbnail((512, 440), Image.Resampling.LANCZOS)
    padded = Image.new('RGBA', (cutout.width + 12, cutout.height + 12))
    padded.paste(cutout, (6, 6))
    padded.save(OUT / (name + '.png'))
    manifest['frames'][name] = {'file': name + '.png', 'kind': 'sprite', 'w': padded.width, 'h': padded.height}

for alias, source in [('two-storey-house', 'shop'), ('inn', 'shop'), ('workshop', 'barn')]:
    manifest['frames'][alias] = dict(manifest['frames'][source])
(OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('Prepared four buildings and public/world/v4/manifest.json')
