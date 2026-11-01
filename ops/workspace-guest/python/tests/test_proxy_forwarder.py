"""The forwarder against local fake proxies and a local fake site: real sockets, nothing beyond loopback.

Run: python3 -m unittest discover -s ops/workspace-guest/python/tests -p 'test_proxy_*.py'
"""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa.browser import _paths  # noqa: E402
from aiqsa.proxy import _forwarder, _plan, _upstream, address, client  # noqa: E402

PASSWORD = "synthetic-pass-1f3a"
SAFE_FETCH = Path(__file__).resolve().parents[4] / "lib" / "server" / "mcp" / "safeFetch.ts"


class Background:
    """An event loop on a thread, so the tests below can use plain blocking sockets."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

    def run(self, coroutine: Any) -> Any:
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(20)

    def call(self, function: Callable[[], Any]) -> Any:
        async def inner() -> Any:
            return function()
        return self.run(inner())

    def stop(self) -> None:
        async def cancel_the_rest() -> None:
            others = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
            for task in others:
                task.cancel()
            await asyncio.gather(*others, return_exceptions=True)

        self.run(cancel_the_rest())
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self.loop.close()


class Site:
    """A plain HTTP site that says which request it saw and keeps its connection open, as many do."""

    def __init__(self) -> None:
        self.connections = 0
        self.lines: List[str] = []
        self.heads: List[bytes] = []
        self.port = 0

    async def start(self) -> "Site":
        server = await asyncio.start_server(self.serve, "127.0.0.1", 0)
        self.server = server
        self.port = server.sockets[0].getsockname()[1]
        return self

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.connections += 1
        try:
            while True:
                head = await reader.readuntil(b"\r\n\r\n")
                self.heads.append(head)
                line = head.split(b"\r\n", 1)[0].decode("latin-1")
                self.lines.append(line)
                body = f"site saw {line}".encode()
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\n%s" % (len(body), body))
                await writer.drain()
        except (asyncio.IncompleteReadError, OSError):
            pass
        finally:
            writer.close()


class FakeProxy:
    """HTTP CONNECT (optionally over TLS) or SOCKS5 with a login, every tunnel ending at the fake site."""

    def __init__(self, kind: str, site: Site, login: Optional[str] = "user", password: Optional[str] = PASSWORD,
                 tls: Optional[ssl.SSLContext] = None, refuse: bool = False):
        self.kind, self.site, self.login, self.password, self.tls, self.refuse = kind, site, login, password, tls, refuse
        self.targets: List[str] = []
        self.auth: List[Optional[str]] = []
        self.heads: List[bytes] = []
        self.writers: List[asyncio.StreamWriter] = []
        self.port = 0

    async def start(self) -> "FakeProxy":
        self.server = await asyncio.start_server(self.serve_socks if self.kind == "socks5" else self.serve_http, "127.0.0.1", 0, ssl=self.tls)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def tunnel(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        up_reader, up_writer = await asyncio.open_connection("127.0.0.1", self.site.port)
        self.writers.append(writer)

        async def pipe(source: asyncio.StreamReader, sink: asyncio.StreamWriter) -> None:
            try:
                while True:
                    data = await source.read(65536)
                    if not data:
                        break
                    sink.write(data)
                    await sink.drain()
            except OSError:
                pass
            finally:
                sink.close()

        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))

    async def serve_http(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await reader.readuntil(b"\r\n\r\n")
        except (asyncio.IncompleteReadError, OSError, ssl.SSLError):
            writer.close()
            return
        self.heads.append(head)
        lines = head.decode("latin-1").split("\r\n")
        method, target, _ = lines[0].split(" ")
        supplied = next((line.split(": ", 1)[1] for line in lines if line.lower().startswith("proxy-authorization:")), None)
        self.auth.append(supplied)
        self.targets.append(target)
        expected = None if self.login is None else "Basic " + base64.b64encode(f"{self.login}:{self.password}".encode()).decode()
        if expected is not None and supplied != expected:
            writer.write(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        if self.refuse:
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        if method == "CONNECT":
            writer.write(b"HTTP/1.1 200 OK\r\n\r\n")
            await writer.drain()
            await self.tunnel(reader, writer)
            return
        # An absolute-form request: answer it as the site would, and say it went through here.
        body = f"proxy forwarded {lines[0]}".encode()
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s" % (len(body), body))
        await writer.drain()
        writer.close()

    async def serve_socks(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            _, count = await reader.readexactly(2)
            methods = await reader.readexactly(count)
            if self.login is not None:
                if 2 not in methods:
                    writer.write(b"\x05\xff")
                    await writer.drain()
                    writer.close()
                    return
                writer.write(b"\x05\x02")
                await writer.drain()
                _, size = await reader.readexactly(2)
                name = await reader.readexactly(size)
                size = (await reader.readexactly(1))[0]
                secret = await reader.readexactly(size)
                self.auth.append(f"{name.decode()}:{secret.decode()}")
                if name.decode() != self.login or secret.decode() != self.password:
                    writer.write(b"\x01\x01")
                    await writer.drain()
                    writer.close()
                    return
                writer.write(b"\x01\x00")
            else:
                writer.write(b"\x05\x00")
            await writer.drain()
            _, _, _, kind = await reader.readexactly(4)
            if kind == 3:
                host = (await reader.readexactly((await reader.readexactly(1))[0])).decode()
            elif kind == 1:
                host = socket.inet_ntoa(await reader.readexactly(4))
            else:
                host = socket.inet_ntop(socket.AF_INET6, await reader.readexactly(16))
            port = int.from_bytes(await reader.readexactly(2), "big")
            self.targets.append(f"{host}:{port}")
            if self.refuse:
                writer.write(b"\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00")
                await writer.drain()
                writer.close()
                return
            writer.write(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()
        except (asyncio.IncompleteReadError, OSError):
            writer.close()
            return
        await self.tunnel(reader, writer)


def entry(identifier: str, proxy: Optional[FakeProxy] = None, *, port: Optional[int] = None, hints: Tuple[str, ...] = (), protocol: Optional[str] = None,
          login: Optional[str] = "user", password: Optional[str] = PASSWORD, host: str = "127.0.0.1", **overrides: Any) -> Dict[str, Any]:
    kind = protocol or (proxy.kind if proxy else "http")
    return {"active": True, "available": True, "country": None, "domainHints": list(hints), "host": host, "id": identifier,
            "login": login, "name": identifier.upper(), "owner": "personal", "password": password,
            "port": port or (proxy.port if proxy else 9), "protocol": kind, **overrides}


def dead_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Harness(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp(prefix="aiqsa-proxy-"))
        self.addCleanup(shutil.rmtree, self.directory, True)
        self.plan_path = self.directory / "plan.json"
        self.state_path = self.directory / "rotation.json"
        self.background = Background()
        self.addCleanup(self.background.stop)
        self.site = self.background.run(Site().start())
        self.addCleanup(self.background.call, self.site.server.close)
        self.resolved: Dict[str, List[str]] = {}

    def fake(self, kind: str, **options: Any) -> FakeProxy:
        proxy = self.background.run(FakeProxy(kind, self.site, **options).start())
        self.addCleanup(self.background.call, proxy.server.close)
        return proxy

    def write_plan(self, *entries: Dict[str, Any]) -> None:
        temporary = self.plan_path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"version": 1, "proxies": list(entries)}), "utf-8")
        os.replace(temporary, self.plan_path)

    def forwarder(self, *, real_policy: bool = False, tls: Optional[ssl.SSLContext] = None) -> Tuple[_forwarder.Forwarder, int]:
        async def resolver(host: str, port: int) -> List[str]:
            if host not in self.resolved and not real_policy:
                return ["127.0.0.1"]
            if host not in self.resolved:
                raise socket.gaierror("no such name")
            return self.resolved[host]

        network = _upstream.Network(resolver=resolver, allow_local=not real_policy, tls=tls)

        async def start() -> Tuple[_forwarder.Forwarder, int]:
            instance = _forwarder.Forwarder(self.plan_path, self.state_path, network)
            server = await asyncio.start_server(instance.serve, "127.0.0.1", 0, limit=_upstream.STREAM_LIMIT)
            self.addCleanup(self.background.call, server.close)
            instance.port = server.sockets[0].getsockname()[1]
            return instance, instance.port

        return self.background.run(start())

    def connect(self, port: int, target: str, *, route: Optional[str] = None) -> Tuple[socket.socket, int, bytes]:
        """A CONNECT through the forwarder: its socket, the status, and the head."""
        client_socket = socket.create_connection(("127.0.0.1", port), timeout=30)
        self.addCleanup(client_socket.close)
        lines = [f"CONNECT {target} HTTP/1.1", f"Host: {target}"]
        if route:
            lines.append("Proxy-Authorization: Basic " + base64.b64encode(f"{route}:x".encode()).decode())
        client_socket.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = client_socket.recv(65536)
            if not chunk:
                break
            head += chunk
        status = int(head.split(b" ", 2)[1]) if head else 0
        return client_socket, status, head

    def through(self, port: int, host: str, *, route: Optional[str] = None) -> str:
        """A request inside a tunnel to the fake site, as a browser would after CONNECT; the site's answer."""
        tunnel, status, head = self.connect(port, f"{host}:{self.site.port}", route=route)
        self.assertEqual(status, 200, head)
        tunnel.sendall(f"GET /path HTTP/1.1\r\nHost: {host}\r\n\r\n".encode())
        return tunnel.recv(65536).decode()

    def plain(self, port: int, url: str, extra: str = "") -> Tuple[int, bytes, socket.socket]:
        """An absolute-form request; reads until the response's own length is in, as a client told `close` does."""
        client_socket = socket.create_connection(("127.0.0.1", port), timeout=30)
        self.addCleanup(client_socket.close)
        host = url.split("/")[2]
        client_socket.sendall(f"GET {url} HTTP/1.1\r\nHost: {host}\r\nProxy-Connection: keep-alive\r\n{extra}\r\n".encode())
        data = b""
        while True:
            chunk = client_socket.recv(65536)
            if not chunk:
                break
            data += chunk
            head, separator, body = data.partition(b"\r\n\r\n")
            length = re.search(rb"content-length: (\d+)", head.lower())
            if separator and length and len(body) >= int(length.group(1)):
                break
        return int(data.split(b" ", 2)[1]), data, client_socket


