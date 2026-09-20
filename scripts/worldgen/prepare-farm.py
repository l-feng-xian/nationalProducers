"""Extract the gpt-image-2.5-flare v5 farm sheet, keeping native alpha silhouettes.

Input: output/imagegen/world-v5/raw/farm-assets.png, 3 columns x 2 rows.
Run: python scripts/worldgen/prepare-farm.py
"""
from pathlib import Path
import json
import posixpath
import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/world/v5'
OUT.mkdir(parents=True, exist_ok=True)
sheet = Image.open(ROOT / 'output/imagegen/world-v5/raw/farm-assets.png').convert('RGBA')
manifest = json.loads((ROOT / 'public/world/v4/manifest.json').read_text(encoding='utf-8'))
manifest['assetVersion'] = 'world-5'
manifest['generatedAt'] = '2026-09-17'
for frame in manifest['frames'].values():
    frame['file'] = posixpath.normpath('../v4/' + frame['file'])
review = Image.new('RGB', (900, 600), '#73844f')
for index, name in enumerate(['crop-cabbage', 'crop-seedling', 'crop-wheat', 'crop-beans', 'farm-fence', 'garden-hedge']):
    cw, ch = sheet.width // 3, sheet.height // 2
    x, y = index % 3 * cw, index // 3 * ch
    rgba = np.array(sheet.crop((x, y, x + cw, y + ch)))
    # Exterior glow is low alpha; preserve the antialiased silhouette of leaves and rails.
    alpha = np.clip((rgba[:, :, 3].astype(np.float32) - 180) / 65, 0, 1)
    count, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > .6).astype(np.uint8))
    if count < 2:
        raise ValueError('Missing silhouette: ' + name)
    keep = np.zeros_like(labels, dtype=np.uint8)
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] >= max(12, stats[1:, cv2.CC_STAT_AREA].max() * .025):
            keep[labels == label] = 1
    keep = cv2.dilate(keep, np.ones((3, 3), np.uint8))
    rgba[:, :, 3] = (alpha * keep * 255).astype(np.uint8)
    cutout = Image.fromarray(rgba)
    cutout = cutout.crop(cutout.getbbox())
    cutout.thumbnail((384, 384), Image.Resampling.LANCZOS)
    padded = Image.new('RGBA', (cutout.width + 12, cutout.height + 12))
    padded.paste(cutout, (6, 6))
    padded.save(OUT / (name + '.png'))
    manifest['frames'][name] = {'file': name + '.png', 'kind': 'sprite', 'w': padded.width, 'h': padded.height}
    thumb = padded.copy()
    thumb.thumbnail((260, 260), Image.Resampling.LANCZOS)
    review.paste(thumb, (index % 3 * 300 + (300 - thumb.width) // 2, index // 3 * 300 + 280 - thumb.height), thumb)
(OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
review.save(ROOT / 'output/imagegen/world-v5/farm-cutouts-review.jpg')
print('Prepared six farm sprites and public/world/v5/manifest.json')
