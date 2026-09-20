"""Review actual surface lighting and isolate shadow reception from ground shadows."""
from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
CAP = ROOT / 'output/preview/world-v6/object-lighting'
OUT = ROOT / 'output/analysis/world-v6/object-lighting'
OUT.mkdir(parents=True, exist_ok=True)
FONT = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 22)


def load(name, backend):
    return Image.open(CAP / f'{name}-{backend}.png').convert('RGB')


def sheet(panels, columns, filename, width=768, height=512):
    result = Image.new('RGB', (columns * width, ((len(panels) + columns - 1) // columns) * (height + 40)), '#25302b')
    draw = ImageDraw.Draw(result)
    for i, (img, label) in enumerate(panels):
        x, y = (i % columns) * width, (i // columns) * (height + 40)
        result.paste(img.resize((width, height), Image.Resampling.LANCZOS), (x, y + 40))
        draw.text((x + 12, y + 8), label, font=FONT, fill='white')
    result.save(OUT / filename, quality=96)


reports = []
for backend in ['webgpu', 'webgl']:
    phases = [('morning', '08:00'), ('afternoon', '16:00'), ('night', '22:00')]
    sheet([(load(name, backend), label) for name, label in phases], 3, f'surfaces-{backend}.jpg')
    panels = []
    for name, label in phases:
        # Roof, walls and facade lamps at readable scale, before/after the surface shader.
        crop = (315, 125, 1035, 530)
        panels.extend([(load(f'{name}-flat', backend).crop(crop), f'{label} / uniform sprite tint'),
                       (load(name, backend).crop(crop), f'{label} / directional surface light')])
    sheet(panels, 2, f'comparison-{backend}.jpg', 720, 405)
    comparisons = [('hero-unshaded', 'hero-shaded', 'Tree shadow'),
                   ('hero-building-unshaded', 'hero-building-shaded', 'Building shadow'),
                   ('hero-outside-unshaded', 'hero-outside', 'After walking out')]
    panels = []
    metrics = {'backend': backend}
    for lit_name, shade_name, label in comparisons:
        lit, shade = load(lit_name, backend), load(shade_name, backend)
        delta = np.asarray(lit, dtype=float) - np.asarray(shade, dtype=float)
        changed = np.max(np.abs(delta), axis=2) > 2
        count = int(changed.sum())
        brightness = float(delta[changed].mean()) if count else 0
        if label == 'After walking out':
            assert count < 20, f'{backend}: character retains an obsolete received shadow'
        else:
            assert count > 1000 and brightness > 5, f'{backend}: {label} does not shade the character'
            # Inverted render-target Y can affect only the feet while this broad test still passes.
            # The face/upper-body region must receive the known canopy/roof silhouette too.
            upper = delta[32:68, 44:72]
            assert int((np.max(upper, axis=2) > 4).sum()) > 300, f'{backend}: {label} misses the upper body'
        metrics[label] = {'changedPixels': count, 'meanDarkening8bit': round(brightness, 2)}
        panels.extend([(lit, f'{label}: reception off'), (shade, f'{label}: reception on')])
    sheet(panels, 2, f'receiving-{backend}.jpg', 348, 336)
    sheet([(load('tree-shade', backend).crop((580, 325, 1060, 600)), 'Tree casts onto player'),
           (load('building-shade', backend).crop((580, 230, 1180, 600)), 'Building casts onto player')],
          2, f'casters-{backend}.jpg', 720, 444)
    reports.append(metrics)
    print(json.dumps(metrics))
(OUT / 'pixel-report.json').write_text(json.dumps(reports, indent=2) + '\n', encoding='utf-8')
print('Saved object lighting evidence to', OUT)
