"""Articulated side gait from the generated character art; never morph between repeated poses.

The generated contact poses keep the same support leg. Extract their painted boots,
then animate two independent leg chains under the original painted robe. All frames
share one body scale and foot pivot. Right-facing frames mirror the complete gait.
"""
from pathlib import Path
import json
import math
import cv2
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / 'output/imagegen/world-v6/raw/hero-side-gait.png'
OUT = ROOT / 'public/world/v6'
QA = ROOT / 'output/imagegen/world-v6/qa/side-gait'
SIZE, FOOT, HEIGHT = 256, 238, 218


def polygon_cut(image, points):
    mask = Image.new('L', image.size)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    result = image.copy()
    result.putalpha(Image.fromarray(np.minimum(np.array(image.getchannel('A')), np.array(mask))))
    return result


def affine(image, source, target):
    matrix = cv2.getAffineTransform(np.float32(source), np.float32(target))
    a = np.array(image).astype(np.float32) / 255
    a[:, :, :3] *= a[:, :, 3:4]
    a = cv2.warpAffine(a, matrix, (SIZE, SIZE), flags=cv2.INTER_CUBIC)
    a[:, :, :3] /= np.maximum(a[:, :, 3:4], .001)
    a[a[:, :, 3] < .015] = 0
    return Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8))