class SelectionThroughProxies(Harness):
    def test_http_connect_adds_its_credentials_and_opens_the_hinted_site(self) -> None:
        upstream = self.fake("http")
        self.write_plan(entry("kz", upstream, hints=(".kz",)))
        instance, port = self.forwarder()
        answer = self.through(port, "shop.kz")
        self.assertIn("site saw GET /path", answer)
        self.assertEqual(upstream.targets, [f"shop.kz:{self.site.port}"])
        self.assertEqual(upstream.auth[0], "Basic " + base64.b64encode(f"user:{PASSWORD}".encode()).decode())
        outcome = self.background.call(lambda: instance.control("outcome", {"host": "shop.kz"}))["outcome"]
        self.assertEqual((outcome["kind"], outcome["id"], outcome["reason"], outcome["hint"]), ("proxy", "kz", "hint", ".kz"))

    def test_socks5_with_user_and_password_lets_the_proxy_resolve_the_name(self) -> None:
        upstream = self.fake("socks5")
        self.write_plan(entry("kz", upstream, hints=(".kz",)))
        _, port = self.forwarder()
        self.assertIn("site saw", self.through(port, "shop.kz"))
        self.assertEqual(upstream.targets, [f"shop.kz:{self.site.port}"])
        self.assertEqual(upstream.auth, [f"user:{PASSWORD}"])

    def test_socks5_and_http_without_a_login(self) -> None:
        socks = self.fake("socks5", login=None)
        http = self.fake("http", login=None)
        self.write_plan(entry("a", socks, hints=("a.example",), login=None, password=None), entry("b", http, hints=("b.example",), login=None, password=None))
        _, port = self.forwarder()
        self.assertIn("site saw", self.through(port, "a.example"))
        self.assertIn("site saw", self.through(port, "b.example"))
        self.assertEqual(http.auth, [None])

    def test_a_site_nothing_applies_to_connects_directly(self) -> None:
        upstream = self.fake("http")
        self.write_plan(entry("kz", upstream, hints=(".kz",)))
        instance, port = self.forwarder()
        self.assertIn("site saw", self.through(port, "other.example"))
        self.assertEqual(upstream.targets, [])
        outcome = self.background.call(lambda: instance.control("outcome", {"host": "other.example"}))["outcome"]
        self.assertEqual((outcome["kind"], outcome["reason"]), ("direct", "no_match"))

    def test_two_proxies_alternate_between_sites_and_stay_put_within_one(self) -> None:
        first, second = self.fake("http"), self.fake("http")
        self.write_plan(entry("one", first, hints=(".kz",)), entry("two", second, hints=(".kz",)))
        _, port = self.forwarder()
        for host in ("a.kz", "www.a.kz", "b.kz", "c.kz", "cdn.b.kz"):
            self.through(port, host)
        self.assertEqual([target.split(":")[0] for target in first.targets], ["a.kz", "www.a.kz", "c.kz"])
        self.assertEqual([target.split(":")[0] for target in second.targets], ["b.kz", "cdn.b.kz"])

    def test_a_dead_proxy_moves_on_and_the_site_stays_on_the_next(self) -> None:
        working = self.fake("socks5")
        self.write_plan(entry("dead", port=dead_port(), hints=(".kz",)), entry("good", working, hints=(".kz",)))
        instance, port = self.forwarder()
        self.assertIn("site saw", self.through(port, "shop.kz"))
        self.assertIn("site saw", self.through(port, "www.shop.kz"))
        self.assertEqual(len(working.targets), 2)
        outcome = self.background.call(lambda: instance.control("outcome", {"host": "shop.kz"}))["outcome"]
        self.assertEqual(outcome["id"], "good")

    def test_a_proxy_refusing_the_tunnel_or_the_login_moves_on(self) -> None:
        refusing, wrong, socks_wrong, good = self.fake("http", refuse=True), self.fake("http"), self.fake("socks5"), self.fake("http")
        self.write_plan(entry("refusing", refusing, hints=(".kz",)), entry("wrong", wrong, hints=(".kz",), password="other"),
                        entry("socks", socks_wrong, hints=(".kz",), password="other"), entry("good", good, hints=(".kz",)))
        instance, port = self.forwarder()
        self.assertIn("site saw", self.through(port, "shop.kz"))
        self.assertEqual(len(good.targets), 1)
        moved = self.background.call(lambda: instance.control("outcome", {"host": "shop.kz"}))["outcome"]["movedFrom"]
        self.assertEqual([(step["id"], step["code"]) for step in moved],
                         [("refusing", "proxy_connect_failed"), ("wrong", "proxy_auth_failed"), ("socks", "proxy_auth_failed")])

    def test_none_left_fails_visibly_and_nothing_goes_direct(self) -> None:
        self.write_plan(entry("one", port=dead_port(), hints=(".kz",)), entry("two", port=dead_port(), hints=(".kz",), protocol="socks5"))
        instance, port = self.forwarder()
        _, status, head = self.connect(port, f"shop.kz:{self.site.port}")
        self.assertEqual(status, 502)
        self.assertIn(b"X-Aiqsa-Proxy-Code: proxy_all_failed", head)
        self.assertEqual(self.site.connections, 0)
        outcome = self.background.call(lambda: instance.control("outcome", {"host": "shop.kz"}))["outcome"]
        self.assertEqual((outcome["kind"], outcome["code"]), ("failed", "proxy_all_failed"))
        self.assertEqual({step["code"] for step in outcome["attempts"]}, {"proxy_connect_failed"})
        # The site's next request tries again, so a repaired proxy recovers without a new run.
        _, status, _ = self.connect(port, f"shop.kz:{self.site.port}")
        self.assertEqual(status, 502)
        self.assertEqual(self.site.connections, 0)

    def test_a_proxy_that_cannot_be_loaded_counts_as_failed_and_never_opens_the_way_direct(self) -> None:
        self.write_plan(entry("gone", hints=(".kz",), available=False, login=None, password=None))
        instance, port = self.forwarder()
        _, status, head = self.connect(port, f"shop.kz:{self.site.port}")
        self.assertEqual(status, 502)
        self.assertIn(b"proxy_all_failed", head)
        self.assertEqual(self.site.connections, 0)
        outcome = self.background.call(lambda: instance.control("outcome", {"host": "shop.kz"}))["outcome"]
        self.assertEqual(outcome["attempts"][0]["code"], "proxy_unavailable")
        self.assertIn("site saw", self.through(port, "other.example"))

    def test_a_tls_proxy_is_verified(self) -> None:
        if shutil.which("openssl") is None:
            self.skipTest("no openssl to make a certificate")
        certificate, key = self.directory / "cert.pem", self.directory / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(certificate),
                        "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], check=True, capture_output=True)
        server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server.load_cert_chain(certificate, key)
        upstream = self.fake("https", tls=server)
        self.write_plan(entry("tls", upstream, hints=(".kz",)))
        trusted = ssl.create_default_context(cafile=str(certificate))
        _, port = self.forwarder(tls=trusted)
        self.assertIn("site saw", self.through(port, "shop.kz"))
        self.assertEqual(upstream.auth[0], "Basic " + base64.b64encode(f"user:{PASSWORD}".encode()).decode())
        # A certificate nobody vouches for gets no password.
        before = len(upstream.auth)
        instance, port = self.forwarder(tls=ssl.create_default_context())
        _, status, _ = self.connect(port, f"other.kz:{self.site.port}")
        self.assertEqual(status, 502)
        self.assertEqual(self.background.call(lambda: instance.control("outcome", {"host": "other.kz"}))["outcome"]["attempts"][0]["code"], "proxy_tls_failed")
        self.assertEqual(len(upstream.auth), before)


