"""Read DEX metadata inside a supplied APK. No target code or network is used.

Outputs contain names, descriptors, flags and file offsets, never constant
values, credentials or method bodies. All class_defs are retained, including
inner/duplicate declarations; counts therefore differ from JADX top-level views.
"""
from pathlib import Path
from collections import Counter
import argparse
import csv
import hashlib
import json
import struct
import zipfile


class Dex:
    def __init__(self, data):
        self.data = data
        if not data.startswith(b"dex\n"):
            raise ValueError("Unsupported DEX carrier")
        self.strings = [self.string(self.u32(60) + i * 4)
                        for i in range(self.u32(56))]
        self.types = [self.strings[self.u32(self.u32(68) + i * 4)]
                      for i in range(self.u32(64))]

    def u32(self, offset):
        return struct.unpack_from("<I", self.data, offset)[0]

    def uleb(self, offset):
        result = 0
        for shift in range(0, 35, 7):
            byte = self.data[offset]
            offset += 1
            result |= (byte & 127) << shift
            if not byte & 128:
                return result, offset
        raise ValueError("Invalid ULEB128")

    def string(self, id_offset):
        _, offset = self.uleb(self.u32(id_offset))
        end = self.data.index(0, offset)
        return self.data[offset:end].replace(b"\xc0\x80", b"\0").decode(
            "utf-8", "surrogatepass")

    def prototype(self, index):
        offset = self.u32(76) + index * 12
        return_type, parameters = struct.unpack_from("<II", self.data, offset + 4)
        args = []
        if parameters:
            for i in range(self.u32(parameters)):
                type_id = struct.unpack_from("<H", self.data, parameters + 4 + i * 2)[0]
                args.append(self.types[type_id])
        return "(" + "".join(args) + ")" + self.types[return_type]

    def method(self, index):
        class_id, proto_id, name_id = struct.unpack_from(
            "<HHI", self.data, self.u32(92) + index * 8)
        return self.types[class_id], self.strings[name_id] + self.prototype(proto_id)

    def field(self, index):
        class_id, type_id, name_id = struct.unpack_from(
            "<HHI", self.data, self.u32(84) + index * 8)
        return self.types[class_id], self.strings[name_id] + ":" + self.types[type_id]

    def declarations(self):
        for index in range(self.u32(96)):
            offset = self.u32(100) + index * 32
            definition = struct.unpack_from("<8I", self.data, offset)
            descriptor = self.types[definition[0]]
            cursor = definition[6]
            fields, methods = [], []
            if cursor:
                sizes = []
                for _ in range(4):
                    count, cursor = self.uleb(cursor)
                    sizes.append(count)
                for count in sizes[:2]:
                    field_id = 0
                    for _ in range(count):
                        delta, cursor = self.uleb(cursor)
                        flags, cursor = self.uleb(cursor)
                        field_id += delta
                        owner, signature = self.field(field_id)
                        fields.append((owner, signature, flags))
                for count in sizes[2:]:
                    method_id = 0
                    for _ in range(count):
                        delta, cursor = self.uleb(cursor)
                        flags, cursor = self.uleb(cursor)
                        code, cursor = self.uleb(cursor)
                        method_id += delta
                        owner, signature = self.method(method_id)
                        methods.append((owner, signature, flags, code))
            yield descriptor, offset, definition[1], definition[6], fields, methods


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("label", choices=("primary", "binstream"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    summary = {"file": args.apk.name,
               "sha256": hashlib.sha256(args.apk.read_bytes()).hexdigest(),
               "method": "direct DEX tables and class_data; no decompilation/execution",
               "dex": [], "literal_search": {}, "native_literal_search": {}}
    needles = ["supabase", "postgrest", "supabase.co", "/rest/v1/", "realtime/v1", "firebase"]
    names = Counter()
    with (args.output / ("classes-" + args.label + ".tsv")).open("w", encoding="utf-8", errors="backslashreplace") as cf, \
         (args.output / ("metodos-" + args.label + ".tsv")).open("w", encoding="utf-8", errors="backslashreplace") as mf, \
         (args.output / ("campos-" + args.label + ".tsv")).open("w", encoding="utf-8", errors="backslashreplace") as ff, \
         zipfile.ZipFile(args.apk) as archive:
        classes, methods, fields = [csv.writer(f, delimiter="\t", lineterminator="\n") for f in (cf, mf, ff)]
        classes.writerow(["dex", "class", "class_def_offset", "flags", "fields", "methods", "native_methods", "class_data_offset"])
        methods.writerow(["dex", "class", "method_descriptor", "flags", "code_item_offset", "instructions_offset"])
        fields.writerow(["dex", "class", "field_descriptor", "flags"])
        for member in archive.namelist():
            if member.endswith(".so"):
                lower = archive.read(member).lower()
                summary["native_literal_search"][member] = {n: lower.count(n.encode()) for n in needles}
            if not member.endswith(".dex"):
                continue
            data = archive.read(member)
            dex = Dex(data)
            counts = {"member": member, "sha256": hashlib.sha256(data).hexdigest(),
                      "class_defs": 0, "defined_methods": 0, "defined_fields": 0, "native_methods": 0,
                      "method_ids_including_references": dex.u32(88)}
            summary["literal_search"][member] = {
                n: sum(n in value.lower() for value in dex.strings) for n in needles}
            for name, offset, flags, class_data, fs, ms in dex.declarations():
                names[name] += 1
                native = sum(bool(m[2] & 0x100) for m in ms)
                classes.writerow([member, name, hex(offset), hex(flags), len(fs), len(ms), native, hex(class_data)])
                for owner, signature, access, code in ms:
                    methods.writerow([member, owner, signature, hex(access), hex(code), hex(code + 16) if code else ""])
                for owner, signature, access in fs:
                    fields.writerow([member, owner, signature, hex(access)])
                counts["class_defs"] += 1
                counts["defined_methods"] += len(ms)
                counts["defined_fields"] += len(fs)
                counts["native_methods"] += native
            summary["dex"].append(counts)
    summary["unique_class_descriptors"] = len(names)
    summary["duplicate_class_descriptors"] = {n: c for n, c in names.items() if c > 1}
    (args.output / ("resumo-dex-" + args.label + ".json")).write_text(
        json.dumps(summary, ensure_ascii=True, indent=2) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k not in ("native_literal_search", "literal_search")}, ensure_ascii=True))


if __name__ == "__main__":
    main()
