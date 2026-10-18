"""Lê somente constantes numéricas DEFAULT_* da classe Media3 do APK.

Usa o parser de metadados vizinho; não executa DEX/JNI e não exporta strings.
Uso: python3 ler_defaults_buffer.py APK ARQUIVO_JSON
"""
import argparse
import hashlib
import json
import struct
import zipfile
from pathlib import Path
from inventariar_dex import Dex


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with zipfile.ZipFile(args.apk) as archive:
        data = archive.read("classes.dex")
    dex = Dex(data)
    target = "Landroidx/media3/exoplayer/DefaultLoadControl;"
    result = {"apk_sha256": hashlib.sha256(args.apk.read_bytes()).hexdigest(),
              "dex_member": "classes.dex", "dex_sha256": hashlib.sha256(data).hexdigest(),
              "method": "direct selected DEX encoded_array numeric/boolean constants; no execution",
              "class": target, "values": []}
    for index in range(dex.u32(96)):
        offset = dex.u32(100) + 32 * index
        definition = struct.unpack_from("<8I", data, offset)
        if dex.types[definition[0]] != target:
            continue
        result.update(class_def_offset=hex(offset), static_values_offset=hex(definition[7]))
        cursor, sizes = definition[6], []
        for _ in range(4):
            count, cursor = dex.uleb(cursor)
            sizes.append(count)
        field_ids, field_id = [], 0
        for _ in range(sizes[0]):
            delta, cursor = dex.uleb(cursor)
            _, cursor = dex.uleb(cursor)
            field_id += delta
            field_ids.append(field_id)
        cursor = definition[7]
        count, cursor = dex.uleb(cursor)
        for i in range(count):
            value_offset = cursor
            tag = data[cursor]
            cursor += 1
            kind, arg = tag & 31, tag >> 5
            if kind in (0x1e, 0x1f):
                value = None if kind == 0x1e else bool(arg)
            elif kind in (0, 2, 3, 4, 6, 0x10, 0x11, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b):
                raw = data[cursor:cursor + arg + 1]
                cursor += arg + 1
                value = int.from_bytes(raw, "little", signed=kind in (0, 2, 4, 6))
            else:
                raise ValueError("Tipo encoded_value não suportado nesta classe: " + hex(kind))
            _, name = dex.field(field_ids[i])
            if name.startswith("DEFAULT_") and kind in (0, 2, 3, 4, 6, 0x1f):
                result["values"].append({"field": name, "encoded_value_offset": hex(value_offset),
                                         "type": hex(kind), "value": value})
        break
    if not result["values"]:
        raise ValueError("Constantes da classe esperada não encontradas")
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
