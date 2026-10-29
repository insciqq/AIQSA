"""The real browser Host and LiveHub together, with fake Playwright pages and CDP sessions.

Requires the guest's pinned Playwright Python package, but never starts Chromium.
Run: python3 -m unittest discover -s ops/workspace-guest/python/tests -p test_browser_host_live.py
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import tempfile
import time
import unittest
from typing import Any, Dict, List
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa.browser import _dom, _live, _livehub, _paths  # noqa: E402
from test_browser_livehub import FakeFrame, FakePage, FakeSession, View, jpeg  # noqa: E402

try:
    from aiqsa.browser import _host  # noqa: E402
except ModuleNotFoundError:  # pragma: no cover - the slim guest has no Playwright
    _host = None  # type: ignore[assignment]


class PageFrame(FakeFrame):
    def __init__(self, page: "Page") -> None:
        self.page = page
        self.reads = 0

    @property
    def url(self) -> str:
        return self.page.url

    async def evaluate(self, script: str, _args: Any = None) -> Any:
        if script == _dom.LOCAL_STORAGE:
            return []
        if script == _dom.TEXT:
            self.reads += 1
            return self.page._title
        raise AssertionError("Unexpected page evaluation")


class Page(FakePage):
    def __init__(self, url: str, title: str) -> None:
        super().__init__(url, title)
        self.main_frame = PageFrame(self)
        self.frames = [self.main_frame]
        self.handlers: Dict[str, Any] = {}

    def on(self, event: str, handler: Any) -> None:
        self.handlers[event] = handler

    async def close(self) -> None:
        self.closed = True
        self.handlers["close"](self)


class BrowserContext:
    def __init__(self) -> None:
        self.pages: List[Page] = []
        self.sessions: Dict[Page, FakeSession] = {}

    async def new_page(self) -> Page:
        index = len(self.pages)
        page = Page(f"https://site{index}.example.com/login", f"Site {index}")
        self.pages.append(page)
        return page

    async def new_cdp_session(self, page: Page) -> FakeSession:
        session = self.sessions[page] = FakeSession()
        return session

    async def cookies(self) -> List[Dict[str, Any]]:
        return [{"name": "session", "value": "synthetic", "domain": f"site{index}.example.com", "path": "/",
                 "expires": -1, "httpOnly": True, "secure": True, "sameSite": "Lax"}
                for index in range(len(self.pages))]


class HostView(View):
    """Enter through Host.serve, including the long-lived request's agent context."""

    async def open_host(self, host: Any, **args: Any) -> "HostView":
        ours, theirs = socket.socketpair()
        reader, writer = await asyncio.open_connection(sock=theirs)
        self.reader, self.writer = await asyncio.open_connection(sock=ours, limit=4 * 1024 * 1024)
        self.task = asyncio.create_task(host.serve(reader, writer))
        self.pump = asyncio.create_task(self.read())
        self.send({"v": _host.PROTOCOL, "op": "live", "args": args})
        await self.ask({"t": "ping"})
        return self

    async def close(self) -> None:
        self.writer.close()
        await self.writer.wait_closed()
        await asyncio.wait_for(self.task, 2)
        await asyncio.wait_for(self.pump, 2)


