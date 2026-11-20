"""Saved site sessions: Playwright storage_state files in the managed secrets directory.

One file per account (`/workspace/secrets/browser/<site>.json`, `google.com` for every Google
service), cookies and local storage only, never a password. After an accepted personal run AIQSA
encrypts changed files as Browser session secrets and restores them in later Workspaces
(`lib/server/workspace/secrets/browserCollection.ts`). Limits mirror `lib/contracts/workspaceSecrets.ts`;
a file AIQSA would skip is not written, so the previous version stays. Writes are atomic and synced:
the turn's Workspace is stopped right after the run, and a half-written state must never survive.

Each file this guest writes carries when it was written (`aiqsa.savedAt`, milliseconds; Playwright reads
only `cookies` and `origins`). Freshness, not file order, decides which copy of a cookie wins when files
share one, here on restore and on the server when runs save (`workspaceBrowserSaveOrder` in
`lib/server/workspace/secrets/browserSession.ts`). A file without it (an upload in Settings, an older
guest's) counts as the oldest.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import stat
import time
import unicodedata
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Set, Tuple
from urllib.parse import urlsplit

MAX_BYTES = 8 * 1024 * 1024
TOTAL_MAX_BYTES = 64 * 1024 * 1024
MAX_COUNT = 50
WORKSPACE = Path("/workspace")
ROOT = WORKSPACE / "secrets" / "browser"
#: AIQSA's own key in a session file, beside Playwright's two.
STAMP_KEY = "aiqsa"

_SITE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")
_ADDRESS = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
#: Second-level labels under which a two-letter country code registers names (`co.uk`, `com.au`), as
#: `http.cookiejar` treats them. Without a public suffix list this keeps such pairs, like single labels,
#: from becoming a site whose session would gather every name under them.
_COUNTRY_SECOND_LEVEL = frozenset({"ac", "aero", "biz", "cat", "co", "com", "coop", "edu", "eu", "gov", "info", "int", "jobs",
                                   "mil", "mobi", "museum", "name", "net", "org", "pro", "travel"})
#: Hosting names under which every subdomain is someone else's site (the common ones of the public suffix list's
#: private part): a sign-in there keeps to its own host instead of gathering the platform's other sites.
_SHARED_HOSTING = frozenset({
    "amazonaws.com", "appspot.com", "atlassian.net", "azurewebsites.net", "blogspot.com", "cloudfront.net",
    "codeberg.page", "firebaseapp.com", "fly.dev", "github.io", "gitlab.io", "glitch.me", "herokuapp.com",
    "myshopify.com", "netlify.app", "ngrok-free.app", "ngrok.io", "onrender.com", "pages.dev", "readthedocs.io",
    "sharepoint.com", "surge.sh", "tilda.ws", "vercel.app", "web.app", "workers.dev", "yandexcloud.net"})


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


def suffix_like(host: str) -> bool:
    """A single label, or a country-code pair such as `co.uk`: never a site of its own."""
    labels = host.split(".")
    return len(labels) < 2 or (len(labels) == 2 and len(labels[1]) == 2 and labels[0] in _COUNTRY_SECOND_LEVEL)


def site_of(host: str) -> Optional[str]:
    """The file name a site's session uses: its host in lower case, without a leading `www.`.

    At least two labels and no public suffix: one file holds one site, never every name under a suffix.
    """
    host = (host or "").strip().lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    return host if host and len(host) <= 200 and _SITE.fullmatch(host) and not suffix_like(host) else None


def account_of(host: str) -> Optional[str]:
    """The site a sign-in on this host belongs to: its registrable name (`google.com` for `mail.google.com`,
    `bbc.co.uk` for `news.bbc.co.uk`), so one account's services share one file and its parent-domain cookies
    one place. Under a shared hosting name it is the tenant's own name; an address stays itself. An approximation
    without a public suffix list: a portal whose names belong to different people beyond the list above only
    keeps their cookies together in one file of the same user.
    """
    site = site_of(host)
    if site is None or _ADDRESS.fullmatch(site):
        return site
    labels = site.split(".")
    count = 2
    while count < len(labels) and (suffix_like(".".join(labels[-count:])) or ".".join(labels[-count:]) in _SHARED_HOSTING):
        count += 1
    return ".".join(labels[-count:])


def saved_at(value: Mapping[str, Any]) -> int:
    """When this guest wrote a session file (milliseconds); 0 for a file without it."""
    meta = value.get(STAMP_KEY)
    stamp = meta.get("savedAt") if isinstance(meta, Mapping) else None
    return stamp if isinstance(stamp, int) and not isinstance(stamp, bool) and 0 < stamp < 2 ** 53 else 0


def content_key(state: Mapping[str, Any]) -> str:
    """A state's cookies and local storage in a stable order: two files hold the same session when these match."""
    cookies = sorted(json.dumps(cookie, sort_keys=True, ensure_ascii=False) for cookie in state.get("cookies") or [])
    origins = sorted(json.dumps(origin, sort_keys=True, ensure_ascii=False) for origin in state.get("origins") or [])
    return hashlib.sha256(json.dumps([cookies, origins]).encode("utf-8")).hexdigest()