class Choices(Harness):
    def test_a_named_proxy_opens_any_site_and_a_route_holds_for_the_site(self) -> None:
        kz, other = self.fake("http"), self.fake("http")
        self.write_plan(entry("kz", kz, hints=(".kz",)), entry("other", other, hints=(".es",)))
        instance, port = self.forwarder()
        result = self.background.call(lambda: instance.control("route", {"host": "shop.example", "choice": {"kind": "proxy", "ref": "KZ"}}))
        self.assertEqual((result["decision"]["id"], result["moved"]), ("kz", True))
        self.through(port, "shop.example")
        self.through(port, "cdn.shop.example")
        self.assertEqual([target.split(":")[0] for target in kz.targets], ["shop.example", "cdn.shop.example"])

    def test_direct_beats_a_hint_until_hints_are_followed_again(self) -> None:
        kz = self.fake("http")
        self.write_plan(entry("kz", kz, hints=(".kz",)))
        instance, port = self.forwarder()
        self.background.call(lambda: instance.control("route", {"host": "shop.kz", "choice": {"kind": "direct"}}))
        self.through(port, "shop.kz")
        self.assertEqual(kz.targets, [])
        self.background.call(lambda: instance.control("route", {"host": "shop.kz", "choice": None}))
        self.through(port, "shop.kz")
        self.assertEqual(len(kz.targets), 1)

    def test_a_choice_that_cannot_be_used_changes_nothing(self) -> None:
        self.write_plan(entry("off", hints=(".kz",), active=False))
        instance, _ = self.forwarder()
        for ref, code in (("nobody", "proxy_not_found"), ("OFF", "proxy_inactive")):
            result = self.background.call(lambda ref=ref: instance.control("route", {"host": "shop.kz", "choice": {"kind": "proxy", "ref": ref}}))
            self.assertEqual((result["decision"]["code"], result["moved"]), (code, False))
        self.assertEqual(instance.routes, {})

    def test_a_named_proxy_that_fails_is_reported_and_not_moved_on_from(self) -> None:
        good = self.fake("http")
        self.write_plan(entry("dead", port=dead_port()), entry("good", good, hints=(".kz",)))
        instance, port = self.forwarder()
        self.background.call(lambda: instance.control("route", {"host": "shop.kz", "choice": {"kind": "proxy", "ref": "dead"}}))
        _, status, head = self.connect(port, f"shop.kz:{self.site.port}")
        self.assertEqual(status, 502)
        self.assertIn(b"X-Aiqsa-Proxy-Code: proxy_connect_failed", head)
        self.assertEqual((good.targets, self.site.connections), ([], 0))

    def test_changing_a_sites_route_closes_its_tunnels_so_pooled_sockets_cannot_keep_the_old_exit(self) -> None:
        first, second = self.fake("http"), self.fake("http")
        self.write_plan(entry("one", first), entry("two", second))
        instance, port = self.forwarder()
        self.background.call(lambda: instance.control("route", {"host": "shop.example", "choice": {"kind": "proxy", "ref": "one"}}))
        tunnel, status, _ = self.connect(port, f"shop.example:{self.site.port}")
        self.assertEqual(status, 200)
        unrelated, _, _ = self.connect(port, f"other.example:{self.site.port}")
        result = self.background.call(lambda: instance.control("route", {"host": "www.shop.example", "choice": {"kind": "proxy", "ref": "two"}}))
        self.assertTrue(result["moved"])
        tunnel.settimeout(5)
        try:
            self.assertEqual(tunnel.recv(16), b"")
        except ConnectionResetError:
            pass
        unrelated.sendall(b"GET /still HTTP/1.1\r\nHost: other.example\r\n\r\n")
        self.assertIn(b"site saw GET /still", unrelated.recv(65536))
        self.through(port, "shop.example")
        self.assertEqual(len(second.targets), 1)

    def test_a_commands_choice_travels_per_connection_and_never_upstream(self) -> None:
        kz, other = self.fake("http"), self.fake("http")
        self.write_plan(entry("kz", kz, hints=(".kz",)), entry("other", other))
        instance, port = self.forwarder()
        self.through(port, "shop.kz", route="other")
        self.assertEqual((len(other.targets), kz.targets), (1, []))
        self.assertEqual(other.auth[0], "Basic " + base64.b64encode(f"user:{PASSWORD}".encode()).decode())
        self.through(port, "shop.kz", route="direct")
        self.assertEqual((len(other.targets), kz.targets), (1, []))
        self.assertEqual(instance.routes, {})
        self.through(port, "shop.kz")
        self.assertEqual(len(kz.targets), 1)

    def test_peek_says_what_would_happen_and_what_to_try_without_moving_anything(self) -> None:
        kz, es = self.fake("http"), self.fake("http")
        self.write_plan(entry("kz", kz, hints=(".kz",), country="KZ"), entry("es", es, hints=(".es",)), entry("off", active=False), entry("gone", available=False))
        instance, _ = self.forwarder()
        before = instance.state
        peek = self.background.call(lambda: instance.control("peek", {"host": "shop.kz"}))
        self.assertEqual((peek["decision"]["id"], peek["decision"]["country"]), ("kz", "KZ"))
        self.assertEqual([proxy["id"] for proxy in peek["toTry"]], ["kz", "es"])
        self.assertEqual(instance.state["sites"], before["sites"])
        self.assertNotIn(PASSWORD, json.dumps(peek))


