"""Generátor ikon ChartStudio.

Zdroj je hotová čtvercová ikona s vlastním zaobleným pozadím
(`assets/logo/chart_studio_icon.png`) — nic se do ní nedokresluje, jen se
přeškáluje do formátů, které Windows a Electron potřebují:

  build/icon.ico                     … exe, zástupce na ploše, hlavička instalátoru (NSIS)
  build/icon.png                     … záloha ve zdrojích + fallback pro electron-builder
  src/renderer/assets/appicon.png    … ikona okna (BrowserWindow), tedy i lišta úloh

Spuštění:  python build/make_icon.py
"""
from PIL import Image
import os

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)                       # …/<projekt>/app
SRC = os.path.join(APP, "..", "assets", "logo", "chart_studio_icon.png")

src = Image.open(SRC).convert("RGBA")
if src.width != src.height:
    raise SystemExit(f"Zdroj musí být čtvercový, je {src.width}x{src.height}")

# Windows bere z .ico tu velikost, která se hodí; menší dogenerujeme kvalitním
# LANCZOS převzorkováním (u 16/32 px zůstane čitelný jen ekvalizér, text ne — to je v pořádku).
SIZES = [256, 128, 64, 48, 32, 16]
imgs = {s: src.resize((s, s), Image.LANCZOS) for s in SIZES}

imgs[256].save(os.path.join(HERE, "icon.png"))
imgs[256].save(os.path.join(HERE, "icon.ico"), sizes=[(s, s) for s in SIZES])
# ikona okna: větší kvůli HiDPI displejům
src.resize((512, 512), Image.LANCZOS).save(
    os.path.join(APP, "src", "renderer", "assets", "appicon.png"))

print("OK: build/icon.ico, build/icon.png, src/renderer/assets/appicon.png")
