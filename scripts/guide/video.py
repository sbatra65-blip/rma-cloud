# Builds the YouTube tutorial from the frames made by capture.py: title, chapter cards, each step with a slow zoom
# towards the action, a highlight box, a pointer for clicks, captions, and an original music track.
# Usage: python3 scripts/guide/video.py <capture_out_dir> <out.mp4>
import json, math, os, subprocess, sys, textwrap
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SRC, OUT = sys.argv[1], sys.argv[2]
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W, H, FPS = 1920, 1080, 30
WORK = os.path.join(os.path.dirname(OUT), 'video-work')
os.makedirs(WORK, exist_ok=True)
INK, INK2, PINK, ACC = (30, 27, 75), (48, 48, 144), (224, 64, 128), (48, 48, 144)
F_BOLD = '/usr/share/fonts/opentype/inter/InterDisplay-Bold.otf'
F_MED = '/usr/share/fonts/opentype/inter/InterDisplay-Medium.otf'
F_REG = '/usr/share/fonts/opentype/inter/Inter-Regular.otf'
def font(p, s):
    return ImageFont.truetype(p, s)

timeline = json.load(open(os.path.join(SRC, 'timeline.json')))
mark = Image.open(os.path.join(ROOT, 'public/icons/icon-512.png')).convert('RGBA')

def ease(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)

# ---------- cards ----------
def bg_gradient():
    g = Image.new('RGB', (W, H), INK)
    d = ImageDraw.Draw(g)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=(int(INK[0] + (INK2[0] - INK[0]) * t * 0.7), int(INK[1] + (INK2[1] - INK[1]) * t * 0.7), int(INK[2] + (INK2[2] - INK[2]) * t * 0.7)))
    glow = Image.new('RGB', (W, H), (0, 0, 0))
    ImageDraw.Draw(glow).ellipse([W * 0.55, -H * 0.4, W * 1.3, H * 0.6], fill=(120, 40, 110))
    glow = glow.filter(ImageFilter.GaussianBlur(160))
    return Image.blend(g, Image.composite(glow, g, Image.new('L', (W, H), 255)), 0.35)

BG = bg_gradient()

def wordmark(d, x, y, size, light=True):
    f = font(F_BOLD, size)
    d.text((x, y), 'trackmy', font=f, fill=(255, 255, 255) if light else INK)
    w = d.textlength('trackmy', font=f)
    d.text((x + w, y), 'RMA', font=f, fill=PINK)

def card_title():
    im = BG.copy(); d = ImageDraw.Draw(im)
    m = mark.resize((200, 200), Image.LANCZOS); im.paste(m, (160, 250), m)
    wordmark(d, 400, 285, 96)
    d.text((165, 520), 'How to use TrackMyRMA', font=font(F_BOLD, 88), fill=(255, 255, 255))
    d.text((168, 640), 'Set up your company, add masters and care packs,', font=font(F_MED, 42), fill=(214, 212, 240))
    d.text((168, 700), 'and take every RMA from the customer to the OEM and back.', font=font(F_MED, 42), fill=(214, 212, 240))
    d.text((168, 900), 'Step-by-step tutorial  ·  demo company with made-up data', font=font(F_REG, 30), fill=(170, 168, 205))
    return im

