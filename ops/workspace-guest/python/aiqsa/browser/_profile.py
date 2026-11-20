"""The chat's browser profile: one Chromium user data directory on the chat's Workspace disk.

Operator decision 2026-11-20: a chat keeps its browser between messages. Every site's cookies and site data of
the chat stay in this profile, unencrypted on the chat's VM disk in the managed secrets directory
(`/workspace/secrets/.browser-profile`), outside project files, exports and capture, and go with the VM's disk:
chat deletion, Reset and account deletion destroy it. Saved sign-ins (`_sessions.py`, encrypted on the server)
are still applied at launch, and one written after this profile last held it wins over the profile's copy, so a
sign-in made in another chat reaches this one (`sign_ins_to_apply`).

Beside Chromium's own files the profile keeps `aiqsa-state.json`: which saved sign-ins it already holds, the
browser's session cookies as of the last action or tick (Chromium drops them when it closes, an anonymous cart among
them; its own store keeps the persistent ones, fresher than any copy), and each agent's open tabs, which reopen at that
agent's first browser command of a later boot.

One browser host per boot uses it (`_client.py` starts one), and a lock file it holds for its life refuses a
second. Chromium's own lock left by a browser of an earlier boot is cleared, and an orphan browser of this boot
still on it is ended. The size is bounded at launch: caches go first, then the whole profile, each with a note.
A profile Chromium cannot open, or one a newer Chromium made, is set aside and a fresh one starts; if the fresh one
fails too, the profile was not the cause and comes back. Nobody reads a set-aside profile, so the next browser start
deletes it. Nothing here imports Playwright: `_host.py` launches the browser on `root`.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import os
import secrets
import shutil
import signal
import socket
import stat
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional
from urllib.parse import urlsplit

#: Past this at launch the caches go, and if that is not enough, the profile.
MAX_BYTES = 512 * 1024 * 1024
#: Chromium's HTTP cache stays within this; the rest of the bound is cookies, storage and service workers.
DISK_CACHE_BYTES = 64 * 1024 * 1024
LAUNCH_ARGS = (f"--disk-cache-size={DISK_CACHE_BYTES}",)
#: A host that is closing may hold the profile this long; a second one never shares it.
LOCK_WAIT_SECONDS = 30.0
STATE_FILE = "aiqsa-state.json"
STATE_VERSION = 1
#: The bookkeeping file; past this it keeps no cookie copy (Chromium's own store still has the persistent ones).
STATE_MAX_BYTES = 8 * 1024 * 1024
#: Agents whose tabs are remembered (the browser's five slots and a few more); the longest unused go first.
TAB_AGENTS_KEPT = 8
URL_MAX_CHARS = 4096
#: Files a size walk looks at before it counts the profile as over its bound.
WALK_MAX_ENTRIES = 200_000
#: What Chromium rebuilds by itself: the HTTP and code caches, GPU and shader caches, sites' Cache Storage, downloads
#: of components and models. Cookies, local storage, IndexedDB and service worker registrations stay.
CACHE_PATHS = ("Default/Cache", "Default/Code Cache", "Default/GPUCache", "Default/DawnGraphiteCache", "Default/DawnWebGPUCache",
               "Default/Service Worker/CacheStorage", "Default/Shared Dictionary/cache", "GrShaderCache", "GraphiteDawnCache",
               "ShaderCache", "component_crx_cache", "extensions_crx_cache", "optimization_guide_model_store",
               "BrowserMetrics", "Crash Reports")
SINGLETON_FILES = ("SingletonLock", "SingletonSocket", "SingletonCookie")
SIGN_IN_AGAIN = "this chat's sites need signing in again, except those with saved sign-ins"


class ProfileError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _mib(value: int) -> int:
    return (value + 1024 * 1024 - 1) // (1024 * 1024)


def size_of(path: Path, limit: int = WALK_MAX_ENTRIES) -> Optional[int]:
    """Bytes of the regular files under `path`, links not followed; None when there are more than `limit` entries."""
    total, seen = 0, 0
    stack = [path]
    while stack:
        try:
            with os.scandir(stack.pop()) as scan:
                for entry in scan:
                    seen += 1
                    if seen > limit:
                        return None
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.S_ISDIR(info.st_mode):
                        stack.append(Path(entry.path))
                    elif stat.S_ISREG(info.st_mode):
                        total += info.st_size
        except OSError:
            continue
    return total


def _remove(path: Path) -> None:
    """A file, a link or a whole tree, links never followed."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISDIR(info.st_mode):
        shutil.rmtree(path, ignore_errors=True)
    else:
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def _major(version: Any) -> int:
    try:
        return int(str(version).split(".", 1)[0])
    except ValueError:
        return 0


