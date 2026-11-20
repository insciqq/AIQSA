"""The headed browser's X server and the few evaluations that run in the page's own world, without a browser.

Run: python3 -m unittest discover -s ops/workspace-guest/python/tests -p test_browser_display.py
A stand-in Xvfb (a small script) takes the real one's place; the host part needs Patchright installed (the guest
image has it) and is skipped where it is missing. The real X server and browser run in the live tests.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa.browser import _display, _dom, _identity, _paths  # noqa: E402
try:  # The standard guest image does not install Patchright; host fakes run where it is present.
    from aiqsa.browser import _host  # noqa: E402
except ModuleNotFoundError:  # pragma: no cover - exercised only in the slim guest test image
    _host = None  # type: ignore[assignment]

#: Behaves as Xvfb does for the host: records its arguments, announces display 7 on the -displayfd descriptor, runs
#: until it is ended. `MODE` makes it fail instead: exit at once, or never announce.
FAKE_XVFB = """\
#!{python}
import json, os, sys, time
args = sys.argv[1:]
with open({record!r}, "w") as stream:
    json.dump({{"args": args, "pid": os.getpid(), "display": os.environ.get("DISPLAY")}}, stream)
mode = {mode!r}
if mode == "exit":
    sys.exit(1)
if mode == "announce":
    fd = int(args[args.index("-displayfd") + 1])
    os.write(fd, b"7\\n")
    os.close(fd)
while True:
    time.sleep(1)
