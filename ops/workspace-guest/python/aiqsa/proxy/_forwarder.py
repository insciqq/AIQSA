"""The local forwarder: chooses per site, adds an upstream's credentials, or connects directly.

    python3 -m aiqsa.proxy._forwarder

Started only when the run has proxies (`client.py`), it binds 127.0.0.1 and serves HTTP proxy requests from anything
in the VM, unauthenticated: a process that reaches it gets what it could read in the plan file anyway (operator
decision, `agent_docs/SECURITY.md`, Proxies). A web page gets nothing: Chromium bypasses the proxy for loopback, so
a page's request here is in origin form, which is refused before its body is read, and a name rebinding to loopback
goes through the direct path below, which refuses it.

Egress stays the session's. Both paths are plain sockets of the VM under its default-deny, public-only policy, with
Internet Off denying everything; on top of it `_upstream.py` checks every address first. A target that names a
private or local address is refused on both paths before anything is sent.

How a choice reaches this process. Chromium has one proxy setting per network context, and agents' tabs share one
context so that they share sign-ins; a per-agent port would need a context per agent, and a header set on a page is
inside the TLS the proxy only tunnels, so it never appears on a CONNECT. What Chromium does tell a proxy is the host,
so `aiqsa-browser open --proxy` sets a route for that host's site over the private control socket before it
navigates, and closes the site's tunnels so that Chromium's pooled sockets cannot keep the old exit. Two agents naming
different proxies for one site therefore share the last choice; the host tells the other one. Commands do better:
`aiqsa-browser proxied` carries the choice in their proxy URL's user name, per connection, leaving the route alone.

What is on disk. The plan is reread when its file changes, which is the next install. A different plan (the newest
install wins, as for the VM's SSH identities and files) restarts failures and routes and closes tunnels through a
proxy it dropped or moved. Which proxy a site stays on, and where each rotation stands, are kept beside it, so they
hold across a chat's runs and VM stops; a write lost to a VM stop costs at most a rotation step. No log line carries
a password, an address or a site.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
import re
import signal
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from . import _plan, _upstream, address, selection
from ..browser import _paths

HOST = "127.0.0.1"
#: The VM's network allows 256 connections (`lib/server/workspace/microsandboxRuntime.ts`).
MAX_CONNECTIONS = 240
HEAD_TIMEOUT = 30.0
#: One proxy's connection and handshake; a dead proxy costs this before the next is tried.
ATTEMPT_TIMEOUT = 12.0
#: All attempts of one connection, within the browser's 45 second navigation limit.
OPEN_BUDGET = 40.0
RESPONSE_HEAD_TIMEOUT = 300.0
#: After the client finished sending, how long its half-open connection may wait for the far side to end.
DRAIN_TIMEOUT = 120.0
SAVE_DELAY = 2.0
MAX_SITES = 5000
MAX_OUTCOMES = 1000
CONTROL_MAX_BYTES = 64 * 1024
STATE_VERSION = 1

_REQUEST = re.compile(r"([A-Z]{1,16}) (\S{1,8192}) HTTP/1\.[01]")
_HEADER = re.compile(r"([!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}):[ \t]*([^\r\n]*?)[ \t]*")
_NAME_AUTHORITY = re.compile(r"([A-Za-z0-9._-]{1,253})(?::(\d{1,5}))?")
_IPV6_AUTHORITY = re.compile(r"\[([0-9A-Fa-f:.]{2,45})\](?::(\d{1,5}))?")
_ABSOLUTE = re.compile(r"[Hh][Tt][Tt][Pp]://([^/?#]+)([/?][^#]*)?(?:#.*)?")
site_of = selection.site_of
#: Never forwarded: hop by hop, or about this hop's own choice.
_HOP_HEADERS = frozenset({"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
                          "te", "trailer", "upgrade"})
_RESPONSE_HOP_HEADERS = frozenset({"connection", "keep-alive", "proxy-connection"})
_REASONS = {400: "Bad Request", 403: "Forbidden", 502: "Bad Gateway", 503: "Service Unavailable"}


class Refusal(Exception):
    """Answered to the client with a stable code; never a direct connection instead."""

    def __init__(self, status: int, code: str, text: Optional[str] = None):
        super().__init__(code)
        self.status = status
        self.code = code
        self.text = text or code


class _Request:
    def __init__(self, method: str, host: str, port: int, path: str, headers: List[Tuple[str, str]]):
        self.method = method
        self.host = host
        self.port = port
        self.path = path
        self.headers = headers

    def header(self, name: str) -> Optional[str]:
        return next((value for key, value in self.headers if key.lower() == name), None)


def _authority(value: str, default_port: int) -> Tuple[str, int]:
    match = _IPV6_AUTHORITY.fullmatch(value) or _NAME_AUTHORITY.fullmatch(value)
    if match is None:
        raise Refusal(400, "proxy_request_invalid")
    port = int(match.group(2)) if match.group(2) else default_port
    if not 1 <= port <= 65535:
        raise Refusal(400, "proxy_request_invalid")
    return match.group(1), port


def parse_request(head: bytes) -> _Request:
    lines = head[:-len(_upstream.HEAD_END)].decode("latin-1").split("\r\n")
    line = _REQUEST.fullmatch(lines[0])
    if line is None:
        raise Refusal(400, "proxy_request_invalid")
    headers = []
    for raw in lines[1:]:
        match = _HEADER.fullmatch(raw)
        if match is None:
            raise Refusal(400, "proxy_request_invalid")
        headers.append((match.group(1), match.group(2)))
    method, target = line.group(1), line.group(2)
    if method == "CONNECT":
        host, port = _authority(target, 443)
        return _Request(method, host, port, "", headers)
    absolute = _ABSOLUTE.fullmatch(target)
    # Origin form is what a web page's own request to this port looks like: nothing here serves it.
    if absolute is None:
        raise Refusal(400, "proxy_request_invalid")
    host, port = _authority(absolute.group(1), 80)
    path = absolute.group(2) or "/"
    return _Request(method, host, port, path if path.startswith("/") else "/" + path, headers)


def client_route(request: _Request) -> Optional[Dict[str, str]]:
    """A command's own choice: the user name of its proxy URL, `direct` or a proxy id (`client.py`)."""
    value = request.header("proxy-authorization")
    if value is None or not value[:6].lower() == "basic ":
        return None
    try:
        name = base64.b64decode(value[6:].strip(), validate=True).decode("utf-8").split(":", 1)[0]
    except (binascii.Error, ValueError):
        raise Refusal(400, "proxy_request_invalid") from None
    if not name:
        return None
    return {"kind": "direct"} if name == "direct" else {"kind": "proxy", "ref": name}