class Plain(Harness):
    def test_through_an_http_proxy_in_absolute_form_with_its_credentials(self) -> None:
        upstream = self.fake("http")
        self.write_plan(entry("kz", upstream, hints=(".kz",)))
        _, port = self.forwarder()
        status, data, _ = self.plain(port, "http://shop.kz/a?b=1")
        self.assertEqual(status, 200)
        self.assertIn(b"proxy forwarded GET http://shop.kz:80/a?b=1 HTTP/1.1", data)
        self.assertIn(b"Connection: close", data)
        self.assertEqual(upstream.auth[0], "Basic " + base64.b64encode(f"user:{PASSWORD}".encode()).decode())

    def test_through_socks5_and_direct_in_origin_form_and_the_connection_ends_with_the_response(self) -> None:
        socks = self.fake("socks5")
        self.write_plan(entry("kz", socks, hints=(".kz",)))
        _, port = self.forwarder()
        for host in ("shop.kz", "other.example"):
            status, data, _ = self.plain(port, f"http://{host}:{self.site.port}/page")
            self.assertEqual(status, 200)
            self.assertIn(b"site saw GET /page HTTP/1.1", data)
            self.assertIn(b"Connection: close", data)
            self.assertNotIn(b"keep-alive", data.lower())
        self.assertEqual(len(socks.targets), 1)
        self.assertNotIn(b"proxy-connection", self.site.heads[0].lower())

    def test_a_proxys_own_407_for_a_plain_request_moves_on_without_reaching_the_client(self) -> None:
        wrong, good = self.fake("http"), self.fake("http")
        self.write_plan(entry("wrong", wrong, hints=(".kz",), password="other"), entry("good", good, hints=(".kz",)))
        _, port = self.forwarder()
        status, data, _ = self.plain(port, "http://shop.kz/")
        self.assertEqual(status, 200)
        self.assertIn(b"proxy forwarded", data)

    def test_all_failed_answers_plainly_with_the_code_and_nothing_direct(self) -> None:
        self.write_plan(entry("dead", port=dead_port(), hints=(".kz",)))
        _, port = self.forwarder()
        status, data, _ = self.plain(port, f"http://shop.kz:{self.site.port}/")
        self.assertEqual(status, 502)
        self.assertIn(b"X-Aiqsa-Proxy-Code: proxy_all_failed", data)
        self.assertIn(b"Nothing was sent directly", data)
        self.assertEqual(self.site.connections, 0)

    def test_requests_this_port_does_not_serve_are_refused_before_their_body(self) -> None:
        upstream = self.fake("http")
        self.write_plan(entry("kz", upstream, hints=(".kz",)))
        _, port = self.forwarder()
        for head in (b"POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 40\r\n\r\nCONNECT shop.kz:443 HTTP/1.1\r\n\r\n",
                     b"GET https://shop.kz/ HTTP/1.1\r\nHost: shop.kz\r\n\r\n",
                     b"GET http://user:pw@shop.kz/ HTTP/1.1\r\nHost: shop.kz\r\n\r\n",
                     b"GET http://shop.kz/ HTTP/1.1\r\nHost: shop.kz\r\nX-Evil: a\rb\r\n\r\n",
                     b"CONNECT sh\xc3\xb6p.kz:443 HTTP/1.1\r\n\r\n",
                     b"CONNECT .:443 HTTP/1.1\r\n\r\n"):
            with self.subTest(head[:30]):
                connection = socket.create_connection(("127.0.0.1", port), timeout=10)
                self.addCleanup(connection.close)
                connection.sendall(head)
                self.assertIn(b" 400 ", connection.recv(65536).split(b"\r\n", 1)[0])
        self.assertEqual(upstream.targets, [])