def _runs_on(pid: int, root: Path) -> bool:
    """Whether a live process is a browser on this profile."""
    try:
        arguments = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    except OSError:
        return False
    return f"--user-data-dir={root}".encode() in arguments


def web_url(value: Any) -> Optional[str]:
    """A tab worth reopening: an http(s) address of bounded length."""
    if not isinstance(value, str) or not value or len(value) > URL_MAX_CHARS:
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    return value if parts.scheme in ("http", "https") and parts.hostname else None


def live_cookies(cookies: Iterable[Any], now: float) -> List[Dict[str, Any]]:
    """Cookies of the copy that still hold: session cookies (expires -1) and those not yet expired."""
    kept = []
    for cookie in cookies:
        if not isinstance(cookie, dict) or not all(isinstance(cookie.get(key), str) for key in ("name", "value", "domain", "path")):
            continue
        expires = cookie.get("expires")
        if isinstance(expires, bool) or not isinstance(expires, (int, float)) or (expires != -1 and expires <= now):
            continue
        kept.append(cookie)
    return kept


def sign_ins_to_apply(files: Mapping[str, Mapping[str, Any]], keys: Mapping[str, str], applied: Mapping[str, Any],
                      saved_at: Callable[[Mapping[str, Any]], int]) -> List[str]:
    """The saved sign-ins this profile does not hold yet: one it never held, or one changed since and written after
    the copy it holds. A file without a stamp (an upload in Settings, an older guest's) that changed is applied too:
    the user put it there. One the profile holds a newer copy of (this chat saved it later) is not."""
    names = []
    for name in sorted(files):
        held = applied.get(name)
        if not isinstance(held, dict) or not isinstance(held.get("key"), str):
            names.append(name)
            continue
        if keys.get(name) == held["key"]:
            continue
        stamp = saved_at(files[name])
        seen = held.get("savedAt") if isinstance(held.get("savedAt"), int) else 0
        if stamp == 0 or stamp > seen:
            names.append(name)
    return names


