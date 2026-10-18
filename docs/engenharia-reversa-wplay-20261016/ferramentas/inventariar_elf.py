#!/usr/bin/env python3
"""Inventário estático ELF64 little-endian dentro de um APK; não carrega as SOs.

Uso: python3 inventariar_elf.py APK --output-dir DIRETORIO
Gera apenas metadados de segmentos/símbolos e hashes; não extrai strings livres.
"""
import argparse
import csv
import hashlib
import json
import struct
import zipfile
from pathlib import Path


LIBRARIES = ("libtvcore.so", "libgojni.so", "libffmpegJNI.so", "libijkplayer.so", "libijkcodec.so")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def cstring(data, offset):
    return data[offset:data.index(b"\0", offset)].decode("utf-8", errors="replace")


def inspect_elf(data):
    if data[:6] != b"\x7fELF\x02\x01":
        raise ValueError("Esperado ELF64 little-endian")
    header = struct.unpack_from("<16sHHIQQQIHHHHHH", data)
    machine, phoff, shoff = header[2], header[5], header[6]
    phentsize, phnum, shentsize, shnum = header[9:13]
    segments = []
    for i in range(phnum):
        kind, flags, offset, address, _, filesz, memsz, align = struct.unpack_from("<IIQQQQQQ", data, phoff + i * phentsize)
        if kind == 1:
            segments.append({"offset": offset, "vaddr": address, "file_size": filesz,
                             "memory_size": memsz, "alignment": align, "flags": flags})
    sections = [struct.unpack_from("<IIQQQQIIQQ", data, shoff + i * shentsize) for i in range(shnum)]
    symbols = []
    seen = set()
    for section in sections:
        if section[1] not in (2, 11):
            continue
        strings_section = sections[section[6]]
        strings = data[strings_section[4]:strings_section[4] + strings_section[5]]
        for offset in range(section[4], section[4] + section[5], section[9]):
            name_index, info, _, index, address, size = struct.unpack_from("<IBBHQQ", data, offset)
            if not name_index or not index:
                continue
            name = cstring(strings, name_index)
            identity = (name, address, size)
            if identity in seen:
                continue
            seen.add(identity)
            file_offset = None
            for segment in segments:
                delta = address - segment["vaddr"]
                if 0 <= delta < segment["file_size"] and delta + size <= segment["file_size"]:
                    file_offset = segment["offset"] + delta
                    break
            symbols.append({"name": name, "vaddr": address, "size": size,
                            "type": info & 15, "file_offset": file_offset,
                            "symbol_bytes_sha256": digest(data[file_offset:file_offset + size])
                            if size and file_offset is not None else None})
    return {"machine": machine, "load_segments": segments, "defined_symbols": symbols}


def selected(name):
    return (name == "JNI_OnLoad" or name == "getJNIWrapper"
            or name.startswith("Java_com_tvbus_engine_TVCore_")
            or name.startswith("Java_com_libtvcar_")
            or name.startswith("Java_androidx_media3_decoder_ffmpeg_")
            or name.startswith("_ZN6CTVBus") and any(part in name for part in ("4stop", "4quit", "3run", "5start")))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    apk_hash = digest(args.apk.read_bytes())
    out = args.output_dir
    out.mkdir(parents=True, exist_ok=True)
    inventory, rows = [], []
    with zipfile.ZipFile(args.apk) as archive:
        for library in LIBRARIES:
            member = "lib/arm64-v8a/" + library
            data = archive.read(member)
            elf = inspect_elf(data)
            inventory.append({"apk_sha256": apk_hash, "member": member, "sha256": digest(data),
                              "bytes": len(data), "machine": elf["machine"],
                              "defined_symbol_count": len(elf["defined_symbols"]),
                              "load_segments": elf["load_segments"]})
            for symbol in sorted(elf["defined_symbols"], key=lambda entry: (entry["vaddr"], entry["name"])):
                if selected(symbol["name"]):
                    rows.append([member, digest(data), symbol["name"], hex(symbol["vaddr"]),
                                 hex(symbol["file_offset"]) if symbol["file_offset"] is not None else "",
                                 symbol["size"], symbol["type"], symbol["symbol_bytes_sha256"] or ""])
    (out / "elf-arm64-primary.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n")
    with (out / "simbolos-nativos-arm64.tsv").open("w", newline="") as stream:
        writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
        writer.writerow(["member", "member_sha256", "symbol", "elf_vaddr", "member_file_offset",
                         "size_bytes", "elf_symbol_type", "symbol_bytes_sha256"])
        writer.writerows(rows)


if __name__ == "__main__":
    main()