class AddressRule(Harness):
    def test_the_same_targets_the_server_refuses(self) -> None:
        # `isRefusedProxyTarget`'s cases in `lib/server/proxies/address.test.ts`, spelled the ways a raw client can.
        for host in ("localhost", "LOCALHOST", "shop.localhost", "localhost.", "127.0.0.1", "127.1", "2130706433", "0x7f.1", "0177.0.0.1",
                     "0x7f000001", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
                     "[::1]", "::1", "[::]", "[fc00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[::ffff:10.0.0.1]", "[64:ff9b::7f00:1]",
                     "[2001:db8::1]", "1.2.3.4.5", "256.1.1.1", "0x", "1..2",
                     "１２７.０.０.１"):
            with self.subTest(host):
                self.assertTrue(address.is_refused_target(host))
        for host in ("ozon.ru", "shop.example", "93.184.216.34", "1555808802", "[2606:2800:21f:cb07:6820:80da:af6b:8b2c]", "[::ffff:93.184.216.34]",
                     "1.example", "my_shop.kz", "1.256", "0xzz"):
            with self.subTest(host):
                self.assertFalse(address.is_refused_target(host))

    @unittest.skipUnless(SAFE_FETCH.exists(), "needs the repository")
    def test_the_lists_equal_the_servers(self) -> None:
        source = SAFE_FETCH.read_text("utf-8")
        block = lambda name, make: re.findall(make + r'\("([^"]+)", (\d+)\)', source[source.index(f"const {name}"):source.index("];", source.index(f"const {name}"))])  # noqa: E731
        self.assertEqual([str(cidr) for cidr in address.BLOCKED_IPV4], [f"{net}/{bits}" for net, bits in block("BLOCKED_IPV4_CIDRS", "ipv4Cidr")])
        self.assertEqual([str(cidr) for cidr in address.BLOCKED_IPV6], [f"{net}/{bits}" for net, bits in block("BLOCKED_IPV6_CIDRS", "ipv6Cidr")])

    def test_a_private_target_is_refused_on_both_paths_before_anything_is_sent(self) -> None:
        upstream = self.fake("http")
        self.write_plan(entry("any", upstream, host="93.184.216.34", hints=(".kz",)))
        instance, port = self.forwarder(real_policy=True)
        for target in ("127.0.0.1:80", "2130706433:80", "[::1]:80", "10.0.0.1:443", "localhost:80", "shop.localhost:80"):
            for route in (None, "any", "direct"):
                with self.subTest(target=target, route=route):
                    _, status, head = self.connect(port, target, route=route)
                    self.assertEqual(status, 403)
                    self.assertIn(b"X-Aiqsa-Proxy-Code: proxy_target_refused", head)
        self.assertEqual(upstream.targets, [])

    def test_a_name_that_answers_with_a_private_address_is_refused_on_the_direct_path(self) -> None:
        # Web content can rebind a name to the VM's loopback; the VM's egress policy does not cover loopback.
        self.write_plan(entry("kz", host="93.184.216.34", hints=(".kz",)))
        self.resolved.update({"rebind.example": ["127.0.0.1"], "mixed.example": ["93.184.216.34", "10.0.0.1"], "metadata.example": ["169.254.169.254"]})
        instance, port = self.forwarder(real_policy=True)
        for name in ("rebind.example", "mixed.example", "metadata.example"):
            with self.subTest(name):
                _, status, head = self.connect(port, f"{name}:{self.site.port}")
                self.assertEqual(status, 403)
                self.assertIn(b"proxy_target_refused", head)
        self.assertEqual(self.site.connections, 0)
        _, status, head = self.connect(port, f"nowhere.example:{self.site.port}")
        self.assertEqual(status, 502)
        self.assertIn(b"site_dns_failed", head)

    def test_a_proxys_own_address_is_checked_again_and_moved_on_from(self) -> None:
        upstream = self.fake("http")
        self.resolved["private-proxy.example"] = ["10.1.2.3"]
        self.write_plan(entry("literal", upstream, hints=(".kz",)), entry("name", upstream, host="private-proxy.example", hints=(".kz",)),
                        entry("local", upstream, host="localhost", hints=(".kz",)), entry("unknown", upstream, host="nowhere.example", hints=(".kz",)))
        instance, port = self.forwarder(real_policy=True)
        _, status, _ = self.connect(port, f"shop.kz:{self.site.port}")
        self.assertEqual(status, 502)
        attempts = self.background.call(lambda: instance.control("outcome", {"host": "shop.kz"}))["outcome"]["attempts"]
        self.assertEqual([attempt["code"] for attempt in attempts], ["proxy_address_forbidden", "proxy_address_forbidden", "proxy_address_forbidden", "proxy_dns_failed"])
        self.assertEqual((upstream.targets, self.site.connections), ([], 0))