"""


class DisplayTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.record = Path(self.directory.name) / "xvfb.json"

    def fake(self, mode: str = "announce") -> str:
        path = Path(self.directory.name) / f"Xvfb-{mode}"
        path.write_text(FAKE_XVFB.format(python=sys.executable, record=str(self.record), mode=mode))
        path.chmod(0o755)
        return str(path)

    def recorded(self) -> Dict[str, Any]:
        return json.loads(self.record.read_text())

    async def test_the_server_announces_a_free_display_listens_on_no_tcp_and_has_the_browsers_screen(self) -> None:
        exits: List[bool] = []
        before = os.environ.get("DISPLAY")
        display = _display.Display(self.fake())
        self.addAsyncCleanup(display.stop)
        name = await display.start(lambda: exits.append(True))
        self.assertEqual((name, display.env()), (":7", {"DISPLAY": ":7"}))
        args = self.recorded()["args"]
        self.assertEqual(args[args.index("-screen") + 1:args.index("-screen") + 3], ["0", f"{_identity.SCREEN[0]}x{_identity.SCREEN[1]}x24"])
        self.assertEqual(args[args.index("-nolisten") + 1], "tcp")
        self.assertIn("-noreset", args)
        self.assertIsNone(self.recorded()["display"], "the server itself gets no display from the host")
        self.assertEqual(await display.start(lambda: exits.append(True)), ":7", "started once")
        process = display.process
        await display.stop()
        self.assertIsNotNone(process.returncode)
        self.assertEqual((display.name, display.env(), exits), (None, {}, []), "an ordinary stop is no crash")
        self.assertEqual(os.environ.get("DISPLAY"), before, "the host's own environment never names the display")

    async def test_a_server_that_ends_under_the_browser_is_reported(self) -> None:
        ended = asyncio.Event()
        display = _display.Display(self.fake())
        self.addAsyncCleanup(display.stop)
        await display.start(ended.set)
        display.process.kill()
        await asyncio.wait_for(ended.wait(), 5)
        self.assertIsNone(display.name)
        await display.stop()

    async def test_a_server_that_cannot_start_is_a_visible_failure(self) -> None:
        with self.assertRaises(_display.DisplayError) as raised:
            await _display.Display(self.fake("exit")).start(lambda: None)
        self.assertEqual(raised.exception.code, "browser_display_unavailable")
        silent = _display.Display(self.fake("silent"))
        with mock.patch.object(_display, "START_SECONDS", 0.5), self.assertRaises(_display.DisplayError):
            await silent.start(lambda: None)
        pid = self.recorded()["pid"]
        await asyncio.sleep(0.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        with self.assertRaises(_display.DisplayError):
            await _display.Display(str(Path(self.directory.name) / "missing-Xvfb")).start(lambda: None)


class FakeFrame:
    """The page's top frame: answers the CAPTCHA script by world, and records each call's world."""

    def __init__(self) -> None:
        self.calls: List[Tuple[Any, Optional[bool]]] = []

    async def evaluate(self, script: str, argument: Any = None, *, isolated_context: bool = True) -> Any:
        self.calls.append((argument, isolated_context))
        if script != _dom.CAPTCHA:
            raise AssertionError("unexpected script")
        selectors, names = argument
        if isolated_context:
            return ["Cloudflare challenge"] if selectors else []
        return ["Cloudflare browser check", "Cloudflare challenge"] if names else []


class FakePage:
    def __init__(self) -> None:
        self.url = "https://shop.example/"
        self.main_frame = FakeFrame()
        self.evaluated: List[Tuple[str, Optional[bool]]] = []

    def is_closed(self) -> bool:
        return False

    async def evaluate(self, script: str, argument: Any = None, *, isolated_context: bool = True) -> Any:
        self.evaluated.append((script, isolated_context))
        if script == _dom.MARKERS:
            return {"page": {"webdriver": False}, "worker": None}
        return {"props": {"pageProps": {"id": 7}}}


@unittest.skipIf(_host is None, "needs Patchright")
class HostWorldTests(unittest.IsolatedAsyncioTestCase):
    """Patchright evaluates in an isolated world unless told otherwise: only what reads page globals goes to the page's."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        _paths.use_test_root(self.directory.name, sys.executable)
        self.addCleanup(_paths.use_test_root, None)
        self.addCleanup(self.directory.cleanup)
        self.host = _host.Host({})
        self.page = FakePage()
        state = self.host._state_for("main")
        state.tabs, state.current = [self.page], self.page
        self.host._pages[self.page] = state

    def ready(self) -> None:
        future = asyncio.get_running_loop().create_future()
        future.set_result(None)
        self.host._setups[self.page] = future

    async def test_widgets_are_read_in_isolation_and_only_the_check_pages_globals_in_the_page(self) -> None:
        kinds = await self.host._captcha_forms(self.page)
        self.assertEqual(kinds, ["Cloudflare challenge", "Cloudflare browser check"])
        self.assertEqual(self.page.main_frame.calls, [([_dom.CAPTCHA_SELECTORS, []], True), ([[], _dom.CAPTCHA_GLOBALS], False)])

    async def test_js_and_markers_read_the_page_world(self) -> None:
        self.ready()
        result = await self.host.op_js({"expression": "window.__NEXT_DATA__"})
        self.assertEqual(json.loads(result["text"]), {"props": {"pageProps": {"id": 7}}})
        await self.host.op_status({"markers": True})
        self.assertEqual(self.page.evaluated, [("window.__NEXT_DATA__", False), (_dom.MARKERS, False)])

    async def test_the_browser_starts_headed_on_the_hosts_display_and_only_it_gets_the_display(self) -> None:
        before = os.environ.get("DISPLAY")
        self.host.display.name = ":7"
        options = self.host._launch_options()
        self.assertFalse(options["headless"])
        self.assertEqual(options["env"].get("DISPLAY"), ":7")
        self.assertIn("--enable-unsafe-swiftshader", options["args"])
        self.assertEqual(os.environ.get("DISPLAY"), before, "the host's own environment never names the display")
        self.host.display.name = None
        self.assertFalse("DISPLAY" in self.host._launch_options()["env"], "no display, no DISPLAY")

    async def test_a_display_that_ends_stops_the_browser_like_a_crash(self) -> None:
        record = Path(self.directory.name) / "xvfb.json"
        fake = Path(self.directory.name) / "Xvfb"
        fake.write_text(FAKE_XVFB.format(python=sys.executable, record=str(record), mode="announce"))
        fake.chmod(0o755)
        self.host.display = _display.Display(str(fake))
        await self.host.display.start(self.host._on_disconnected)
        self.host.display.process.kill()
        await asyncio.wait_for(self.host.stopped.wait(), 5)
        self.assertTrue(self.host.crashed)
        await self.host.stop()
        self.assertIsNone(self.host.display.process)


if __name__ == "__main__":
    unittest.main()
