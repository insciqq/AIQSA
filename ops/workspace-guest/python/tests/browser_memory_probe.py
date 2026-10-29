#!/usr/bin/env python3
"""Measure the shared guest browser with several agent identities.

Run this inside a disposable 4096 MiB Workspace guest, for example:

    python3 browser_memory_probe.py --url https://www.amazon.es --agents 5 --tabs 2 --seconds 60

The child commands use the same browser socket, so this exercises per-agent
tabs. Samples are JSON lines containing Chromium RSS and MemAvailable; the
script never records page content or cookies.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List


def memory_sample() -> Dict[str, Any]:
    available = None
    try:
        for line in Path("/proc/meminfo").read_text("utf-8").splitlines():
            if line.startswith("MemAvailable:"):
                available = int(line.split()[1]) * 1024
                break
    except (OSError, ValueError, IndexError):
        pass
    rss = 0
    pids: List[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes().split(b"\0", 1)[0].decode("utf-8", "replace")
            if "/chromium-" not in command or not command.endswith("/chrome"):
                continue
            status = (entry / "status").read_text("utf-8")
            value = next(line for line in status.splitlines() if line.startswith("VmRSS:"))
            rss += int(value.split()[1]) * 1024
            pids.append(int(entry.name))
        except (OSError, ValueError, StopIteration):
            continue
    return {"at": time.time(), "chromiumRssBytes": rss, "chromiumPids": pids, "memAvailableBytes": available}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://www.amazon.es")
    parser.add_argument("--agents", type=int, default=5)
    parser.add_argument("--tabs", type=int, default=2)
    parser.add_argument("--seconds", type=int, default=60)
    args = parser.parse_args()
    if not 1 <= args.agents <= 5 or not 1 <= args.tabs <= 3 or not 1 <= args.seconds <= 3600:
        parser.error("agents 1..5, tabs 1..3 and seconds 1..3600")
    command = (
        "from aiqsa import browser as b; "
        f"b.open({args.url!r}); "
        f"[b.new_tab({args.url!r}) for _ in range({args.tabs - 1})]; "
        f"import time; time.sleep({args.seconds})"
    )
    children = []
    try:
        for index in range(args.agents):
            environment = {**os.environ, "AIQSA_AGENT_ID": f"probe-{index + 1}", "AIQSA_AGENT_NAME": f"probe-{index + 1}"}
            children.append(subprocess.Popen([sys.executable, "-c", command], env=environment,
                                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        end = time.monotonic() + args.seconds
        while time.monotonic() < end:
            print(json.dumps(memory_sample(), separators=(",", ":")), flush=True)
            time.sleep(1)
    finally:
        for child in children:
            child.terminate()
        for child in children:
            child.wait(timeout=15)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