def card_agenda(chapters):
    im = BG.copy(); d = ImageDraw.Draw(im)
    d.text((160, 120), 'In this video', font=font(F_BOLD, 72), fill=(255, 255, 255))
    f = font(F_MED, 40)
    col = (len(chapters) + 1) // 2
    for i, c in enumerate(chapters):
        x = 165 + (i // col) * 820; y = 260 + (i % col) * 104
        d.ellipse([x, y + 2, x + 56, y + 58], fill=PINK)
        d.text((x + 28, y + 30), str(i + 1), font=font(F_BOLD, 30), fill=(255, 255, 255), anchor='mm')
        d.text((x + 80, y + 6), c, font=f, fill=(235, 234, 250))
    return im

def card_chapter(i, title):
    im = BG.copy(); d = ImageDraw.Draw(im)
    d.text((160, 360), f'Step {i}', font=font(F_BOLD, 54), fill=PINK)
    d.text((158, 440), title, font=font(F_BOLD, 110), fill=(255, 255, 255))
    m = mark.resize((90, 90), Image.LANCZOS); im.paste(m, (W - 250, H - 200), m)
    return im

FEATURES = [
    'Fills your OEM\'s own RMA form, photos included, and emails it',
    'Care packs checked against the OEM PO, invoice and payment',
    'Private status page and emails for your customers',
    'Device history and print-head claim rules for every serial',
    'OEM batches with packing list and delivery challans',
    'Works on phone, tablet and computer — two-step login for all',
]
def card_features():
    im = BG.copy(); d = ImageDraw.Draw(im)
    d.text((160, 110), 'Why service centres use TrackMyRMA', font=font(F_BOLD, 66), fill=(255, 255, 255))
    for i, t in enumerate(FEATURES):
        y = 270 + i * 112
        d.rounded_rectangle([160, y, 220, y + 60], radius=16, fill=PINK)
        d.text((190, y + 30), '✓', font=font('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 34), fill=(255, 255, 255), anchor='mm')
        d.text((250, y + 6), t, font=font(F_MED, 42), fill=(235, 234, 250))
    return im

def card_end():
    im = BG.copy(); d = ImageDraw.Draw(im)
    m = mark.resize((220, 220), Image.LANCZOS); im.paste(m, ((W - 220) // 2, 230), m)
    d.text((W // 2, 560), 'Start your free 30-day trial', font=font(F_BOLD, 84), fill=(255, 255, 255), anchor='mm')
    d.text((W // 2, 670), 'trackmyrma.com', font=font(F_BOLD, 64), fill=PINK, anchor='mm')
    d.text((W // 2, 770), 'No card needed  ·  every feature  ·  user guide inside the app', font=font(F_MED, 36), fill=(214, 212, 240), anchor='mm')
    return im

# ---------- step scenes ----------
CURSOR = Image.new('RGBA', (60, 70), (0, 0, 0, 0))
cd = ImageDraw.Draw(CURSOR)
cd.polygon([(4, 2), (4, 52), (17, 40), (27, 62), (36, 58), (26, 37), (44, 37)], fill=(255, 255, 255), outline=(20, 20, 30))
cd.line([(4, 2), (4, 52), (17, 40), (27, 62), (36, 58), (26, 37), (44, 37), (4, 2)], fill=(20, 20, 30), width=3)

def camera_for(box):
    if not box:
        return 1.0, W / 2, H / 2
    x, y, w, h = box
    z = min(W / max(w * 2.2, 1), H / max(h * 2.4, 1))
    z = max(1.0, min(1.35, z))
    cx, cy = x + w / 2, y + h / 2
    hw, hh = W / (2 * z), H / (2 * z)
    cx = min(max(cx, hw), W - hw); cy = min(max(cy, hh), H - hh)
    return z, cx, cy

def view(img, z, cx, cy):
    if z <= 1.0001:
        return img.copy()
    hw, hh = W / (2 * z), H / (2 * z)
    return img.resize((W, H), Image.BICUBIC, box=(cx - hw, cy - hh, cx + hw, cy + hh))

def to_view(pt, z, cx, cy):
    return ((pt[0] - (cx - W / (2 * z))) * z, (pt[1] - (cy - H / (2 * z))) * z)

def caption_layer(chapter, text, top):
    lay = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(lay)
    f = font(F_MED, 44)
    lines = textwrap.wrap(text, 70)[:3]
    bh = 70 + 58 * len(lines)
    y0 = 40 if top else H - bh - 40
    d.rounded_rectangle([90, y0, W - 90, y0 + bh], radius=26, fill=(22, 20, 58, 232))
    d.rounded_rectangle([90, y0, 100, y0 + bh], radius=4, fill=PINK + (255,))
    d.text((130, y0 + 18), chapter.upper(), font=font(F_BOLD, 24), fill=PINK + (255,))
    for i, ln in enumerate(lines):
        d.text((130, y0 + 54 + i * 58), ln, font=f, fill=(255, 255, 255, 255))
    return lay

def render_step(step, prev_last, dur):
    img = Image.open(os.path.join(SRC, 'frames', step['file'])).convert('RGB')
    box = step['box']
    z1, cx1, cy1 = camera_for(box)
    top = bool(box and (box[1] + box[3] / 2) > H * 0.62)
    cap = caption_layer(step['chapter'], step['caption'], top)
    frames = int(dur * FPS)
    still = None
    for i in range(frames):
        t = i / FPS
        k = ease((t - 0.25) / 1.3)
        z = 1 + (z1 - 1) * k; cx = W / 2 + (cx1 - W / 2) * k; cy = H / 2 + (cy1 - H / 2) * k
        if k >= 1 and still is not None:
            fr = still.copy()
        else:
            fr = view(img, z, cx, cy)
            if k >= 1:
                still = fr.copy()
        fr = fr.convert('RGBA')
        ov = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
        if box:
            a = ease((t - 1.1) / 0.5)
            if a > 0:
                p0 = to_view((box[0], box[1]), z, cx, cy); p1 = to_view((box[0] + box[2], box[1] + box[3]), z, cx, cy)
                pad = 12
                r = [p0[0] - pad, p0[1] - pad, p1[0] + pad, p1[1] + pad]
                d.rounded_rectangle(r, radius=16, outline=PINK + (int(255 * a),), width=6)
                if step.get('click'):
                    c = ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)
                    m = ease((t - 1.1) / 0.8)
                    sx, sy = c[0] + 260 * (1 - m), c[1] + 180 * (1 - m)
                    ct = t - 2.0
                    if 0 < ct < 0.6:
                        rr = 20 + 80 * ct
                        d.ellipse([c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr], outline=(255, 255, 255, int(220 * (1 - ct / 0.6))), width=5)
                    ov.alpha_composite(CURSOR, (int(sx), int(sy)))
        ca = ease((t - 0.15) / 0.35)
        if ca < 1:
            c2 = cap.copy(); c2.putalpha(c2.getchannel('A').point(lambda v: int(v * ca)))
            ov.alpha_composite(c2)
        else:
            ov.alpha_composite(cap)
        fr.alpha_composite(ov)
        fr = fr.convert('RGB')
        if prev_last is not None and t < 0.35:
            fr = Image.blend(prev_last, fr, ease(t / 0.35))
        yield fr

def render_still(im, prev_last, dur, fade_out=False):
    frames = int(dur * FPS)
    for i in range(frames):
        t = i / FPS
        fr = im
        if prev_last is not None and t < 0.5:
            fr = Image.blend(prev_last, im, ease(t / 0.5))
        if fade_out and t > dur - 0.8:
            fr = Image.blend(fr, Image.new('RGB', (W, H), (0, 0, 0)), ease((t - (dur - 0.8)) / 0.8))
        yield fr

def encode(name, gen):
    tmp = os.path.join(WORK, name + '.part.mp4'); dst = os.path.join(WORK, name + '.mp4')
    p = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', str(FPS), tmp], stdin=subprocess.PIPE)
    last = None
    for fr in gen:
        p.stdin.write(fr.tobytes()); last = fr
    p.stdin.close()
    if p.wait() != 0:
        raise SystemExit('ffmpeg failed on ' + name)
    os.replace(tmp, dst)
    return dst, last

if os.environ.get('PREVIEW'):
    pv = os.path.join(WORK, 'preview'); os.makedirs(pv, exist_ok=True)
    card_title().save(f'{pv}/title.jpg'); card_agenda(['Start your free trial', 'Company settings', 'Add your team', 'Masters', 'Care packs', 'Raise an RMA', 'Send it to the OEM', 'Dispatch to the OEM', 'Back to the customer', 'Dashboard, reminders & reports', 'Backups & privacy']).save(f'{pv}/agenda.jpg')
    card_chapter(6, 'Raise an RMA').save(f'{pv}/chapter.jpg'); card_features().save(f'{pv}/features.jpg'); card_end().save(f'{pv}/end.jpg')
    for idx in [int(x) for x in os.environ['PREVIEW'].split(',')]:
        st = timeline[idx]
        for j, fr in enumerate(render_step(st, None, 3.0)):
            if j in (10, 75):
                fr.save(f'{pv}/step{idx}-{j}.jpg')
    raise SystemExit('preview done')

chapters = []
for s in timeline:
    if s['chapter'] not in chapters:
        chapters.append(s['chapter'])

parts, chapter_times = [], []
clock = 0.0
def add(name, gen, dur):
    global clock
    path, last = encode(name, gen)
    parts.append(path); clock += int(dur * FPS) / FPS
    return last

last = add('000-title', render_still(card_title(), None, 5.0), 5.0)
last = add('001-agenda', render_still(card_agenda(chapters), last, 7.0), 7.0)
n = 2
current = None
for i, s in enumerate(timeline):
    if s['chapter'] != current:
        current = s['chapter']
        chapter_times.append((clock, current))
        k = chapters.index(current) + 1
        last = add(f'{n:03d}-ch', render_still(card_chapter(k, current), last, 2.4), 2.4); n += 1
    words = len(s['caption'].split())
    dur = max(s.get('hold', 3.2), 1.6 + words / 2.7)
    last = add(f'{n:03d}-s', render_step(s, last, dur), dur); n += 1
    print(f'{i + 1}/{len(timeline)}', flush=True)
chapter_times.append((clock, 'Why TrackMyRMA'))
last = add(f'{n:03d}-feat', render_still(card_features(), last, 9.0), 9.0); n += 1
last = add(f'{n:03d}-end', render_still(card_end(), last, 6.0, fade_out=True), 6.0)

lst = os.path.join(WORK, 'list.txt')
open(lst, 'w').write(''.join(f"file '{p}'\n" for p in parts))
silent = os.path.join(WORK, 'silent.mp4')
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', silent], check=True)
music = os.path.join(WORK, 'music.wav')
subprocess.run([sys.executable, os.path.join(ROOT, 'scripts/guide/music.py'), str(clock + 1), music], check=True)
tmp = OUT + '.part.mp4'
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', silent, '-i', music, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', tmp], check=True)
os.replace(tmp, OUT)
def ts(x):
    x = int(x); return f'{x // 60}:{x % 60:02d}'
with open(os.path.join(os.path.dirname(OUT), 'chapters.txt'), 'w') as f:
    f.write('0:00 Introduction\n')
    for t, c in chapter_times:
        f.write(f'{ts(t)} {c}\n')
json.dump([{'t': round(t, 1), 'chapter': c} for t, c in chapter_times], open(os.path.join(WORK, 'chapters.json'), 'w'))
print('video', OUT, round(clock), 's')