class PlanChanges(Harness):
    def test_a_later_runs_plan_keeps_where_sites_stay_and_gives_failed_proxies_a_fresh_chance(self) -> None:
        first, second = self.fake("http"), self.fake("http")
        dead = dead_port()
        self.write_plan(entry("one", first, hints=(".kz",)), entry("two", second, hints=(".kz",)), entry("three", port=dead, hints=(".ru",)))
        instance, port = self.forwarder()
        self.through(port, "a.kz")
        self.through(port, "b.kz")
        _, status, _ = self.connect(port, f"shop.ru:{self.site.port}")
        self.assertEqual(status, 502)
        self.background.call(lambda: instance.control("route", {"host": "c.example", "choice": {"kind": "direct"}}))
        revived = self.fake("http")
        # The next run: one password replaced, one proxy gone from .ru's dead port to a live one.
        self.write_plan(entry("one", first, hints=(".kz",)), entry("two", second, hints=(".kz",)), entry("three", revived, hints=(".ru",)))
        self.through(port, "www.b.kz")
        self.assertEqual(second.targets[-1].split(":")[0], "www.b.kz")
        self.through(port, "shop.ru")
        self.assertEqual(len(revived.targets), 1)
        self.assertEqual(instance.routes, {})

    def test_the_same_plan_installed_again_changes_nothing(self) -> None:
        # A sub-agent's run installs its plan mid-turn: an agent's choice and what failed stay.
        kz = self.fake("http")
        dead = dead_port()
        plan = (entry("kz", kz, hints=(".kz",)), entry("dead", port=dead, hints=(".ru",)))
        self.write_plan(*plan)
        instance, port = self.forwarder()
        self.background.call(lambda: instance.control("route", {"host": "shop.kz", "choice": {"kind": "direct"}}))
        tunnel, _, _ = self.connect(port, f"a.kz:{self.site.port}")
        self.write_plan(*plan)
        self.through(port, "shop.kz")
        self.assertEqual(instance.routes, {"shop.kz": {"kind": "direct"}})
        tunnel.sendall(b"GET /kept HTTP/1.1\r\nHost: a.kz\r\n\r\n")
        self.assertIn(b"site saw GET /kept", tunnel.recv(65536))

    def test_a_plan_without_a_proxy_closes_its_tunnels_and_keeps_others(self) -> None:
        first, second = self.fake("http"), self.fake("http")
        self.write_plan(entry("one", first, hints=(".kz",)), entry("two", second, hints=(".es",)))
        _, port = self.forwarder()
        dropped, _, _ = self.connect(port, f"a.kz:{self.site.port}")
        kept, _, _ = self.connect(port, f"b.es:{self.site.port}")
        self.write_plan(entry("two", second, hints=(".es",)))
        self.through(port, "other.example")
        dropped.settimeout(5)
        try:
            self.assertEqual(dropped.recv(16), b"")
        except ConnectionResetError:
            pass
        kept.sendall(b"GET /kept HTTP/1.1\r\nHost: b.es\r\n\r\n")
        self.assertIn(b"site saw GET /kept", kept.recv(65536))

    def test_no_plan_is_direct_and_an_unreadable_plan_is_a_visible_failure(self) -> None:
        upstream = self.fake("http")
        self.write_plan(entry("kz", upstream, hints=(".kz",)))
        _, port = self.forwarder()
        self.through(port, "a.kz")
        self.plan_path.unlink()
        self.through(port, "b.kz")
        self.assertEqual(len(upstream.targets), 1)
        self.plan_path.write_text("{not json", "utf-8")
        connections = self.site.connections
        _, status, head = self.connect(port, f"c.example:{self.site.port}")
        self.assertEqual(status, 502)
        self.assertIn(b"proxy_unavailable", head)
        self.assertEqual(self.site.connections, connections)

    def test_where_sites_stay_survives_a_vm_stop_and_failures_do_not(self) -> None:
        first, second = self.fake("http"), self.fake("http")
        self.write_plan(entry("one", first, hints=(".kz",)), entry("two", second, hints=(".kz",)))
        instance, port = self.forwarder()
        self.through(port, "a.kz")
        self.through(port, "b.kz")
        self.background.call(instance.flush)
        self.assertEqual(stat_mode(self.state_path), 0o600)
        saved = json.loads(self.state_path.read_text("utf-8"))
        self.assertEqual(saved["sites"], {"a.kz": "one", "b.kz": "two"})
        self.assertEqual(set(saved), {"version", "cursors", "sites"})
        restarted, port = self.forwarder()
        self.through(port, "www.b.kz")
        self.assertEqual(second.targets[-1].split(":")[0], "www.b.kz")
        self.through(port, "c.kz")
        self.assertEqual(first.targets[-1].split(":")[0], "c.kz")
        self.assertIsNotNone(restarted)

    def test_a_damaged_rotation_file_starts_over(self) -> None:
        for content in ("{not json", json.dumps({"version": 9, "sites": {"a.kz": "one"}}), json.dumps({"version": 1, "sites": {"a.kz": 1}, "cursors": {"x": -1}})):
            self.state_path.write_text(content, "utf-8")
            instance = _forwarder.Forwarder(self.plan_path, self.state_path)
            self.assertEqual(instance.state, {"cursors": {}, "failed": {}, "sites": {}})


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777


