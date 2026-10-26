"""Saved site sessions: Playwright storage_state files in the managed secrets directory.

One file per site (`/workspace/secrets/browser/<site>.json`), cookies and local
storage only, never a password. After an accepted personal run AIQSA encrypts
changed files as Browser session secrets and restores them in later
Workspaces (`lib/server/workspace/secrets/browserCollection.ts`). Limits mirror
`lib/contracts/workspaceSecrets.ts`; a file AIQSA would skip is not written, so
the previous version stays. Writes are atomic and synced: the turn's Workspace
is stopped right after the run, and a half-written state must never survive.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import stat
import unicodedata
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Set, Tuple
from urllib.parse import urlsplit

MAX_BYTES = 8 * 1024 * 1024
TOTAL_MAX_BYTES = 64 * 1024 * 1024
MAX_COUNT = 50
WORKSPACE = Path("/workspace")
ROOT = WORKSPACE / "secrets" / "browser"

_SITE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$")


class SessionError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def safe_basename(value: str) -> str:
    """`safeWorkspaceBasename` of `lib/contracts/workspace.ts`, without its byte truncation."""
    normalized = unicodedata.normalize("NFC", value).strip()
    replaced = re.sub(r"[\x00-\x1f\x7f/\\]+", "-", normalized)
    replaced = "".join(ch if (ch.isalnum() or ch in "._-") else "-" for ch in replaced)
    replaced = re.sub(r"-+", "-", replaced)
    replaced = re.sub(r"^[.-]+|[.-]+$", "", replaced)
    return replaced or "file"


def is_session_filename(value: str) -> bool:
    """`isWorkspaceBrowserSessionFilename` of `lib/contracts/workspaceSecrets.ts`."""
    return len(value) > 5 and value.endswith(".json") and len(value.encode("utf-8")) <= 255 and safe_basename(value) == value


def session_name(site: str) -> str:
    """The file a site's session uses. Punycode hosts lose their double dash, as every saved name must."""
    return safe_basename(site) + ".json"


def site_of(host: str) -> Optional[str]:
    """The file name a site's session uses: its host in lower case, without a leading `www.`."""
    host = (host or "").strip().lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    return host if host and len(host) <= 200 and _SITE.match(host) else None


def domain_matches(domain: str, wanted: Iterable[str]) -> bool:
    """A cookie or origin host belongs to a site when either is the other or its subdomain."""
    value = (domain or "").lstrip(".").lower()
    if not value:
        return False
    return any(value == site or value.endswith("." + site) or site.endswith("." + value) for site in wanted)


def _origin_host(origin: str) -> str:
    try:
        return urlsplit(origin).hostname or ""
    except ValueError:
        return ""


def domains_of(state: Mapping[str, Any]) -> Set[str]:
    found: Set[str] = set()
    for cookie in state.get("cookies") or []:
        if isinstance(cookie, dict) and isinstance(cookie.get("domain"), str):
            host = site_of(cookie["domain"].lstrip("."))
            if host:
                found.add(host)
    for origin in state.get("origins") or []:
        if isinstance(origin, dict) and isinstance(origin.get("origin"), str):
            host = site_of(_origin_host(origin["origin"]))
            if host:
                found.add(host)
    return found


def filter_state(state: Mapping[str, Any], wanted: Iterable[str]) -> Dict[str, Any]:
    """The part of the browser's whole state that belongs to the given sites."""
    wanted = set(wanted)
    cookies = [cookie for cookie in state.get("cookies") or []
               if isinstance(cookie, dict) and domain_matches(str(cookie.get("domain", "")), wanted)]
    origins = [origin for origin in state.get("origins") or []
               if isinstance(origin, dict) and domain_matches(_origin_host(str(origin.get("origin", ""))), wanted)
               and origin.get("localStorage")]
    return {"cookies": cookies, "origins": [{"origin": origin["origin"], "localStorage": origin["localStorage"]} for origin in origins]}


