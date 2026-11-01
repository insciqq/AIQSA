"""Starting the forwarder and asking it things. Standard library only, so any guest Python can use it.

Only a VM whose plan has proxies gets here past `has_plan`: with no plan, or an explicitly empty one, there is no
process and no browser flag.
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

from . import _plan
from ..browser import _client, _paths

START_TIMEOUT = 15.0
CONTROL_TIMEOUT = 5.0
RESPONSE_MAX_BYTES = 1024 * 1024
UNAVAILABLE = "proxy_forwarder_unavailable"
#: Names a choice can never mean as a proxy's: such a proxy is named by its id.
DIRECT = "direct"
AUTO = "auto"
#: The relay a guest command reaches MCP through, and the VM itself, stay off the forwarder.
NO_PROXY = "localhost,127.0.0.1,::1,host.microsandbox.internal"
#: Keeps the process object of a detached forwarder from being finalized while it runs.
_STARTED: list = []
_PROXY_VARIABLES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")


class ProxyError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def has_plan() -> bool:
    """Whether the forwarder is wanted. A file that cannot be read counts: the forwarder then refuses, and nothing goes direct."""
    try:
        plan = _plan.load(_paths.proxy_plan_path())
    except _plan.PlanInvalid:
        return True
    return plan is not None and bool(plan.proxies)


def load_plan() -> Optional[_plan.Plan]:
    """The plan for reading names, None without proxies; a file that cannot be read is a visible failure, never "no proxies"."""
    try:
        plan = _plan.load(_paths.proxy_plan_path())
    except _plan.PlanInvalid:
        raise ProxyError("proxy_unavailable", "This chat's proxies could not be read; nothing is sent directly in their place.") from None
    return plan if plan is not None and plan.proxies else None


def _exchange(path: Path, payload: bytes, timeout: float) -> Optional[Dict[str, Any]]:
    """One request over the private socket; None when no forwarder listens there."""
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        try:
            client.connect(str(path))
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ECONNREFUSED, errno.ENOTSOCK):
                return None
            raise ProxyError(UNAVAILABLE, "The proxy forwarder could not be reached.") from None
        chunks = []
        total = 0
        try:
            client.sendall(payload)
            client.shutdown(socket.SHUT_WR)
            while True:
                chunk = client.recv(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > RESPONSE_MAX_BYTES:
                    raise ProxyError(UNAVAILABLE, "The proxy forwarder answered with too much data.")
                chunks.append(chunk)
        except OSError:
            raise ProxyError(UNAVAILABLE, "The connection to the proxy forwarder broke.") from None
    finally:
        client.close()
    try:
        response = json.loads(b"".join(chunks).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return response if isinstance(response, dict) else None


def _request(op: str, args: Mapping[str, Any]) -> bytes:
    return json.dumps({"op": op, "args": dict(args)}, ensure_ascii=False).encode("utf-8") + b"\n"


def _ping() -> Optional[int]:
    response = _exchange(_paths.proxy_run_dir() / "control.sock", _request("ping", {}), CONTROL_TIMEOUT)
    if response is None or response.get("ok") is not True:
        return None
    port = response["result"].get("port")
    return port if isinstance(port, int) else None


def _leave_agent_group(pid: int) -> None:
    """It serves every agent, so one agent's stop must not end it (`_client.SHARED_CGROUP`). From outside: the host calls this on a worker thread."""
    try:
        os.makedirs(_client.SHARED_CGROUP, exist_ok=True)
        with open(os.path.join(_client.SHARED_CGROUP, "cgroup.procs"), "w") as handle:
            handle.write(str(pid))
    except OSError:
        pass  # No cgroup v2 here: no agent group holds it either.


def _start(run_dir: Path) -> None:
    argv = [_paths.python() or sys.executable, "-m", "aiqsa.proxy._forwarder"]
    test_root = _paths.current_test_root()
    if test_root is not None:
        argv += [_paths.TEST_ROOT_FLAG, str(test_root)]
    # It needs no command's environment: saved secrets stay out of its process.
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8",
           "PYTHONPATH": str(Path(__file__).resolve().parents[2])}
    log = open(run_dir / "forwarder.log", "wb")  # noqa: SIM115 - handed to the detached forwarder
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                   close_fds=True, cwd="/", env=env)
    except OSError:
        raise ProxyError(UNAVAILABLE, "The proxy forwarder could not start.") from None
    finally:
        log.close()
    _STARTED.append(process)
    _leave_agent_group(process.pid)


def ensure() -> int:
    """The forwarder's port, starting it when none answers. The caller decided the run has proxies."""
    port = _ping()
    if port is not None:
        return port
    run_dir = _paths.proxy_run_dir()
    try:
        _client._private_directory(run_dir)
    except _client.BrowserError:
        raise ProxyError(UNAVAILABLE, "The proxy forwarder's directory is not usable.") from None
    with open(run_dir / "start.lock", "a+b") as lock:
        deadline = time.monotonic() + START_TIMEOUT
        while True:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise ProxyError(UNAVAILABLE, "Another command is still starting the proxy forwarder.") from None
                time.sleep(0.05)
        try:
            port = _ping()
            if port is not None:
                return port
            _start(run_dir)
            while time.monotonic() < deadline:
                port = _ping()
                if port is not None:
                    return port
                time.sleep(0.05)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    raise ProxyError(UNAVAILABLE, "The proxy forwarder did not start.")


def call(op: str, args: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """One control request, restarting a forwarder that went away."""
    ensure()
    response = _exchange(_paths.proxy_run_dir() / "control.sock", _request(op, args or {}), CONTROL_TIMEOUT)
    if response is None:
        raise ProxyError(UNAVAILABLE, "The proxy forwarder does not answer.")
    if response.get("ok") is not True:
        raise ProxyError(str(response.get("code") or UNAVAILABLE), "The proxy forwarder refused this request.")
    result = response.get("result")
    return result if isinstance(result, dict) else {}


def parse_choice(value: Optional[str]) -> Any:
    """`--proxy`: None for no choice, `AUTO` to follow hints again, else the choice the rules take."""
    if value is None:
        return None
    if value == AUTO:
        return AUTO
    return {"kind": "direct"} if value == DIRECT else {"kind": "proxy", "ref": value}


def command_environment(environ: Mapping[str, str], route: Optional[str] = None) -> Dict[str, str]:
    """A command's environment with every common proxy variable at the forwarder; `route` is `direct` or a proxy id."""
    port = ensure()
    url = f"http://{route}:x@127.0.0.1:{port}" if route else f"http://127.0.0.1:{port}"
    env = dict(environ)
    env.update({name: url for name in _PROXY_VARIABLES})
    env.update({"NO_PROXY": NO_PROXY, "no_proxy": NO_PROXY})
    return env


def labels(names: List[Mapping[str, Any]]) -> str:
    """`KZ1 (KZ), Shared`: how answers name proxies."""
    return ", ".join(f"{entry['name']} ({entry['country']})" if entry.get("country") else str(entry["name"]) for entry in names)
