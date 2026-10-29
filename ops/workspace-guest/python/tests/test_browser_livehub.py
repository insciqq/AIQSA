"""The live hub per agent, against a fake host with fake tabs and CDP sessions (standard library only, no browser).

Run: python3 -m unittest discover -s ops/workspace-guest/python/tests -t ops/workspace-guest/python -p test_browser_livehub.py

The fake host is what the per-agent browser host provides (`Host.live_targets`, `Host.agent_steps`,
`Host.save_site_session(agent)`); `LegacyHost` is today's host with one current tab and one lock.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import socket
import sys
import unittest
from typing import Any, Callable, Dict, List, Optional, Tuple
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa import agents  # noqa: E402
from aiqsa.browser import _format, _live, _livehub  # noqa: E402


def jpeg(width: int, height: int) -> str:
    """A base64 JPEG header with a SOF0 frame size, enough for `_live.jpeg_size`."""
    sof = b"\xff\xc0\x00\x11\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x03" + b"\x00" * 9
    return base64.b64encode(b"\xff\xd8" + sof + b"\x00" * 8).decode("ascii")


class FakeSession:
    def __init__(self) -> None:
        self.sent: List[Tuple[str, Dict[str, Any]]] = []
        self.handlers: Dict[str, Callable[[Dict[str, Any]], None]] = {}

    async def send(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self.sent.append((method, params or {}))
        return {}

    def on(self, event: str, handler: Callable[[Dict[str, Any]], None]) -> None:
        self.handlers[event] = handler

    def methods(self) -> List[str]:
        return [method for method, _ in self.sent]

    def frame(self, data: str, sid: int = 1) -> None:
        self.handlers["Page.screencastFrame"]({"data": data, "sessionId": sid, "metadata": {"deviceWidth": 1280, "deviceHeight": 800}})


class FakeFrame:
    url = "https://shop.example/"

    def is_detached(self) -> bool:
        return False

    async def evaluate_handle(self, _script: str) -> Any:
        class Handle:
            def as_element(self) -> None:
                return None

            async def dispose(self) -> None:
                return None
        return Handle()


class FakePage:
    def __init__(self, url: str, title: str) -> None:
        self.url = url
        self._title = title
        self.closed = False
        self.main_frame = FakeFrame()
        self.frames = [self.main_frame]

    async def title(self) -> str:
        return self._title

    def is_closed(self) -> bool:
        return self.closed


class AgentHost:
    """The per-agent host: each agent's current tab, lock and steps."""

    def __init__(self) -> None:
        self.cdp: Dict[Any, FakeSession] = {}
        self.order: List[str] = []
        self.tabs: Dict[str, FakePage] = {}
        self.names: Dict[str, Optional[str]] = {}
        self.locks: Dict[str, asyncio.Lock] = {}
        self.acted: Dict[str, int] = {}
        self.steps_by: Dict[str, List[Dict[str, Any]]] = {}
        self.hidden = _format.HiddenValues()
        self.env_hidden = _format.HiddenValues()
        self.masked: Dict[Any, Any] = {}
        self.last_used = 0.0
        self.crashed = False
        self.saved: List[str] = []

    def add(self, agent: str, name: Optional[str], url: str, title: str, acted: int = 0) -> FakePage:
        page = FakePage(url, title)
        self.cdp[page] = FakeSession()
        self.order.append(agent)
        self.tabs[agent], self.names[agent], self.acted[agent] = page, name, acted
        self.locks[agent] = asyncio.Lock()
        self.steps_by[agent] = [{"n": 1, "action": "open", "target": "", "url": url}]
        return page

    def live_targets(self) -> List[_livehub.Target]:
        return [_livehub.Target(agent, self.names[agent], self.tabs[agent], self.locks[agent], self.acted[agent]) for agent in self.order]

    def agent_steps(self, agent: str) -> List[Dict[str, Any]]:
        return self.steps_by.get(agent, [])

    async def save_site_session(self, agent: str) -> Optional[str]:
        self.saved.append(agent)
        return "shop.example" if agent in self.tabs else None


class LegacyHost:
    """Today's host: one current tab under one lock, the main agent's."""

    def __init__(self) -> None:
        self.current = FakePage("https://shop.example/login", "Sign in")
        self.cdp = {self.current: FakeSession()}
        self.lock = asyncio.Lock()
        self.steps: List[Dict[str, Any]] = []
        self.hidden = _format.HiddenValues()
        self.env_hidden = _format.HiddenValues()
        self.masked: Dict[Any, Any] = {}
        self.last_used = 0.0
        self.crashed = False
        self.saves = 0

    async def save_site_session(self) -> Optional[str]:
        self.saves += 1
        return "shop.example"


