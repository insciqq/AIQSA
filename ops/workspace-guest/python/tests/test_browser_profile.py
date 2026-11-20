"""The chat's browser profile: its lock, bound, set-aside and bookkeeping, and the host's use of it, without a browser.

Run: python3 -m unittest discover -s ops/workspace-guest/python/tests -p test_browser_profile.py
The host part needs Playwright installed (the guest image has it) and is skipped where it is missing.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa.browser import _paths, _profile, _sessions  # noqa: E402
try:  # The standard guest image does not install Playwright; host fakes run where it is present.
    from aiqsa.browser import _host  # noqa: E402
except ModuleNotFoundError:  # pragma: no cover - exercised only in the slim guest test image
    _host = None  # type: ignore[assignment]


def cookie(name: str, domain: str, value: str = "v", expires: float = -1) -> Dict[str, Any]:
    return {"name": name, "value": value, "domain": domain, "path": "/", "expires": expires, "httpOnly": True,
            "secure": True, "sameSite": "Lax"}


class ProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.secrets = Path(self.directory.name) / "workspace" / "secrets"
        self.root = self.secrets / ".browser-profile"
        self.profile = _profile.ChatProfile(self.root, clock=lambda: 1_000.0)

    def tearDown(self) -> None:
        self.profile.release()
        self.directory.cleanup()

    def put(self, relative: str, size: int) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x" * size)

    def test_a_new_profile_is_private_and_starts_fresh(self) -> None:
        self.profile.prepare("148.0.7000.0")
        self.assertTrue(self.profile.fresh)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        self.put("Default/Cookies", 10)
        again = _profile.ChatProfile(self.root)
        again.prepare("148.0.7000.0")
        self.assertFalse(again.fresh)
        self.assertEqual((again.notes, self.profile.notes), ([], []))

    def test_one_host_holds_the_profile_and_a_second_is_refused_after_waiting(self) -> None:
        self.profile.acquire()
        other = _profile.ChatProfile(self.root)
        started = time.monotonic()
        with self.assertRaises(_profile.ProfileError) as raised:
            other.acquire(wait=0.3)
        self.assertEqual(raised.exception.code, "browser_profile_busy")
        self.assertGreaterEqual(time.monotonic() - started, 0.3)
        self.profile.release()
        other.acquire(wait=0.3)
        other.release()

    def test_over_its_bound_the_caches_go_first_then_the_whole_profile(self) -> None:
        self.profile.prepare("148.0.7000.0")
        self.put("Default/Cookies", 100)
        self.put("Default/Cache/Cache_Data/data_1", 3_000)
        self.put("Default/Service Worker/CacheStorage/a/b", 1_000)
        self.put("GrShaderCache/data_0", 500)
        with mock.patch.object(_profile, "MAX_BYTES", 2_000):
            self.profile.prepare("148.0.7000.0")
            self.assertFalse(self.profile.fresh)
            self.assertTrue((self.root / "Default/Cookies").exists())
            for relative in ("Default/Cache", "Default/Service Worker/CacheStorage", "GrShaderCache"):
                self.assertFalse((self.root / relative).exists(), relative)
            self.assertIn("caches were cleared; cookies and site data stay", self.profile.notes[-1])
            self.put("Default/IndexedDB/https_shop.example_0.indexeddb.leveldb/000003.log", 5_000)
            self.profile.prepare("148.0.7000.0")
        self.assertTrue(self.profile.fresh)
        self.assertEqual(os.listdir(self.root), [])
        self.assertIn("so it was reset", self.profile.notes[-1])

    def test_a_profile_a_newer_chromium_made_is_set_aside_and_one_set_aside_is_kept(self) -> None:
        self.profile.prepare("148.0.7000.0")
        self.put("Default/Cookies", 10)
        self.assertTrue(self.profile.write("150.0.1.0", {}, [], {}))
        self.profile.prepare("148.0.7000.0")
        self.assertTrue(self.profile.fresh)
        self.assertTrue((self.profile.aside / "Default/Cookies").exists())
        self.assertIn("made by a newer Chromium (150.0.1.0)", self.profile.notes[-1])
        # The next one replaces it; undoing a set-aside brings back the newest.
        self.put("Default/Preferences", 5)
        self.profile.set_aside()
        self.assertFalse((self.profile.aside / "Default/Cookies").exists())
        self.assertTrue(self.profile.restore_set_aside())
        self.assertTrue((self.root / "Default/Preferences").exists())
        self.assertFalse(self.profile.restore_set_aside())
        # Nobody reads a set-aside profile: the next browser start deletes it, a restart in between keeps it.
        self.profile.set_aside()
        self.profile.prepare("148.0.7000.0", bound=False)
        self.assertTrue(self.profile.aside.exists())
        self.profile.prepare("148.0.7000.0")
        self.assertFalse(self.profile.aside.exists())

    def test_chromium_lock_of_a_gone_browser_is_cleared_and_an_orphan_on_this_profile_ends(self) -> None:
        self.profile.prepare("148.0.7000.0")
        os.symlink("other-host-4242", self.root / "SingletonLock")
        os.symlink("/tmp/gone/SingletonSocket", self.root / "SingletonSocket")
        self.profile.prepare("148.0.7000.0")
        self.assertFalse(os.path.lexists(self.root / "SingletonLock"))
        self.assertFalse(os.path.lexists(self.root / "SingletonSocket"))
        orphan = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", f"--user-data-dir={self.root}"])
        self.addCleanup(lambda: (orphan.kill(), orphan.wait()))
        bystander = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.addCleanup(lambda: (bystander.kill(), bystander.wait()))
        deadline = time.monotonic() + 5
        while not _profile._runs_on(orphan.pid, self.root) and time.monotonic() < deadline:
            time.sleep(0.05)
        os.symlink(f"{socket.gethostname()}-{orphan.pid}", self.root / "SingletonLock")
        self.profile.prepare("148.0.7000.0")
        self.assertIsNotNone(orphan.wait(timeout=5))
        os.symlink(f"{socket.gethostname()}-{bystander.pid}", self.root / "SingletonLock")
        self.profile.prepare("148.0.7000.0")
        self.assertIsNone(bystander.poll(), "a process that is no browser on this profile is left alone")

    def test_a_link_in_place_of_the_profile_is_never_followed(self) -> None:
        elsewhere = Path(self.directory.name) / "workspace" / "project"
        elsewhere.mkdir(parents=True)
        (elsewhere / "keep.txt").write_text("project file")
        self.secrets.mkdir(parents=True)
        os.symlink(elsewhere, self.root)
        self.profile.prepare("148.0.7000.0")
        self.assertFalse(self.root.is_symlink())
        self.assertTrue(self.profile.fresh)
        self.assertEqual(os.listdir(elsewhere), ["keep.txt"])
        linked = Path(self.directory.name) / "linked"
        linked.mkdir()
        os.rmdir(self.root)
        os.rmdir(self.secrets)
        os.symlink(linked, self.secrets)
        with self.assertRaises(_profile.ProfileError):
            _profile.ChatProfile(self.root).prepare("148.0.7000.0")

    def test_the_bookkeeping_survives_a_restart_bounded_and_written_only_when_it_changed(self) -> None:
        self.profile.prepare("148.0.7000.0")
        cookies = [cookie("cart", "shop.example"), cookie("old", "shop.example", expires=500), cookie("sid", "shop.example", expires=5_000)]
        tabs = {f"agent-{index}": {"urls": [f"https://site{index}.example/"], "current": 0, "used": index} for index in range(10)}
        applied = {"shop.example.json": {"savedAt": 7, "key": "k"}}
        self.assertTrue(self.profile.write("148.0.7000.0", applied, cookies, tabs))
        self.assertFalse(self.profile.write("148.0.7000.0", applied, cookies, tabs))
        again = _profile.ChatProfile(self.root, clock=lambda: 1_000.0)
        again.prepare("148.0.7000.0")
        self.assertEqual(again.applied(), applied)
        self.assertEqual([entry["name"] for entry in again.cookies()], ["cart", "sid"], "an expired cookie is not restored")
        self.assertEqual(sorted(again.tabs()), [f"agent-{index}" for index in range(2, 10)], "the longest unused go first")
        self.assertEqual(again.tabs()["agent-9"], {"urls": ["https://site9.example/"], "current": 0, "used": 9})
        with mock.patch.object(_profile, "STATE_MAX_BYTES", 600):
            self.assertTrue(again.write("148.0.7000.0", applied, [cookie("big", "shop.example", "v" * 1_000)], {}))
        self.assertEqual(again.state["cookies"], [], "past the bound the copy keeps no cookies, the rest stays")
        self.assertEqual(again.applied(), applied)
        (self.root / _profile.STATE_FILE).write_text("{not json")
        broken = _profile.ChatProfile(self.root)
        broken.prepare("148.0.7000.0")
        self.assertEqual((broken.applied(), broken.cookies(), broken.tabs()), ({}, [], {}))

    def test_saved_sign_ins_are_applied_when_the_profile_holds_no_newer_copy(self) -> None:
        files = {"new.example.json": {"aiqsa": {"savedAt": 50}}, "held.example.json": {"aiqsa": {"savedAt": 50}},
                 "newer.example.json": {"aiqsa": {"savedAt": 90}}, "older.example.json": {"aiqsa": {"savedAt": 30}},
                 "uploaded.example.json": {}}
        keys = {"new.example.json": "a", "held.example.json": "b", "newer.example.json": "c2", "older.example.json": "d2",
                "uploaded.example.json": "e2"}
        applied = {"held.example.json": {"savedAt": 50, "key": "b"}, "newer.example.json": {"savedAt": 60, "key": "c1"},
                   "older.example.json": {"savedAt": 40, "key": "d1"}, "uploaded.example.json": {"savedAt": 0, "key": "e1"}}
        self.assertEqual(_profile.sign_ins_to_apply(files, keys, applied, _sessions.saved_at),
                         ["new.example.json", "newer.example.json", "uploaded.example.json"])

    def test_only_web_pages_are_remembered_as_tabs(self) -> None:
        record = _profile.tab_record(["about:blank", "https://shop.example/cart?id=1", "chrome-error://chromewebdata/",
                                      "http://mail.example/", "https://x.example/" + "a" * 5_000], 3, 9)
        self.assertEqual(record, {"urls": ["https://shop.example/cart?id=1", "http://mail.example/"], "current": 1, "used": 9})
        self.assertEqual(_profile.tab_record(["about:blank"], 0, 1), {"urls": [], "current": -1, "used": 1})


class FakePage:
    def __init__(self, url: str = "about:blank") -> None:
        self.url = url
        self.closed = False
        self.handlers: Dict[str, Any] = {}
        self.visits: List[str] = []
        self.stored: Dict[str, List[Any]] = {}
        self.routes = 0
        self.frames: List[Any] = []

    def is_closed(self) -> bool:
        return self.closed

    def on(self, event: str, handler: Any) -> None:
        self.handlers[event] = handler

    async def close(self) -> None:
        self.closed = True
        if "close" in self.handlers:
            self.handlers["close"](self)

    async def route(self, *_: Any) -> None:
        self.routes += 1

    async def unroute(self, *_: Any) -> None:
        self.routes -= 1

    async def goto(self, url: str, **_: Any) -> None:
        self.url = url
        self.visits.append(url)

    async def evaluate(self, script: str, argument: Any = None) -> None:
        self.stored[self.url] = argument


class FakeSession:
    def __init__(self) -> None:
        self.sent: List[str] = []

    async def send(self, method: str, params: Any = None) -> Dict[str, Any]:
        self.sent.append(method)
        return {}

    async def detach(self) -> None:
        pass


class FakeContext:
    def __init__(self) -> None:
        self.pages: List[FakePage] = [FakePage()]
        self.added: List[List[Dict[str, Any]]] = []
        self.jar: List[Dict[str, Any]] = []
        self.listeners: Dict[str, Any] = {}
        self.closed = False

    def on(self, event: str, handler: Any) -> None:
        self.listeners[event] = handler

    def remove_listener(self, event: str, *_: Any) -> None:
        self.listeners.pop(event, None)

    async def add_cookies(self, cookies: List[Dict[str, Any]]) -> None:
        if any(entry.get("name") == "refused" for entry in cookies):
            raise _host.PlaywrightError("invalid cookie")
        self.added.append(cookies)

    async def cookies(self) -> List[Dict[str, Any]]:
        return list(self.jar)

    async def new_page(self) -> FakePage:
        page = FakePage()
        self.pages.append(page)
        if "page" in self.listeners:
            self.listeners["page"](page)
        return page

    async def new_cdp_session(self, page: Any) -> FakeSession:
        return FakeSession()

    async def close(self) -> None:
        self.closed = True


class FakeChromium:
    def __init__(self, failures: int = 0) -> None:
        self.failures = failures
        self.launched: List[Path] = []
        self.options: List[Dict[str, Any]] = []
        self.context: Optional[FakeContext] = None

    async def launch_persistent_context(self, path: str, **options: Any) -> FakeContext:
        self.launched.append(Path(path))
        self.options.append(options)
        if self.failures:
            self.failures -= 1
            raise _host.PlaywrightError("Browser closed: profile could not be read")
        self.context = FakeContext()
        return self.context


@unittest.skipIf(_host is None, "needs Playwright")
class HostProfileTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        _paths.use_test_root(self.directory.name, sys.executable)
        self.addCleanup(_paths.use_test_root, None)
        self.addCleanup(self.directory.cleanup)
        self.host = _host.Host({})
        self.host.version = "148.0.7000.0"
        self.chromium = FakeChromium()
        self.host.playwright = SimpleNamespace(chromium=self.chromium)
        self.sessions = _paths.sessions_dir()
        self.sessions.mkdir(parents=True)
        self.addCleanup(self.host.profile.release)

    def write_session(self, name: str, value: Dict[str, Any]) -> None:
        (self.sessions / name).write_text(json.dumps(value), "utf-8")

    async def test_launch_opens_the_profile_and_puts_its_cookie_copy_then_only_newer_sign_ins_on_top(self) -> None:
        # An earlier turn left a profile: it holds shop.example's sign-in, a session cookie Chromium would drop, and tabs.
        profile = _profile.ChatProfile(_paths.profile_dir())
        profile.prepare("148.0.7000.0")
        (profile.root / "Default").mkdir()
        self.write_session("shop.example.json", {"cookies": [cookie("sid", "shop.example", "held")], "origins": [], "aiqsa": {"savedAt": 50}})
        self.write_session("mail.example.json", {"cookies": [cookie("sid", "mail.example", "from-another-chat")],
                                                 "origins": [{"origin": "https://mail.example", "localStorage": [{"name": "t", "value": "1"}]}],
                                                 "aiqsa": {"savedAt": 90}})
        store = _sessions.SessionStore(self.sessions)
        store.load()
        profile.write("148.0.7000.0", {"shop.example.json": {"savedAt": 50, "key": store.keys["shop.example.json"]},
                                       "mail.example.json": {"savedAt": 60, "key": "older"}},
                      [cookie("cart", "shop.example", "anonymous"), cookie("gone", "shop.example", expires=1)],
                      {"main": {"urls": ["https://shop.example/cart"], "current": 0, "used": 1}})
        self.host.store.load()
        applied = await self.host._launch()
        self.assertEqual(applied, ["mail.example.json"])
        self.assertEqual(self.chromium.launched, [_paths.profile_dir()])
        options = self.chromium.options[0]
        self.assertIn(f"--disk-cache-size={_profile.DISK_CACHE_BYTES}", options["args"])
        self.assertEqual((options["channel"], options["headless"], options["no_viewport"], options["accept_downloads"]),
                         ("chromium", True, True, True))
        context = self.chromium.context
        self.assertEqual([[entry["name"] for entry in batch] for batch in context.added], [["cart"], ["sid"]])
        self.assertEqual(context.added[1][0]["value"], "from-another-chat")
        helper = context.pages[0]
        self.assertEqual(helper.stored, {"https://mail.example/": [{"name": "t", "value": "1"}]})
        self.assertEqual((helper.url, helper.routes), ("about:blank", 0))
        self.assertEqual(self.host.tab_records["main"]["urls"], ["https://shop.example/cart"])
        self.assertFalse(self.host.profile.fresh)
        # Its own close is no crash.
        await self.host._close_context(context, 1)
        self.assertNotIn("close", context.listeners)
        self.assertFalse(self.host.crashed)

    async def test_a_profile_chromium_cannot_open_is_set_aside_and_a_fresh_one_starts(self) -> None:
        profile = _profile.ChatProfile(_paths.profile_dir())
        profile.prepare("148.0.7000.0")
        (profile.root / "Default").mkdir()
        (profile.root / "Default" / "Cookies").write_text("corrupt")
        self.chromium.failures = 1
        await self.host._launch()
        self.assertEqual(len(self.chromium.launched), 2)
        self.assertTrue((self.host.profile.aside / "Default" / "Cookies").exists())
        self.assertTrue(self.host.profile.fresh)
        self.assertIn("could not be opened (Browser closed: profile could not be read)", self.host.profile.notes[-1])

    async def test_when_a_fresh_profile_fails_too_the_old_one_comes_back(self) -> None:
        profile = _profile.ChatProfile(_paths.profile_dir())
        profile.prepare("148.0.7000.0")
        (profile.root / "Default").mkdir()
        (profile.root / "Default" / "Cookies").write_text("fine")
        self.chromium.failures = 2
        with self.assertRaises(_host.PlaywrightError):
            await self.host._launch()
        self.assertEqual((profile.root / "Default" / "Cookies").read_text(), "fine")
        self.assertFalse(self.host.profile.aside.exists())

    async def test_tabs_reopen_in_their_own_agent_and_a_release_keeps_them_for_its_next_turn(self) -> None:
        await self.host._launch()
        self.host._check_memory = lambda: None  # type: ignore[method-assign]
        opened: List[str] = []

        async def route(page: Any, url: str, value: Any) -> None:
            return None

        async def goto(page: Any, url: str) -> int:
            if "broken" in url:
                raise _host.HostError("navigation_failed", "net::ERR_NAME_NOT_RESOLVED")
            await page.goto(url)
            opened.append(url)
            return 200

        self.host._route_navigation = route  # type: ignore[method-assign]
        self.host._goto = goto  # type: ignore[method-assign]
        self.host.tab_records = {"thread-7": {"urls": ["https://shop.example/cart", "https://broken.example/"], "current": 0, "used": 5}}
        sub = self.host._state_for("thread-7", "shop")
        main = self.host._state_for("main")
        self.assertFalse(await self.host._reopen_tabs(main), "the main agent had no tabs")
        self.assertTrue(await self.host._reopen_tabs(sub))
        self.assertFalse(await self.host._reopen_tabs(sub), "once per browser")
        self.assertEqual(opened, ["https://shop.example/cart"])
        self.assertEqual([tab.url for tab in sub.tabs], ["https://shop.example/cart", "about:blank"])
        self.assertIs(sub.current, sub.tabs[0])
        self.assertFalse(main.tabs)
        note = sub.notes[-1]
        self.assertIn("Reopened the tabs you had open at the end of your last turn: 1. shop.example/cart; 2. broken.example/", note)
        self.assertIn("The current tab is 1.", note)
        self.assertIn("Tab 2 did not load again: net::ERR_NAME_NOT_RESOLVED", note)
        # The sub-agent's turn ends with its release: its tabs close and are remembered as they were.
        sub.slot = True
        await self.host.release_agent("thread-7")
        self.assertTrue(all(tab.is_closed() for tab in sub.tabs) or not sub.tabs)
        self.assertEqual(self.host.tab_records["thread-7"]["urls"], ["https://shop.example/cart"])
        await self.host._autosave()
        written = json.loads((self.host.profile.root / _profile.STATE_FILE).read_text())
        self.assertEqual(written["tabs"]["thread-7"]["urls"], ["https://shop.example/cart"])
        # Its next turn in this same browser (a sub-agent continued within one boot) finds them again.
        self.assertTrue(await self.host._reopen_tabs(sub))
        self.assertEqual([tab.url for tab in sub.tabs if not tab.is_closed()], ["https://shop.example/cart"])

    async def test_a_password_typed_in_the_live_view_saves_the_sign_in_once_the_site_sets_new_cookies(self) -> None:
        await self.host._launch()
        context = self.chromium.context
        context.jar = [cookie("consent", ".shop.example", "yes")]
        page = FakePage("https://accounts.shop.example/login")
        await self.host.user_typed_password("main", page)
        await self.host.user_typed_password("main", page)
        self.assertEqual(list(self.host._pending_sign_ins), ["shop.example"])
        await self.host._autosave()
        self.assertFalse((self.sessions / "shop.example.json").exists(), "no new cookies yet: nothing is saved")
        context.jar = [cookie("consent", ".shop.example", "yes"), cookie("sid", ".shop.example", "signed-in"),
                       cookie("other", "elsewhere.example")]
        await self.host._autosave()
        saved = json.loads((self.sessions / "shop.example.json").read_text())
        self.assertEqual(sorted(entry["name"] for entry in saved["cookies"]), ["consent", "sid"])
        self.assertEqual(self.host.store.tracked["shop.example.json"], {"shop.example"})
        main = self.host._state_for("main")
        self.assertIn("The user signed in to shop.example in the live view", main.notes[-1])
        self.assertEqual([step["action"] for step in main.steps], ["save_session"])
        self.assertEqual(self.host._pending_sign_ins, {})
        # A site that already has a saved sign-in is kept current anyway: nothing waits for it.
        await self.host.user_typed_password("main", FakePage("https://www.shop.example/again"))
        self.assertEqual(self.host._pending_sign_ins, {})


if __name__ == "__main__":
    unittest.main()
