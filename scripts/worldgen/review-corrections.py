"""Evidence for the four v6 corrections, preserving the previous acceptance captures."""
from pathlib import Path
import json
from PIL import Image,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parents[2]
PREVIEW=ROOT/'output/preview/world-v6'
NEW=PREVIEW/'corrections'
OUT=ROOT/'output/analysis/world-v6/corrections'
OUT.mkdir(parents=True,exist_ok=True)
font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',16)

def pair(before,after,name):
    canvas=Image.new('RGB',(before.width+after.width+12,max(before.height,after.height)+32),'#25302b')
    d=ImageDraw.Draw(canvas);d.text((8,7),'Before',font=font,fill='white');d.text((before.width+20,7),'After',font=font,fill='white')
    canvas.paste(before,(0,32));canvas.paste(after,(before.width+12,32));canvas.save(OUT/name)

old=Image.open(PREVIEW/'reference-webgpu.png').convert('RGB')
new=Image.open(NEW/'reference-webgpu.png').convert('RGB')
pair(old,new,'town-before-after.jpg')
for name,box in [('fences-flowers',(275,315,650,570)),('bank-stones',(180,270,340,580)),('tree-spacing',(480,0,1020,135))]:
    pair(old.crop(box),new.crop(box),name+'.png')
overview=Image.open(NEW/'overview-webgpu.png').convert('RGB');overview.thumbnail((1600,1000));overview.save(OUT/'forest-overview.jpg',quality=95)

for backend in ['webgpu','webgl']:
    frames=[Image.open(p).convert('RGB').crop((530,365,965,590)) for p in sorted((NEW/f'wading-{backend}').glob('*.png'))]
    assert len(frames)==36
    frames[0].save(OUT/f'wading-{backend}.webp',save_all=True,append_images=frames[1:],duration=95,loop=0,lossless=True)
    sheet=Image.new('RGB',(435*3,255*2),'#25302b');d=ImageDraw.Draw(sheet)
    for k,index in enumerate([0,6,12,18,24,35]):
        x=k%3*435;y=k//3*255
        d.text((x+8,y+6),f'Frame {index:02}',font=font,fill='white');sheet.paste(frames[index],(x,y+30))
    sheet.save(OUT/f'wading-frames-{backend}.jpg',quality=96)

report=json.loads((NEW/'wading-report.json').read_text('utf-8'))
for r in report:
    heights=[h['height'] for h in r['heroHeights']]
    print(r['backend'],'normalized opaque hero heights:',min(heights),max(heights),'atlas pixels; max immersion:',max(s['submersion'] for s in r['samples']))
print('Saved correction evidence:',OUT)
