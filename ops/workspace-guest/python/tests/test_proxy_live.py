"""The forwarder under a real Chromium and the real browser host, with local fake proxies; no network beyond 127.0.0.1.

Opt in where the pinned Playwright and its full Chromium are installed:

    AIQSA_BROWSER_LIVE_TESTS=1 python3 -m unittest discover -s ops/workspace-guest/python/tests -p test_proxy_live.py
"""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, List, Optional, Set
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa.browser import _client, _paths  # noqa: E402
from aiqsa.proxy import _forwarder, _upstream, client  # noqa: E402
from test_proxy_forwarder import PASSWORD, Background, FakeProxy, Site, dead_port, entry  # noqa: E402

LIVE = os.environ.get("AIQSA_BROWSER_LIVE_TESTS") == "1" and importlib.util.find_spec("playwright") is not None
SKIP = "set AIQSA_BROWSER_LIVE_TESTS=1 where Playwright and its Chromium are installed"


class Pages(Site):
    """A small website: its pages say who they are, sign a visitor in, read the sign-in back and refuse on request."""

    def __init__(self, tls: Optional[ssl.SSLContext] = None) -> None:
        super().__init__()
        self.tls = tls

    async def start(self) -> "Pages":
        self.server = await asyncio.start_server(self.serve, "127.0.0.1", 0, ssl=self.tls)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.connections += 1
        try:
            while True:
                head = await reader.readuntil(b"\r\n\r\n")
                self.heads.append(head)
                lines = head.decode("latin-1").split("\r\n")
                path = lines[0].split(" ")[1]
                self.lines.append(lines[0])
                cookie = next((line.split(": ", 1)[1] for line in lines if line.lower().startswith("cookie:")), "none")
                status, extra = 200, ""
                if path.startswith("/blocked"):
                    status = 403
                if path.startswith("/signin"):
                    extra = "Set-Cookie: session=synthetic; Path=/\r\n"
                body = f"<!doctype html><title>Page {path}</title><h1>cookie={cookie}</h1>".encode()
                writer.write(f"HTTP/1.1 {status} X\r\nContent-Type: text/html\r\nContent-Length: {len(body)}\r\nConnection: close\r\n{extra}\r\n".encode() + body)
                await writer.drain()
                writer.close()
                return
        except (asyncio.IncompleteReadError, OSError, ssl.SSLError):
            writer.close()


def descendants(pid: int) -> Set[int]:
    found: Set[int] = set()
    pending = [pid]
    while pending:
        current = pending.pop()
        try:
            children = Path(f"/proc/{current}/task/{current}/children").read_text().split()
        except OSError:
            continue
        for child in children:
            found.add(int(child))
            pending.append(int(child))
    return found


def chromium_flags(pid: int) -> List[str]:
    lines = []
    for process in descendants(pid):
        try:
            lines.append(Path(f"/proc/{process}/cmdline").read_bytes().decode("utf-8", "replace"))
        except OSError:
            continue
    return lines