def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    QA.mkdir(parents=True, exist_ok=True)
    sheet = Image.open(RAW).convert('RGBA')
    source = sheet.crop((0, 0, sheet.width // 4, sheet.height // 2))
    a = np.array(source)
    # Remove transparent colour haze; the opaque brushwork and fine outline remain.
    a[:, :, 3] = (np.clip((a[:, :, 3].astype(float) - 90) / 150, 0, 1) * 255).astype(np.uint8)
    source = Image.fromarray(a)
    ys, xs = np.where(a[:, :, 3] > 160)
    scale = HEIGHT / (ys.max() - ys.min() + 1)
    matrix = np.float32([[scale, 0, 128 - 170 * scale], [0, scale, FOOT - ys.max() * scale]])
    source = Image.fromarray(cv2.warpAffine(a, matrix, (SIZE, SIZE), flags=cv2.INTER_CUBIC))
    source.save(QA / 'source.png')
    # Separate the painted legs at the robe silhouette (not rectangular clipping).
    near_region = [(89,201),(112,210),(108,224),(102,240),(62,240),(60,219),(80,217)]
    far_region = [(152,206),(176,196),(204,215),(204,241),(169,241),(170,222)]
    body = source.copy()
    alpha = body.getchannel('A')
    d = ImageDraw.Draw(alpha)
    for points in [near_region, far_region]:
        d.polygon(points, fill=0)
    body.putalpha(alpha)
    boot = polygon_cut(source, [(80,219),(102,224),(103,239),(61,239),(61,219)])
    # Both joints are skinned with the generated trouser brushwork, under the robe.
    cloth = source.crop((87,212,103,222)).resize((16,40), Image.Resampling.BICUBIC)
    cloth.putalpha(Image.new('L', cloth.size, 255))
    limb = Image.new('RGBA', (SIZE,SIZE))
    limb.alpha_composite(cloth, (120,0))
    soft = Image.new('L',(SIZE,SIZE))
    sd = ImageDraw.Draw(soft)
    sd.rounded_rectangle((120,0,135,39),radius=3,fill=255)
    limb.putalpha(soft)
    frames, tracks = [], []

    def leg(phase, bob, far):
        phase %= 1
        stance = phase < .5
        u = phase * 2 if stance else (phase-.5)*2
        # Constant backward travel on planted foot; lifted boot returns forward.
        x = 99 + 53*u if stance else 152 - 53*(u*u*(3-2*u))
        lift = 0 if stance else 17*math.sin(math.pi*u)
        angle = -.26 + (0 if stance else .32*math.sin(2*math.pi*u))
        c, s = math.cos(angle), math.sin(angle)
        rotation = np.array([[c,-s],[s,c]])
        anchor = np.array([93.,225.])
        # Keep the sole on the ground during support, independent of boot angle.
        by,bx = np.where(np.array(boot.getchannel('A')) > 160)
        bottom = max((np.stack([bx,by],axis=1)-anchor) @ rotation.T, key=lambda v:v[1])[1]
        ankle = np.array([x, FOOT-lift-bottom])
        hip = np.array([123.,184.+bob])
        v = ankle-hip
        length = np.linalg.norm(v)
        # Bend both knees toward travel. Two real chains alternate by half a cycle.
        knee = (hip+ankle)*.5 + np.array([-v[1],v[0]])/length*math.sqrt(max(0,29**2-(length/2)**2))
        paint = Image.new('RGBA',(SIZE,SIZE))
        for a,b,width in [(hip,knee,16),(knee,ankle,13)]:
            delta = b-a
            normal = np.array([-delta[1],delta[0]])/np.linalg.norm(delta)*width*.5
            paint.alpha_composite(affine(limb, [[120,0],[136,0],[120,40]], [a-normal,a+normal,b-normal]))
        triangle = np.array([[80,220],[102,220],[80,239]],float)
        paint.alpha_composite(affine(boot, triangle, (triangle-anchor) @ rotation.T + ankle))
        if far:
            pixels = np.array(paint)
            pixels[:,:,:3] = (pixels[:,:,:3]*.76).astype(np.uint8)
            paint = Image.fromarray(pixels)
        return paint, dict(ankle=ankle.tolist(),knee=knee.tolist(),lift=lift,stance=stance)

    for i in range(32):
        phase = i/32
        bob = -2*math.sin(phase*2*math.pi)**2
        back, back_track = leg(phase+.5,bob,True)
        front, front_track = leg(phase,bob,False)
        canvas = Image.new('RGBA',(SIZE,SIZE))
        canvas.alpha_composite(back)
        canvas.alpha_composite(front)
        # A very small cloth sway below the waist, with a stable head/body scale.
        a = np.array(body).astype(np.float32)/255
        a[:,:,:3] *= a[:,:,3:4]
        yy,xx = np.mgrid[:SIZE,:SIZE].astype(np.float32)
        sway = math.sin(phase*2*math.pi)*2*np.clip((yy-150)/65,0,1)
        a = cv2.remap(a,xx-sway,yy-bob,cv2.INTER_CUBIC)
        a[:,:,:3] /= np.maximum(a[:,:,3:4],.001)
        a[a[:,:,3]<.015]=0
        canvas.alpha_composite(Image.fromarray(np.clip(a*255,0,255).astype(np.uint8)))
        frames.append(canvas)
        tracks.append(dict(frame=i,near=front_track,far=back_track))

    override = dict(model='gpt-image-2.5-flare',source=str(RAW.relative_to(ROOT)),
                    animation='two independent leg chains; continuous 32-frame cycle; mirrored right',frames={})
    for direction in ['left','right']:
        for i,frame in enumerate(frames):
            name = f'walk-{direction}-{i}'
            file = f'hero-side/{name}.png'
            (OUT/'hero-side').mkdir(exist_ok=True)
            if direction=='right':
                frame=frame.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            frame.save(OUT/file)
            override['frames'][name]=dict(file=file,kind='sprite',w=SIZE,h=SIZE,
                                         pivot=[.5,FOOT/SIZE],frameHeight=HEIGHT)
    (OUT/'side-gait.json').write_text(json.dumps(override,indent=2)+'\n','utf-8')
    for version in ['v5','v6']:
        path=ROOT/f'public/world/{version}/manifest.json'
        manifest=json.loads(path.read_text('utf-8'))
        for name,spec in override['frames'].items():
            manifest['frames'][name]={**spec,'file':('' if version=='v6' else '../v6/')+spec['file']}
        manifest['heroSideGait']={k:v for k,v in override.items() if k!='frames'}
        path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n','utf-8')

    review=Image.new('RGBA',(SIZE*8,SIZE*2),'#718153')
    for row in range(2):
        for col in range(8):
            frame=frames[col*4]
            if row: frame=frame.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            review.alpha_composite(frame,(col*SIZE,row*SIZE))
    review.convert('RGB').save(QA/'contact-sheet.jpg',quality=96)
    animation=[]
    for frame in frames:
        canvas=Image.new('RGBA',(SIZE*2,SIZE),'#718153')
        canvas.alpha_composite(frame,(0,0))
        canvas.alpha_composite(frame.transpose(Image.Transpose.FLIP_LEFT_RIGHT),(SIZE,0))
        animation.append(canvas.convert('RGB'))
    animation[0].save(QA/'side-walk.webp',save_all=True,append_images=animation[1:],duration=24,loop=0,lossless=True)
    (QA/'joint-tracks.json').write_text(json.dumps(tracks,indent=2)+'\n','utf-8')
    print('Prepared 32 articulated frames per side; manifests v5/v6 updated.')


if __name__ == '__main__':
    prepare()
