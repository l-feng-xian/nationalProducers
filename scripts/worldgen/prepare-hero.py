"""Prepare generated key poses as fixed-pivot sprites and interpolate a seamless 16-frame gait.

Requires Pillow, numpy, opencv-python. All image generation is performed by the imagegen skill CLI.
python scripts/worldgen/prepare-hero.py
"""
from pathlib import Path
import json
import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'output/imagegen/world-v3/raw'
OUT = ROOT / 'public/world/v3'
QA = ROOT / 'output/imagegen/world-v3/qa'
OUT.mkdir(parents=True, exist_ok=True)
QA.mkdir(parents=True, exist_ok=True)
SIZE = 256
FOOT = 238
HEIGHT = 218


def cutout(cell):
    rgb = np.array(cell.convert('RGB'), dtype=np.float32)
    # The generated background is slightly off pure magenta. Estimate its actual RGB at the border.
    border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]))
    key = np.median(border, axis=0)
    dominance = np.minimum(rgb[:, :, 0], rgb[:, :, 2]) - rgb[:, :, 1]
    key_axis = min(key[0], key[2]) - key[1]
    a = 1 - np.clip((dominance - 22) / max(1, key_axis - 22), 0, 1)
    a[a < 0.025] = 0
    # Invert compositing at antialiased edges; preserve the black/red costume.
    clean = (rgb - (1-a[:, :, None]) * key) / np.maximum(a[:, :, None], 0.01)
    rgba = np.dstack((np.clip(clean, 0, 255), a*255)).astype(np.uint8)
    return Image.fromarray(rgba)


def aligned(cell, scale, mirror=False):
    sprite = cutout(cell)
    if mirror:
        sprite = sprite.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    arr = np.array(sprite)
    ys, xs = np.where(arr[:, :, 3] > 160)
    top, bottom = ys.min(), ys.max()
    # Hair/ribbon width changes during a stride. Anchor the top of the head, not the full silhouette.
    hy, hx = np.where(arr[:top+35, :, 3] > 160)
    center = (hx.min()+hx.max()) / 2
    matrix = np.float32([[scale, 0, SIZE/2-center*scale], [0, scale, FOOT-bottom*scale]])
    result = cv2.warpAffine(arr, matrix, (SIZE, SIZE), flags=cv2.INTER_CUBIC)
    return result


def tween(a, b, t):
    if t == 0:
        return a.copy()
    # Optical flow aligns moving contours before blending; simple crossfades leave duplicate limbs.
    backdrop = np.array([112, 127, 82], np.float32)
    def analysis(im):
        alpha = im[:, :, 3:4].astype(np.float32)/255
        composite = im[:, :, :3]*alpha + backdrop*(1-alpha)
        return cv2.cvtColor(composite.astype(np.uint8), cv2.COLOR_RGB2GRAY)
    flow = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    ga, gb = analysis(a), analysis(b)
    ab = flow.calc(ga, gb, None)
    ba = flow.calc(gb, ga, None)
    yy, xx = np.mgrid[:SIZE, :SIZE].astype(np.float32)
    def warp(im, f, amount):
        value = im.astype(np.float32)/255
        value[:, :, :3] *= value[:, :, 3:4]
        return cv2.remap(value, xx-f[:, :, 0]*amount, yy-f[:, :, 1]*amount, cv2.INTER_LINEAR)
    value = warp(a, ab, t)*(1-t) + warp(b, ba, 1-t)*t
    value[:, :, :3] /= np.maximum(value[:, :, 3:4], 0.001)
    value[value[:, :, 3] < 0.025] = 0
    return np.clip(value*255, 0, 255).astype(np.uint8)


gait = Image.open(RAW/'hero-gait.png')
stand = Image.open(RAW/'hero-walk.png')
manifest = json.loads((ROOT/'public/world/v1/manifest.json').read_text('utf-8'))
# Versioned manifest inherits unchanged terrain/decor/NPC frames without duplicating them on disk.
manifest['frames'] = {k: {**v, 'file': '../v1/'+v['file']} for k,v in manifest['frames'].items()
                      if not k.startswith(('hero-', 'walk-', 'idle-'))}
manifest['assetVersion'] = 'world-3'
manifest['heroSource'] = {'model':'gpt-image-2.5-flare', 'walkKeyframes':4, 'walkFrames':16,
                         'interpolation':'bidirectional optical flow, fixed head anchor and foot baseline'}
sheet = Image.new('RGBA', (SIZE*8, SIZE*8), '#718153')
gif_frames=[]
for row, direction in enumerate(['down','up','left','right']):
    # The generated last right-facing key pose faces left. Mirror the matching left passing pose.
    cells = [gait.crop((col*256, row*256, (col+1)*256, (row+1)*256)) for col in range(4)]
    if direction == 'right':
        cells[3] = gait.crop((3*256, 2*256, 4*256, 3*256)).transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    heights = [cutout(c).getbbox()[3]-cutout(c).getbbox()[1] for c in cells]
    scale = HEIGHT / np.median(heights)
    keys = [aligned(c, scale) for c in cells]
    frames = [tween(keys[i//4], keys[(i//4+1)%4], (i%4)/4) for i in range(16)]
    for i, arr in enumerate(frames):
        name = f'walk-{direction}-{i}'
        img = Image.fromarray(arr)
        img.save(OUT/f'{name}.png')
        manifest['frames'][name] = {'file':f'{name}.png','kind':'sprite','w':SIZE,'h':SIZE,
                                   'pivot':[0.5,FOOT/SIZE],'frameHeight':HEIGHT}
        sheet.alpha_composite(img, ((i%8)*SIZE,(row*2+i//8)*SIZE))
    # Stable standing pose and a restrained continuous breathing cycle, same physical scale.
    cw,ch=stand.width//8,stand.height//4
    cell=stand.crop((0,row*ch,cw,(row+1)*ch))
    box=cutout(cell).getbbox()
    rest=aligned(cell, HEIGHT/(box[3]-box[1]))
    for i in range(16):
        breath=(1-np.cos(2*np.pi*i/16))*0.003
        matrix=np.float32([[1,0,0],[0,1+breath,-FOOT*breath]])
        arr=cv2.warpAffine(rest,matrix,(SIZE,SIZE),flags=cv2.INTER_CUBIC)
        name=f'idle-{direction}-{i}'
        Image.fromarray(arr).save(OUT/f'{name}.png')
        manifest['frames'][name]={'file':f'{name}.png','kind':'sprite','w':SIZE,'h':SIZE,
                                 'pivot':[0.5,FOOT/SIZE],'frameHeight':HEIGHT}
    Image.fromarray(rest).save(OUT/f'hero-{direction}.png')
    manifest['frames'][f'hero-{direction}']={'file':f'hero-{direction}.png','kind':'sprite','w':SIZE,'h':SIZE,
                                          'pivot':[0.5,FOOT/SIZE],'frameHeight':HEIGHT}
    gif_frames.append(frames)

(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n','utf-8')
sheet.convert('RGB').resize((1024,1024)).save(QA/'hero-contact-sheet.jpg',quality=95)
preview=[]
for i in range(16):
    canvas=Image.new('RGBA',(SIZE*4,SIZE),'#718153')
    for row in range(4): canvas.alpha_composite(Image.fromarray(gif_frames[row][i]),(row*SIZE,0))
    preview.append(canvas.convert('RGB'))
preview[0].save(QA/'hero-walk.gif',save_all=True,append_images=preview[1:],duration=50,loop=0)
print(f'Prepared 4 directions, 16 walk + 16 idle frames each in {OUT}')
