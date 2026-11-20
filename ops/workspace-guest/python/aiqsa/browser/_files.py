"""Pages the agent built in the Workspace, opened in the browser without a web server of its own.

`open /workspace/project/site/index.html` (or a `file:` address) serves the file's folder from a
loopback server in the browser host, so the page's relative CSS, scripts and images load. Each
folder gets an origin of its own, `http://<token>.localhost:<port>/`, with a random token
(Chromium resolves every `*.localhost` name to loopback itself and never sends it to a proxy):

- a page reads only its own folder and what is below it, never another opened folder, other Workspace
  files or the managed secrets, even when it came from the web (a download) and runs scripts;
- a site open in another tab cannot guess the address, so it cannot read these files either;
- a request with any other host name, a path that leaves the folder or a link out of the project,
  output and tmp roots gets 404; folders are never listed.

Nothing is cached (`no-store`): the agent edits a file and opens it again. The server lives as long as
its host; its addresses end with it, and opening the path again gives a new one.
"""

from __future__ import annotations

import os
import secrets
import stat
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Optional, Tuple
from urllib.parse import quote, unquote, urlsplit

from . import _paths

#: Types Python's table may lack or get wrong for pages built today.
_TYPES = {".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
          ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".webp": "image/webp", ".avif": "image/avif", ".wasm": "application/wasm",
          ".woff": "font/woff", ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8"}
_SUFFIX = ".localhost"


class FileRefused(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _roots() -> Tuple[Path, ...]:
    return tuple(Path(os.path.realpath(root)) for root in _paths.writable_roots())


def _inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def workspace_target(value: str) -> Optional[Tuple[Path, str]]:
    """A Workspace path or `file:` address to open, with the `?query#fragment` it carries; None for a web address.

    Only files and folders under the project, output and tmp roots open, after symbolic links are followed.
    """
    candidate = value.strip()
    if candidate.lower().startswith("file:"):
        parts = urlsplit(candidate)
        if parts.netloc not in ("", "localhost"):
            raise FileRefused("A file: address opens only files of this Workspace, such as file:///workspace/project/index.html.")
        raw, tail = unquote(parts.path), (f"?{parts.query}" if parts.query else "") + (f"#{parts.fragment}" if parts.fragment else "")
    elif candidate.startswith("/"):
        raw, tail = candidate, ""
        if not os.path.exists(candidate):
            # A page's own address part, as in /workspace/project/app/index.html#settings.
            parts = urlsplit(candidate)
            raw, tail = parts.path, (f"?{parts.query}" if parts.query else "") + (f"#{parts.fragment}" if parts.fragment else "")
    else:
        return None
    path = Path(os.path.realpath(raw))
    if not any(_inside(path, root) for root in _roots()):
        raise FileRefused("Only files under /workspace/project, /workspace/output or /workspace/tmp open in the browser; "
                          "other places, such as /workspace/secrets or /workspace/inbox, do not.")
    if not path.exists():
        raise FileRefused(f"There is no file {raw}.")
    if path.is_dir() and not any((path / name).is_file() for name in ("index.html", "index.htm")):
        raise FileRefused(f"The folder {raw} has no index.html; open a file in it.")
    return path, tail


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    folders: Dict[str, Path]


class _Handler(SimpleHTTPRequestHandler):
    server: _Server
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **_TYPES}

    def log_message(self, *_args: object) -> None:
        pass

    def _folder(self) -> Optional[Path]:
        host = (self.headers.get("Host") or "").lower()
        name, _, port = host.rpartition(":")
        if port != str(self.server.server_address[1]) or not name.endswith(_SUFFIX):
            return None
        return self.server.folders.get(name[: -len(_SUFFIX)])

    @staticmethod
    def _allowed(path: Path, folder: Path) -> bool:
        return _inside(path, folder) and any(_inside(path, root) for root in _roots())

    def _open(self, folder: Path, target: Path) -> Optional[Tuple[int, os.stat_result]]:
        """The checked file opened, and where the open really landed checked again: a link swapped in between serves nothing."""
        try:
            fd = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except OSError:
            return None
        try:
            status = os.fstat(fd)
            landed = Path(os.path.realpath(f"/proc/self/fd/{fd}")) if os.path.isdir("/proc/self/fd") else target
            if stat.S_ISREG(status.st_mode) and self._allowed(landed, folder):
                return fd, status
        except OSError:
            pass
        os.close(fd)
        return None

    def send_head(self):  # type: ignore[no-untyped-def]
        """The file a request names inside its folder; a folder serves its index page. Every other request gets 404.

        Python's own handler is not used for this: it picks a folder's index page without checking where it leads.
        """
        folder = self._folder()
        if folder is None:
            self.send_error(404)
            return None
        url_path = urlsplit(self.path).path
        target = Path(os.path.realpath(folder / unquote(url_path).lstrip("/")))
        if not self._allowed(target, folder):
            self.send_error(404)
            return None
        if target.is_dir():
            target = next((index for index in (Path(os.path.realpath(target / name)) for name in ("index.html", "index.htm"))
                           if self._allowed(index, folder) and index.is_file()), target)
            if target.is_file() and not url_path.endswith("/"):
                # Relative links on an index page resolve against the folder only with a trailing slash.
                self.send_response(301)
                self.send_header("Location", url_path + "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
        opened = self._open(folder, target) if target.is_file() else None
        if opened is None:
            self.send_error(404)
            return None
        fd, status = opened
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(target)))
        self.send_header("Content-Length", str(status.st_size))
        self.end_headers()
        return os.fdopen(fd, "rb")

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


class FileServer:
    """The host's loopback server for Workspace files; it starts with the first file opened."""

    def __init__(self) -> None:
        self._server: Optional[_Server] = None
        self._lock = threading.Lock()

    def _ensure(self) -> _Server:
        with self._lock:
            if self._server is None:
                server = _Server(("127.0.0.1", 0), _Handler)
                server.folders = {}
                threading.Thread(target=server.serve_forever, name="aiqsa-browser-files", daemon=True).start()
                self._server = server
            return self._server

    def address(self, path: Path, tail: str = "") -> str:
        """The page's address: its folder's origin, then its name (a folder opens its index.html)."""
        server = self._ensure()
        folder = path if path.is_dir() else path.parent
        token = next((name for name, known in server.folders.items() if known == folder), None)
        if token is None:
            token = secrets.token_hex(8)
            server.folders[token] = folder
        name = "" if path.is_dir() else quote(path.name)
        return f"http://{token}{_SUFFIX}:{server.server_address[1]}/{name}{tail}"

    def close(self) -> None:
        with self._lock:
            server, self._server = self._server, None
        if server is not None:
            server.shutdown()
            server.server_close()
