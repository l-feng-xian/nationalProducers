"""Package native-size visual comparisons and real renderer frames; never redraw them."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ANALYSIS = ROOT / 'output/analysis/world-v6'
PREVIEW = ROOT / 'output/preview/world-v6'
OUT = ANALYSIS / 'acceptance'
OUT.mkdir(parents=True, exist_ok=True)
font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 18)
small = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 14)
reference = Image.open(ROOT / 'output/imagegen/world-v5/raw/town-reference.png').convert('RGB')
runtime = Image.open(PREVIEW / 'reference-webgpu.png').convert('RGB')
legacy = Image.open(ANALYSIS / 'current-same-viewport.png').convert('RGB')
assert reference.size == runtime.size == legacy.size == (1536, 1024)


def pair(left, right, name, left_label='Reference - native pixels', right_label='Runtime WebGPU - native pixels'):
    canvas = Image.new('RGB', (left.width + right.width + 12, max(left.height, right.height) + 42), '#1d2725')
    draw = ImageDraw.Draw(canvas)
    draw.text((10, 12), left_label, font=small, fill='#e3e6da')
    draw.text((left.width + 22, 12), right_label, font=small, fill='#e3e6da')
    canvas.paste(left, (0, 42))
    canvas.paste(right, (left.width + 12, 42))
    canvas.save(OUT / name)
    return canvas


pair(reference, runtime, 'reference-vs-runtime.png')
pair(legacy, runtime, 'before-vs-after.png', 'Previous v5 runtime - same viewport', 'New v6 runtime - same viewport')
webgl = Image.open(PREVIEW / 'reference-webgl.png').convert('RGB')
pair(runtime, webgl, 'webgpu-vs-webgl.png', 'Runtime WebGPU - frozen at t=0', 'Runtime WebGL - frozen at t=0')
regions = json.loads((ANALYSIS / 'regions.json').read_text('utf-8-sig'))['regions']
details = []
for name, box in regions.items():
    # Same viewport windows, not pixel-aligned landmarks. Preserve their native scale.
    details.append(pair(reference.crop(box), runtime.crop(box), name + '.png'))
contact = Image.new('RGB', (1440, 1320), '#1d2725')
draw = ImageDraw.Draw(contact)
for k, detail in enumerate(details):
    x, y = (k % 2) * 720, (k // 2) * 330
    detail.thumbnail((710, 290), Image.Resampling.LANCZOS)
    draw.text((x + 12, y + 8), list(regions)[k], font=font, fill='#e3e6da')
    contact.paste(detail, (x, y + 35))
contact.save(OUT / 'eight-details.jpg', quality=94)

overview = Image.new('RGB', (1920, 467), '#1d2725')
draw = ImageDraw.Draw(overview)
for k, (label, im) in enumerate([('Reference', reference), ('Previous v5', legacy), ('New v6', runtime)]):
    draw.text((k * 640 + 15, 12), label, font=font, fill='#e3e6da')
    overview.paste(im.resize((640, 427), Image.Resampling.LANCZOS), (k * 640, 40))
overview.save(OUT / 'overview-comparison.jpg', quality=95)
natural = Image.open(PREVIEW / 'overview-webgpu.png').convert('RGB')
natural.thumbnail((1536, 960), Image.Resampling.LANCZOS)
natural.save(OUT / 'natural-overview.jpg', quality=95)
for backend in ('webgpu', 'webgl'):
    interaction = PREVIEW / 'interactions'
    if (interaction / f'well-front-{backend}.png').exists():
        behind = Image.open(interaction / f'well-behind-{backend}.png').crop((710, 325, 930, 550))
        front = Image.open(interaction / f'well-front-{backend}.png').crop((710, 325, 930, 550))
        pair(behind, front, f'occlusion-{backend}.png', 'Behind the well', 'In front of the well')

for backend in ('webgpu', 'webgl'):
    frames = [Image.open(p).convert('RGB') for p in sorted((PREVIEW / f'animation-{backend}').glob('*.png'))]
    assert len(frames) == 16
    for name, box in [('walking', (430, 425, 970, 630)), ('water', (30, 0, 300, 570))]:
        crops = [frame.crop(box) for frame in frames]
        crops[0].save(OUT / f'{name}-{backend}.webp', save_all=True, append_images=crops[1:],
                      duration=80, loop=0, lossless=True)
    # Native-resolution contact sheet makes stride poses reviewable without animation support.
    crops = [frames[i].crop((500, 480, 900, 620)) for i in range(0, 16, 2)]
    sheet = Image.new('RGB', (800, 4 * 170), '#1d2725')
    draw = ImageDraw.Draw(sheet)
    for k, crop in enumerate(crops):
        x, y = k % 2 * 400, k // 2 * 170
        draw.text((x + 8, y + 4), f'Frame {k * 2:02}', font=small, fill='#e3e6da')
        sheet.paste(crop, (x, y + 30))
    sheet.save(OUT / f'walking-frames-{backend}.jpg', quality=96)

reports = {backend: json.loads((PREVIEW / filename).read_text('utf-8'))
           for backend, filename in [('webgpu', 'report-webgpu.json'), ('webgl', 'report.json')]}
for backend, report in reports.items():
    assert len(report) == 14
    assert all(r['summary']['backend'] == backend and not r['errors'] for r in report)
    assert all(r.get('pauseVerified') for r in report if r['variant'] in ('reference', 'bridge', 'fixture'))
interaction_report = json.loads((PREVIEW / 'interactions/report.json').read_text('utf-8'))
assert len(interaction_report) == 12
(OUT / 'evidence.json').write_text(json.dumps({
    'viewport': [1536, 1024], 'dpr': 1, 'frozenInitialTime': 0,
    'cropMethod': 'Unscaled same-viewport windows; landmarks are not pixel-aligned.',
    'animationMethod': '16 actual canvas captures; 80ms per encoded frame; inspection playback, not an FPS benchmark.',
    'regions': regions,
    'backendCoverage': {backend: [r['variant'] for r in report] for backend, report in reports.items()},
    'interactionRoutes': len(interaction_report),
}, indent=2) + '\n', 'utf-8')
print(f'Saved full-size pairs, eight region pairs, backend comparisons and motion evidence to {OUT}')
