#!/usr/bin/env python3
"""Render the reconstructed ARKHEN vector geometry to transparent PNG/ICO assets.

The geometry follows the owner's Camada 2.png and fff.png references. Raster
assets are rendered from these paths; the original small PNGs are never enlarged
or modified. Requires Pillow and NumPy, already available in the local runtime.
"""
from pathlib import Path
import json
import re
from shutil import copyfile
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'web/assets/brand'
OUT.mkdir(parents=True, exist_ok=True)

SYMBOL_VIEW = (14, 14, 86, 93)
ICON_VIEW = (8, 8, 98, 105)
WORDMARK_VIEW = (39, 17, 597, 64)
UPPER = 'M17 17 L54.5 55.6 L54.5 92.6 L46.6 73.4 L24.2 53.3 Z'
FACET = 'M17 17 L24.2 53.3 L36.4 64.1 Z'
LOWER = 'M26.2 63.4 L43.8 76.2 L55 104.7 L29.6 76.5 Z'
LOWER_BEVEL = 'M26.2 63.4 L43.8 76.2 L55 104.7 L41.1 79.1 Z'
LETTERS = [
    ('A', 'M41.8 76.8 L72.2 19.8 L80.2 19.8 L110 76.8 L99.9 76.8 L76.2 29 L51.1 76.8 Z'),
    ('R', 'M158.4 20.2 H194.3 C207.1 20.2 213.2 26.4 213.2 37.9 C213.2 48.7 207.4 54.2 198.1 55.2 L216.3 76.5 H206 L178.5 46.9 H193.9 C201.9 46.9 205.1 43.8 205.1 37.8 C205.1 31.5 201.6 28.2 194.1 28.2 H166.5 V76.5 H158.4 Z'),
    ('K-stem', 'M266.7 20 H275.5 V76.7 H266.7 Z'),
    ('K-arm', 'M278 47.1 L310.6 20 H323.5 L289.6 47.4 L325 76.7 H312 Z'),
    ('H', 'M374.1 20 H382.8 V44.1 H420.1 V20 H428.8 V76.7 H420.1 V52.1 H382.8 V76.7 H374.1 Z'),
    ('E', 'M479.1 20 H528.8 V28 H487.8 V44.1 H521.8 V52.1 H487.8 V69 H528.8 V76.7 H479.1 Z'),
    ('N', 'M577.2 76.5 V20.2 H585.6 L623.3 64.2 V20.2 H631.1 V76.5 H623.5 L585.5 32.1 V76.5 Z'),
]
STOPS = [(0, (249, 249, 247)), (.24, (236, 237, 235)), (.55, (210, 213, 211)), (1, (166, 171, 170))]
FACET_STOPS = [(0, (210, 213, 211)), (1, (116, 121, 121))]


def path_points(source):
    tokens = re.findall(r'[MLHVCQZ]|-?\d+(?:\.\d+)?', source)
    index = 0
    current = (0, 0)
    result = []
    while index < len(tokens):
        command = tokens[index]
        index += 1
        if command == 'Z':
            break
        count = {'M': 2, 'L': 2, 'H': 1, 'V': 1, 'C': 6, 'Q': 4}[command]
        values = [float(value) for value in tokens[index:index + count]]
        index += count
        if command in ('M', 'L'):
            current = tuple(values)
            result.append(current)
        elif command == 'H':
            current = (values[0], current[1])
            result.append(current)
        elif command == 'V':
            current = (current[0], values[0])
            result.append(current)
        else:
            start = np.array(current)
            controls = [np.array(values[offset:offset + 2]) for offset in range(0, len(values), 2)]
            for t in np.linspace(0, 1, 65)[1:]:
                if command == 'C':
                    point = (1 - t) ** 3 * start + 3 * (1 - t) ** 2 * t * controls[0] + 3 * (1 - t) * t ** 2 * controls[1] + t ** 3 * controls[2]
                else:
                    point = (1 - t) ** 2 * start + 2 * (1 - t) * t * controls[0] + t ** 2 * controls[1]
                result.append(tuple(point))
            current = tuple(controls[-1])
    return result


