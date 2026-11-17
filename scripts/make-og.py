# scripts/make-og.py - Regenerates public/img/og.png (1200x630) from NIGHTLIFEZ brand tokens. Needs Pillow.
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1200, 630
# NIGHTLIFEZ brand tokens: Midnight obsidian, pure white, electric cyan, luminous magenta, muted text
BG = (9, 11, 22)           # #090B16 Obsidian
INK = (255, 255, 255)      # #FFFFFF White
CYAN = (0, 217, 255)       # #00D9FF Neon Cyan
MAGENTA = (255, 42, 133)   # #FF2A85 Neon Magenta
MUTED = (184, 184, 192)    # Muted secondary text

S = 2  # supersample for smooth graphics
img = Image.new('RGB', (W * S, H * S), BG)
d = ImageDraw.Draw(img)

# Geometric neon ambient curves in top-right
cx, cy, r = 940 * S, 315 * S, 150 * S
d.ellipse([cx - 70 * S - r, cy - r, cx - 70 * S + r, cy + r], outline=CYAN, width=4 * S)
d.ellipse([cx + 70 * S - r, cy - r, cx + 70 * S + r, cy + r], outline=MAGENTA, width=4 * S)
# Accent glowing core
d.ellipse([cx - 20 * S, cy - 20 * S, cx + 20 * S, cy + 20 * S], fill=CYAN)

img = img.resize((W, H), Image.LANCZOS)
d = ImageDraw.Draw(img)


def font(size, bold=False):
    for p in ['/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf',
              '/Library/Fonts/Arial.ttf']:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


# Brand badge / name
d.text((80, 130), 'NIGHTLIFEZ', font=font(34, True), fill=CYAN)

# Tagline / Headline
y = 200
for line in ['Discover. Connect.', 'Experience.']:
    d.text((80, y), line, font=font(64, True), fill=INK)
    y += 82

# Description / Subtitle
d.text((80, 480), 'Social Discovery & Experiences · South India · Adults 21+', font=font(26), fill=MUTED)

out = os.path.join(os.path.dirname(__file__), '..', 'public', 'img', 'og.png')
img.save(out, optimize=True)
print('wrote', os.path.normpath(out))
