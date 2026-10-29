"""The calling side of the Workspace browser. Standard library only, so any guest Python can use it.

Each call sends one request to this boot's browser host over its private Unix
socket, starting the host first when none answers. The host is a separate,
detached process (`_host.py`), so the browser outlives the command that started
it and serves the next ones of the turn.
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import re
import socket
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from . import _identity, _paths
from ..agents import AGENT_ID_ENV, AGENT_ID_PATTERN, AGENT_NAME_ENV, MAIN_AGENT_ID

PROTOCOL = 1
#: Starting the host launches Chromium twice: once to read its own identity, once for the turn.
START_TIMEOUT = 90.0
RESPONSE_MAX_BYTES = 16 * 1024 * 1024
_SLOW = {"open", "back", "forward", "reload", "new_tab"}
#: Hosts this process started. The host outlives the command on purpose; the reference only
#: keeps the process object from being finalized while the host still runs.
_STARTED: list = []


class BrowserError(Exception):
    """A browser request that did not complete. `code` is stable; `message` says what to do next."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _private_directory(path: Path) -> None:
    try:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = path.lstat()
    except OSError as error:
        raise BrowserError("browser_unavailable", f"The browser's run directory is not usable ({error.strerror}).") from None
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise BrowserError("browser_unavailable", "The browser's run directory is not a private directory.")
    if stat.S_IMODE(info.st_mode) != 0o700:
        os.chmod(path, 0o700)


def _connect(path: Path, timeout: float) -> Optional[socket.socket]:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect(str(path))
        return client
    except OSError as error:
        client.close()
        if error.errno in (errno.ENOENT, errno.ECONNREFUSED, errno.ENOTSOCK):
            return None
        raise BrowserError("browser_unavailable", f"The browser could not be reached ({error.strerror}).") from None


def _host_environment(environ: Mapping[str, str]) -> Dict[str, str]:
    env = {key: value for key, value in environ.items() if key not in _identity.DROPPED_ENV}
    package_root = str(Path(__file__).resolve().parents[2])
    paths = [entry for entry in env.get("PYTHONPATH", "").split(os.pathsep) if entry]
    if package_root not in paths:
        env["PYTHONPATH"] = os.pathsep.join([package_root, *paths])
    return env


def _start(run_dir: Path, socket_path: Path) -> None:
    python = _paths.python() or sys.executable
    status_path = run_dir / "host.status"
    try:
        status_path.unlink()
    except FileNotFoundError:
        pass
    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass
    argv = [python, "-m", "aiqsa.browser._host"]
    test_root = _paths.current_test_root()
    if test_root is not None:
        argv += [_paths.TEST_ROOT_FLAG, str(test_root)]
    log = open(run_dir / "host.log", "wb")  # noqa: SIM115 - handed to the detached host
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True, close_fds=True, cwd="/",
                                   env=_host_environment(os.environ))
    except OSError as error:
        raise BrowserError("browser_start_failed", f"The browser host could not start ({error.strerror}).") from None
    finally:
        log.close()
    _STARTED.append(process)
    deadline = time.monotonic() + START_TIMEOUT
    while time.monotonic() < deadline:
        client = _connect(socket_path, 2.0)
        if client is not None:
            client.close()
            return
        if process.poll() is not None:
            detail = ""
            try:
                status = json.loads(status_path.read_text("utf-8"))
                detail = f" ({status.get('error', '')}: {status.get('detail', '')})"
            except (OSError, ValueError):
                pass
            raise BrowserError("browser_start_failed", f"The browser did not start{detail}. See {run_dir / 'host.log'}.")
        time.sleep(0.1)
    raise BrowserError("browser_start_failed", f"The browser did not start within {int(START_TIMEOUT)} seconds.")


def _ensure_host(timeout: float) -> socket.socket:
    run_dir = _paths.run_dir()
    socket_path = run_dir / "control.sock"
    client = _connect(socket_path, timeout)
    if client is not None:
        return client
    _private_directory(run_dir)
    with open(run_dir / "start.lock", "a+b") as lock:
        deadline = time.monotonic() + START_TIMEOUT
        while True:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise BrowserError("browser_unavailable", "Another command is still starting the browser.") from None
                time.sleep(0.1)
        try:
            client = _connect(socket_path, timeout)
            if client is None:
                _start(run_dir, socket_path)
                client = _connect(socket_path, timeout)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    if client is None:
        raise BrowserError("browser_unavailable", "The browser started but does not answer.")
    return client


def request_timeout(op: str, args: Mapping[str, Any]) -> float:
    if op == "wait":
        value = args.get("timeout", 15)
        return float(value if isinstance(value, int) and not isinstance(value, bool) else 15) + 30.0
    return 100.0 if op in _SLOW else 70.0


def _agent_request(environ: Mapping[str, str]) -> Dict[str, str]:
    """The server-owned identity travels with every socket request.

    The guest environment is the coordination input for the helper, not an
    authorization boundary. Invalid or missing values use the main agent so an
    old caller remains compatible while a malformed server value is harmless.
    """
    agent_id = environ.get(AGENT_ID_ENV, MAIN_AGENT_ID)
    if not re.fullmatch(AGENT_ID_PATTERN, agent_id):
        agent_id = MAIN_AGENT_ID
    name = environ.get(AGENT_NAME_ENV, "")
    return {"id": agent_id, **({"name": name} if name else {})}


def call(op: str, args: Optional[Dict[str, Any]] = None, timeout: Optional[float] = None) -> Dict[str, Any]:
    """One browser request; returns its result or raises `BrowserError`."""
    args = {key: value for key, value in (args or {}).items() if value is not None}
    payload = (json.dumps({"v": PROTOCOL, "op": op, "args": args, "agent": _agent_request(os.environ)}, ensure_ascii=False) + "\n").encode("utf-8")
    wait = timeout if timeout is not None else request_timeout(op, args)
    client = _ensure_host(wait)
    chunks = []
    total = 0
    try:
        client.settimeout(wait)
        client.sendall(payload)
        client.shutdown(socket.SHUT_WR)
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > RESPONSE_MAX_BYTES:
                raise BrowserError("protocol_error", "The browser answered with too much data.")
            chunks.append(chunk)
    except socket.timeout:
        raise BrowserError("timeout", f"The browser did not answer within {int(wait)} seconds; the page may still be busy.") from None
    except OSError as error:
        raise BrowserError("browser_crashed", f"The connection to the browser broke ({error.strerror}).") from None
    finally:
        client.close()
    if not chunks:
        raise BrowserError("browser_crashed", "The browser stopped while handling this request; the next command starts a new one.")
    try:
        response = json.loads(b"".join(chunks).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise BrowserError("protocol_error", "The browser's answer could not be read.") from None
    if not isinstance(response, dict):
        raise BrowserError("protocol_error", "The browser's answer could not be read.")
    if response.get("ok") is not True:
        error = response.get("error") if isinstance(response.get("error"), dict) else {}
        raise BrowserError(str(error.get("code") or "browser_error"), str(error.get("message") or "The browser request failed."))
    result = response.get("result")
    return result if isinstance(result, dict) else {}
