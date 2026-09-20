"""Review the actual dry-ground and wading captures from both renderers."""
from pathlib import Path
import json
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
CAPTURES = ROOT / 'output/preview/world-v6/movement'
OUT = ROOT / 'output/analysis/world-v6/movement'
OUT.mkdir(parents=True, exist_ok=True)
font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 16)
reports = json.loads((CAPTURES/'wading-report.json').read_text('utf-8'))

for report in reports:
    backend = report['backend']
    # Camera tracks the player: the foot is always at the center of the canvas.
    captures = {}
    for direction in ['left', 'right']:
        paths = sorted((CAPTURES/f'drywalk-{direction}-{backend}').glob('*.png'))
        assert len(paths) == 16
        captures[direction] = [Image.open(p).convert('RGB').crop((678,408,858,544)).resize((360,272)) for p in paths]
    animation=[]
    for i in range(16):
        canvas=Image.new('RGB',(720,306),'#25302b')
        draw=ImageDraw.Draw(canvas)
        for x,direction in [(0,'left'),(360,'right')]:
            draw.text((x+10,8),f'{direction.title()} / dry grass / 3.2 tiles per second',font=font,fill='white')
            canvas.paste(captures[direction][i],(x,34))
        animation.append(canvas)
    animation[0].save(OUT/f'grass-walk-{backend}.webp',save_all=True,append_images=animation[1:],duration=80,loop=0,lossless=True)
    sheet=Image.new('RGB',(360*4,306*2),'#25302b')
    draw=ImageDraw.Draw(sheet)
    for row,direction in enumerate(['left','right']):
        for col,index in enumerate([0,3,6,9]):
            x,y=col*360,row*306
            draw.text((x+8,y+8),f'{direction} / capture {index:02}',font=font,fill='white')
            sheet.paste(captures[direction][index],(x,y+34))
    sheet.save(OUT/f'grass-walk-frames-{backend}.jpg',quality=96)
    water = [Image.open(p).convert('RGB').crop((588,370,948,566)) for p in sorted((CAPTURES/f'wading-{backend}').glob('*.png'))]
    water[0].save(OUT/f'wading-{backend}.webp',save_all=True,append_images=water[1:],duration=95,loop=0,lossless=True)
    print(backend, 'dry speeds:', sorted(set(s['walkSpeed'] for s in report['drySamples'])),
          'body heights:', min(h['height'] for h in report['heroHeights']), max(h['height'] for h in report['heroHeights']))
print('Saved movement evidence at', OUT)