class ChatProfile:
    """The profile directory, its lock, its bound and its bookkeeping."""

    def __init__(self, root: Path, clock: Callable[[], float] = time.time):
        self.root = root
        self.aside = root.with_name(root.name + ".set-aside")
        self.lock_path = root.with_name(root.name + ".lock")
        self.clock = clock
        self._lock: Optional[int] = None
        #: True when Chromium is about to make this profile from nothing.
        self.fresh = False
        #: What the page summary says about the profile, once.
        self.notes: List[str] = []
        self.state: Dict[str, Any] = {}
        self._written: Optional[str] = None

    # The lock ------------------------------------------------------------------------------------------------------

    def _parent(self) -> Path:
        parent = self.root.parent
        for directory in (parent.parent, parent):
            if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
                raise ProfileError("browser_profile_unusable", f"{directory} is not a plain directory, so the chat's browser profile cannot be kept.")
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        return parent

    def acquire(self, wait: float = LOCK_WAIT_SECONDS) -> None:
        """Hold the profile for this host's life; the lock ends with the process however it ends."""
        if self._lock is not None:
            return
        self._parent()
        if self.lock_path.is_symlink() or (self.lock_path.exists() and not self.lock_path.is_file()):
            _remove(self.lock_path)
        descriptor = os.open(self.lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._lock = descriptor
                return
            except OSError as error:
                if error.errno not in (errno.EWOULDBLOCK, errno.EAGAIN):
                    os.close(descriptor)
                    raise
            if time.monotonic() >= deadline:
                os.close(descriptor)
                raise ProfileError("browser_profile_busy", "The chat's browser profile is still in use by a browser that is closing. "
                                   "Try again in a moment.")
            time.sleep(0.2)

    def release(self) -> None:
        if self._lock is not None:
            try:
                os.close(self._lock)
            finally:
                self._lock = None

    # Before Chromium opens it -----------------------------------------------------------------------------------

    def prepare(self, version: str, bound: bool = True) -> None:
        """Make the profile ready for this Chromium: a usable directory within its bound (checked when a browser starts,
        never between a browser and its restart), no lock of a dead browser."""
        self._parent()
        if bound:
            _remove(self.aside)
        if self.root.is_symlink() or (self.root.exists() and not self.root.is_dir()):
            # Never let Chromium write through a link, into exported folders or elsewhere.
            _remove(self.root)
        self._remove_stale_staging()
        self.state = self._read_state() if self.root.is_dir() else {}
        made_by = self.state.get("chromium")
        if self.root.is_dir() and _major(made_by) > _major(version) > 0:
            self.set_aside()
            self.notes.append(f"The chat's browser profile was made by a newer Chromium ({made_by}) than this one ({version}), "
                              f"so it was set aside and a new one started: {SIGN_IN_AGAIN}.")
        if bound:
            self._bound()
        self._clear_singleton()
        self.fresh = not self.root.is_dir() or not [name for name in os.listdir(self.root) if name != STATE_FILE]
        self.root.mkdir(mode=0o700, exist_ok=True)

    def _remove_stale_staging(self) -> None:
        """Bookkeeping files a browser stopped mid-write left; the rename never happened."""
        try:
            with os.scandir(self.root) as scan:
                for entry in scan:
                    if entry.name.startswith(f".{STATE_FILE}.") and entry.name.endswith(".tmp") and entry.is_file(follow_symlinks=False):
                        _remove(Path(entry.path))
        except OSError:
            pass

    def _bound(self) -> None:
        if not self.root.is_dir():
            return
        size = size_of(self.root)
        if size is not None and size <= MAX_BYTES:
            return
        for relative in CACHE_PATHS:
            _remove(self.root / relative)
        after = size_of(self.root)
        grown = f"had grown to {_mib(size)} MiB" if size is not None else f"held over {WALK_MAX_ENTRIES} files"
        if after is not None and after <= MAX_BYTES:
            self.notes.append(f"The chat's browser profile {grown}, past its bound of {_mib(MAX_BYTES)} MiB, so its caches were "
                              "cleared; cookies and site data stay.")
            return
        _remove(self.root)
        self.state = {}
        self.notes.append(f"The chat's browser profile {grown}, past its bound of {_mib(MAX_BYTES)} MiB even without its caches, "
                          f"so it was reset: {SIGN_IN_AGAIN}.")

    def _clear_singleton(self) -> None:
        """Chromium's lock names a browser by host and process; one of an earlier boot is gone, one of this boot is an orphan."""
        try:
            target = os.readlink(self.root / "SingletonLock")
        except OSError:
            target = ""
        host, _, pid = target.rpartition("-")
        if host and host == socket.gethostname() and pid.isdigit() and int(pid) != os.getpid() and _runs_on(int(pid), self.root):
            try:
                os.kill(int(pid), signal.SIGKILL)
            except OSError:
                pass
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline and _runs_on(int(pid), self.root):
                time.sleep(0.1)
        for name in SINGLETON_FILES:
            _remove(self.root / name)

    def set_aside(self) -> None:
        """Move the profile out of the way until the next browser start; one set aside before goes."""
        _remove(self.aside)
        try:
            os.replace(self.root, self.aside)
        except FileNotFoundError:
            pass
        self.state, self._written = {}, None

    def restore_set_aside(self) -> bool:
        """Undo `set_aside` when a fresh profile failed too: the profile was not the cause."""
        if not self.aside.is_dir() or self.aside.is_symlink():
            return False
        _remove(self.root)
        os.replace(self.aside, self.root)
        self.state = self._read_state()
        return True

    # Bookkeeping ------------------------------------------------------------------------------------------------

    def _read_state(self) -> Dict[str, Any]:
        try:
            descriptor = os.open(self.root / STATE_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    return {}
                raw = stream.read(STATE_MAX_BYTES + 1)
            value = json.loads(raw.decode("utf-8")) if len(raw) <= STATE_MAX_BYTES else None
        except (OSError, RecursionError, UnicodeDecodeError, ValueError):
            return {}
        return value if isinstance(value, dict) and value.get("version") == STATE_VERSION else {}

    def applied(self) -> Dict[str, Any]:
        value = self.state.get("applied")
        return value if isinstance(value, dict) else {}

    def session_cookies(self) -> List[Dict[str, Any]]:
        """The session cookies of the copy: only those, since a persistent cookie in Chromium's own store may be fresher."""
        value = self.state.get("cookies")
        return [cookie for cookie in live_cookies(value, self.clock()) if cookie.get("expires") == -1] if isinstance(value, list) else []

    def tabs(self) -> Dict[str, Dict[str, Any]]:
        """Each agent's remembered tabs: `urls` and the index of the `current` one."""
        value = self.state.get("tabs")
        result: Dict[str, Dict[str, Any]] = {}
        for agent, record in (value.items() if isinstance(value, dict) else []):
            if not isinstance(agent, str) or not isinstance(record, dict) or not isinstance(record.get("urls"), list):
                continue
            urls = [url for url in (web_url(entry) for entry in record["urls"]) if url]
            current = record.get("current")
            result[agent] = {"urls": urls, "current": current if isinstance(current, int) and 0 <= current < len(urls) else len(urls) - 1,
                             "used": record.get("used") if isinstance(record.get("used"), int) else 0}
        return result

    def write(self, version: str, applied: Mapping[str, Any], cookies: List[Dict[str, Any]], tabs: Mapping[str, Dict[str, Any]]) -> bool:
        """Keep the bookkeeping, atomically and only when it changed; best effort, it never fails the browser."""
        kept = sorted(tabs.items(), key=lambda item: item[1].get("used", 0), reverse=True)[:TAB_AGENTS_KEPT]
        state = {"version": STATE_VERSION, "chromium": version, "applied": dict(applied), "cookies": cookies, "tabs": dict(kept)}
        data = json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(data) > STATE_MAX_BYTES:
            state["cookies"] = []
            data = json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        digest = hashlib.sha256(data).hexdigest()
        if digest == self._written or not self.root.is_dir() or self.root.is_symlink():
            return False
        staging = self.root / f".{STATE_FILE}.{secrets.token_hex(6)}.tmp"
        try:
            descriptor = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(staging, self.root / STATE_FILE)
        except OSError:
            _remove(staging)
            return False
        self.state, self._written = state, digest
        return True


def tab_record(urls: Iterable[Any], current: Optional[int], used: int) -> Dict[str, Any]:
    """An agent's open tabs as they are remembered; `current` indexes `urls` as given."""
    kept: List[str] = []
    chosen = -1
    for index, url in enumerate(urls):
        address = web_url(url)
        if address is None:
            continue
        if index == current:
            chosen = len(kept)
        kept.append(address)
    return {"urls": kept, "current": chosen if chosen >= 0 else len(kept) - 1, "used": used}


def describe(urls: List[str], where: Callable[[str], str]) -> str:
    return "; ".join(f"{index}. {where(url)}" for index, url in enumerate(urls, start=1))