def _response(status: int, code: str, text: str) -> bytes:
    body = (text + "\n").encode("utf-8", "replace")
    return (f"HTTP/1.1 {status} {_REASONS.get(status, 'Error')}\r\nConnection: close\r\n"
            f"Content-Type: text/plain; charset=utf-8\r\nContent-Length: {len(body)}\r\nX-Aiqsa-Proxy-Code: {code}\r\n\r\n").encode("ascii") + body


def _abort(writer: Optional[asyncio.StreamWriter]) -> None:
    if writer is None:
        return
    try:
        writer.transport.abort()
    except (OSError, RuntimeError):
        pass


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, limit: Optional[int] = None) -> None:
    """Copies until EOF (or `limit` bytes) and passes the EOF on where the transport can."""
    remaining = limit
    try:
        while remaining is None or remaining > 0:
            data = await reader.read(65536 if remaining is None else min(65536, remaining))
            if not data:
                break
            if remaining is not None:
                remaining -= len(data)
            writer.write(data)
            await writer.drain()
        if limit is None and writer.can_write_eof():
            writer.write_eof()
    except (OSError, RuntimeError, asyncio.IncompleteReadError):
        _abort(writer)


class _Tunnel:
    def __init__(self, site: str, proxy_id: Optional[str], pinned: bool, *writers: asyncio.StreamWriter):
        self.site = site
        self.proxy_id = proxy_id
        #: Chosen by the command per connection, so a route for its site does not concern it.
        self.pinned = pinned
        self.writers = writers

    def close(self) -> None:
        for writer in self.writers:
            _abort(writer)