def reflect(points):
    return [(114 - x, y) for x, y in points]


def symbol_layers():
    result = []
    for mirror in (False, True):
        for name, path, stops, width in [
            ('upper', UPPER, STOPS, .34),
            ('facet', FACET, FACET_STOPS, .22),
            ('lower', LOWER, STOPS, .34),
            ('lower-bevel', LOWER_BEVEL, STOPS, .22),
        ]:
            points = path_points(path)
            result.append((name, reflect(points) if mirror else points, stops, width))
    return result


def svg_gradient(name, stops, y1, y2):
    values = ''.join(f'<stop offset="{offset}" stop-color="#{red:02x}{green:02x}{blue:02x}"/>' for offset, (red, green, blue) in stops)
    return f'<linearGradient id="{name}" gradientUnits="userSpaceOnUse" x1="0" y1="{y1}" x2="0" y2="{y2}">{values}</linearGradient>'


def svg_document(kind):
    symbol = kind != 'wordmark'
    view = ICON_VIEW if kind == 'favicon' else SYMBOL_VIEW if symbol else WORDMARK_VIEW
    title = 'Símbolo ARKHEN' if symbol else 'ARKHEN'
    description = 'Símbolo angular de quatro lâminas com facetas em prata, sem fundo.' if symbol else 'Logotipo ARKHEN desenhado em curvas vetoriais, com A aberto e prata metálica, sem fundo.'
    width, height = (128, 128) if kind == 'favicon' else (860, 930) if symbol else (1194, 128)
    header = f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="{" ".join(map(str, view))}" role="img" aria-labelledby="title description"><title id="title">{title}</title><desc id="description">{description}</desc>'
    definitions = '<defs>' + svg_gradient('silver', STOPS, 17 if symbol else 20.2, 103.7 if symbol else 76.5) + svg_gradient('facet', FACET_STOPS, 17, 103.7) + '</defs>'
    if symbol:
        group = ''
        for mirror in (False, True):
            transform = ' transform="translate(114 0) scale(-1 1)"' if mirror else ''
            group += f'<g{transform} stroke-linejoin="miter" stroke-miterlimit="3">'
            group += f'<path d="{UPPER}" fill="url(#silver)" stroke="#eef1ef" stroke-width=".34"/>'
            group += f'<path d="{FACET}" fill="url(#facet)" stroke="#d5dbd8" stroke-width=".22"/>'
            group += f'<path d="{LOWER}" fill="url(#silver)" stroke="#e5eae7" stroke-width=".34"/>'
            group += f'<path d="{LOWER_BEVEL}" fill="url(#silver)" stroke="#f5f7f4" stroke-width=".22"/>'
            group += '</g>'
    else:
        group = '<g fill="url(#silver)" stroke="#eef1ef" stroke-width=".25" stroke-linejoin="miter">' + ''.join(f'<path d="{path}"/>' for _, path in LETTERS) + '</g>'
    return header + definitions + group + '</svg>\n'


def safari_mask_document():
    # Safari pinned tabs require a black, single-layer silhouette in a 16px viewBox.
    scale = 16 / ICON_VIEW[3]
    offset_x = (16 - ICON_VIEW[2] * scale) / 2
    paths = []
    for mirror in (False, True):
        for source in (UPPER, LOWER):
            points = path_points(source)
            if mirror:
                points = reflect(points)
            coordinates = [f'{(x - ICON_VIEW[0]) * scale + offset_x:.5f} {(y - ICON_VIEW[1]) * scale:.5f}' for x, y in points]
            paths.append('M' + ' L'.join(coordinates) + ' Z')
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#000" d="' + ' '.join(paths) + '"/></svg>\n'