@unittest.skipUnless(LIVE, SKIP)
class SpikeThroughChromium(unittest.TestCase):
    """What the design rests on: Chromium, the forwarder and TLS sites through both upstream kinds."""

    def test_https_through_http_connect_and_socks5_and_what_a_connect_can_carry(self) -> None:
        from playwright.sync_api import sync_playwright

        directory = tempfile.mkdtemp(prefix="aiqsa-proxy-spike-")
        self.addCleanup(shutil.rmtree, directory, True)
        certificate, key = Path(directory) / "cert.pem", Path(directory) / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(certificate), "-days", "1",
                        "-subj", "/CN=secure.example"], check=True, capture_output=True)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certificate, key)
        background = Background()
        self.addCleanup(background.stop)
        site = background.run(Pages(context).start())
        connect = background.run(FakeProxy("http", site).start())
        socks = background.run(FakeProxy("socks5", site).start())
        plan = Path(directory) / "plan.json"
        plan.write_text(json.dumps({"version": 1, "proxies": [entry("connect", connect, hints=(".kz",)), entry("socks", socks, hints=(".es",)),
                                                              entry("dead", port=dead_port(), hints=(".ru",))]}), "utf-8")

        async def resolver(host: str, port: int) -> List[str]:
            return ["127.0.0.1"]

        async def start() -> Any:
            instance = _forwarder.Forwarder(plan, Path(directory) / "rotation.json", _upstream.Network(resolver=resolver, allow_local=True))
            server = await asyncio.start_server(instance.serve, "127.0.0.1", 0, limit=_upstream.STREAM_LIMIT)
            instance.port = server.sockets[0].getsockname()[1]
            self.addCleanup(background.call, server.close)
            return instance

        instance = background.run(start())
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chromium", headless=True, args=[
                f"--proxy-server=http://127.0.0.1:{instance.port}", "--ignore-certificate-errors"])
            try:
                shared = browser.new_context()
                page = shared.new_page()
                # A header on a page is inside TLS, so a CONNECT never carries it: the reason a header cannot choose a route.
                page.set_extra_http_headers({"X-Agent-Route": "synthetic-route"})
                self.assertEqual(page.goto(f"https://secure.kz:{site.port}/signin").status, 200)
                self.assertEqual(connect.targets, [f"secure.kz:{site.port}"])
                self.assertNotIn(b"synthetic-route", b"".join(connect.heads))
                self.assertTrue(any(b"synthetic-route" in head for head in site.heads))
                self.assertEqual(page.goto(f"https://secure.es:{site.port}/signin").status, 200)
                self.assertEqual(socks.targets, [f"secure.es:{site.port}"])
                # One context: a new tab on either site reads the sign-in, whichever proxy it went through.
                other = shared.new_page()
                self.assertIn("cookie=session=synthetic", other.goto(f"https://secure.kz:{site.port}/whoami").text() or "")
                # A dead proxy with nothing behind it ends in Chromium's tunnel error, never a direct connection.
                with self.assertRaisesRegex(Exception, "ERR_TUNNEL_CONNECTION_FAILED"):
                    page.goto(f"https://secure.ru:{site.port}/")
                self.assertFalse(any(b"secure.ru" in head for head in site.heads))
                # What a seam would use exists on this build.
                cdp = shared.new_cdp_session(other)
                cdp.send("Emulation.setLocaleOverride", {"locale": "ru-RU"})
                cdp.send("Emulation.setTimezoneOverride", {"timezoneId": "Europe/Moscow"})
                self.assertEqual(other.evaluate("[navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone]")[1], "Europe/Moscow")
            finally:
                browser.close()


