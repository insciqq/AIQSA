"""Browser helper tests against a real Chromium and local fixture pages; no network beyond 127.0.0.1.

Opt in where the pinned Playwright and its full Chromium are installed (the guest
image, or the Playwright Python image on the dev server), never on a workstation:

    AIQSA_BROWSER_LIVE_TESTS=1 python3 -m unittest discover -s ops/workspace-guest/python/tests -p test_browser_live.py
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

LIVE = os.environ.get("AIQSA_BROWSER_LIVE_TESTS") == "1" and importlib.util.find_spec("playwright") is not None

INDEX = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture shop</title></head><body><main>
<h1>Fixture shop</h1>
<a href="/catalog">Catalog</a>
<form action="/login" method="post">
  <label>Login <input name="login"></label>
  <label>Password <input type="password" name="password"></label>
  <button>Sign in</button>
</form>
<label>Sort <select id="sort"><option value="az">Name (A to Z)</option><option value="lohi">Price (low to high)</option></select></label>
<label><input type="checkbox" id="remember"> Remember me</label>
<button disabled>Disabled action</button>
<button style="display:none">Hidden action</button>
<div role="button" tabindex="0" onclick="document.title='clicked div'">Div button</div>
<my-widget></my-widget>
<input type="search" aria-label="Search the shop">
<iframe src="/frame" style="width:400px;height:120px"></iframe>
<a href="/popup" target="_blank">Open in new tab</a>
<button onclick="alert('Hello from alert')">Alert me</button>
<button onclick="document.getElementById('out').textContent = confirm('Sure?') ? 'yes' : 'no'">Confirm me</button>
<a href="/report.txt" download>Download file</a>
<p id="out"></p>
<div style="height:3000px"></div>
<button id="far">Far below</button>
</main>
<script>customElements.define('my-widget', class extends HTMLElement { constructor() { super();
  this.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow button</button>'; } });</script>
</body></html>"""

PAGES = {
    "/frame": "<!doctype html><title>frame</title><button>Frame button</button>",
    "/popup": "<!doctype html><title>Popup page</title><h1>Popup</h1>",
    "/catalog": "<!doctype html><title>Catalog</title>" + "".join(f"<button>Add item {i}</button>" for i in range(1, 601)),
    "/captcha": ("<!doctype html><title>Robot check</title><form action='/errors/validateCaptcha'>"
                 "<p>Click to continue</p><button>Continue shopping</button></form><a href='/'>Home</a>"),
    "/storage": "<!doctype html><title>Storage</title><script>localStorage.setItem('cart', '3')</script><p>stored</p>",
    "/text": "<!doctype html><title>Text</title><p>" + " ".join(f"word{i}" for i in range(3000)) + "</p>",
}


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_: Any) -> None:
        pass

    def reply(self, body: str, status: int = 200, headers: Dict[str, str] = None, ctype: str = "text/html; charset=utf-8") -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/":
            return self.reply(INDEX)
        if self.path == "/account":
            signed = "sid=" in (self.headers.get("cookie") or "")
            return self.reply(f"<!doctype html><title>Account</title><h1>{'Signed in' if signed else 'Signed out'}</h1>")
        if self.path == "/rotate":
            return self.reply("<!doctype html><title>Rotated</title><p>rotated</p>", headers={"set-cookie": "sid=rotated; Path=/; HttpOnly"})
        if self.path == "/report.txt":
            return self.reply("report", ctype="text/plain", headers={"content-disposition": 'attachment; filename="report.txt"'})
        if self.path in PAGES:
            return self.reply(PAGES[self.path])
        return self.reply("<!doctype html><title>Missing</title>", status=404)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length).decode()
        if self.path == "/login" and "login=fixture-user" in body and "password=fixture-password" in body:
            self.send_response(303)
            self.send_header("location", "/account")
            self.send_header("set-cookie", "sid=fixture-session; Path=/; HttpOnly")
            self.send_header("content-length", "0")
            self.end_headers()
            return None
        return self.reply("<!doctype html><title>Denied</title><h1>Denied</h1>", status=403)