class View:
    """One streamer's connection to the hub over a socket pair."""

    def __init__(self, hub: _livehub.LiveHub) -> None:
        self.hub = hub
        self.messages: List[Dict[str, Any]] = []
        self.task: Optional[asyncio.Task] = None

    async def open(self, **args: Any) -> "View":
        ours, theirs = socket.socketpair()
        hub_reader, hub_writer = await asyncio.open_connection(sock=theirs)
        self.reader, self.writer = await asyncio.open_connection(sock=ours, limit=4 * 1024 * 1024)
        self.task = asyncio.ensure_future(self.hub.serve(hub_reader, hub_writer, args))
        self.pump = asyncio.ensure_future(self.read())
        await asyncio.sleep(0.05)
        return self

    async def read(self) -> None:
        while True:
            line = await self.reader.readline()
            if not line:
                return
            self.messages.append(json.loads(line))

    def send(self, message: Dict[str, Any]) -> None:
        self.writer.write(json.dumps(message).encode("ascii") + b"\n")

    async def ask(self, message: Dict[str, Any]) -> Dict[str, Any]:
        ident = f"q{len(self.messages)}-{id(message)}"
        self.send({**message, "id": ident})
        for _ in range(200):
            await asyncio.sleep(0.01)
            for received in self.messages:
                if received.get("t") == "ack" and received.get("id") == ident:
                    return received
        raise AssertionError("no ack")

    def last(self, kind: str) -> Dict[str, Any]:
        return [message for message in self.messages if message.get("t") == kind][-1]

    def of(self, kind: str) -> List[Dict[str, Any]]:
        return [message for message in self.messages if message.get("t") == kind]

    async def close(self) -> None:
        self.writer.close()
        await asyncio.sleep(0.05)
        self.pump.cancel()


def run(coroutine: Any) -> Any:
    return asyncio.run(asyncio.wait_for(coroutine, 20))


class AgentIdTests(unittest.TestCase):
    def test_a_missing_agent_is_the_main_agent_and_a_malformed_one_is_refused(self) -> None:
        self.assertEqual(_livehub.agent_of({"t": "control"}), agents.MAIN_AGENT_ID)
        self.assertEqual(_livehub.agent_of({"agent": "thread_1"}), "thread_1")
        for bad in ("", "a b", "x" * 65, "../x", 7, None, "main\n"):
            with self.assertRaises(_live.LiveError):
                _livehub.agent_of({"agent": bad})


class LegacyHostTests(unittest.TestCase):
    def test_a_host_without_per_agent_tabs_lists_and_serves_the_main_agent(self) -> None:
        async def scenario() -> None:
            host = LegacyHost()
            hub = _livehub.LiveHub(host)
            view = await View(hub).open(frames=True)
            listed = view.last("agents")["agents"]
            self.assertEqual([entry["agent"] for entry in listed], ["main"])
            self.assertEqual(listed[0]["page"], {"url": "https://shop.example/login", "title": "Sign in"})
            self.assertEqual(view.last("state")["agent"], "main")
            # Protocol 1 messages, without an agent, act on the main agent's tab.
            self.assertTrue((await view.ask({"t": "handoff", "action": "begin"}))["ok"])
            self.assertEqual((await view.ask({"t": "control", "action": "return"}))["code"], "handoff_pending")
            ended = await view.ask({"t": "handoff", "action": "end", "outcome": "completed", "reason": "sign_in"})
            self.assertEqual((ended["saved"], host.saves), ("shop.example", 1))
            await view.close()
            await hub.close()
        run(scenario())


class PerAgentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.wait = mock.patch.object(_live, "CONTROL_WAIT_SECONDS", 0.3)
        self.wait.start()

    def tearDown(self) -> None:
        self.wait.stop()

    @staticmethod
    def three() -> Tuple[AgentHost, _livehub.LiveHub]:
        host = AgentHost()
        host.add("main", None, "https://amazon.es/", "Amazon", acted=1)
        host.add("t_amazon", "amazon", "https://amazon.es/s?k=kettle", "Kettles", acted=3)
        host.add("t_shop", "shop", "https://saucedemo.com/", "Swag Labs", acted=2)
        return host, _livehub.LiveHub(host)

    def test_the_agents_message_lists_every_browsing_agent_with_its_page_and_last_action(self) -> None:
        async def scenario() -> None:
            host, hub = self.three()
            view = await View(hub).open()
            listed = view.last("agents")["agents"]
            self.assertEqual([(entry["agent"], entry["name"], entry["acted"]) for entry in listed],
                             [("main", None, 1), ("t_amazon", "amazon", 3), ("t_shop", "shop", 2)])
            self.assertEqual(listed[1]["page"], {"url": "https://amazon.es/s?k=kettle", "title": "Kettles"})
            self.assertTrue(all(entry["controller"] == "agent" and entry["handoff"] is False for entry in listed))
            await view.close()
            await hub.close()
        run(scenario())

    def test_select_streams_the_chosen_agent_state_steps_and_frames(self) -> None:
        async def scenario() -> None:
            host, hub = self.three()
            view = await View(hub).open(frames=True)
            main_session = host.cdp[host.tabs["main"]]
            self.assertIn("Page.startScreencast", main_session.methods())
            view.send({"t": "select", "agent": "t_shop"})
            await asyncio.sleep(0.05)
            state = view.last("state")
            self.assertEqual((state["agent"], state["page"]["title"]), ("t_shop", "Swag Labs"))
            self.assertEqual(view.last("steps")["agent"], "t_shop")
            self.assertEqual(view.last("steps")["steps"][0]["host"], "saucedemo.com")
            # The cast moved: the main tab stopped, the shop tab streams, and its frames carry their agent.
            self.assertIn("Page.stopScreencast", main_session.methods())
            shop_session = host.cdp[host.tabs["t_shop"]]
            self.assertIn("Page.startScreencast", shop_session.methods())
            shop_session.frame(jpeg(640, 400))
            await asyncio.sleep(0.2)
            frame = view.last("frame")
            self.assertEqual((frame["agent"], frame["width"], frame["height"]), ("t_shop", 640, 400))
            # A frame of a tab no view streams is acknowledged and dropped.
            before = len(view.of("frame"))
            main_session.handlers["Page.screencastFrame"]({"data": jpeg(10, 10), "sessionId": 9, "metadata": {}})
            await asyncio.sleep(0.2)
            self.assertEqual(len(view.of("frame")), before)
            self.assertIn(("Page.screencastFrameAck", {"sessionId": 9}), main_session.sent)
            await view.close()
            await hub.close()
        run(scenario())

    def test_a_restarted_streamer_keeps_its_selection(self) -> None:
        async def scenario() -> None:
            host, hub = self.three()
            view = await View(hub).open(frames=False, agent="t_amazon")
            self.assertEqual(view.last("state")["agent"], "t_amazon")
            await view.close()
            await hub.close()
        run(scenario())

    def test_take_control_holds_only_the_selected_agent(self) -> None:
        async def scenario() -> None:
            host, hub = self.three()
            view = await View(hub).open()
            self.assertTrue((await view.ask({"t": "control", "action": "take", "agent": "t_amazon"}))["ok"])
            listed = {entry["agent"]: entry for entry in view.last("agents")["agents"]}
            self.assertEqual((listed["t_amazon"]["controller"], listed["main"]["controller"], listed["t_shop"]["controller"]),
                             ("user", "agent", "agent"))
            # The other agents act at once; the held one waits its bounded time and is refused.
            async with hub.agent_action(host.locks["t_shop"], agent="t_shop"):
                pass
            async with hub.agent_action(host.locks["main"], agent="main"):
                pass
            with self.assertRaises(_livehub.UserInControl):
                async with hub.agent_action(host.locks["t_amazon"], agent="t_amazon"):
                    pass
            # Input goes to that agent's tab only.
            self.assertEqual((await view.ask({"t": "input", "agent": "t_shop", "input": {"kind": "text", "text": "x"}}))["code"],
                             "not_in_control")
            self.assertTrue((await view.ask({"t": "input", "agent": "t_amazon", "input": {"kind": "text", "text": "kettle"}}))["ok"])
            self.assertIn(("Input.insertText", {"text": "kettle"}), host.cdp[host.tabs["t_amazon"]].sent)
            self.assertNotIn("Input.insertText", host.cdp[host.tabs["t_shop"]].methods())
            # Return control: the agent's next action is told the page the user left, without what the user typed.
            self.assertTrue((await view.ask({"t": "control", "action": "return", "agent": "t_amazon"}))["ok"])
            note = hub.take_note("t_amazon") or ""
            self.assertIn("https://amazon.es/s?k=[hidden]", note)
            self.assertNotIn("kettle", note)
            self.assertIsNone(hub.take_note("t_shop"))
            async with hub.agent_action(host.locks["t_amazon"], agent="t_amazon"):
                pass
            await view.close()
            await hub.close()
        run(scenario())

    def test_take_control_of_an_agent_that_does_not_browse_is_refused(self) -> None:
        async def scenario() -> None:
            host, hub = self.three()
            view = await View(hub).open()
            self.assertEqual((await view.ask({"t": "control", "action": "take", "agent": "t_gone"}))["code"], "no_page")
            self.assertEqual((await view.ask({"t": "control", "action": "take", "agent": "bad id"}))["code"], "message_invalid")
            await view.close()
            await hub.close()
        run(scenario())

    def test_two_handoffs_end_per_agent_and_save_that_agent_site(self) -> None:
        async def scenario() -> None:
            host, hub = self.three()
            view = await View(hub).open()
            self.assertTrue((await view.ask({"t": "handoff", "action": "begin", "agent": "t_amazon"}))["ok"])
            self.assertTrue((await view.ask({"t": "handoff", "action": "begin", "agent": "t_shop"}))["ok"])
            listed = {entry["agent"]: entry for entry in view.last("agents")["agents"]}
            self.assertTrue(listed["t_amazon"]["handoff"] and listed["t_shop"]["handoff"])
            self.assertFalse(listed["main"]["handoff"])
            self.assertEqual((await view.ask({"t": "control", "action": "return", "agent": "t_shop"}))["code"], "handoff_pending")
            ended = await view.ask({"t": "handoff", "action": "end", "agent": "t_amazon", "outcome": "completed", "reason": "sign_in"})
            self.assertEqual((ended["saved"], ended["page"]["url"]), ("shop.example", "https://amazon.es/s?k=kettle"))
            self.assertEqual(host.saved, ["t_amazon"])
            listed = {entry["agent"]: entry for entry in view.last("agents")["agents"]}
            self.assertEqual((listed["t_amazon"]["handoff"], listed["t_shop"]["handoff"]), (False, True))
            # The shop agent still waits; amazon acts again.
            async with hub.agent_action(host.locks["t_amazon"], agent="t_amazon"):
                pass
            with self.assertRaises(_livehub.UserInControl):
                async with hub.agent_action(host.locks["t_shop"], agent="t_shop"):
                    pass
            ended = await view.ask({"t": "handoff", "action": "end", "agent": "t_shop", "outcome": "cancelled", "reason": "captcha"})
            self.assertIsNone(ended["saved"])
            self.assertEqual(host.saved, ["t_amazon"])
            await view.close()
            await hub.close()
        run(scenario())

    def test_control_returns_per_agent_after_the_last_view_closes(self) -> None:
        async def scenario() -> None:
            host, hub = self.three()
            with mock.patch.object(_live, "CONTROL_GRACE_SECONDS", 0.1):
                view = await View(hub).open()
                self.assertTrue((await view.ask({"t": "control", "action": "take", "agent": "t_shop"}))["ok"])
                self.assertTrue((await view.ask({"t": "handoff", "action": "begin", "agent": "t_amazon"}))["ok"])
                await view.close()
                await asyncio.sleep(0.4)
            self.assertEqual(hub.agents["t_shop"].controller, "agent")
            # A handoff's control ends only with its own end.
            self.assertEqual(hub.agents["t_amazon"].controller, "user")
            self.assertTrue(hub.busy())
            await hub.close()
            self.assertFalse(hub.busy())
        run(scenario())

    def test_an_agent_that_stopped_browsing_keeps_a_pending_handoff_listed_and_idle_ones_go(self) -> None:
        async def scenario() -> None:
            host, hub = self.three()
            view = await View(hub).open()
            self.assertTrue((await view.ask({"t": "handoff", "action": "begin", "agent": "t_shop"}))["ok"])
            async with hub.agent_action(host.locks["main"], agent="main"):
                pass
            host.order.remove("t_shop")
            await hub.refresh()
            await asyncio.sleep(0.05)
            listed = view.last("agents")["agents"]
            self.assertEqual([(entry["agent"], entry["page"], entry["handoff"]) for entry in listed][-1], ("t_shop", None, True))
            self.assertIn("t_shop", hub.agents)
            await view.ask({"t": "handoff", "action": "end", "agent": "t_shop", "outcome": "timed_out"})
            await hub.refresh()
            await asyncio.sleep(0.05)
            self.assertNotIn("t_shop", hub.agents)
            self.assertEqual([entry["agent"] for entry in view.last("agents")["agents"]], ["main", "t_amazon"])
            await view.close()
            await hub.close()
        run(scenario())


if __name__ == "__main__":
    unittest.main()