class Forwarder:
    def __init__(self, plan_path: Path, state_path: Path, network: Optional[_upstream.Network] = None):
        self.plan_path = plan_path
        self.state_path = state_path
        self.network = network or _upstream.Network()
        self.plan: Optional[_plan.Plan] = None
        self.plan_invalid = False
        self._plan_mark: Any = object()
        self.state: selection.State = self._load_state()
        self.routes: Dict[str, Dict[str, str]] = {}
        self.outcomes: Dict[str, Dict[str, Any]] = {}
        self.tunnels: Set[_Tunnel] = set()
        self.connections = 0
        self.port = 0
        self._save_handle: Optional[asyncio.TimerHandle] = None

    # Plan and state --------------------------------------------------------------------------------------------

    def _load_state(self) -> Dict[str, Any]:
        state = selection.empty_state()
        try:
            data = json.loads(self.state_path.read_text("utf-8"))
        except (OSError, ValueError):
            return state
        if isinstance(data, dict) and data.get("version") == STATE_VERSION:
            cursors, sites = data.get("cursors"), data.get("sites")
            if isinstance(cursors, dict) and all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in cursors.values()):
                state["cursors"] = cursors
            if isinstance(sites, dict) and all(isinstance(value, str) for value in sites.values()):
                state["sites"] = sites
        return state

    def _save_state(self) -> None:
        self._save_handle = None
        temporary = None
        try:
            self.state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=".proxy-rotation-", dir=self.state_path.parent)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                # Failures are this run's knowledge; a later run gives every proxy a fresh chance.
                json.dump({"version": STATE_VERSION, "cursors": self.state["cursors"], "sites": self.state["sites"]}, stream)
            os.replace(temporary, self.state_path)
            temporary = None
        except OSError:
            pass  # Stickiness across a stop is a courtesy: nothing goes direct without it.
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def _state_changed(self, state: selection.State) -> None:
        if state is self.state:
            return
        sites = state["sites"]
        if len(sites) > MAX_SITES:
            state = {**state, "sites": dict(list(sites.items())[-MAX_SITES:])}
        if len(state["failed"]) > MAX_SITES:
            state = {**state, "failed": dict(list(state["failed"].items())[-MAX_SITES:])}
        changed_on_disk = state["sites"] is not self.state["sites"] or state["cursors"] is not self.state["cursors"]
        self.state = state
        if changed_on_disk and self._save_handle is None:
            self._save_handle = asyncio.get_running_loop().call_later(SAVE_DELAY, self._save_state)

    def flush(self) -> None:
        if self._save_handle is not None:
            self._save_handle.cancel()
            self._save_state()

    def refresh_plan(self) -> None:
        """One `stat` per connection: the next run's install is seen by the next request."""
        try:
            info = os.stat(self.plan_path, follow_symlinks=False)
            mark: Any = (info.st_ino, info.st_mtime_ns, info.st_size)
        except FileNotFoundError:
            mark = None
        except OSError:
            mark = "unreadable"
        if mark == self._plan_mark:
            return
        self._plan_mark = mark
        previous = self.plan
        try:
            self.plan, self.plan_invalid = _plan.load(self.plan_path), False
        except _plan.PlanInvalid:
            self.plan, self.plan_invalid = None, True
        # Each run of a chat installs its plan, a sub-agent's starting mid-turn too: the same plan changes nothing.
        if previous is not None and self.plan is not None and previous.fingerprint == self.plan.fingerprint:
            return
        # A later run's plan: failures and explicit routes start over; where each site stays and each rotation stand hold.
        self.state = {**self.state, "failed": {}}
        self.routes.clear()
        self.outcomes.clear()
        for tunnel in list(self.tunnels):
            if tunnel.proxy_id is None:
                continue
            before = previous.endpoint(tunnel.proxy_id) if previous else None
            after = self.plan.endpoint(tunnel.proxy_id) if self.plan else None
            if after is None or before != after:
                tunnel.close()

    def _entries(self) -> List[Dict[str, Any]]:
        return self.plan.proxies if self.plan else []

    # Selection -------------------------------------------------------------------------------------------------

    def _select(self, host: str, explicit: Optional[Mapping[str, str]], *, apply: bool = True) -> Dict[str, Any]:
        if self.plan_invalid:
            return {"code": "proxy_unavailable", "kind": "failed", "tried": []}
        state: selection.State = self.state
        if explicit is None and self.plan:
            for proxy_id in self.plan.unavailable:
                state = selection.record_failure(host, proxy_id, state)
        decision, after = selection.select(self._entries(), host, state, explicit)
        if apply:
            self._state_changed(after)
        return decision

    def _explicit_for(self, host: str, pinned: Optional[Mapping[str, str]]) -> Optional[Mapping[str, str]]:
        return pinned if pinned is not None else self.routes.get(site_of(host))

    def _remember(self, host: str, outcome: Dict[str, Any]) -> None:
        site = site_of(host)
        self.outcomes.pop(site, None)
        self.outcomes[site] = outcome
        while len(self.outcomes) > MAX_OUTCOMES:
            self.outcomes.pop(next(iter(self.outcomes)))

    def _failed(self, host: str, code: str, attempts: List[Dict[str, str]], tried: Sequence[str] = ()) -> Refusal:
        """Every proxy the failure covers: those this connection tried, and those that failed earlier or cannot load."""
        attempted = {attempt["id"] for attempt in attempts}
        for proxy_id in tried:
            if proxy_id not in attempted and self.plan and proxy_id in self.plan.by_id:
                late = "proxy_failed_earlier" if self.plan.by_id[proxy_id]["available"] else "proxy_unavailable"
                attempts = [*attempts, {**self.plan.label(proxy_id), "code": late}]
        self._remember(host, {"kind": "failed", "code": code, "attempts": attempts})
        names = ", ".join(f"{attempt['name']} ({attempt['code']})" for attempt in attempts)
        text = code + (f": {names}" if names else "") + ". Nothing was sent directly."
        return Refusal(502, code, text)

    async def _open(self, host: str, port: int, pinned: Optional[Mapping[str, str]], *, tunnel: bool,
                    seen: Optional[Set[str]] = None, attempts: Optional[List[Dict[str, str]]] = None) -> Tuple[_upstream.Stream, Optional[Mapping[str, Any]], bool]:
        """A stream for this request: the selection, moved on through failures, with its deadline. Never direct after a failure."""
        seen = set() if seen is None else seen
        attempts = [] if attempts is None else attempts
        loop = asyncio.get_running_loop()
        deadline = loop.time() + OPEN_BUDGET
        while True:
            explicit = self._explicit_for(host, pinned)
            decision = self._select(host, explicit)
            if decision["kind"] == "failed":
                raise self._failed(host, decision["code"], attempts, decision["tried"])
            if decision["kind"] == "direct":
                return await self._open_direct(host, port, decision), None, False
            proxy_id = decision["proxyId"]
            label = self.plan.label(proxy_id)  # type: ignore[union-attr]
            if proxy_id in seen:
                # Another connection's failures reset the site meanwhile: this one has tried what there is.
                raise self._failed(host, "proxy_all_failed", attempts)
            seen.add(proxy_id)
            proxy = self.plan.by_id[proxy_id]  # type: ignore[union-attr]
            try:
                if not proxy["available"]:
                    raise _upstream.UpstreamFailure("proxy_unavailable")
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise asyncio.TimeoutError()
                stream = await asyncio.wait_for(self.network.open_proxy(proxy, host, port, tunnel=tunnel), min(ATTEMPT_TIMEOUT, remaining))
            except (asyncio.TimeoutError, _upstream.UpstreamFailure) as error:
                code = error.code if isinstance(error, _upstream.UpstreamFailure) else "proxy_timeout"
                attempts.append({**label, "code": code})
                if decision["reason"] == "explicit":
                    raise self._failed(host, code, attempts) from None
                self._state_changed(selection.record_failure(host, proxy_id, self.state))
                continue
            # A page's later requests stay on this proxy; what it took to get here stays part of the site's story.
            previous = self.outcomes.get(site_of(host)) or {}
            moved = attempts or (previous.get("movedFrom") if previous.get("id") == proxy_id else None)
            self._remember(host, {"kind": "proxy", "reason": decision["reason"], "hint": decision["hint"], **label,
                                  **({"movedFrom": moved} if moved else {})})
            return stream, proxy, decision["reason"] == "explicit"

    async def _open_direct(self, host: str, port: int, decision: Mapping[str, Any]) -> _upstream.Stream:
        try:
            stream = await asyncio.wait_for(self.network.open_direct(host, port), ATTEMPT_TIMEOUT * 2)
        except asyncio.TimeoutError:
            code = "site_timeout"
        except _upstream.UpstreamFailure as error:
            code = error.code
        else:
            self._remember(host, {"kind": "direct", "reason": decision["reason"]})
            return stream
        self._remember(host, {"kind": "direct", "reason": decision["reason"], "code": code})
        raise Refusal(403 if code == "proxy_target_refused" else 502, code, f"{code}: the direct connection failed.")

    def _check_target(self, request: _Request) -> str:
        if address.is_refused_target(request.host):
            self._remember(request.host, {"kind": "refused", "code": "proxy_target_refused"})
            raise Refusal(403, "proxy_target_refused", "proxy_target_refused: a private or local address is not sent anywhere from here.")
        if not request.host.strip("."):
            raise Refusal(400, "proxy_request_invalid")
        literal = address.literal_address(request.host)
        # The canonical form of an address, so no parser further on reads the digits differently.
        return literal if isinstance(literal, str) else request.host.lower().rstrip(".")

    # Serving ---------------------------------------------------------------------------------------------------

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.connections += 1
        try:
            if self.connections > MAX_CONNECTIONS:
                raise Refusal(503, "proxy_busy")
            try:
                head = await asyncio.wait_for(reader.readuntil(_upstream.HEAD_END), HEAD_TIMEOUT)
            except (asyncio.IncompleteReadError, asyncio.TimeoutError, OSError):
                return
            except asyncio.LimitOverrunError:
                raise Refusal(400, "proxy_request_invalid") from None
            request = parse_request(head)
            self.refresh_plan()
            host = self._check_target(request)
            pinned = client_route(request)
            if request.method == "CONNECT":
                await self._tunnel(host, request, pinned, reader, writer)
            else:
                await self._forward(host, request, pinned, reader, writer)
        except Refusal as refusal:
            try:
                writer.write(_response(refusal.status, refusal.code, refusal.text))
                await writer.drain()
            except (OSError, RuntimeError):
                pass
        except (OSError, RuntimeError, ValueError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError):
            pass  # One broken connection; the client sees it end.
        finally:
            self.connections -= 1
            try:
                writer.close()
            except (OSError, RuntimeError):
                pass

    async def _tunnel(self, host: str, request: _Request, pinned: Optional[Mapping[str, str]],
                      reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        (up_reader, up_writer), proxy, _explicit = await self._open(host, request.port, pinned, tunnel=True)
        tunnel = _Tunnel(site_of(host), proxy["id"] if proxy else None, pinned is not None, writer, up_writer)
        self.tunnels.add(tunnel)
        try:
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            sending = asyncio.ensure_future(_pipe(reader, up_writer))
            receiving = asyncio.ensure_future(_pipe(up_reader, writer))
            try:
                await asyncio.wait({sending, receiving}, return_when=asyncio.FIRST_COMPLETED)
                if not receiving.done():
                    await asyncio.wait({receiving}, timeout=DRAIN_TIMEOUT)
            finally:
                sending.cancel()
                receiving.cancel()
        finally:
            self.tunnels.discard(tunnel)
            _abort(up_writer)

    def _request_head(self, host: str, request: _Request, proxy: Optional[Mapping[str, Any]]) -> bytes:
        named = {value.strip().lower() for key, line in request.headers if key.lower() == "connection" for value in line.split(",")}
        kept = [(key, value) for key, value in request.headers if key.lower() not in _HOP_HEADERS and key.lower() not in named]
        authority = _upstream.authority(host, request.port)
        if proxy is not None and proxy["protocol"] != "socks5":
            target = f"http://{authority}{request.path}"
            credentials = _upstream.proxy_authorization(proxy)
            if credentials is not None:
                kept.append(("Proxy-Authorization", credentials))
        else:
            target = request.path
        kept.append(("Connection", "close"))
        lines = [f"{request.method} {target} HTTP/1.1", *(f"{key}: {value}" for key, value in kept)]
        return ("\r\n".join(lines) + _upstream.HEAD_END.decode("ascii")).encode("latin-1")

    async def _forward(self, host: str, request: _Request, pinned: Optional[Mapping[str, str]],
                       reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """One plain-HTTP request per client connection: the response says so, so nothing later can reach another host."""
        length_text, chunked = request.header("content-length"), request.header("transfer-encoding") is not None
        if length_text is not None and (chunked or not length_text.isdigit()):
            raise Refusal(400, "proxy_request_invalid")
        length = int(length_text) if length_text else 0
        seen: Set[str] = set()
        attempts: List[Dict[str, str]] = []
        while True:
            (up_reader, up_writer), proxy, explicit = await self._open(host, request.port, pinned, tunnel=False, seen=seen, attempts=attempts)
            tunnel = _Tunnel(site_of(host), proxy["id"] if proxy else None, pinned is not None, writer, up_writer)
            self.tunnels.add(tunnel)
            sending: Optional[asyncio.Future] = None
            try:
                up_writer.write(self._request_head(host, request, proxy))
                await up_writer.drain()
                sending = asyncio.ensure_future(_pipe(reader, up_writer, None if chunked else length))
                head = await asyncio.wait_for(up_reader.readuntil(_upstream.HEAD_END), RESPONSE_HEAD_TIMEOUT)
                status = head[9:12]
                if status == b"407" and proxy is not None and proxy["protocol"] != "socks5":
                    # An HTTP proxy's answer to its own credentials, in band: its failure, moved on from while nothing was sent back.
                    attempts.append({**self.plan.label(proxy["id"]), "code": "proxy_auth_failed"})  # type: ignore[union-attr]
                    if explicit or length or chunked:
                        raise self._failed(host, "proxy_auth_failed", attempts)
                    self._state_changed(selection.record_failure(host, proxy["id"], self.state))
                    continue
                while status[:1] == b"1" and status != b"101":
                    writer.write(head)
                    await writer.drain()
                    head = await asyncio.wait_for(up_reader.readuntil(_upstream.HEAD_END), RESPONSE_HEAD_TIMEOUT)
                    status = head[9:12]
                writer.write(_closing_head(head))
                await writer.drain()
                await _pipe(up_reader, writer)
                return
            finally:
                if sending is not None:
                    sending.cancel()
                self.tunnels.discard(tunnel)
                _abort(up_writer)

    # Control ---------------------------------------------------------------------------------------------------

    def control(self, op: str, args: Mapping[str, Any]) -> Dict[str, Any]:
        self.refresh_plan()
        if op == "ping":
            return {"port": self.port, "pid": os.getpid()}
        host = args.get("host")
        if not isinstance(host, str) or not host or len(host) > selection.RAW_MAX_LENGTH:
            raise Refusal(400, "proxy_request_invalid")
        if op == "route":
            return self._route(host, args.get("choice"))
        if op == "peek":
            return self._peek(host)
        if op == "outcome":
            return {"outcome": self.outcomes.get(site_of(host)), "toTry": self._to_try(host)}
        raise Refusal(400, "proxy_request_invalid")

    def _labelled(self, decision: Dict[str, Any]) -> Dict[str, Any]:
        if decision["kind"] == "proxy" and self.plan:
            return {**decision, **self.plan.label(decision["proxyId"])}
        return decision

    def _to_try(self, host: str) -> List[Dict[str, Any]]:
        if not self.plan:
            return []
        return [self.plan.label(proxy_id) for proxy_id in selection.proxies_to_try(self.plan.proxies, host)
                if self.plan.by_id[proxy_id]["available"]]

    def _peek(self, host: str) -> Dict[str, Any]:
        site = site_of(host)
        decision = self._select(host, self.routes.get(site), apply=False)
        return {"decision": self._labelled(decision), "outcome": self.outcomes.get(site), "toTry": self._to_try(host), "site": site}

    def _route(self, host: str, choice: Any) -> Dict[str, Any]:
        """An explicit choice for the site, or none to follow hints again. A refused choice changes nothing."""
        site = site_of(host)
        if choice is not None and not (isinstance(choice, dict) and (
                choice.get("kind") == "direct" or (choice.get("kind") == "proxy" and isinstance(choice.get("ref"), str)))):
            raise Refusal(400, "proxy_request_invalid")
        decision = self._select(host, choice, apply=False)
        if choice is not None and decision["kind"] == "failed":
            return {"decision": decision, "site": site, "moved": False}
        before = self.routes.get(site)
        if choice is None:
            self.routes.pop(site, None)
        else:
            self.routes[site] = {"kind": choice["kind"], **({"ref": choice["ref"]} if choice["kind"] == "proxy" else {})}
        moved = before != self.routes.get(site)
        if moved:
            # Chromium pools sockets per host, so an open tunnel would keep the old exit.
            target = decision.get("proxyId") if decision["kind"] == "proxy" else None
            for tunnel in list(self.tunnels):
                if tunnel.site == site and not tunnel.pinned and tunnel.proxy_id != target:
                    tunnel.close()
            self.outcomes.pop(site, None)
        return {"decision": self._labelled(decision), "site": site, "moved": moved}

    async def serve_control(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            raw = await asyncio.wait_for(reader.readline(), HEAD_TIMEOUT)
            request = json.loads(raw.decode("utf-8"))
            if not isinstance(request, dict) or not isinstance(request.get("op"), str) or not isinstance(request.get("args", {}), dict):
                raise Refusal(400, "proxy_request_invalid")
            response: Dict[str, Any] = {"ok": True, "result": self.control(request["op"], request.get("args", {}))}
        except Refusal as refusal:
            response = {"ok": False, "code": refusal.code}
        except (OSError, ValueError, asyncio.TimeoutError, asyncio.LimitOverrunError):
            response = {"ok": False, "code": "proxy_request_invalid"}
        try:
            writer.write(json.dumps(response, ensure_ascii=False).encode("utf-8") + b"\n")
            await writer.drain()
        except (OSError, RuntimeError):
            pass
        finally:
            writer.close()


def _closing_head(head: bytes) -> bytes:
    """The response head with `Connection: close`: Chromium reuses a proxy connection for any host otherwise."""
    lines = head[:-len(_upstream.HEAD_END)].split(b"\r\n")
    kept = [line for line in lines[1:] if line.split(b":", 1)[0].strip().lower().decode("latin-1") not in _RESPONSE_HOP_HEADERS]
    return b"\r\n".join([lines[0], *kept, b"Connection: close"]) + _upstream.HEAD_END


async def run(forwarder: Forwarder, run_dir: Path) -> None:
    run_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    port_path = run_dir / "port"
    socket_path = run_dir / "control.sock"
    forwarder.refresh_plan()
    server = None
    # A restart keeps the port Chromium was started with, when it can.
    try:
        previous = int(port_path.read_text("ascii").strip())
    except (OSError, ValueError):
        previous = 0
    for port in ([previous, 0] if previous else [0]):
        try:
            server = await asyncio.start_server(forwarder.serve, HOST, port, limit=_upstream.STREAM_LIMIT, reuse_address=True)
            break
        except OSError:
            continue
    if server is None:
        raise OSError("proxy_listen_failed")
    forwarder.port = server.sockets[0].getsockname()[1]
    port_path.write_text(str(forwarder.port), "ascii")
    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass
    control = await asyncio.start_unix_server(forwarder.serve_control, path=str(socket_path), limit=CONTROL_MAX_BYTES)
    os.chmod(socket_path, 0o600)
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        loop.add_signal_handler(signum, stopped.set)
    await stopped.wait()
    forwarder.flush()
    server.close()
    control.close()
    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass


async def _test_resolver(host: str, port: int) -> List[str]:
    """Under a test root, the reserved `.test` zone is this machine, so a test can open a site directly without a network."""
    return ["127.0.0.1"] if host.endswith(".test") else await _upstream.system_resolver(host, port)


def main(argv: Optional[List[str]] = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    network = None
    if len(args) == 2 and args[0] == _paths.TEST_ROOT_FLAG:
        _paths.use_test_root(args[1])
        network = _upstream.Network(allow_local=True, resolver=_test_resolver)
    elif args:
        sys.exit(2)
    # Asyncio's default handlers print exception text; this process prints nothing but the type of a fatal error.
    logging.disable(logging.CRITICAL)
    forwarder = Forwarder(_paths.proxy_plan_path(), _paths.proxy_state_path(), network)
    try:
        asyncio.run(run(forwarder, _paths.proxy_run_dir()))
    except Exception as error:  # noqa: BLE001 - the client reports the forwarder as unavailable
        sys.stderr.write(type(error).__name__ + "\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