@unittest.skipUnless(LIVE, SKIP)
class RealHost(unittest.TestCase):
    """`aiqsa-browser` as agents use it: its host starts Chromium and the forwarder on the delivered plan."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.root = tempfile.mkdtemp(prefix="aiqsa-proxy-live-")
        _paths.use_test_root(cls.root, sys.executable)
        cls.background = Background()
        cls.site = cls.background.run(Pages().start())
        cls.one = cls.background.run(FakeProxy("socks5", cls.site).start())
        cls.two = cls.background.run(FakeProxy("socks5", cls.site).start())
        cls.spanish = cls.background.run(FakeProxy("socks5", cls.site).start())
        cls.behind = cls.background.run(FakeProxy("socks5", cls.site).start())
        cls.http = cls.background.run(FakeProxy("http", cls.site).start())
        path = _paths.proxy_plan_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": 1, "proxies": [
            entry("one", cls.one, hints=(".kz",), country="KZ"), entry("two", cls.two, hints=(".kz",)), entry("es", cls.spanish, hints=(".es",)),
            entry("dead", port=dead_port(), hints=(".ru",)), entry("behind", cls.behind, hints=(".ru",)),
            entry("gone1", port=dead_port(), hints=("gone.test",)), entry("plain", cls.http, hints=("plain.test",)),
            entry("hinted", cls.spanish, hints=("hinted.test",))]}), "utf-8")
        cls.environment = mock.patch.dict(os.environ, {"PYTHONPATH": str(Path(__file__).resolve().parents[1])})
        cls.environment.start()

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            _client.call("close")
        except _client.BrowserError:
            pass
        try:
            os.kill(client.call("ping")["pid"], 15)
        except (client.ProxyError, OSError):
            pass
        cls.environment.stop()
        _paths.use_test_root(None)
        cls.background.stop()
        shutil.rmtree(cls.root, True)

    def test_01_the_browser_points_at_the_forwarder(self) -> None:
        result = _client.call("open", {"url": "http://shop.kz/first"})
        self.assertIn("through proxy", result["step"]["target"])
        port = client.ensure()
        flags = chromium_flags(_client._STARTED[-1].pid)
        self.assertTrue(any(f"--proxy-server=http://127.0.0.1:{port}" in line for line in flags))
        self.assertEqual((_paths.proxy_run_dir() / "forwarder.log").read_bytes(), b"")
        self.assertNotIn("synthetic-pass", (_paths.run_dir() / "host.log").read_text("utf-8", "replace"))

    def test_02_a_hint_opens_through_its_proxy_and_two_alternate_between_sites_and_stay_within_one(self) -> None:
        opened = {host: _client.call("open", {"url": f"http://{host}/"})["step"]["target"] for host in ("a.kz", "b.kz", "c.kz")}
        self.assertEqual(len({target for target in opened.values()}), 2)
        self.assertNotEqual(opened["a.kz"], opened["b.kz"])
        self.assertEqual(_client.call("open", {"url": "http://www.a.kz/"})["step"]["target"], opened["a.kz"])
        self.assertTrue(any(target.startswith("a.kz") for target in self.one.targets + self.two.targets))

    def test_03_a_named_proxy_opens_any_site_and_the_step_says_so(self) -> None:
        result = _client.call("open", {"url": "http://any.example/", "proxy": "ES"})
        self.assertEqual(result["step"]["target"], "through proxy ES")
        self.assertIn("any.example:80", self.spanish.targets)

    def test_04_direct_beats_a_hint_and_nothing_applying_is_direct(self) -> None:
        before = list(self.spanish.targets)
        result = _client.call("open", {"url": f"http://hinted.test:{self.site.port}/x", "proxy": "direct"})
        self.assertEqual(result["step"]["target"], "direct")
        self.assertEqual(self.spanish.targets, before)
        result = _client.call("open", {"url": f"http://nothing.test:{self.site.port}/y"})
        self.assertEqual(result["step"]["target"], "direct")
        result = _client.call("open", {"url": f"http://hinted.test:{self.site.port}/z", "proxy": "auto"})
        self.assertEqual(result["step"]["target"], "through proxy HINTED")

    def test_05_a_dead_proxy_moves_on_and_with_none_left_the_failure_is_visible(self) -> None:
        result = _client.call("open", {"url": "http://shop.ru/"})
        self.assertEqual(result["step"]["target"], "through proxy BEHIND after DEAD failed")
        with self.assertRaises(_client.BrowserError) as caught:
            _client.call("open", {"url": f"http://gone.test:{self.site.port}/"})
        self.assertEqual(caught.exception.code, "proxy_all_failed")
        self.assertIn("GONE1", caught.exception.message)
        self.assertIn("Nothing was sent directly", caught.exception.message)
        self.assertFalse(any(b"gone.test" in head for head in self.site.heads))

    def test_06_a_blocked_answer_names_the_proxies_to_try(self) -> None:
        result = _client.call("open", {"url": f"http://nothing.test:{self.site.port}/blocked"})
        self.assertIn("HTTP status 403.", result["text"])
        self.assertIn("Proxies to try: ", result["text"])
        self.assertIn("ONE (KZ)", result["text"])
        result = _client.call("open", {"url": "http://shop.es/blocked"})
        line = next(line for line in result["text"].splitlines() if line.startswith("This site refused"))
        self.assertIn("proxy ES", line)
        self.assertNotIn("ES,", line.split("Proxies to try:")[1])

    def test_07_a_name_nobody_has_and_a_private_address_are_refused(self) -> None:
        with self.assertRaises(_client.BrowserError) as caught:
            _client.call("open", {"url": "http://shop.kz/", "proxy": "nobody"})
        self.assertEqual(caught.exception.code, "proxy_not_found")
        for url in ("http://10.0.0.1/", "https://10.0.0.1/"):
            with self.assertRaises(_client.BrowserError) as caught:
                _client.call("open", {"url": url})
            self.assertEqual(caught.exception.code, "proxy_target_refused")

    def test_08_a_local_page_still_opens(self) -> None:
        result = _client.call("open", {"url": f"http://127.0.0.1:{self.site.port}/local"})
        self.assertIn("/local", result["text"])

    def test_09_tabs_of_two_agents_on_different_proxies_share_sign_ins(self) -> None:
        _client.call("open", {"url": "http://signed.example/signin", "proxy": "ONE"})
        self.assertIn("signed.example:80", self.one.targets)
        with mock.patch.dict(os.environ, {"AIQSA_AGENT_ID": "agent-b", "AIQSA_AGENT_NAME": "agent-b"}):
            result = _client.call("open", {"url": "http://signed.example/whoami", "proxy": "TWO"})
            self.assertEqual(result["step"]["target"], "through proxy TWO")
            self.assertIn("cookie=session=synthetic", _client.call("text", {})["text"])
            _client.call("release")
        self.assertIn("signed.example:80", self.two.targets)
        # The first agent's tab shares that one exit now, and it is told.
        self.assertIn("Another agent chose proxy TWO", _client.call("info", {})["text"])
        # Agents on different sites keep different exits at once.
        with mock.patch.dict(os.environ, {"AIQSA_AGENT_ID": "agent-c", "AIQSA_AGENT_NAME": "agent-c"}):
            self.assertEqual(_client.call("open", {"url": "http://elsewhere.example/", "proxy": "ES"})["step"]["target"], "through proxy ES")
            _client.call("release")

    def test_10_plain_http_through_an_http_proxy(self) -> None:
        result = _client.call("open", {"url": "http://plain.test/page"})
        self.assertEqual(result["step"]["target"], "through proxy PLAIN")
        self.assertIn("http://plain.test:80/page", self.http.targets)
        self.assertEqual(self.http.auth[0], "Basic " + base64.b64encode(f"user:{PASSWORD}".encode()).decode())


@unittest.skipUnless(LIVE, SKIP)
class NoProxies(unittest.TestCase):
    """A chat without proxies: no process, no flag, and a page opens as it always did."""

    def test_nothing_starts_and_nothing_changes(self) -> None:
        root = tempfile.mkdtemp(prefix="aiqsa-proxy-none-")
        self.addCleanup(shutil.rmtree, root, True)
        _paths.use_test_root(root, sys.executable)
        self.addCleanup(_paths.use_test_root, None)
        background = Background()
        self.addCleanup(background.stop)
        site = background.run(Pages().start())
        with mock.patch.dict(os.environ, {"PYTHONPATH": str(Path(__file__).resolve().parents[1])}):
            result = _client.call("open", {"url": f"http://127.0.0.1:{site.port}/page"})
            self.assertIsNone(result["step"]["target"])
            self.assertFalse(_paths.proxy_run_dir().exists())
            self.assertFalse(any("--proxy-server" in line for line in chromium_flags(_client._STARTED[-1].pid)))
            with self.assertRaises(_client.BrowserError) as caught:
                _client.call("open", {"url": f"http://127.0.0.1:{site.port}/page", "proxy": "KZ1"})
            self.assertEqual(caught.exception.code, "proxy_not_found")
            # Proxies that arrive later never open a hinted site directly from this browser.
            path = _paths.proxy_plan_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"version": 1, "proxies": [entry("kz", hints=(".kz",))]}), "utf-8")
            with self.assertRaises(_client.BrowserError) as caught:
                _client.call("open", {"url": "http://shop.kz/"})
            self.assertEqual(caught.exception.code, "proxy_browser_restart_required")
            _client.call("close")


if __name__ == "__main__":
    unittest.main()
