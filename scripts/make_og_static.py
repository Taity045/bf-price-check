# Makes the static share images: public/og-home.jpg (1200x630, from og-home.png) and public/og-square.jpg (600x600).
from PIL import Image, ImageDraw, ImageFont
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
pub = root / "public"
Image.open(pub / "og-home.png").convert("RGB").save(pub / "og-home.jpg", "JPEG", quality=85, optimize=True, progressive=False)
FONT = "/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf"
def font(size, wght):
    f = ImageFont.truetype(FONT, size)
    try: f.set_variation_by_axes([32, wght])
    except Exception:
        try: f.set_variation_by_axes([wght])
        except Exception: pass
    return f
W = 600; im = Image.new("RGB", (W, W), "#fbfaf6"); d = ImageDraw.Draw(im)
d.rectangle([0, 0, W, 14], fill="#111111")
d.rectangle([0, W - 22, W, W], fill="#ffc21a")
d.rectangle([48, 60, 92, 84], fill="#ffc21a", outline="#111111", width=3)
d.text((106, 56), "Deal or Dud?", font=font(28, 700), fill="#111111")
y = 170
for line in ["You think you", "found a good", "deal? Let's", "find out!"]:
    d.text((48, y), line, font=font(64, 800), fill="#111111"); y += 78
im.save(pub / "og-square.jpg", "JPEG", quality=85, optimize=True)
for n in ["og-home.jpg", "og-square.jpg"]: print(n, (pub / n).stat().st_size, Image.open(pub / n).size)
