#!/usr/bin/env python3
"""Record visible logo bounds for CSS framing; never rewrite image assets."""
import json
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
manifest = root / "web/assets/channels/manifest.json"
data = json.loads(manifest.read_text())
for entry in data["channels"]:
    asset = (root / "web" / entry["file"].lstrip("/")).resolve()
    if asset.parent != manifest.parent:
        continue
    with Image.open(asset) as image:
        width, height = image.size
        alpha = image.convert("RGBA").getchannel("A")
        bounds = alpha.point(lambda value: 255 if value >= 12 else 0).getbbox()
        if not bounds:
            continue
        left, top, right, bottom = bounds
        entry["artwork"] = {"width": width, "height": height,
                            "bounds": [left, top, right - left, bottom - top]}
manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
print(f"Measured {len(data['channels'])} existing logos; image files unchanged.")