def state_digest(state: Mapping[str, Any], wanted: Iterable[str]) -> str:
    """What a site's session file would hold: its cookies and its origins' local storage, in a stable order.

    Local storage counts because single-page apps keep (and rotate) their sign-in
    tokens there; a rotated token that is not saved signs the next Workspace out.
    """
    wanted = set(wanted)
    rows = sorted(json.dumps(["cookie", cookie.get("name"), cookie.get("domain"), cookie.get("path"), cookie.get("value"),
                              cookie.get("expires")], ensure_ascii=False)
                  for cookie in state.get("cookies") or []
                  if isinstance(cookie, Mapping) and domain_matches(str(cookie.get("domain", "")), wanted))
    rows += sorted(json.dumps(["storage", origin.get("origin"), item.get("name"), item.get("value")], ensure_ascii=False)
                   for origin in state.get("origins") or []
                   if isinstance(origin, Mapping) and domain_matches(_origin_host(str(origin.get("origin", ""))), wanted)
                   for item in origin.get("localStorage") or [] if isinstance(item, Mapping))
    return hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()


def valid_state(value: Any) -> bool:
    """The shape AIQSA saves (`workspaceBrowserSessionError` in `lib/server/workspace/secrets/browserSession.ts`)."""
    if not isinstance(value, dict) or not isinstance(value.get("cookies"), list) or not isinstance(value.get("origins"), list):
        return False
    for cookie in value["cookies"]:
        if not isinstance(cookie, dict) or not all(isinstance(cookie.get(key), str) for key in ("name", "value", "domain", "path")):
            return False
        if isinstance(cookie.get("expires"), bool) or not isinstance(cookie.get("expires"), (int, float)):
            return False
        if not isinstance(cookie.get("httpOnly"), bool) or not isinstance(cookie.get("secure"), bool):
            return False
        if cookie.get("sameSite") not in ("Strict", "Lax", "None"):
            return False
    for origin in value["origins"]:
        if not isinstance(origin, dict) or not isinstance(origin.get("origin"), str) or not isinstance(origin.get("localStorage"), list):
            return False
        if not all(isinstance(item, dict) and isinstance(item.get("name"), str) and isinstance(item.get("value"), str)
                   for item in origin["localStorage"]):
            return False
        parts = urlsplit(origin["origin"])
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.path or parts.query or parts.fragment:
            return False
    return True


