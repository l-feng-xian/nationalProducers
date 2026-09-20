"""Prepare independently generated v6 materials/cutouts; preserve source images."""
from pathlib import Path
import json
import posixpath
import cv2
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'output/imagegen/world-v6/raw'
OUT = ROOT / 'public/world/v6'
OUT.mkdir(parents=True, exist_ok=True)
manifest = json.loads((ROOT / 'public/world/v5/manifest.json').read_text('utf-8'))
manifest['assetVersion'] = 'world-6'
for frame in manifest['frames'].values():
    frame['file'] = posixpath.normpath('../v5/' + frame['file'])


def seamless(image):
    a = np.array(image.convert('RGB'), dtype=np.float32)
    for axis in [1, 0]:
        n = a.shape[axis]
        source = a.copy()
        band = 32
        for i in range(band):
            t = .5 * (1 - i / band) ** 2
            lo, hi = [slice(None)] * 3, [slice(None)] * 3
            lo[axis], hi[axis] = i, n - i - 1
            a[tuple(lo)] = source[tuple(lo)] * (1-t) + source[tuple(hi)] * t
            a[tuple(hi)] = source[tuple(hi)] * (1-t) + source[tuple(lo)] * t
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).convert('RGBA')


terrain = Image.open(RAW / 'terrain-sample.png')
for k, name in enumerate(['grass-meadow', 'dirt-path', 'cobble', 'soil-tilled', 'water-shallow', 'sand']):
    x, y = (k % 3) * 512, (k // 3) * 512
    im = seamless(terrain.crop((x+2, y+2, x+510, y+510)).resize((512,512), Image.Resampling.LANCZOS))
    if name == 'grass-meadow':
        a=np.array(im).astype(np.float32)
        # Retain painted details, subdue the uniformly bright flower speckle in the source.
        a[:,:,:3]=a[:,:,:3]*.78 + np.array([127,146,76])*.22
        im=Image.fromarray(a.clip(0,255).astype(np.uint8))
    im.save(OUT / f'{name}.png')
    manifest['frames'][name] = dict(file=f'{name}.png', kind='tiling', w=512, h=512)
# The forest floor shares the meadow brushwork, with subdued shaded greens.
for name, tint in [('forest-floor', (.77, .88, .84)), ('marsh', (.79, .90, .92))]:
    a = np.array(Image.open(OUT / 'grass-meadow.png'))
    a[:,:,:3] = (a[:,:,:3] * np.array(tint)).astype(np.uint8)
    Image.fromarray(a).save(OUT / f'{name}.png')
    manifest['frames'][name] = dict(file=f'{name}.png', kind='tiling', w=512, h=512)

reviews = []
report = {}


def cut_sheet(filename, cols, rows, names, cutoffs, tier=256, split_y=None):
    sheet = Image.open(RAW / filename).convert('RGBA')
    for k, name in enumerate(names):
        if not name:
            continue
        x0, y0 = round(k % cols * sheet.width/cols), round(k//cols * sheet.height/rows)
        x1, y1 = round((k % cols+1)*sheet.width/cols), round((k//cols+1)*sheet.height/rows)
        if split_y is not None:
            y0,y1=(0,split_y) if k<cols else (split_y,sheet.height)
        a = np.array(sheet.crop((x0,y0,x1,y1)))
        alpha = a[:,:,3].astype(np.float32)
        low = cutoffs[k]
        if alpha.min() > 240:
            raise ValueError(f'{name}: opaque background requires separate extraction')
        # Remove only exterior mist. Fine high-alpha twigs stay in the connected silhouette.
        clean = np.clip((alpha-low)/(250-low), 0, 1)
        components, labels, stats, _ = cv2.connectedComponentsWithStats((clean>.4).astype(np.uint8))
        keep = np.zeros(labels.shape, np.uint8)
        largest = stats[1:,cv2.CC_STAT_AREA].max()
        for label in range(1,components):
            if stats[label,cv2.CC_STAT_AREA] >= max(3,largest*.001):
                keep[labels==label]=1
        keep = cv2.dilate(keep,np.ones((3,3),np.uint8))
        a[:,:,3] = (clean*keep*255).astype(np.uint8)
        im = Image.fromarray(a)
        box = im.getbbox()
        if not box or box[0] <= 1 or box[1] <= 1 or box[2]>=a.shape[1]-1 or box[3]>=a.shape[0]-1:
            raise ValueError(f'{name}: missing or clipped silhouette {box}')
        im = im.crop(box)
        padded = Image.new('RGBA',(im.width+16, im.height+16))
        padded.paste(im,(8,8))
        padded.save(OUT / f'{name}.png')
        manifest['frames'][name] = dict(file=f'{name}.png',kind='sprite',w=padded.width,h=padded.height,tier=tier)
        report[name] = dict(source=filename,cell=k,alphaFloor=low,bounds=box)
        thumb=padded.copy()
        thumb.thumbnail((270,230),Image.Resampling.LANCZOS)
        reviews.append((name,thumb))


cut_sheet('environment-sample.png',4,3,
    ['bank-rocks','water-rocks','shore-flowers','shore-reeds','farm-fence','side-fence',
     'town-lamp','flower-trough','crop-cabbage','crop-seedling','crop-wheat','barn-supplies'],
    [95,70,65,45,90,90,70,90,80,65,50,90])

# Later passes may add these independently generated kits without changing prior outputs.
for filename,names in [
    ('buildings-public.png',['shop','inn','barn','well']),
    ('buildings-homes.png',['cottage','cottage-blue','cottage-wide','cottage-gold']),
    ('trees-bridge.png',['oak-round','oak-spreading','leafy-bush','bridge-rail'])]:
    if (RAW/filename).exists():
        cut_sheet(filename,2,2,names,[100,100,90,80],512,
                  540 if filename=='buildings-public.png' else 670 if filename=='trees-bridge.png' else 512)

if (RAW/'refine-trees-barn.png').exists():
    cut_sheet('refine-trees-barn.png',2,2,['oak-round','oak-spreading','barn',None],
              [110,110,100,100],512,570)

if (RAW/'props-correction.png').exists():
    corrected=['fence-front-straight','fence-side-straight','flower-box-straight',
               'bank-stones-dry','rounded-stones-dry','flat-stone-dry']
    cut_sheet('props-correction.png',3,2,corrected,[110,110,110,105,105,105])
    for name,alias in zip(corrected,['farm-fence','side-fence','flower-trough',
                                   'bank-rocks','water-rocks','mossy-rock']):
        manifest['frames'][alias]=manifest['frames'].pop(name)
    # Build a zero-yaw side module from the SAME generated timber. The raw side
    # view incorrectly stretches its rear post; two identical posts remove that
    # perspective distortion without rotating the whole billboard.
    front=Image.open(OUT/'fence-front-straight.png').convert('RGBA')
    post=front.crop((8,8,72,270)).resize((24,96),Image.Resampling.LANCZOS)
    rail=front.crop((85,66,355,93)).resize((177,12),Image.Resampling.LANCZOS).transpose(Image.Transpose.ROTATE_90)
    side=Image.new('RGBA',(56,289))
    side.alpha_composite(post,(16,8))
    side.alpha_composite(rail,(29,45))
    side.alpha_composite(post,(16,185))
    side.save(OUT/'fence-side-aligned.png')
    manifest['frames']['side-fence']=dict(file='fence-side-aligned.png',kind='sprite',w=56,h=289)
    manifest['frames']['water-rocks']=dict(manifest['frames']['mossy-rock'])

canvas = Image.new('RGB',(1200,280*((len(reviews)+3)//4)),'#8a956b')
draw = ImageDraw.Draw(canvas)
for k,(name,im) in enumerate(reviews):
    x,y=k%4*300,k//4*280
    canvas.paste(im,(x+(300-im.width)//2,y+245-im.height),im)
    draw.text((x+12,y+252),name,fill='#17271b')
canvas.save(RAW.parent/'cutouts-review.jpg')
manifest['frames']['garden-hedge']=dict(manifest['frames']['leafy-bush'])
manifest['frames']['leafy-bush']=dict(file='../v5/leafy-bush.png',kind='sprite',w=256,h=256)
# Keep the inherited bush's exact source path (v5 can itself refer to an earlier asset).
old=json.loads((ROOT/'public/world/v5/manifest.json').read_text('utf-8'))['frames']['leafy-bush']
manifest['frames']['leafy-bush']={**old,'file':posixpath.normpath('../v5/'+old['file'])}
(RAW.parent/'extraction-report.json').write_text(json.dumps(report,indent=2)+'\n','utf-8')
if (OUT/'side-gait.json').exists():
    gait=json.loads((OUT/'side-gait.json').read_text('utf-8'))
    manifest['frames'].update(gait['frames'])
    manifest['heroSideGait']={k:v for k,v in gait.items() if k!='frames'}
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n','utf-8')
print(f'Prepared {len(reviews)} independent sprites and 8 ground materials at {OUT}')
