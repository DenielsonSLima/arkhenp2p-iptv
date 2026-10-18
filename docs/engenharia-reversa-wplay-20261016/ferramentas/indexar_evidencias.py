"""Export only provenance metadata from private REA envelopes, never code/constants."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = Path(__file__).resolve().parents[1] / "evidencias-rea.json"
records = {}
for folder in [ROOT / ".local/analysiscurrent/apk-dissection-20261016",
               ROOT / ".local/analysiscurrent/tv-apk-static"]:
    for path in sorted(folder.glob("*.json")):
        try:
            content = path.read_bytes()
            evidence = json.loads(content)
        except (ValueError, OSError):
            continue
        if isinstance(evidence, dict) and evidence.get("ok") is True and isinstance(evidence.get("data"), dict):
            evidence = evidence["data"]
        if not isinstance(evidence, dict) or not isinstance(evidence.get("evidence_id"), str):
            continue
        params = evidence.get("parameters", {})
        selectors = {k: v for k, v in params.items() if k in (
            "class_name", "className", "method_name", "methodName", "overload_index")}
        subject = evidence.get("subject", {})
        records[evidence["evidence_id"]] = {
            "evidence_id": evidence["evidence_id"],
            "operation": evidence.get("operation"),
            "artifact": subject.get("name"),
            "artifact_sha256": subject.get("digest", {}).get("sha256"),
            "selectors": selectors,
            "provider": evidence.get("provider"),
            "private_source_basename": path.name,
            "private_envelope_sha256": hashlib.sha256(content).hexdigest(),
            "limitations": evidence.get("limitations", []),
        }
OUTPUT.write_text(json.dumps({"scope": "metadata only; canonical envelopes remain private",
                              "records": sorted(records.values(), key=lambda x: x["evidence_id"])},
                             ensure_ascii=False, indent=2) + "\n")
print(f"{len(records)} referências REA exportadas sem corpos ou constantes")
