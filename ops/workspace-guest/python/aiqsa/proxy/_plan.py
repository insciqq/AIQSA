"""The run's proxies as AIQSA delivered them (`workspaceProxyPlanFile` in `lib/server/workspace/secrets/manifest.ts`).

The file lives in the managed `/workspace/secrets/` directory: it stays out of output capture, project archives,
downloads and shares, and every install replaces or removes it. It holds passwords, and the agent may read them
(operator decision, `agent_docs/SECURITY.md`, Proxies); nothing here prints or logs one.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

PLAN_VERSION = 1
PLAN_MAX_BYTES = 2 * 1024 * 1024
PROTOCOLS = ("http", "https", "socks5")
OWNERS = ("personal", "administrator")


class PlanInvalid(Exception):
    """The file is there but cannot be read: no site may then go direct on a guess."""


class Plan:
    def __init__(self, proxies: Sequence[Dict[str, Any]], fingerprint: bytes = b""):
        self.proxies = list(proxies)
        #: Tells a later run's plan from the same plan installed again, which every run of a chat does.
        self.fingerprint = fingerprint
        self.by_id = {proxy["id"]: proxy for proxy in self.proxies}
        #: Active in the plan but not loadable now: failed on every site, so a matching site never goes direct.
        self.unavailable = [proxy["id"] for proxy in self.proxies if proxy["active"] and not proxy["available"]]

    def endpoint(self, proxy_id: str) -> Any:
        proxy = self.by_id.get(proxy_id)
        return None if proxy is None else (proxy["protocol"], proxy["host"], proxy["port"])

    def label(self, proxy_id: str) -> Dict[str, Any]:
        proxy = self.by_id.get(proxy_id)
        return {"id": proxy_id, "name": proxy["name"] if proxy else proxy_id, "country": proxy["country"] if proxy else None}

    def public(self) -> List[Dict[str, Any]]:
        """What may be listed without asking for a secret: never a login or password."""
        return [{key: proxy[key] for key in ("active", "available", "country", "domainHints", "id", "name", "owner", "protocol")}
                for proxy in self.proxies]


def _text(entry: Mapping[str, Any], key: str, limit: int) -> str:
    value = entry.get(key)
    if not isinstance(value, str) or not value or len(value) > limit:
        raise PlanInvalid(key)
    return value


def _optional_text(entry: Mapping[str, Any], key: str, limit: int) -> Optional[str]:
    value = entry.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise PlanInvalid(key)
    return value


def _entry(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise PlanInvalid("entry")
    port, hints = raw.get("port"), raw.get("domainHints")
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise PlanInvalid("port")
    if not isinstance(hints, list) or not all(isinstance(hint, str) for hint in hints):
        raise PlanInvalid("domainHints")
    if raw.get("protocol") not in PROTOCOLS or raw.get("owner") not in OWNERS:
        raise PlanInvalid("protocol")
    if not isinstance(raw.get("active"), bool) or not isinstance(raw.get("available"), bool):
        raise PlanInvalid("active")
    return {"active": raw["active"], "available": raw["available"], "country": _optional_text(raw, "country", 2),
            "domainHints": hints, "host": _text(raw, "host", 1012), "id": _text(raw, "id", 128),
            "login": _optional_text(raw, "login", 1020), "name": _text(raw, "name", 256), "owner": raw["owner"],
            "password": _optional_text(raw, "password", 1020), "port": port, "protocol": raw["protocol"]}


def load(path: Path) -> Optional[Plan]:
    """The plan, or None when this Workspace has none. A file that cannot be read raises `PlanInvalid`."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        raise PlanInvalid("open") from None
    try:
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > PLAN_MAX_BYTES:
                raise PlanInvalid("file")
            raw = stream.read(PLAN_MAX_BYTES + 1)
            data = json.loads(raw)
    except (OSError, ValueError):
        raise PlanInvalid("read") from None
    if not isinstance(data, dict) or data.get("version") != PLAN_VERSION or not isinstance(data.get("proxies"), list):
        raise PlanInvalid("shape")
    proxies = [_entry(raw) for raw in data["proxies"]]
    if len({proxy["id"] for proxy in proxies}) != len(proxies):
        raise PlanInvalid("id")
    return Plan(proxies, hashlib.sha256(raw).digest())