@unittest.skipUnless(_host is not None, "Playwright is not installed")
class HostLiveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        previous = _paths.current_test_root()
        _paths.use_test_root(directory.name)
        self.addCleanup(_paths.use_test_root, previous)
        _paths.workspace_dir().mkdir()
        self.host = _host.Host({})
        self.host.context = BrowserContext()
        self.views: List[HostView] = []
        self.addAsyncCleanup(self.close_views)
        # Only the browser API is fake. Commands create and prepare their own
        # pages through Host's real dispatcher, slot admission and page ownership.
        for agent in ("main", "thread-shop"):
            self.assertTrue((await self.command(agent))["ok"])
        self.main = self.host._states["main"]
        self.sub = self.host._states["thread-shop"]
        self.main_page, self.sub_page = self.main.current, self.sub.current

    async def close_views(self) -> None:
        for view in self.views:
            await view.close()
        await self.host.live.close()
        if self.host.live.watcher is not None:
            await asyncio.gather(self.host.live.watcher, return_exceptions=True)

    async def command(self, agent: str, op: str = "text", **args: Any) -> Dict[str, Any]:
        ours, theirs = socket.socketpair()
        reader, writer = await asyncio.open_connection(sock=ours)
        host_reader, host_writer = await asyncio.open_connection(sock=theirs)
        task = asyncio.create_task(self.host.serve(host_reader, host_writer))
        try:
            request = {"v": _host.PROTOCOL, "op": op, "args": args,
                       "agent": {"id": agent, "name": "shop" if agent == "thread-shop" else ""}}
            writer.write(json.dumps(request).encode("ascii") + b"\n")
            response = json.loads(await asyncio.wait_for(reader.readline(), 2))
            await asyncio.wait_for(task, 2)
            return response
        finally:
            writer.close()
            await writer.wait_closed()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def view(self, **args: Any) -> HostView:
        view = await HostView(self.host.live).open_host(self.host, **args)
        self.views.append(view)
        return view

    async def test_lists_both_agents_and_streams_only_the_selected_tab(self) -> None:
        view = await self.view(frames=True)
        listed = view.last("agents")["agents"]
        self.assertEqual([(entry["agent"], entry["name"], entry["page"]["url"]) for entry in listed],
                         [("main", None, self.main_page.url), ("thread-shop", "shop", self.sub_page.url)])
        self.assertTrue(all(entry["acted"] > 0 for entry in listed))
        main_session = self.main.cdp[self.main_page]
        sub_session = self.sub.cdp[self.sub_page]
        self.assertIn("Page.startScreencast", main_session.methods())
        self.assertNotIn("Page.startScreencast", sub_session.methods())
        self.assertTrue((await view.ask({"t": "select", "agent": self.sub.agent_id}))["ok"])
        self.assertEqual(self.host._selected_agent_id, self.sub.agent_id)
        self.assertEqual(view.last("state")["page"]["url"], self.sub_page.url)
        self.assertIn("Page.stopScreencast", main_session.methods())
        self.assertIn("Page.startScreencast", sub_session.methods())
        # A late frame from the previous cast must not appear under the new agent.
        main_session.frame(jpeg(40, 30))
        sub_session.frame(jpeg(80, 60))
        for _ in range(100):
            if view.of("frame"):
                break
            await asyncio.sleep(0.01)
        self.assertEqual([(frame["agent"], frame["width"]) for frame in view.of("frame")], [(self.sub.agent_id, 80)])

    async def test_targets_omit_unused_agents_but_keep_slots_and_released_main_tabs(self) -> None:
        self.host._state_for("unused")
        slot = self.host._state_for("waiting")
        slot.slot = True
        self.assertEqual([target.agent for target in self.host.live_targets()], ["main", self.sub.agent_id, "waiting"])
        self.assertTrue((await self.command(self.sub.agent_id, "release"))["ok"])
        self.assertTrue((await self.command("main", "release"))["ok"])
        targets = self.host.live_targets()
        self.assertEqual([target.agent for target in targets], ["main", "waiting"])
        self.assertIs(targets[0].page, self.main_page)
        self.assertIsNone(targets[1].page)

    async def test_subagent_input_and_return_notice_never_reach_the_main_agent(self) -> None:
        view = await self.view()
        before = self.main.last_used
        self.sub.last_used = time.monotonic() - 1000
        self.assertTrue((await view.ask({"t": "control", "action": "take", "agent": self.sub.agent_id}))["ok"])
        self.assertGreater(self.sub.last_used, before)
        self.assertEqual(self.main.last_used, before)
        self.assertTrue(self.host.live.agent_held_by_user(self.sub.agent_id))
        self.assertFalse(self.host.live.agent_held_by_user("main"))
        with mock.patch.object(_live, "CONTROL_WAIT_SECONDS", 0.05):
            main, sub = await asyncio.gather(self.command("main"), self.command(self.sub.agent_id))
        self.assertEqual(main["result"]["text"], "Site 0")
        self.assertEqual(sub["error"]["code"], "user_in_control")
        self.assertEqual(self.sub_page.main_frame.reads, 1)
        self.assertTrue((await self.command(self.sub.agent_id, "steps"))["ok"])
        event = {"kind": "text", "text": "private-input"}
        self.sub.last_used = 1
        self.assertTrue((await view.ask({"t": "input", "agent": self.sub.agent_id, "input": event}))["ok"])
        self.assertGreater(self.sub.last_used, 1)
        self.assertIn(("Input.insertText", {"text": "private-input"}), self.sub.cdp[self.sub_page].sent)
        self.assertNotIn("Input.insertText", self.main.cdp[self.main_page].methods())
        self.assertEqual(self.main.hidden.text("private-input"), "private-input")
        self.assertNotEqual(self.sub.hidden.text("private-input"), "private-input")
        self.assertEqual((await view.ask({"t": "input", "agent": "main", "input": event}))["code"], "not_in_control")
        self.assertTrue((await view.ask({"t": "control", "action": "return", "agent": self.sub.agent_id}))["ok"])
        self.assertTrue((await self.command("main"))["ok"])
        self.assertTrue((await self.command(self.sub.agent_id, "steps"))["ok"])
        returned = await self.command(self.sub.agent_id)
        self.assertEqual(returned["error"]["code"], "user_returned_control")
        self.assertIn(self.sub_page.url, returned["error"]["message"])
        self.assertNotIn(self.main_page.url, returned["error"]["message"])
        self.assertEqual(self.sub_page.main_frame.reads, 1)
        self.assertEqual((await self.command(self.sub.agent_id))["result"]["text"], "Site 1")

    async def test_subagent_handoff_answers_and_saves_its_site_while_viewing_main(self) -> None:
        view = await self.view()
        self.assertTrue((await view.ask({"t": "handoff", "action": "begin", "agent": self.sub.agent_id}))["ok"])
        listed = {entry["agent"]: entry for entry in view.last("agents")["agents"]}
        self.assertTrue(listed[self.sub.agent_id]["handoff"])
        self.assertFalse(listed["main"]["handoff"])
        self.assertTrue((await self.command("main"))["ok"])
        # The streamer's task inherited main's context; saving must explicitly
        # enter the handoff agent's context even when another tab is selected.
        self.assertEqual(self.host._selected_agent_id, "main")
        ended = await view.ask({"t": "handoff", "action": "end", "agent": self.sub.agent_id,
                                "outcome": "completed", "reason": "sign_in"})
        self.assertTrue(ended["ok"])
        self.assertEqual(ended["page"], {"url": self.sub_page.url, "title": "Site 1"})
        self.assertEqual(ended["saved"], "site1.example.com")
        self.assertEqual(sorted(self.host.store.tracked), ["site1.example.com.json"])
        saved = json.loads((_paths.sessions_dir() / "site1.example.com.json").read_text())
        self.assertEqual([cookie["domain"] for cookie in saved["cookies"]], ["site1.example.com"])
        self.assertEqual([step["action"] for step in self.sub.steps], ["save_session"])
        self.assertFalse(self.main.steps)
        self.assertFalse(self.host.live.agent_held_by_user(self.sub.agent_id))
        self.assertTrue((await self.command(self.sub.agent_id))["ok"])

    async def test_default_session_save_uses_main_and_restores_the_callers_context(self) -> None:
        self.host.select_live_agent(self.sub.agent_id)
        token = self.host._agent_context.set(self.sub.agent_id)
        try:
            self.assertEqual(await self.host.save_site_session(), "site0.example.com")
            self.assertIs(self.host._active_state(), self.sub)
            self.assertEqual([step["action"] for step in self.main.steps], ["save_session"])
            self.assertFalse(self.sub.steps)
        finally:
            self.host._agent_context.reset(token)

    async def test_release_keeps_the_subagent_tab_during_user_control_and_handoffs(self) -> None:
        view = await self.view()
        for kind, action in (("control", "take"), ("handoff", "begin")):
            with self.subTest(kind=kind):
                self.assertTrue((await view.ask({"t": kind, "action": action, "agent": self.sub.agent_id}))["ok"])
                response = await self.command(self.sub.agent_id, "release")
                self.assertFalse(self.sub_page.closed)
                self.assertTrue(self.sub.slot)
                self.assertEqual(response["error"]["code"], "user_in_control")
                returned = {"t": kind, "agent": self.sub.agent_id, "action": "return" if kind == "control" else "end"}
                self.assertTrue((await view.ask({**returned, "outcome": "cancelled"}))["ok"])
        self.assertTrue((await self.command(self.sub.agent_id, "release"))["ok"])
        self.assertTrue(self.sub_page.closed)
        self.assertFalse(self.sub.slot)
        self.assertFalse(self.main_page.closed)

    async def test_main_close_refuses_another_agents_user_control_and_handoff(self) -> None:
        view = await self.view()
        with mock.patch.object(self.host, "stop", new_callable=mock.AsyncMock) as stop:
            for kind, action in (("control", "take"), ("handoff", "begin")):
                with self.subTest(kind=kind):
                    self.assertTrue((await view.ask({"t": kind, "action": action, "agent": self.sub.agent_id}))["ok"])
                    response = await self.command("main", "close")
                    stop.assert_not_awaited()
                    self.assertEqual(response["error"]["code"], "user_in_control")
                    self.assertFalse(self.host._closing)
                    returned = {"t": kind, "agent": self.sub.agent_id, "action": "return" if kind == "control" else "end"}
                    self.assertTrue((await view.ask({**returned, "outcome": "cancelled"}))["ok"])
            self.assertTrue((await self.command("main", "close"))["ok"])
            stop.assert_awaited_once()

    async def test_release_rechecks_control_after_waiting_for_the_browser_lock(self) -> None:
        view = await self.view()
        locked = asyncio.Event()
        acquire = self.sub.lock.acquire

        async def acquire_agent_lock() -> bool:
            result = await acquire()
            locked.set()
            return result

        await self.host.browser_lock.acquire()
        with mock.patch.object(self.sub.lock, "acquire", side_effect=acquire_agent_lock):
            release = asyncio.create_task(self.command(self.sub.agent_id, "release"))
            try:
                await asyncio.wait_for(locked.wait(), 1)
                with mock.patch.object(_livehub, "TAKE_WAIT_SECONDS", 0.01):
                    self.assertTrue((await view.ask({"t": "control", "action": "take", "agent": self.sub.agent_id}))["ok"])
            finally:
                self.host.browser_lock.release()
                response = await release
        self.assertEqual(response["error"]["code"], "user_in_control")
        self.assertFalse(self.sub_page.closed)
        self.assertTrue(self.sub.slot)

    async def test_main_close_refuses_control_admitted_before_the_agent_lock_is_free(self) -> None:
        view = await self.view()
        waiting = asyncio.Event()
        acquire = self.sub.lock.acquire

        async def wait_for_agent_lock() -> bool:
            waiting.set()
            return await acquire()

        await self.sub.lock.acquire()
        with mock.patch.object(self.sub.lock, "acquire", side_effect=wait_for_agent_lock), \
                mock.patch.object(self.host, "stop", new_callable=mock.AsyncMock) as stop:
            take = asyncio.create_task(view.ask({"t": "control", "action": "take", "agent": self.sub.agent_id}))
            try:
                await asyncio.wait_for(waiting.wait(), 1)
                self.assertEqual(self.host.live.control_of(self.sub.agent_id).controller, "agent")
                response = await self.command("main", "close")
                stop.assert_not_awaited()
                self.assertEqual(response["error"]["code"], "user_in_control")
                self.assertFalse(self.host._closing)
            finally:
                self.sub.lock.release()
                self.assertTrue((await take)["ok"])

    async def test_shutdown_refuses_new_control_and_handoffs_until_stop_finishes(self) -> None:
        view = await self.view()
        stopping, finish = asyncio.Event(), asyncio.Event()

        async def stop() -> None:
            stopping.set()
            await finish.wait()

        with mock.patch.object(self.host, "stop", side_effect=stop) as stopped:
            close = asyncio.create_task(self.command("main", "close"))
            try:
                await asyncio.wait_for(stopping.wait(), 1)
                for kind, action in (("control", "take"), ("handoff", "begin")):
                    with self.subTest(kind=kind):
                        response = await view.ask({"t": kind, "action": action, "agent": self.sub.agent_id})
                        self.assertFalse(response["ok"])
                        self.assertEqual(response["code"], "browser_unavailable")
                        self.assertFalse(self.host.live.agent_held_by_user(self.sub.agent_id))
            finally:
                finish.set()
                self.assertTrue((await close)["ok"])
            stopped.assert_awaited_once()
        self.assertFalse(self.host._closing)

    async def test_idle_expiry_keeps_user_control_and_handoffs_until_returned(self) -> None:
        view = await self.view()
        for kind in ("control", "handoff"):
            with self.subTest(kind=kind):
                action = "take" if kind == "control" else "begin"
                self.assertTrue((await view.ask({"t": kind, "action": action, "agent": self.sub.agent_id}))["ok"])
                self.sub.last_used = time.monotonic() - _host.AGENT_IDLE_SECONDS - 1
                self.host._expire_agents_locked()
                await asyncio.wait_for(self.sub.expiry_task, 2)
                self.assertTrue(self.sub.slot)
                self.assertFalse(self.sub_page.closed)
                self.assertIsNone(self.sub.expiry_task)
                returned = {"t": kind, "agent": self.sub.agent_id, "action": "return" if kind == "control" else "end"}
                self.assertTrue((await view.ask({**returned, "outcome": "cancelled"}))["ok"])
        self.sub.last_used = time.monotonic() - _host.AGENT_IDLE_SECONDS - 1
        await self.host._expire_agent(self.sub, self.sub.last_used)
        self.assertFalse(self.sub.slot)
        self.assertTrue(self.sub_page.closed)
        self.assertFalse(self.main_page.closed)

    async def test_expiry_rechecks_user_control_after_waiting_for_the_browser_lock(self) -> None:
        view = await self.view()
        self.sub.last_used = time.monotonic() - _host.AGENT_IDLE_SECONDS - 1
        await self.host.browser_lock.acquire()
        expiry = asyncio.create_task(self.host._expire_agent(self.sub, self.sub.last_used))
        try:
            await asyncio.sleep(0)
            self.assertTrue(self.sub.lock.locked())
            with mock.patch.object(_livehub, "TAKE_WAIT_SECONDS", 0.01):
                self.assertTrue((await view.ask({"t": "control", "action": "take", "agent": self.sub.agent_id}))["ok"])
        finally:
            self.host.browser_lock.release()
            await asyncio.wait_for(expiry, 2)
        self.assertTrue(self.sub.slot)
        self.assertFalse(self.sub_page.closed)


if __name__ == "__main__":
    unittest.main()
