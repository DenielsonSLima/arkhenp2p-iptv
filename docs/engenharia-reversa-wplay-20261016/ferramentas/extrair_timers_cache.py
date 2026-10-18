"""Extract only three numeric timer defaults from the supplied primary APK.

Static file parsing, never execution of DEX/JNI. Intentionally fails closed on
an unsupported opcode or artifact hash. It does not decode strings or URLs.
Run from this directory: python3 extrair_timers_cache.py /path/WPLAYP2P.apk
"""
from pathlib import Path
import argparse
import hashlib
import json
import struct
import zipfile

from inventariar_dex import Dex


TARGET = "2e2b680d01ed0178e40368e02964d004e16bbe1b39206cda8da7680d6b95fc69"
OWNER = "Lorg/bitspark/android/h;"
FIELDS = {"g:I", "h:I", "i:I"}


def signed(value, bits):
    return value - (1 << bits) if value & (1 << (bits - 1)) else value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    args = parser.parse_args()
    digest = hashlib.sha256(args.apk.read_bytes()).hexdigest()
    if digest != TARGET:
        raise ValueError("Artifact hash differs from the documented primary APK")
    with zipfile.ZipFile(args.apk) as archive:
        raw = archive.read("classes2.dex")
    dex = Dex(raw)
    methods = [m for _, _, _, _, _, group in dex.declarations() for m in group
               if m[0] == OWNER and m[1] == "<clinit>()V"]
    if len(methods) != 1:
        raise ValueError("Expected one matching initializer")
    _, _, flags, code = methods[0]
    if flags & 0x100 or not code:
        raise ValueError("Expected a bytecode initializer")
    count = struct.unpack_from("<I", raw, code + 12)[0]
    units = struct.unpack_from("<" + "H" * count, raw, code + 16)
    registers, assignments = {}, []
    cursor = 0
    # Widths cover every opcode in this exact initializer. Calls are skipped,
    # never executed. Unknown values remain unknown after move-result-object.
    widths = {0x0e: 1, 0x0c: 1, 0x12: 1, 0x13: 2, 0x14: 3,
              0x1a: 2, 0x62: 2, 0x67: 2, 0x69: 2, 0x6a: 2,
              0x71: 3}
    while cursor < count:
        word = units[cursor]
        op, reg = word & 255, word >> 8
        if op not in widths:
            raise ValueError(f"Unsupported opcode {op:#x} at unit {cursor}")
        if op == 0x12:
            reg = (word >> 8) & 15
            registers[reg] = signed(word >> 12, 4)
        elif op == 0x13:
            registers[reg] = signed(units[cursor + 1], 16)
        elif op == 0x14:
            registers[reg] = signed(units[cursor + 1] | units[cursor + 2] << 16, 32)
        elif op in (0x0c, 0x1a, 0x62):
            registers.pop(reg, None)
        elif op == 0x67:
            owner, field = dex.field(units[cursor + 1])
            if owner == OWNER and field in FIELDS:
                if reg not in registers:
                    raise ValueError("Timer assignment lacks a known numeric literal")
                assignments.append({"field": owner + "->" + field,
                                    "value": registers[reg],
                                    "instruction_offset": hex(code + 16 + cursor * 2)})
        cursor += widths[op]
    if cursor != count or {a["field"].split("->")[1] for a in assignments} != FIELDS:
        raise ValueError("Incomplete initializer decode")
    print(json.dumps({"kind": "direct-static-dex-literal-assignment",
                      "apk_sha256": digest,
                      "dex_sha256": hashlib.sha256(raw).hexdigest(),
                      "dex": "classes2.dex", "code_item_offset": hex(code),
                      "complete_decoder_for_this_code_item": True,
                      "assignments": assignments}, indent=2))


if __name__ == "__main__":
    main()