def _safe_directory(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISDIR(info.st_mode)


class SessionStore:
    """The sessions of this Workspace and which of them the browser keeps current."""

    def __init__(self, root: Path = ROOT):
        self.root = root
        #: file name -> sites whose cookies and storage it holds
        self.tracked: Dict[str, Set[str]] = {}
        self.digests: Dict[str, str] = {}
        self.skipped: List[str] = []

    def _usable_root(self, create: bool) -> bool:
        for parent in [self.root.parent.parent, self.root.parent, self.root]:
            if parent.is_symlink():
                return False
        if create and not self.root.exists():
            try:
                self.root.parent.mkdir(mode=0o700, exist_ok=True)
                self.root.mkdir(mode=0o700, exist_ok=True)
            except OSError:
                return False
        return _safe_directory(self.root)

    def _entries(self) -> List[Tuple[str, int]]:
        entries = []
        with os.scandir(self.root) as scan:
            for item in scan:
                info = item.stat(follow_symlinks=False)
                entries.append((item.name, info.st_size if stat.S_ISREG(info.st_mode) else -1))
        return entries

    def _remove_stale_staging(self) -> None:
        """Staging files left by a browser stopped mid-write; the rename never happened."""
        try:
            with os.scandir(self.root.parent) as scan:
                for item in scan:
                    if item.name.startswith(".aiqsa-browser-") and item.name.endswith(".tmp") and item.is_file(follow_symlinks=False):
                        os.unlink(item.path)
        except OSError:
            pass

    def load(self) -> Dict[str, Any]:
        """Every valid saved session merged into one storage_state; others are skipped and reported."""
        merged: Dict[str, Any] = {"cookies": [], "origins": []}
        self.tracked, self.digests, self.skipped = {}, {}, []
        if not self._usable_root(create=False):
            return merged
        self._remove_stale_staging()
        cookies: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        origins: Dict[str, Dict[str, Any]] = {}
        total = 0
        for name, size in sorted(self._entries()):
            if not is_session_filename(name) or size < 1 or size > MAX_BYTES or total + size > TOTAL_MAX_BYTES:
                self.skipped.append(name)
                continue
            try:
                descriptor = os.open(self.root / name, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(descriptor, "rb") as stream:
                    raw = stream.read(MAX_BYTES + 1)
                value = json.loads(raw.decode("utf-8"))
            except (OSError, ValueError, UnicodeDecodeError):
                self.skipped.append(name)
                continue
            if len(raw) > MAX_BYTES or not valid_state(value):
                self.skipped.append(name)
                continue
            total += len(raw)
            for cookie in value["cookies"]:
                cookies[(cookie["name"], cookie["domain"], cookie["path"])] = cookie
            for origin in value["origins"]:
                origins[origin["origin"]] = origin
            stem = name[: -len(".json")]
            sites = domains_of(value)
            own = site_of(stem)
            if own:
                sites.add(own)
            self.tracked[name] = sites
            self.digests[name] = state_digest(value, sites)
        merged["cookies"] = list(cookies.values())
        merged["origins"] = list(origins.values())
        return merged

    def track(self, name: str, sites: Iterable[str]) -> None:
        self.tracked.setdefault(name, set()).update(sites)

    def sites(self) -> Set[str]:
        """Every site whose session the browser keeps current."""
        return set().union(*self.tracked.values()) if self.tracked else set()

    def changed(self, state: Mapping[str, Any]) -> List[str]:
        """Tracked files whose cookies or local storage differ from what was last saved or restored."""
        return [name for name, sites in self.tracked.items() if state_digest(state, sites) != self.digests.get(name)]

    def save(self, name: str, state: Mapping[str, Any]) -> Dict[str, Any]:
        """Write one tracked file from the browser's whole state; returns its size and whether it changed."""
        if not is_session_filename(name):
            raise SessionError("session_name_invalid", "The session file name must be a site such as shop.example.json.")
        sites = self.tracked.get(name)
        if not sites:
            raise SessionError("session_name_invalid", "This site is not tracked.")
        part = filter_state(state, sites)
        data = json.dumps(part, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(data) > MAX_BYTES:
            raise SessionError("browser_session_too_large",
                               "The site's session is larger than 8 MiB, so it was not saved; the previous version stays.")
        if not self._usable_root(create=True):
            raise SessionError("session_save_failed", "The saved sessions directory is not usable.")
        entries = {entry: size for entry, size in self._entries() if entry != name and is_session_filename(entry) and size > 0}
        if len(entries) + 1 > MAX_COUNT:
            raise SessionError("browser_session_limit", f"At most {MAX_COUNT} site sessions can be saved; this one was not.")
        if sum(entries.values()) + len(data) > TOTAL_MAX_BYTES:
            raise SessionError("browser_session_total_limit", "Saved sessions would exceed 64 MiB in total; this one was not saved.")
        target = self.root / name
        try:
            current = target.read_bytes() if target.is_file() and not target.is_symlink() else None
        except OSError:
            current = None
        digest = state_digest(part, sites)
        if current == data:
            self.digests[name] = digest
            return {"file": name, "bytes": len(data), "changed": False}
        staging = self.root.parent / f".aiqsa-browser-{secrets.token_hex(8)}.tmp"
        try:
            descriptor = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if target.is_symlink() or (target.exists() and not target.is_file()):
                raise SessionError("session_save_failed", "The saved session path is not a regular file.")
            os.replace(staging, target)
            directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError as error:
            raise SessionError("session_save_failed", f"The session could not be written ({error.strerror}).") from None
        finally:
            try:
                os.unlink(staging)
            except FileNotFoundError:
                pass
            except OSError:
                pass
        self.digests[name] = digest
        return {"file": name, "bytes": len(data), "changed": True}