def gradient_image(width, height, stops, view, scale, offset, y1, y2):
    ys = (np.arange(height) - offset[1]) / scale + view[1]
    positions = np.clip((ys - y1) / (y2 - y1), 0, 1)
    colors = np.asarray([np.interp(positions, [stop[0] for stop in stops], [stop[1][channel] for stop in stops]) for channel in range(3)]).T.astype(np.uint8)
    return Image.fromarray(np.broadcast_to(colors[:, None, :], (height, width, 3)).copy())


def render(kind, width, height, icon=False):
    # Supersampling rasterizes vector edges smoothly at small UI/favicon sizes.
    factor = 4
    canvas_width, canvas_height = width * factor, height * factor
    view = ICON_VIEW if icon else SYMBOL_VIEW if kind == 'symbol' else WORDMARK_VIEW
    scale = min(canvas_width / view[2], canvas_height / view[3])
    offset = ((canvas_width - view[2] * scale) / 2, (canvas_height - view[3] * scale) / 2)
    canvas = Image.new('RGBA', (canvas_width, canvas_height))
    layers = symbol_layers() if kind == 'symbol' else [(name, path_points(path), STOPS, .25) for name, path in LETTERS]
    gradients = {}
    for name, points, stops, stroke_width in layers:
        translated = [((x - view[0]) * scale + offset[0], (y - view[1]) * scale + offset[1]) for x, y in points]
        mask = Image.new('L', canvas.size)
        draw = ImageDraw.Draw(mask)
        draw.polygon(translated, fill=255)
        key = tuple(stops)
        if key not in gradients:
            gradients[key] = gradient_image(canvas_width, canvas_height, stops, view, scale, offset, 17 if kind == 'symbol' else 20.2, 103.7 if kind == 'symbol' else 76.5)
        fill = gradients[key].copy()
        fill.putalpha(mask)
        canvas.alpha_composite(fill)
        edge = Image.new('RGBA', canvas.size)
        ImageDraw.Draw(edge).line(translated + translated[:1], fill=(231, 237, 233, 255), width=max(1, round(stroke_width * scale)), joint='curve')
        canvas.alpha_composite(edge)
    return canvas.resize((width, height), Image.Resampling.LANCZOS)


(OUT / 'symbol.svg').write_text(svg_document('symbol'), encoding='utf8')
(OUT / 'wordmark.svg').write_text(svg_document('wordmark'), encoding='utf8')
(OUT / 'favicon.svg').write_text(svg_document('favicon'), encoding='utf8')
(OUT / 'safari-pinned-tab.svg').write_text(safari_mask_document(), encoding='utf8')
render('symbol', 1024, round(1024 * SYMBOL_VIEW[3] / SYMBOL_VIEW[2])).save(OUT / 'symbol.png', optimize=True)
render('wordmark', 2388, 256).save(OUT / 'wordmark.png', optimize=True)
for size in (16, 32, 48, 180, 192, 512):
    name = 'apple-touch-icon.png' if size == 180 else f'favicon-{size}x{size}.png'
    render('symbol', size, size, icon=True).save(OUT / name, optimize=True)
render('symbol', 512, 512, icon=True).save(OUT / 'favicon.ico', format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
copyfile(OUT / 'favicon.ico', ROOT / 'web/favicon.ico')
copyfile(OUT / 'apple-touch-icon.png', ROOT / 'web/apple-touch-icon.png')

inventory = []
for target in sorted(OUT.glob('*')):
    if target.suffix not in ('.svg', '.png', '.ico'):
        continue
    entry = {'file': target.name, 'bytes': target.stat().st_size, 'source': 'vector geometry reconstructed from owner references'}
    if target.suffix != '.svg':
        im = Image.open(target)
        entry.update({'width': im.width, 'height': im.height, 'mode': im.mode, 'alphaRange': list(im.getchannel('A').getextrema()) if 'A' in im.getbands() else None})
    inventory.append(entry)
(OUT / 'inventory.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
print(f'Generated {len(inventory)} transparent brand assets in {OUT}')
