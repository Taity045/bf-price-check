#!/usr/bin/env python3
"""Make small self-hosted woff2 fonts (Latin subset). Run once; output is committed. Fonts: SIL Open Font License."""
import pathlib, subprocess
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
G = "/usr/share/fonts/truetype/sand-box/google"
OUT = pathlib.Path(__file__).parent.parent / "public/fonts"
UNI = "U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-201D,U+2022,U+2026,U+20AC,U+2192,U+2212,U+2715,U+2605,U+2713"
jobs = [
  ("display.woff2", f"{G}/Bricolage Grotesque/BricolageGrotesque-VariableFont_opsz,wdth,wght.ttf", {"wght": 800, "opsz": 48, "wdth": 100}),
  ("mono.woff2", f"{G}/IBM Plex Mono/IBMPlexMono-SemiBold.ttf", None),
]
for name, src, axes in jobs:
    f = TTFont(src)
    if axes: f = instancer.instantiateVariableFont(f, axes)
    tmp = f"/tmp/{name}.ttf"; f.save(tmp)
    subprocess.run(["pyftsubset", tmp, f"--unicodes={UNI}", "--flavor=woff2", "--layout-features=kern,liga,tnum,case,ss01", f"--output-file={OUT / name}", "--no-hinting", "--desubroutinize"], check=True)
    print(name, (OUT / name).stat().st_size)
