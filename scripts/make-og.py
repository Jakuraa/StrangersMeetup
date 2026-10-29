# scripts/make-og.py - Regenerates public/img/og.png (1200x630) from brand tokens. Needs Pillow.
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1200, 630
BG, INK, ACCENT, SOFT, MUTED = (251, 248, 244), (35, 32, 29), (163, 71, 58), (245, 230, 225), (110, 101, 93)
S = 2  # supersample for smooth circles
img = Image.new('RGB', (W * S, H * S), BG)
d = ImageDraw.Draw(img)
cx, cy, r = 940 * S, 315 * S, 150 * S
d.ellipse([cx - 65 * S - r, cy - r, cx - 65 * S + r, cy + r], outline=INK, width=3 * S)
d.ellipse([cx + 65 * S - r, cy - r, cx + 65 * S + r, cy + r], outline=ACCENT, width=3 * S)
img = img.resize((W, H), Image.LANCZOS)
d = ImageDraw.Draw(img)


def font(size, bold=False):
    for p in ['/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf',
              '/Library/Fonts/Arial.ttf']:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


d.text((80, 150), 'StrangersMeetup', font=font(30, True), fill=ACCENT)
y = 210
for line in ['Your next favourite', 'people are still', 'strangers.']:
    d.text((80, y), line, font=font(62, True), fill=INK)
    y += 76
d.text((80, 470), 'Meetups · Dinners · Trips · South India · 21+', font=font(26), fill=MUTED)
out = os.path.join(os.path.dirname(__file__), '..', 'public', 'img', 'og.png')
img.save(out, optimize=True)
print('wrote', os.path.normpath(out))