def domain_matches(domain: str, wanted: Iterable[str]) -> bool:
    """A cookie or origin host belongs to a site when it is the site, its subdomain, or a parent that is
    still a registrable name (sign-in cookies often sit on the parent: `.example.com` for `app.example.com`)."""
    value = (domain or "").lstrip(".").lower()
    if not value:
        return False
    return any(value == site or value.endswith("." + site) or (site.endswith("." + value) and not suffix_like(value))
               for site in wanted)


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

    def __init__(self, root: Path = ROOT, clock: Callable[[], float] = time.time):
        self.root = root
        self.clock = clock
        #: file name -> sites whose cookies and storage it holds
        self.tracked: Dict[str, Set[str]] = {}
        self.digests: Dict[str, str] = {}
        self.skipped: List[str] = []
        #: file name -> its state as loaded or last written (with its stamp)
        self.files: Dict[str, Dict[str, Any]] = {}

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
        """Every valid saved session merged into one storage_state (`merge`); others are skipped and reported."""
        self.tracked, self.digests, self.skipped, self.files = {}, {}, [], {}
        if not self._usable_root(create=False):
            return {"cookies": [], "origins": []}
        self._remove_stale_staging()
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
            except (OSError, RecursionError, ValueError, UnicodeDecodeError):
                self.skipped.append(name)
                continue
            if len(raw) > MAX_BYTES or not valid_state(value):
                self.skipped.append(name)
                continue
            total += len(raw)
            stem = name[: -len(".json")]
            sites = domains_of(value)
            own = site_of(stem)
            if own:
                sites.add(own)
            self.files[name] = value
            self.tracked[name] = sites
            self.digests[name] = state_digest(value, sites)
        return self.merge(self.files)

    def merge(self, names: Iterable[str]) -> Dict[str, Any]:
        """The given loaded files as one storage_state. A cookie (name, domain, path) or an origin that several hold
        comes from the one written last (`saved_at`; a file without it counts as the oldest, then by name), whatever
        the names: one account's sign-in saved under several site names (`accounts.google.com`, `mail.google.com`)
        shares its parent-domain cookies, and the alphabetically last file must not win with stale ones."""
        cookies: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        origins: Dict[str, Dict[str, Any]] = {}
        known = [name for name in names if name in self.files]
        for name in sorted(known, key=lambda entry: (saved_at(self.files[entry]), entry)):
            value = self.files[name]
            for cookie in value["cookies"]:
                cookies[(cookie["name"], cookie["domain"], cookie["path"])] = cookie
            for origin in value["origins"]:
                origins[origin["origin"]] = {"origin": origin["origin"], "localStorage": origin["localStorage"]}
        return {"cookies": list(cookies.values()), "origins": list(origins.values())}

    def track(self, name: str, sites: Iterable[str]) -> None:
        self.tracked.setdefault(name, set()).update(sites)

    def file_for(self, host: str) -> Optional[Tuple[str, Set[str]]]:
        """Where a sign-in on this host is saved, with the sites that file keeps: its account's file, else a kept file
        that already holds the whole account (one saved per subdomain before accounts shared a file), else a new file
        named after the account. None for a host that is no site."""
        account = account_of(host)
        if account is None:
            return None
        name = session_name(account)
        if name not in self.tracked:
            holding = sorted(entry for entry, sites in self.tracked.items() if account in sites)
            if holding:
                name = holding[0]
        return (name, {account}) if is_session_filename(name) else None

    def sites(self) -> Set[str]:
        """Every site whose session the browser keeps current."""
        return set().union(*self.tracked.values()) if self.tracked else set()

    def changed(self, state: Mapping[str, Any]) -> List[str]:
        """Tracked files whose cookies or local storage differ from what was last saved or restored."""
        return [name for name, sites in self.tracked.items() if state_digest(state, sites) != self.digests.get(name)]

    def _current(self, target: Path) -> Optional[Tuple[Dict[str, Any], int]]:
        """The file as it stands now and its size, when it is a valid state."""
        try:
            descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    return None
                raw = stream.read(MAX_BYTES + 1)
            value = json.loads(raw.decode("utf-8"))
        except (OSError, RecursionError, ValueError, UnicodeDecodeError):
            return None
        return (value, len(raw)) if len(raw) <= MAX_BYTES and valid_state(value) else None

    def save(self, name: str, state: Mapping[str, Any]) -> Dict[str, Any]:
        """Write one tracked file from the browser's whole state, stamped with when; returns its size, whether it
        changed and its stamp. Content equal to the file's keeps the file and its stamp."""
        if not is_session_filename(name):
            raise SessionError("session_name_invalid", "The session file name must be a site such as shop.example.json.")
        sites = self.tracked.get(name)
        if not sites:
            raise SessionError("session_name_invalid", "This site is not tracked.")
        part = filter_state(state, sites)
        target = self.root / name
        found = self._current(target) if self._usable_root(create=False) else None
        current = found[0] if found is not None else None
        digest = state_digest(part, sites)
        if found is not None and content_key(found[0]) == content_key(part):
            self.digests[name] = digest
            self.files[name] = found[0]
            return {"file": name, "bytes": found[1], "changed": False, "savedAt": saved_at(found[0])}
        # Newer than what it replaces even if this clock is behind the one that wrote that.
        stamp = max(int(self.clock() * 1000), (saved_at(current) if current is not None else 0) + 1)
        written = {**part, STAMP_KEY: {"savedAt": stamp}}
        data = json.dumps(written, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
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
        self.files[name] = written
        return {"file": name, "bytes": len(data), "changed": True, "savedAt": stamp}
