"""Make /favicon.ico (16, 32, 48 px) and /apple-touch-icon.png (180 px) from the same design as the
page's inline SVG icon (dark rounded square, white rising line). Link-preview fetchers (WhatsApp on
iPhone asks for /favicon.ico) and iOS use these files. Run: python3 scripts/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / "public"

def icon(size, pad_round=True):
    s = 8  # draw large, then scale down for smooth edges
    W = size * s
    im = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    k = W / 32
    if pad_round:
        d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(7 * k), fill=(17, 18, 20, 255))
    else:
        d.rectangle([0, 0, W - 1, W - 1], fill=(17, 18, 20, 255))
    pts = [(8 * k, 20 * k), (13 * k, 15 * k), (17 * k, 19 * k), (24 * k, 11 * k)]
    lw = int(3 * k)
    d.line(pts, fill=(255, 255, 255, 255), width=lw, joint="curve")
    for x, y in (pts[0], pts[-1]):
        d.ellipse([x - lw / 2, y - lw / 2, x + lw / 2, y + lw / 2], fill=(255, 255, 255, 255))
    return im.resize((size, size), Image.LANCZOS)

# iOS rounds the corners itself: square, opaque.
icon(180, pad_round=False).convert("RGB").save(root / "apple-touch-icon.png", optimize=True)
icon(48).save(root / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
for n in ("apple-touch-icon.png", "favicon.ico"):
    print(n, (root / n).stat().st_size, "bytes")
