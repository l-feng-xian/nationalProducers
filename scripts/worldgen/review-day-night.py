"""Side-by-side evidence from the real WebGPU and WebGL renders."""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parents[2]
CAP=ROOT/'output/preview/world-v6/day-night'
OUT=ROOT/'output/analysis/world-v6/day-night'
OUT.mkdir(parents=True,exist_ok=True)
font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',22)
phases=[('dawn','06:00 / Dawn'),('morning','08:00 / Morning'),('noon','12:00 / Noon'),
        ('sunset','17:30 / Sunset'),('twilight','19:00 / Twilight'),('night','22:00 / Night')]
for backend in ['webgpu','webgl']:
    sheet=Image.new('RGB',(768*3,552*2),'#25302b')
    frames=[]
    for i,(name,label) in enumerate(phases):
        img=Image.open(CAP/f'{name}-{backend}.png').convert('RGB').resize((768,512),Image.Resampling.LANCZOS)
        panel=Image.new('RGB',(768,552),'#25302b')
        panel.paste(img,(0,40))
        ImageDraw.Draw(panel).text((14,8),label,font=font,fill='white')
        sheet.paste(panel,((i%3)*768,(i//3)*552))
        frames.append(panel)
    sheet.save(OUT/f'cycle-{backend}.jpg',quality=95)
    frames[0].save(OUT/f'cycle-{backend}.webp',save_all=True,append_images=frames[1:],duration=1200,loop=0,quality=90)
    before=Image.open(CAP/f'morning-no-shadows-{backend}.png').convert('RGB')
    after=Image.open(CAP/f'morning-{backend}.png').convert('RGB')
    diff=np.abs(np.array(after).astype(float)-np.array(before).astype(float)).max(axis=2)
    print(backend,'visible shadow pixels:',int((diff>3).sum()))
    pair=Image.new('RGB',(1536,552),'#25302b')
    for x,img,label in [(0,before,'Solar shadows off'),(768,after,'Solar shadows on / 08:00')]:
        pair.paste(img.resize((768,512),Image.Resampling.LANCZOS),(x,40))
        ImageDraw.Draw(pair).text((x+14,8),label,font=font,fill='white')
    pair.save(OUT/f'shadows-{backend}.jpg',quality=96)
    day=np.asarray(Image.open(CAP/f'noon-{backend}.png').convert('RGB'),dtype=float)
    night=np.asarray(Image.open(CAP/f'night-{backend}.png').convert('RGB'),dtype=float)
    print(backend,'mean day/night brightness:',round(day.mean(),1),round(night.mean(),1))
print('Saved day/night evidence to',OUT)