@unittest.skipUnless(LIVE, "set AIQSA_BROWSER_LIVE_TESTS=1 where Playwright and its Chromium are installed")
class LiveBrowserTests(unittest.TestCase):
    server: ThreadingHTTPServer
    directory: tempfile.TemporaryDirectory
    root: Path
    environment: Any
    base: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.directory = tempfile.TemporaryDirectory()
        cls.root = Path(cls.directory.name)
        workspace = cls.root / "workspace"
        for part in ("project", "output", "tmp", "secrets/browser"):
            (workspace / part).mkdir(parents=True)
        cls.environment = mock.patch.dict(os.environ, {
            "AIQSA_BROWSER_RUN_DIR": str(cls.root / "run"),
            "AIQSA_BROWSER_STEPS_DIR": str(cls.root / "steps"),
            "AIQSA_BROWSER_SHOTS_DIR": str(workspace / "project" / ".browser"),
            "AIQSA_BROWSER_DOWNLOADS_DIR": str(workspace / "project" / "downloads"),
            "AIQSA_BROWSER_SESSIONS_DIR": str(workspace / "secrets" / "browser"),
            "AIQSA_BROWSER_WORKSPACE_DIR": str(workspace),
            "AIQSA_BROWSER_PYTHON": sys.executable,
            "AIQSA_BROWSER_LOCALE": "es-ES",
            "AIQSA_BROWSER_TIMEZONE": "Europe/Madrid",
        })
        cls.environment.start()
        cls.workspace = workspace

    @classmethod
    def tearDownClass(cls) -> None:
        from aiqsa import browser
        from aiqsa.browser import _client

        try:
            browser.close()
        except browser.BrowserError:
            pass
        cls.wait_for_host_exit()
        for process in _client._STARTED:
            process.wait(timeout=30)
        cls.environment.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.directory.cleanup()

    @staticmethod
    def chromium_processes() -> list:
        """Chromium processes of this machine (the test container runs no other browser)."""
        found = []
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                argv0 = (entry / "cmdline").read_bytes().split(b"\0", 1)[0].decode("utf-8", "replace")
            except OSError:
                continue
            if "/chromium-" in argv0 and argv0.endswith("/chrome"):
                found.append(int(entry.name))
        return found

    @classmethod
    def wait_for_host_exit(cls) -> None:
        deadline = time.monotonic() + 30
        while (cls.root / "run" / "control.sock").exists() and time.monotonic() < deadline:
            time.sleep(0.2)

    def quiet(self, call: Any, *args: Any, **kwargs: Any) -> Any:
        out = io.StringIO()
        with redirect_stdout(out):
            value = call(*args, **kwargs)
        self.printed = out.getvalue()
        return value

    def item(self, page: Any, name: str) -> Dict[str, Any]:
        found = [item for item in page.items if item.get("name") == name]
        self.assertEqual(len(found), 1, f"{name}: {[item.get('name') for item in page.items]}")
        return found[0]

    def test_1_numbered_elements_describe_the_page(self) -> None:
        from aiqsa import browser

        page = self.quiet(browser.open, self.base + "/")
        self.assertRegex(self.printed, r"^\[browser #\d+\] open @ 127\.0\.0\.1:\d+/\n$")
        text = str(page)
        self.assertIn("Title: Fixture shop", text)
        self.assertIn(f"[{self.item(page, 'Catalog')['n']}] link \"Catalog\" → /catalog", text)
        self.assertIn(f"[{self.item(page, 'Password')['n']}] textbox \"Password\" (hidden value, empty)", text)
        self.assertIn(f"[{self.item(page, 'Sort')['n']}] combobox \"Sort\" = \"Name (A to Z)\"", text)
        self.assertIn(f"[{self.item(page, 'Remember me')['n']}] checkbox \"Remember me\" (not checked)", text)
        self.assertIn(f"[{self.item(page, 'Disabled action')['n']}] button \"Disabled action\" (disabled)", text)
        self.assertEqual(self.item(page, "Div button")["role"], "button")
        self.assertEqual(self.item(page, "Shadow button")["role"], "button")
        self.assertTrue(self.item(page, "Search the shop")["search"])
        self.assertTrue(self.item(page, "Frame button")["frame"])
        self.assertNotIn("Hidden action", text)
        far = self.item(page, "Far below")
        self.assertEqual(far["position"], "below")
        self.assertNotIn('"Far below"', text)
        self.assertIn("below", text)
        self.assertIn('"Far below"', str(browser.page_info(all=True)))
        self.assertIn("Started a new browser", text)
        search = self.item(page, "Search the shop")["n"]
        self.quiet(browser.type, search, "boots")
        self.assertIn('("boots")', self.printed)
        with mock.patch.dict(os.environ, {"SHOP_TERM": "hidden-term"}):
            self.quiet(browser.type, search, env="SHOP_TERM")
        self.assertIn("(11 characters)", self.printed)
        self.assertNotIn("hidden-term", self.printed)

    def test_2_numbers_stay_with_their_elements(self) -> None:
        from aiqsa import browser

        page = self.quiet(browser.open, self.base + "/")
        catalog = self.item(page, "Catalog")["n"]
        browser.js("document.querySelector('h1').insertAdjacentHTML('afterend', '<button>Inserted</button>')")
        again = browser.page_info()
        self.assertEqual(self.item(again, "Catalog")["n"], catalog)
        self.assertGreater(self.item(again, "Inserted")["n"], max(item["n"] for item in page.items))

    def test_3_sign_in_saves_and_restores_the_session(self) -> None:
        from aiqsa import browser

        page = self.quiet(browser.open, self.base + "/")
        self.quiet(browser.type, self.item(page, "Login")["n"], "fixture-user")
        self.assertIn("(12 characters)", self.printed)
        self.assertNotIn("fixture-user", self.printed)
        self.quiet(browser.type, self.item(page, "Password")["n"], "fixture-password")
        signed = self.quiet(browser.click, self.item(page, "Sign in")["n"])
        self.assertIn('click: button "Sign in"', self.printed)
        self.assertIn("Title: Account", str(signed))
        self.assertIn("Signed in", browser.text())
        result = self.quiet(browser.save_session)
        self.assertIn("127.0.0.1.json", result)
        saved_path = self.workspace / "secrets" / "browser" / "127.0.0.1.json"
        saved = json.loads(saved_path.read_text("utf-8"))
        self.assertEqual([cookie["name"] for cookie in saved["cookies"]], ["sid"])
        self.assertEqual(oct(saved_path.stat().st_mode & 0o777), "0o600")
        self.quiet(browser.open, self.base + "/rotate")
        rotated = json.loads(saved_path.read_text("utf-8"))
        self.assertEqual(rotated["cookies"][0]["value"], "rotated")
        # Local storage (where single-page apps keep their tokens) stays current as well.
        self.quiet(browser.open, self.base + "/storage")
        stored = json.loads(saved_path.read_text("utf-8"))
        self.assertIn({"name": "cart", "value": "3"}, [item for origin in stored["origins"] for item in origin["localStorage"]])
        from aiqsa.browser import _client

        browser.close()
        self.wait_for_host_exit()
        for process in _client._STARTED:
            self.assertIsNotNone(process.wait(timeout=30))
        self.assertEqual(self.chromium_processes(), [], "a closed browser leaves no Chromium process")
        restored = self.quiet(browser.open, self.base + "/account")
        self.assertIn("saved sign-ins restored: 127.0.0.1", str(restored))
        self.assertIn("Signed in", browser.text())
        self.assertEqual(browser.status()["sessions"], ["127.0.0.1.json"])

    def test_4_errors_name_the_next_step(self) -> None:
        from aiqsa import browser

        page = self.quiet(browser.open, self.base + "/")
        cases = [
            (lambda: browser.click(99999), "element_not_found"),
            (lambda: browser.select(self.item(page, "Catalog")["n"], "x"), "not_a_select"),
            (lambda: browser.select(self.item(page, "Sort")["n"], "Nope"), "option_not_found"),
            (lambda: browser.open("ftp://example.test/"), "invalid_url"),
            (lambda: browser.wait_for(text="never shown", timeout=1), "wait_timeout"),
        ]
        for action, code in cases:
            with self.assertRaises(browser.BrowserError) as raised:
                self.quiet(action)
            self.assertEqual(raised.exception.code, code)
        selected = self.quiet(browser.select, self.item(page, "Sort")["n"], "low to high")
        self.assertIn('"Price (low to high)"', str(selected))
        old = self.item(page, "Catalog")["n"]
        self.quiet(browser.open, self.base + "/popup")
        with self.assertRaises(browser.BrowserError) as raised:
            self.quiet(browser.click, old)
        self.assertIn(raised.exception.code, ("stale_element", "element_not_found"))

    def test_5_bot_checks_go_to_the_user(self) -> None:
        from aiqsa import browser

        page = self.quiet(browser.open, self.base + "/captcha")
        self.assertIn("Amazon bot check", str(page))
        self.assertIn("Do not try to solve or get around it", str(page))
        with self.assertRaises(browser.BrowserError) as raised:
            self.quiet(browser.click, self.item(page, "Continue shopping")["n"])
        self.assertEqual(raised.exception.code, "captcha_requires_user")
        self.quiet(browser.click, self.item(page, "Home")["n"])

    def test_6_large_pages_stay_bounded(self) -> None:
        from aiqsa import browser

        page = self.quiet(browser.open, self.base + "/catalog")
        text = str(page)
        self.assertLessEqual(len(text), 16_200)
        self.assertIn("more not listed", text)
        self.assertIn("Only the first elements of a very large page were numbered.", text)
        self.assertIn("Add item 450", str(browser.find("Add item 450")))
        long_text = browser.text()
        self.assertIn("continue with start=", long_text)
        self.quiet(browser.open, self.base + "/text")
        first = browser.text(max_chars=100)
        second = browser.text(start=100, max_chars=100)
        self.assertTrue(first.startswith("word0 word1"))
        self.assertNotEqual(first.split("\n")[0], second.split("\n")[0])

    def test_7_tabs_dialogs_downloads_and_steps(self) -> None:
        from aiqsa import browser

        page = self.quiet(browser.open, self.base + "/")
        popup = self.quiet(browser.click, self.item(page, "Open in new tab")["n"])
        self.assertIn("Title: Popup page", str(popup))
        self.assertIn("now the current tab", str(popup))
        self.assertIn("tab 2", browser.tabs())
        home = self.quiet(browser.switch_tab, 1)
        alert = self.quiet(browser.click, self.item(home, "Alert me")["n"])
        self.assertIn("alert dialog was accepted", str(alert))
        self.quiet(browser.click, self.item(home, "Confirm me")["n"])
        self.assertIn("no", browser.text())
        self.quiet(browser.click, self.item(home, "Download file")["n"])
        target = self.workspace / "project" / "downloads" / "report.txt"
        deadline = time.monotonic() + 10
        while not target.exists() and time.monotonic() < deadline:
            time.sleep(0.2)
        self.assertEqual(target.read_text("utf-8"), "report")
        self.assertIn("download: report.txt", browser.steps())
        steps = browser.steps()
        self.assertIn("click: link \"Open in new tab\"", steps)
        self.assertIn("tab: 1", steps)
        self.assertTrue(list((self.root / "steps").glob("step-*.jpg")))
        records = [json.loads(line) for line in (self.root / "steps" / "steps.jsonl").read_text("utf-8").splitlines()]
        self.assertTrue(all({"n", "action", "target", "url", "at"} <= set(record) for record in records))

    def test_8_the_browser_shows_no_automation_markers(self) -> None:
        from aiqsa import browser

        self.quiet(browser.open, self.base + "/")
        status = browser.status(markers=True)
        self.assertTrue(status["version"])
        if status["pinned"]:
            self.assertEqual(status["version"], status["pinned"])
        self.assertFalse(status["userAgentHeadless"])
        for scope in ("page", "worker"):
            markers = status["markers"][scope]
            self.assertIsNotNone(markers, scope)
            self.assertIn(markers["webdriver"], (False, None), scope)
            self.assertNotIn("Headless", markers["userAgent"], scope)
            self.assertFalse([brand for brand in markers["brands"] if "Headless" in brand], scope)
            self.assertEqual(markers["timeZone"], "Europe/Madrid", scope)
            self.assertEqual(markers["languages"][0], "es-ES", scope)
        self.assertIs(status["markers"]["page"]["webdriver"], False)
        from aiqsa.browser import cli

        out = io.StringIO()
        self.assertEqual(cli.main(["status", "--markers"], stdout=out, stderr=io.StringIO()), 0)
        text = out.getvalue()
        self.assertRegex(text, r"(?m)^Chromium ([0-9.]+) \(pinned \1\), language es-ES, time zone Europe/Madrid\.$" if status["pinned"]
                         else r"^Chromium [0-9.]+ \(pinned unknown\)")
        for scope in ("page", "worker"):
            self.assertRegex(text, rf"(?m)^Markers in {scope} scope: webdriver=(false|null), headless user agent=false, brands=[^\n]*, "
                                   r"time zone=Europe/Madrid, languages=es-ES")

    def test_9_screenshots_scrolling_and_history(self) -> None:
        from aiqsa import browser

        page = self.quiet(browser.open, self.base + "/")
        path = self.quiet(browser.screenshot)
        self.assertTrue(path.endswith(".png") and Path(path).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n")
        self.assertTrue(path.startswith(str(self.workspace / "project" / ".browser")))
        with self.assertRaises(browser.BrowserError) as raised:
            self.quiet(browser.screenshot, path=str(self.workspace / "secrets" / "x.png"))
        self.assertEqual(raised.exception.code, "invalid_path")
        bottom = self.quiet(browser.scroll, "bottom")
        self.assertTrue(self.item(bottom, "Far below")["inView"])
        self.quiet(browser.press, "Escape")
        self.quiet(browser.click, self.item(page, "Catalog")["n"])
        back = self.quiet(browser.back)
        self.assertIn("Title: Fixture shop", str(back))


if __name__ == "__main__":
    unittest.main()
