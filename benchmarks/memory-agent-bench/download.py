"""Acquire only the pinned upstream source/data; never install or call agents."""
import hashlib
import json
import subprocess
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    manifest = json.loads((ROOT / "upstream.json").read_text())
    repository = manifest["repository"]
    upstream = ROOT / ".upstream"
    if not upstream.exists():
        subprocess.run(["git", "clone", "--no-checkout", repository["url"], str(upstream)], check=True)
        subprocess.run(["git", "-C", str(upstream), "checkout", "--detach", repository["commit"]], check=True)
    revision = subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip()
    if revision != repository["commit"]:
        raise ValueError("factconsolidation_existing_checkout_mismatch")
    for filename, expected in repository["files"].items():
        if hashlib.sha256((upstream / filename).read_bytes()).hexdigest() != expected:
            raise ValueError("factconsolidation_upstream_hash_mismatch")
    data = ROOT / ".data"
    data.mkdir(mode=0o700, exist_ok=True)
    destination = data / "Conflict_Resolution.parquet"
    dataset = manifest["dataset"]
    if not destination.exists():
        url = f'{dataset["repository"]}/resolve/{dataset["revision"]}/{dataset["path"]}'
        with urllib.request.urlopen(url, timeout=120) as response:
            value = response.read(8_000_001)
        if len(value) > 8_000_000 or hashlib.sha256(value).hexdigest() != dataset["sha256"]:
            raise ValueError("factconsolidation_dataset_hash_mismatch")
        with destination.open("xb") as output:
            output.write(value)
        destination.chmod(0o600)
    if hashlib.sha256(destination.read_bytes()).hexdigest() != dataset["sha256"]:
        raise ValueError("factconsolidation_existing_dataset_mismatch")
    print(json.dumps({"event": "factconsolidation_acquired", "revision": revision}))


if __name__ == "__main__":
    main()
