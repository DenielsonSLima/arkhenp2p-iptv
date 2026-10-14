#!/usr/bin/env python3
"""Optimize temporary real channel logos without changing their background."""

import argparse
import hashlib
import json
import re
import unicodedata
import warnings
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 25_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)


def slug(name):
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-")[:70].rstrip("-") or "canal"


def optimize(job_path, output_path, report_path):
    job = json.loads(Path(job_path).read_text(encoding="utf-8"))
    output = Path(output_path)
    output.mkdir(parents=True, exist_ok=True)
    records = {}
    sources, failures = [], []
    for completed, entry in enumerate(job["sources"], 1):
        try:
            raw_path = Path(entry["input"])
            if raw_path.stat().st_size > 5 * 1024 * 1024:
                raise ValueError("Image download exceeds limit")
            with Image.open(raw_path) as original:
                original.seek(0)
                image = ImageOps.exif_transpose(original)
                original_size = image.size
                alpha = image.mode in ("RGBA", "LA") or "transparency" in image.info
                image = image.convert("RGBA" if alpha else "RGB")
                image.thumbnail((256, 256), Image.Resampling.LANCZOS)
                # Presentation metadata only: preserve all original pixels and
                # let the frontend frame away transparent padding with CSS.
                visible = image.convert("RGBA").getchannel("A").point(lambda value: 255 if value >= 12 else 0).getbbox()
                artwork = None
                if visible:
                    left, top, right, bottom = visible
                    artwork = {"width": image.width, "height": image.height, "bounds": [left, top, right - left, bottom - top]}
                encoded = BytesIO()
                image.save(encoded, format="WEBP", quality=84, method=6, exact=True)
                payload = encoded.getvalue()
                digest = hashlib.sha256(payload).hexdigest()
                if digest not in records:
                    name = min(entry["names"], key=lambda value: (value.casefold(), value))
                    filename = f"{slug(name)}-{digest[:16]}.webp"
                    destination = output / filename
                    if destination.exists() and destination.read_bytes() != payload:
                        raise ValueError("Existing asset has different bytes")
                    destination.write_bytes(payload)
                    records[digest] = {"file": f"/assets/channels/{filename}", "ids": set(), "names": set(), "bytes": len(payload), "artwork": artwork}
                record = records[digest]
                record["ids"].update(entry["ids"])
                record["names"].update(entry["names"])
                sources.append({"index": entry["index"], "file": record["file"], "originalSize": original_size, "size": image.size, "alpha": alpha, "bytes": len(payload)})
        except Exception as error:
            # Parser messages may contain untrusted input. Keep only the class.
            failures.append({"index": entry["index"], "reason": type(error).__name__})
        if completed % 50 == 0 or completed == len(job["sources"]):
            print(json.dumps({"phase": "optimize", "completed": completed, "total": len(job["sources"]), "succeeded": len(sources), "failed": len(failures)}), flush=True)
    channels = []
    for record in records.values():
        channels.append({"file": record["file"], "ids": sorted(record["ids"], key=int), "names": sorted(record["names"], key=lambda value: (value.casefold(), value)), "artwork": record["artwork"]})
    channels.sort(key=lambda record: record["file"])
    result = {"channels": channels, "sources": sources, "failures": failures, "optimizedBytes": sum(record["bytes"] for record in records.values())}
    Path(report_path).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", help="Temporary job JSON with input paths, exact names and IDs; no source URLs")
    parser.add_argument("output", help="Directory for generated WebP assets")
    parser.add_argument("report", help="Temporary result JSON")
    arguments = parser.parse_args()
    optimize(arguments.job, arguments.output, arguments.report)
