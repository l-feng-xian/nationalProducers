"""Remove colored matte residue from inherited sprites without changing their drawn contours."""
from pathlib import Path
import json
import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT/'public/world/v3'
manifest = json.loads((OUT/'manifest.json').read_text('utf-8'))
count = 0
for name, frame in manifest['frames'].items():
    if frame['kind'] != 'sprite' or name.startswith(('hero-', 'walk-', 'idle-')):
        continue
    rgba = np.array(Image.open(ROOT/'public/world/v1'/f'{name}.png').convert('RGBA'))
    alpha = rgba[:, :, 3]
    alpha[alpha <= 8] = 0
    # Samples come from one pixel inside the opaque silhouette, not contaminated matte pixels.
    core = cv2.erode((alpha >= 250).astype(np.uint8), np.ones((3,3), np.uint8))
    if not core.any():
        continue
    distance, labels = cv2.distanceTransformWithLabels(1-core, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    colors = np.zeros((labels.max()+1,3),np.uint8)
    colors[labels[core>0]] = rgba[core>0,:3]
    fringe = (alpha < 245) & (distance < 8)
    rgba[fringe,:3] = colors[labels[fringe]]
    # Ground-cover clumps have a cut-off turf base. Fade only that base into the terrain.
    if name in ('wildflower','grass-tuft','cattail-reed'):
        ys, xs = np.where(alpha > 128)
        floor = ys.max()
        band = max(3, int((floor-ys.min())*0.08))
        fade = np.clip((floor-np.arange(alpha.shape[0]))/band, 0, 1)
        fade = fade*fade*(3-2*fade)
        rgba[:,:,3] = (alpha*fade[:,None]).astype(np.uint8)
    Image.fromarray(rgba).save(OUT/f'{name}.png')
    frame['file'] = f'{name}.png'
    count += 1
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n','utf-8')
print(f'Cleaned matte edges on {count} environment/NPC sprites')