class PlanFile(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.mkdtemp(prefix="aiqsa-plan-")
        self.addCleanup(shutil.rmtree, self.directory, True)
        self.path = Path(self.directory) / "plan.json"

    def test_shapes_that_cannot_be_trusted_are_refused(self) -> None:
        good = entry("one", hints=(".kz",))
        for broken in ("{", "[]", json.dumps({"version": 2, "proxies": []}), json.dumps({"version": 1, "proxies": [{**good, "port": 0}]}),
                       json.dumps({"version": 1, "proxies": [{**good, "port": True}]}), json.dumps({"version": 1, "proxies": [{**good, "protocol": "ftp"}]}),
                       json.dumps({"version": 1, "proxies": [{**good, "domainHints": ".kz"}]}), json.dumps({"version": 1, "proxies": [{**good, "available": "yes"}]}),
                       json.dumps({"version": 1, "proxies": [good, good]})):
            with self.subTest(broken[:60]):
                self.path.write_text(broken, "utf-8")
                with self.assertRaises(_plan.PlanInvalid):
                    _plan.load(self.path)

    def test_no_file_is_no_plan_and_a_link_is_refused(self) -> None:
        self.assertIsNone(_plan.load(self.path))
        target = Path(self.directory) / "elsewhere.json"
        target.write_text(json.dumps({"version": 1, "proxies": []}), "utf-8")
        self.path.symlink_to(target)
        with self.assertRaises(_plan.PlanInvalid):
            _plan.load(self.path)

    def test_what_may_be_listed_holds_no_credential(self) -> None:
        self.path.write_text(json.dumps({"version": 1, "proxies": [entry("one", hints=(".kz",))]}), "utf-8")
        plan = _plan.load(self.path)
        assert plan is not None
        self.assertNotIn(PASSWORD, json.dumps(plan.public()))
        self.assertNotIn("user", [value for proxy in plan.public() for value in proxy.values() if isinstance(value, str) and value != "personal"])


class RealProcess(Harness):
    """The forwarder as the guest starts it: a detached process, loopback, nothing in its environment or log."""

    def setUp(self) -> None:
        super().setUp()
        self.root = self.directory / "root"
        _paths.use_test_root(self.root, sys.executable)
        self.addCleanup(_paths.use_test_root, None)
        self.addCleanup(self._stop)

    def _stop(self) -> None:
        try:
            pid = client.call("ping")["pid"] if client.has_plan() else None
        except client.ProxyError:
            pid = None
        if pid:
            os.kill(pid, 15)
            for _ in range(100):
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.02)

    def deliver(self, *entries: Dict[str, Any]) -> None:
        path = _paths.proxy_plan_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": 1, "proxies": list(entries)}), "utf-8")

    def test_it_binds_loopback_only_keeps_no_secret_anywhere_and_restarts_on_its_port(self) -> None:
        self.assertFalse(client.has_plan())
        upstream = self.fake("socks5")
        self.deliver(entry("kz", upstream, hints=(".kz",)))
        with mock.patch.dict(os.environ, {"SAVED_SECRET_VALUE": "synthetic-saved-secret"}):
            port = client.ensure()
        self.assertEqual(client.ensure(), port)
        pid = client.call("ping")["pid"]
        listening = Path("/proc/net/tcp").read_text()
        self.assertIn(f"0100007F:{port:04X}", listening)
        self.assertNotIn(f"00000000:{port:04X}", listening)
        self.assertNotIn(b"synthetic-saved-secret", Path(f"/proc/{pid}/environ").read_bytes())
        self.assertNotIn(PASSWORD.encode(), Path(f"/proc/{pid}/cmdline").read_bytes())
        self.assertNotIn(PASSWORD.encode(), Path(f"/proc/{pid}/environ").read_bytes())
        self.assertEqual(stat_mode(_paths.proxy_run_dir()), 0o700)
        self.assertEqual(stat_mode(_paths.proxy_run_dir() / "control.sock"), 0o600)
        self.assertIn("site saw", self.through(port, "shop.kz"))
        self.assertEqual(upstream.auth, [f"user:{PASSWORD}"])
        # A failure, a refusal and an invalid request later, the log still has nothing to say.
        self.deliver(entry("kz", port=dead_port(), hints=(".kz",)))
        self.connect(port, f"shop.kz:{self.site.port}")
        self.connect(port, "127.0.0.1:80")
        self.assertEqual((_paths.proxy_run_dir() / "forwarder.log").read_bytes(), b"")
        os.kill(pid, 9)
        for _ in range(200):
            try:
                os.kill(pid, 0)
                time.sleep(0.01)
            except ProcessLookupError:
                break
        self.assertEqual(client.ensure(), port)

    def test_a_command_gets_the_forwarder_in_every_common_variable_and_mcp_stays_off_it(self) -> None:
        self.deliver(entry("kz", port=dead_port(), hints=(".kz",)))
        env = client.command_environment({"PATH": "/usr/bin", "KEEP": "1"})
        port = client.ensure()
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            self.assertEqual(env[name], f"http://127.0.0.1:{port}")
        self.assertIn("host.microsandbox.internal", env["NO_PROXY"])
        self.assertEqual(env["KEEP"], "1")
        self.assertEqual(client.command_environment({}, "direct")["HTTPS_PROXY"], f"http://direct:x@127.0.0.1:{port}")


    @unittest.skipUnless(shutil.which("curl"), "needs curl")
    def test_curl_goes_through_it_and_a_failure_is_its_exit_status(self) -> None:
        upstream = self.fake("socks5")
        self.deliver(entry("kz", upstream, hints=(".kz",)), entry("dead", port=dead_port(), hints=(".ru",)))
        run = lambda url, route=None: subprocess.run(["curl", "-sS", "--fail", "--max-time", "20", url], capture_output=True, text=True,  # noqa: E731
                                                     env=client.command_environment(os.environ, route))
        through = run("http://shop.kz/page")
        self.assertEqual((through.returncode, through.stdout), (0, "site saw GET /page HTTP/1.1"))
        self.assertEqual(upstream.targets, ["shop.kz:80"])
        direct = run(f"http://shop.test:{self.site.port}/direct", "direct")
        self.assertEqual((direct.returncode, direct.stdout), (0, "site saw GET /direct HTTP/1.1"))
        self.assertEqual(upstream.targets, ["shop.kz:80"])
        lines = len(self.site.lines)
        failed = run("http://shop.ru/page")
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(len(self.site.lines), lines)
        self.assertEqual(client.call("outcome", {"host": "shop.ru"})["outcome"]["code"], "proxy_all_failed")
        self.assertNotIn(PASSWORD, failed.stdout + failed.stderr)


class ConcurrentFailures(Harness):
    def test_many_connections_at_a_dead_proxy_each_end_visibly(self) -> None:
        self.write_plan(entry("one", port=dead_port(), hints=(".kz",)), entry("two", port=dead_port(), hints=(".kz",)))
        _, port = self.forwarder()
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            results = list(pool.map(lambda _: self.connect(port, f"shop.kz:{self.site.port}")[1], range(16)))
        self.assertEqual(set(results), {502})
        self.assertEqual(self.site.connections, 0)


if __name__ == "__main__":
    unittest.main()
