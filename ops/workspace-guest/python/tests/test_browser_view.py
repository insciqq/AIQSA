"""Live view tests that need no browser: the wire, the host's hub with a fake tab, and the streamer.

Run: python3 -m unittest discover -s ops/workspace-guest/python/tests -p "test_browser_view.py"
The real-Chromium screencast, input and control tests live in test_browser_live.py.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa.browser import _format, _live, _livehub, _paths, live  # noqa: E402


def jpeg(width: int, height: int, tail: bytes = b"") -> str:
    """A JPEG header with an APP0 segment and a baseline frame of the given size, as base64."""
    app0 = b"\xff\xe0" + (16).to_bytes(2, "big") + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof0 = b"\xff\xc0" + (17).to_bytes(2, "big") + b"\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big") + \
        b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    return base64.b64encode(b"\xff\xd8" + app0 + sof0 + tail + b"\xff\xd9").decode("ascii")


class WireTests(unittest.TestCase):
    def test_lines_carry_their_length_and_a_cut_line_is_dropped(self) -> None:
        line = _live.encode_line({"t": "state", "page": {"title": "Café"}})
        self.assertTrue(line.startswith("@") and line.endswith("\n") and line.isascii())
        self.assertEqual(_live.decode_line(line.rstrip("\n")), {"t": "state", "page": {"title": "Café"}})
        self.assertIsNone(_live.decode_line(line[:-6]))
        self.assertIsNone(_live.decode_line("@3 [1]"))
        self.assertIsNone(_live.decode_line("Traceback (most recent call last):"))

    def test_frame_size_comes_from_the_jpeg_header(self) -> None:
        self.assertEqual(_live.jpeg_size(jpeg(1280, 800)), (1280, 800))
        self.assertEqual(_live.jpeg_size(jpeg(1024, 640, tail=b"\x00" * 9000)), (1024, 640))
        self.assertIsNone(_live.jpeg_size(base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 40).decode()))
        self.assertIsNone(_live.jpeg_size("not base64!"))

    def test_pointer_input_maps_frame_pixels_to_the_page_and_tracks_held_buttons(self) -> None:
        frame, device = (1280, 800), (1440.0, 900.0)
        down, held = _live.mouse_event({"type": "down", "x": 640, "y": 400, "button": "left", "clickCount": 1}, frame, device, 0)
        self.assertEqual(down, {"type": "mousePressed", "x": 720.0, "y": 450.0, "modifiers": 0, "button": "left", "clickCount": 1,
                                "buttons": 1})
        move, held = _live.mouse_event({"type": "move", "x": 10, "y": 20}, frame, device, held)
        self.assertEqual((move["type"], move["button"], move["buttons"]), ("mouseMoved", "left", 1))
        up, held = _live.mouse_event({"type": "up", "x": 10, "y": 20, "button": "left"}, frame, device, held)
        self.assertEqual((up["type"], held), ("mouseReleased", 0))
        wheel, _ = _live.mouse_event({"type": "wheel", "x": 0, "y": 0, "deltaY": 120}, frame, device, 0)
        self.assertEqual((wheel["type"], wheel["deltaX"], wheel["deltaY"]), ("mouseWheel", 0.0, 120.0))
        for bad in ({"type": "down", "x": -1, "y": 0}, {"type": "drag", "x": 1, "y": 1}, {"type": "down", "x": 1281, "y": 1},
                    {"type": "down", "x": 1, "y": 1, "button": "side"}, {"type": "down", "x": float("nan"), "y": 1},
                    {"type": "down", "x": True, "y": 1}):
            with self.assertRaises(_live.LiveError, msg=str(bad)):
                _live.mouse_event(bad, frame, device, 0)

    def test_keys_type_their_character_and_raw_keys_carry_a_virtual_code(self) -> None:
        down, typed = _live.key_event({"type": "down", "key": "s", "code": "KeyS"})
        self.assertEqual((down["type"], down["text"], down["windowsVirtualKeyCode"], typed), ("keyDown", "s", 83, "s"))
        down, typed = _live.key_event({"type": "down", "key": "ф", "code": "KeyA"})
        self.assertEqual((down["text"], down["windowsVirtualKeyCode"], typed), ("ф", 65, "ф"))
        enter, typed = _live.key_event({"type": "down", "key": "Enter", "code": "Enter"})
        self.assertEqual((enter["type"], enter["text"], enter["windowsVirtualKeyCode"], typed), ("keyDown", "\r", 13, None))
        back, typed = _live.key_event({"type": "down", "key": "Backspace", "code": "Backspace"})
        self.assertEqual((back["type"], back["windowsVirtualKeyCode"], typed), ("rawKeyDown", 8, None))
        select_all, typed = _live.key_event({"type": "down", "key": "a", "code": "KeyA", "modifiers": _live.MODIFIER_CTRL})
        self.assertEqual((select_all["type"], "text" in select_all, typed), ("rawKeyDown", False, None))
        up, typed = _live.key_event({"type": "up", "key": "s", "code": "KeyS"})
        self.assertEqual((up["type"], typed), ("keyUp", None))
        for bad in ({"type": "down", "key": "", "code": ""}, {"type": "press", "key": "a", "code": "KeyA"},
                    {"type": "down", "key": "\u0007", "code": ""}, {"type": "down", "key": "a" * 33, "code": ""}):
            with self.assertRaises(_live.LiveError, msg=str(bad)):
                _live.key_event(bad)

    def test_text_insertions_are_bounded_and_free_of_control_characters(self) -> None:
        self.assertEqual(_live.text_input({"kind": "text", "text": "123456"}), "123456")
        for bad in ("", "a" * 1025, "a\u0000b", 5):
            with self.assertRaises(_live.LiveError):
                _live.text_input({"kind": "text", "text": bad})

    def test_steps_and_page_show_no_query_user_info_or_control_characters(self) -> None:
        step = {"n": 3, "action": "click", "target": 'button "Pay\nnow"', "url": "https://shop.example:8443/cart?token=abc#x", "at": "t"}
        self.assertEqual(_live.step_view(step), {"n": 3, "action": "click", "target": 'button "Pay now"',
                                                  "host": "shop.example:8443", "path": "/cart"})
        self.assertIsNone(_live.step_view({"n": 0, "action": "click"}))
        self.assertIsNone(_live.step_view({"n": 1, "action": "Click"}))
        self.assertEqual(len(_live.steps_view([{**step, "n": index} for index in range(1, 80)])), _live.STEPS_PER_MESSAGE)
        self.assertEqual(_live.page_view("https://user:pw@shop.example/a?b=1", "Shop\u0007 home"),
                         {"url": "https://shop.example/a?b=1", "title": "Shop home"})
        self.assertIsNone(_live.page_view(None, "x"))


class FakeSession:
    def __init__(self) -> None:
        self.sent: List[Tuple[str, Dict[str, Any]]] = []
        self.handlers: Dict[str, List[Any]] = {}

    async def send(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self.sent.append((method, dict(params or {})))
        return {}

    def on(self, event: str, handler: Any) -> None:
        self.handlers.setdefault(event, []).append(handler)

    def emit(self, event: str, params: Dict[str, Any]) -> None:
        for handler in self.handlers.get(event, []):
            handler(params)

    def calls(self, method: str) -> List[Dict[str, Any]]:
        return [params for name, params in self.sent if name == method]


class FakeElement:
    def __init__(self, value: str) -> None:
        self.value = value

    async def evaluate(self, script: str, *args: Any) -> Any:
        return self.value


class FakeHandle:
    def __init__(self, element: Optional[FakeElement]) -> None:
        self.element = element

    def as_element(self) -> Optional[FakeElement]:
        return self.element

    async def dispose(self) -> None:
        return None


class FakeFrame:
    def __init__(self, url: str) -> None:
        self.url = url
        self.focused: Optional[FakeElement] = None

    def is_detached(self) -> bool:
        return False

    async def evaluate_handle(self, script: str) -> FakeHandle:
        return FakeHandle(self.focused)


class FakePage:
    def __init__(self, url: str, title: str) -> None:
        self.url = url
        self.page_title = title
        self.main_frame = FakeFrame(url)
        self.frames = [self.main_frame]
        self.closed = False

    def is_closed(self) -> bool:
        return self.closed

    async def title(self) -> str:
        return self.page_title


class FakeHost:
    def __init__(self) -> None:
        self.current = FakePage("https://shop.example/login?next=/cart", "Sign in")
        self.session = FakeSession()
        self.cdp = {self.current: self.session}
        self.hidden = _format.HiddenValues()
        self.env_hidden = _format.HiddenValues()
        self.steps: List[Dict[str, Any]] = [{"n": 1, "action": "open", "target": None, "url": "https://shop.example/login"}]
        self.masked: Dict[Any, List[Tuple[str, Any]]] = {}
        self.last_used = 0.0
        self.saved = 0
        self.lock = asyncio.Lock()

    async def save_site_session(self) -> Optional[str]:
        # As the host's: under its lock, which a waiting agent action must not hold.
        await asyncio.wait_for(self.lock.acquire(), 2)
        try:
            self.saved += 1
            return "shop.example"
        finally:
            self.lock.release()


class HubTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.host = FakeHost()
        self.hub = _livehub.LiveHub(self.host)  # type: ignore[arg-type]
        self.path = str(Path(self.directory.name) / "control.sock")

        async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            request = json.loads(await reader.readline())
            await self.hub.serve(reader, writer, request["args"])

        self.server = await asyncio.start_unix_server(serve, path=self.path, limit=4 * 1024 * 1024)
        self.views: List[Tuple[asyncio.StreamReader, asyncio.StreamWriter]] = []
        self.seen: List[Dict[str, Any]] = []

    @property
    def main(self) -> _livehub.AgentLive:
        """The main agent's control: a host without per-agent tabs serves only it."""
        return self.hub.control_of(_livehub.MAIN)

    async def asyncTearDown(self) -> None:
        for _reader, writer in self.views:
            writer.close()
        await self.hub.close()
        self.server.close()
        await self.server.wait_closed()
        self.directory.cleanup()

    async def open_view(self, frames: bool = True) -> Tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        reader, writer = await asyncio.open_unix_connection(self.path, limit=4 * 1024 * 1024)
        writer.write(json.dumps({"v": 1, "op": "live", "args": {"frames": frames}}).encode() + b"\n")
        await writer.drain()
        self.views.append((reader, writer))
        return reader, writer

    async def next_message(self, reader: asyncio.StreamReader, kind: str, timeout: float = 3.0) -> Dict[str, Any]:
        """The next message of a kind; the ones before it are kept in `self.seen`."""
        async def find() -> Dict[str, Any]:
            while True:
                message = json.loads(await reader.readline())
                if message.get("t") == kind:
                    return message
                self.seen.append(message)
        return await asyncio.wait_for(find(), timeout)

    async def ask(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, message: Dict[str, Any]) -> Dict[str, Any]:
        writer.write(json.dumps(message).encode() + b"\n")
        await writer.drain()
        return await self.next_message(reader, "ack")

    def frame_event(self, data: str, sid: int, width: float = 1440, height: float = 900) -> Dict[str, Any]:
        return {"data": data, "sessionId": sid, "metadata": {"deviceWidth": width, "deviceHeight": height, "offsetTop": 0,
                                                             "pageScaleFactor": 1}}

    async def test_a_view_gets_state_steps_and_paced_changed_frames_only(self) -> None:
        reader, _writer = await self.open_view()
        state = await self.next_message(reader, "state")
        self.assertEqual((state["browser"], state["controller"], state["handoff"]), ("running", "agent", False))
        self.assertEqual(state["page"], {"url": "https://shop.example/login?next=/cart", "title": "Sign in"})
        steps = await self.next_message(reader, "steps")
        self.assertEqual(steps["steps"], [{"n": 1, "action": "open", "target": "", "host": "shop.example", "path": "/login"}])
        session = self.host.session
        self.assertEqual(session.calls("Page.startScreencast")[0]["maxWidth"], 1280)
        with mock.patch.object(_live, "FRAME_INTERVAL", 0.2):
            loop = asyncio.get_running_loop()
            started = loop.time()
            session.emit("Page.screencastFrame", self.frame_event(jpeg(1280, 800, b"a"), 1))
            first = await self.next_message(reader, "frame")
            self.assertEqual((first["seq"], first["width"], first["height"]), (1, 1280, 800))
            # A burst: only the newest goes out, at the next slot; every frame is acknowledged.
            session.emit("Page.screencastFrame", self.frame_event(jpeg(1280, 800, b"b"), 2))
            session.emit("Page.screencastFrame", self.frame_event(jpeg(1280, 800, b"c"), 3))
            second = await self.next_message(reader, "frame")
            self.assertGreaterEqual(loop.time() - started, 0.19)
            self.assertEqual((second["seq"], second["data"]), (2, jpeg(1280, 800, b"c")))
            # The same picture again is not sent.
            session.emit("Page.screencastFrame", self.frame_event(jpeg(1280, 800, b"c"), 4))
            session.emit("Page.screencastFrame", self.frame_event(jpeg(1280, 800, b"d"), 5))
            third = await self.next_message(reader, "frame")
            self.assertEqual((third["seq"], third["data"]), (3, jpeg(1280, 800, b"d")))
        await asyncio.sleep(0.05)
        self.assertEqual(sorted(params["sessionId"] for params in session.calls("Page.screencastFrameAck")), [1, 2, 3, 4, 5])

    async def test_input_only_while_the_user_holds_control_and_the_agent_waits(self) -> None:
        reader, writer = await self.open_view()
        self.hub.geometry[self.host.current] = ((1280, 800), (1440.0, 900.0))
        click = {"kind": "mouse", "type": "down", "x": 640, "y": 400, "button": "left", "clickCount": 1}
        refused = await self.ask(reader, writer, {"t": "input", "id": "i1", "input": click})
        self.assertEqual((refused["ok"], refused["code"]), (False, "not_in_control"))
        self.assertEqual(self.host.session.calls("Input.dispatchMouseEvent"), [])
        self.assertTrue((await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"}))["ok"])
        # The panel learns the new controller before the request's own answer.
        self.assertEqual([message["controller"] for message in self.seen if message["t"] == "state"][-1], "user")
        self.assertFalse(await self.hub.wait_for_agent(0.05))
        self.assertTrue((await self.ask(reader, writer, {"t": "input", "id": "i2", "input": click}))["ok"])
        self.assertEqual(self.host.session.calls("Input.dispatchMouseEvent")[0]["x"], 720.0)
        waiting = asyncio.ensure_future(self.hub.wait_for_agent(2.0))
        self.host.current.url = "https://shop.example/cart"
        self.assertTrue((await self.ask(reader, writer, {"t": "control", "id": "c2", "action": "return"}))["ok"])
        self.assertTrue(await waiting)
        self.assertEqual(self.hub.take_note(),
                         'The user gave the browser back to you after using it. The page is now https://shop.example/cart ("Sign in").')
        self.assertIsNone(self.hub.take_note())

    async def test_what_the_user_types_is_masked_for_the_agent_and_its_field_reads_as_hidden(self) -> None:
        reader, writer = await self.open_view()
        field = FakeElement("standard_user")
        self.host.current.main_frame.focused = field
        await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"})
        for char in "standard_usr":
            await self.ask(reader, writer, {"t": "input", "id": "k" + char, "input": {"kind": "key", "type": "down", "key": char,
                                                                                     "code": ""}})
        await self.ask(reader, writer, {"t": "input", "id": "b", "input": {"kind": "key", "type": "down", "key": "Backspace",
                                                                          "code": "Backspace"}})
        await self.ask(reader, writer, {"t": "input", "id": "t", "input": {"kind": "text", "text": "er"}})
        self.assertEqual(self.host.session.calls("Input.insertText"), [{"text": "er"}])
        await self.ask(reader, writer, {"t": "input", "id": "tab", "input": {"kind": "key", "type": "down", "key": "Tab", "code": "Tab"}})
        self.assertEqual(self.host.hidden.text("Welcome, standard_user!"), "Welcome, [hidden]!")
        self.assertEqual(self.host.env_hidden.text("standard_user"), "standard_user")
        self.assertEqual([element for _url, element in self.host.masked[self.host.current.main_frame]], [field])
        self.assertEqual(self.main.typed, "")

    async def test_a_handoff_holds_control_until_its_end_and_done_saves_the_site(self) -> None:
        reader, writer = await self.open_view(frames=False)
        self.assertEqual(self.host.session.calls("Page.startScreencast"), [])
        self.assertTrue((await self.ask(reader, writer, {"t": "handoff", "id": "h1", "action": "begin"}))["ok"])
        self.assertEqual((self.main.controller, self.main.handoff), ("user", True))
        refused = await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "return"})
        self.assertEqual(refused["code"], "handoff_pending")
        self.host.hidden.add("standard_user")
        self.host.current.url = "https://shop.example/inventory?u=standard_user"
        ended = await self.ask(reader, writer, {"t": "handoff", "id": "h2", "action": "end", "outcome": "completed", "reason": "sign_in"})
        self.assertEqual(ended["page"], {"url": "https://shop.example/inventory?u=[hidden]", "title": "Sign in"})
        self.assertEqual((ended["saved"], self.host.saved, self.main.controller), ("shop.example", 1, "agent"))
        cancelled = await self.ask(reader, writer, {"t": "handoff", "id": "h3", "action": "end", "outcome": "cancelled"})
        self.assertEqual((cancelled["saved"], self.host.saved), (None, 1))
        self.assertIsNone(self.hub.take_note())

    async def test_control_the_user_took_returns_to_the_agent_after_the_last_view_left(self) -> None:
        with mock.patch.object(_live, "CONTROL_GRACE_SECONDS", 0.1):
            reader, writer = await self.open_view()
            await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"})
            writer.close()
            self.views.clear()
            self.assertTrue(await self.hub.wait_for_agent(2.0))
        self.assertIn("The user gave the browser back to you", self.hub.take_note() or "")

    async def press(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, event: Dict[str, Any]) -> None:
        self.assertTrue((await self.ask(reader, writer, {"t": "input", "id": "p", "input": event}))["ok"])

    def released(self) -> List[Tuple[str, Any, Any]]:
        session = self.host.session
        return [("mouse", params["type"], params["button"]) for params in session.calls("Input.dispatchMouseEvent")] + \
            [("key", params["type"], params["code"] or params["key"]) for params in session.calls("Input.dispatchKeyEvent")]

    async def test_control_leaving_the_user_lets_go_of_what_their_input_left_pressed(self) -> None:
        reader, writer = await self.open_view()
        self.hub.geometry[self.host.current] = ((1280, 800), (1440.0, 900.0))
        session = self.host.session
        # Take control, then a drag whose button never comes up, an arrow key held and Shift pressed and let go.
        await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"})
        await self.press(reader, writer, {"kind": "mouse", "type": "down", "x": 100, "y": 100, "button": "left", "clickCount": 1})
        await self.press(reader, writer, {"kind": "mouse", "type": "move", "x": 640, "y": 400})
        await self.press(reader, writer, {"kind": "key", "type": "down", "key": "ArrowDown", "code": "ArrowDown"})
        await self.press(reader, writer, {"kind": "key", "type": "down", "key": "Shift", "code": "ShiftLeft", "modifiers": 8})
        await self.press(reader, writer, {"kind": "key", "type": "up", "key": "Shift", "code": "ShiftLeft"})
        session.sent.clear()
        self.assertTrue((await self.ask(reader, writer, {"t": "control", "id": "c2", "action": "return"}))["ok"])
        # Before the agent has the page back: the button at the pointer's last position, then the key still down.
        self.assertEqual(session.calls("Input.dispatchMouseEvent"), [{"type": "mouseReleased", "x": 720.0, "y": 450.0, "button": "left",
                                                                     "buttons": 0, "clickCount": 1, "modifiers": 0}])
        self.assertEqual(session.calls("Input.dispatchKeyEvent"), [{"type": "keyUp", "key": "ArrowDown", "code": "ArrowDown", "modifiers": 0,
                                                                   "windowsVirtualKeyCode": 40, "nativeVirtualKeyCode": 40}])
        self.assertEqual((self.main.pressed, self.main.keys), (0, {}))
        # A handoff's end lets go the same way whatever its outcome; nothing is let go twice.
        self.assertTrue((await self.ask(reader, writer, {"t": "handoff", "id": "h1", "action": "begin"}))["ok"])
        await self.press(reader, writer, {"kind": "mouse", "type": "down", "x": 10, "y": 10, "button": "right", "clickCount": 1})
        await self.press(reader, writer, {"kind": "mouse", "type": "down", "x": 10, "y": 10, "button": "left", "clickCount": 1})
        await self.press(reader, writer, {"kind": "key", "type": "down", "key": "Control", "code": "ControlLeft", "modifiers": 2})
        await self.press(reader, writer, {"kind": "key", "type": "down", "key": "a", "code": "KeyA", "modifiers": 2})
        session.sent.clear()
        self.assertTrue((await self.ask(reader, writer, {"t": "handoff", "id": "h2", "action": "end", "outcome": "cancelled"}))["ok"])
        self.assertEqual(self.released(), [("mouse", "mouseReleased", "left"), ("mouse", "mouseReleased", "right"),
                                           ("key", "keyUp", "KeyA"), ("key", "keyUp", "ControlLeft")])
        self.assertEqual([params["buttons"] for params in session.calls("Input.dispatchMouseEvent")], [2, 0])
        session.sent.clear()
        await self.ask(reader, writer, {"t": "control", "id": "c3", "action": "take"})
        await self.ask(reader, writer, {"t": "control", "id": "c4", "action": "return"})
        self.assertEqual(self.released(), [])

    async def test_the_grace_end_and_the_host_stop_let_go_of_what_the_user_held(self) -> None:
        self.hub.geometry[self.host.current] = ((1280, 800), (1440.0, 900.0))
        with mock.patch.object(_live, "CONTROL_GRACE_SECONDS", 0.1):
            reader, writer = await self.open_view()
            await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"})
            await self.press(reader, writer, {"kind": "mouse", "type": "down", "x": 640, "y": 400, "button": "left", "clickCount": 1})
            # The panel's tab closes mid-drag: its button up never comes.
            writer.close()
            self.views.clear()
            self.assertTrue(await self.hub.wait_for_agent(2.0))
        self.assertEqual(self.released(), [("mouse", "mousePressed", "left"), ("mouse", "mouseReleased", "left")])
        reader, writer = await self.open_view()
        await self.ask(reader, writer, {"t": "control", "id": "c2", "action": "take"})
        await self.press(reader, writer, {"kind": "key", "type": "down", "key": "Control", "code": "ControlLeft", "modifiers": 2})
        self.host.session.sent.clear()
        await self.hub.close()
        self.assertEqual(self.released(), [("key", "keyUp", "ControlLeft")])
        self.assertEqual((self.main.controller, self.main.pressed, self.main.keys), ("agent", 0, {}))

    async def test_held_keys_stay_bounded_by_letting_the_oldest_go(self) -> None:
        reader, writer = await self.open_view()
        await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"})
        for index in range(_livehub.HELD_KEYS_MAX + 1):
            await self.press(reader, writer, {"kind": "key", "type": "down", "key": "F1", "code": f"Code{index}"})
        self.assertEqual(len(self.main.keys), _livehub.HELD_KEYS_MAX)
        self.assertEqual([params["code"] for params in self.host.session.calls("Input.dispatchKeyEvent") if params["type"] == "keyUp"],
                         ["Code0"])

    async def test_a_queued_agent_action_never_starts_after_take_control(self) -> None:
        reader, writer = await self.open_view()
        lock, ran = self.host.lock, []
        first_may_end = asyncio.Event()

        async def action(name: str, until: Optional[asyncio.Event] = None) -> None:
            # The host's dispatch, mocked: what runs under the lock, and who held the browser then.
            async with self.hub.agent_action(lock):
                ran.append((name, self.main.controller))
                if until is not None:
                    await until.wait()

        first = asyncio.ensure_future(action("first", first_may_end))
        await asyncio.sleep(0.02)
        queued = asyncio.ensure_future(action("queued"))
        await asyncio.sleep(0.02)
        self.assertTrue(lock.locked())
        take = asyncio.ensure_future(self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"}))
        await asyncio.sleep(0.05)
        # Take waits for the action under way; the queued one does not start meanwhile, nor after it.
        self.assertFalse(take.done())
        first_may_end.set()
        self.assertTrue((await take)["ok"])
        await first
        await asyncio.sleep(0.05)
        self.assertEqual((ran, self.main.controller, queued.done()), ([("first", "agent")], "user", False))
        self.assertTrue((await self.ask(reader, writer, {"t": "control", "id": "c2", "action": "return"}))["ok"])
        await asyncio.wait_for(queued, 2)
        self.assertEqual(ran, [("first", "agent"), ("queued", "agent")])

    async def test_a_take_does_not_wait_out_a_long_agent_action(self) -> None:
        reader, writer = await self.open_view()
        never = asyncio.Event()

        async def waiting_action() -> None:
            async with self.hub.agent_action(self.host.lock):
                await never.wait()

        long_action = asyncio.ensure_future(waiting_action())
        await asyncio.sleep(0.02)
        with mock.patch.object(_livehub, "TAKE_WAIT_SECONDS", 0.1):
            self.assertTrue((await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"}))["ok"])
        self.assertEqual(self.main.controller, "user")
        long_action.cancel()
        await asyncio.gather(long_action, return_exceptions=True)

    async def test_an_agent_action_waiting_for_the_user_holds_no_lock_the_handoff_end_needs(self) -> None:
        reader, writer = await self.open_view()
        self.assertTrue((await self.ask(reader, writer, {"t": "handoff", "id": "h1", "action": "begin"}))["ok"])
        ran = []

        async def action() -> None:
            async with self.hub.agent_action(self.host.lock):
                ran.append(self.main.controller)

        waiting = asyncio.ensure_future(action())
        await asyncio.sleep(0.05)
        self.assertFalse(self.host.lock.locked())
        loop = asyncio.get_running_loop()
        started = loop.time()
        ended = await self.ask(reader, writer, {"t": "handoff", "id": "h2", "action": "end", "outcome": "completed", "reason": "sign_in"})
        self.assertEqual((ended["ok"], ended["saved"]), (True, "shop.example"))
        self.assertLess(loop.time() - started, 1.0)
        await asyncio.wait_for(waiting, 2)
        self.assertEqual(ran, ["agent"])

    async def test_an_agent_action_fails_when_the_user_keeps_the_browser(self) -> None:
        reader, writer = await self.open_view()
        await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"})
        with mock.patch.object(_live, "CONTROL_WAIT_SECONDS", 0.1):
            with self.assertRaises(_livehub.UserInControl):
                async with self.hub.agent_action(self.host.lock):
                    self.fail("the action must not run")
            # Reading no page, `status` and `steps` still answer.
            async with self.hub.agent_action(self.host.lock, control_free=True):
                pass
        self.assertFalse(self.host.lock.locked())

    async def test_a_value_typed_with_pauses_is_hidden_whole(self) -> None:
        reader, writer = await self.open_view()
        await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"})
        # A code widget whose value the page does not expose in one field: only what the user typed is known.
        self.host.current.main_frame.focused = None
        with mock.patch.object(_livehub, "CAPTURE_DELAY", 0.02):
            for part in ("123", "456"):
                for char in part:
                    await self.ask(reader, writer, {"t": "input", "id": "k" + char, "input": {"kind": "key", "type": "down", "key": char,
                                                                                             "code": "Digit" + char}})
                await asyncio.sleep(0.1)
        self.assertEqual(self.host.hidden.text("code=123456"), "code=[hidden]")

    async def test_a_field_that_submits_on_its_last_digit_is_hidden_before_the_agent_gets_the_page(self) -> None:
        reader, writer = await self.open_view()
        self.assertTrue((await self.ask(reader, writer, {"t": "handoff", "id": "h1", "action": "begin"}))["ok"])
        field = FakeElement("1234")
        self.host.current.main_frame.focused = field
        with mock.patch.object(_livehub, "CAPTURE_DELAY", 0.02):
            await self.ask(reader, writer, {"t": "input", "id": "t1", "input": {"kind": "text", "text": "1234"}})
            await asyncio.sleep(0.1)
        with mock.patch.object(_livehub, "CAPTURE_DELAY", 30):
            await self.ask(reader, writer, {"t": "input", "id": "t2", "input": {"kind": "text", "text": "56"}})
            # The page submitted on the last digit and moved on before anything was captured.
            self.host.current.url = "https://shop.example/verify?otp=123456"
            self.host.current.main_frame.focused = None
            ended = await self.ask(reader, writer, {"t": "handoff", "id": "h2", "action": "end", "outcome": "completed", "reason": "sign_in"})
        self.assertEqual(ended["page"]["url"], "https://shop.example/verify?otp=[hidden]")

    async def test_a_corrected_code_is_hidden_before_a_field_that_submits_on_it(self) -> None:
        reader, writer = await self.open_view()
        self.assertTrue((await self.ask(reader, writer, {"t": "handoff", "id": "h1", "action": "begin"}))["ok"])
        self.host.current.main_frame.focused = FakeElement("123456")
        await self.ask(reader, writer, {"t": "input", "id": "t1", "input": {"kind": "text", "text": "123456"}})
        await self.main.capture_now()
        # Select all, then the replacement: the page submits on its last digit and the field goes away.
        await self.ask(reader, writer, {"t": "input", "id": "a", "input": {"kind": "key", "type": "down", "key": "a", "code": "KeyA",
                                                                          "modifiers": 2}})
        send = self.host.session.send

        async def submitting(method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
            if method == "Input.insertText":
                self.host.current.url = f"https://shop.example/verify?otp={(params or {})['text']}"
                self.host.current.main_frame.focused = None
            return await send(method, params)

        self.host.session.send = submitting  # type: ignore[method-assign]
        await self.ask(reader, writer, {"t": "input", "id": "t2", "input": {"kind": "text", "text": "654321"}})
        ended = await self.ask(reader, writer, {"t": "handoff", "id": "h2", "action": "end", "outcome": "completed", "reason": "sign_in"})
        self.assertNotIn("654321", ended["page"]["url"])
        self.assertEqual(ended["page"]["url"], "https://shop.example/verify?otp=[hidden]")

    async def test_a_typo_fixed_with_backspace_is_hidden_as_corrected(self) -> None:
        reader, writer = await self.open_view()
        await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"})
        self.host.current.main_frame.focused = None
        for char in "12345":
            await self.ask(reader, writer, {"t": "input", "id": "k", "input": {"kind": "key", "type": "down", "key": char, "code": "Digit" + char}})
        await self.ask(reader, writer, {"t": "input", "id": "b", "input": {"kind": "key", "type": "down", "key": "Backspace", "code": "Backspace"}})
        seen: List[str] = []
        send = self.host.session.send

        async def watching(method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
            seen.append(self.host.hidden.text("otp=12346"))
            return await send(method, params)

        self.host.session.send = watching  # type: ignore[method-assign]
        await self.ask(reader, writer, {"t": "input", "id": "k6", "input": {"kind": "key", "type": "down", "key": "6", "code": "Digit6"}})
        # Hidden before the corrected digit went out; the mistyped value stays hidden too.
        self.assertEqual(seen, ["otp=[hidden]"])
        self.assertEqual(self.host.hidden.text("12345 12346"), "[hidden] [hidden]")

    async def test_typing_keeps_one_pattern_for_the_value_being_typed(self) -> None:
        reader, writer = await self.open_view()
        await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"})
        self.host.current.main_frame.focused = None
        for index in range(40):
            await self.ask(reader, writer, {"t": "input", "id": "t", "input": {"kind": "text", "text": "abcdefghij"[index % 10]}})
        self.assertEqual(len(self.host.hidden.patterns), 0)
        self.assertEqual(self.host.hidden.text("x" + "abcdefghij" * 4), "x[hidden]")
        await self.ask(reader, writer, {"t": "input", "id": "tab", "input": {"kind": "key", "type": "down", "key": "Tab", "code": "Tab"}})
        self.assertEqual(len(self.host.hidden.patterns), 1)

    async def test_done_saves_the_site_only_for_a_handoff_about_signing_in(self) -> None:
        reader, writer = await self.open_view()
        for index, (reason, saves) in enumerate((("sign_in", True), ("verification_code", True), ("captcha", True),
                                                 ("consent", True), ("user_choice", False), ("other", False), (None, False))):
            self.assertTrue((await self.ask(reader, writer, {"t": "handoff", "id": f"b{index}", "action": "begin"}))["ok"])
            before = self.host.saved
            end: Dict[str, Any] = {"t": "handoff", "id": f"e{index}", "action": "end", "outcome": "completed"}
            if reason is not None:
                end["reason"] = reason
            ended = await self.ask(reader, writer, end)
            self.assertEqual((ended["saved"] is not None, self.host.saved - before), (saves, 1 if saves else 0), reason)

    async def test_enter_tab_and_a_click_go_out_after_what_was_typed_is_hidden(self) -> None:
        reader, writer = await self.open_view()
        self.hub.geometry[self.host.current] = ((1280, 800), (1440.0, 900.0))
        await self.ask(reader, writer, {"t": "control", "id": "c1", "action": "take"})
        session = self.host.session
        seen: List[Tuple[str, str]] = []
        send = session.send

        async def watching(method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
            if method != "Input.insertText":
                key = (params or {}).get("key") or (params or {}).get("type")
                seen.append((str(key), self.host.hidden.text("secret-one secret-two secret-six")))
            return await send(method, params)

        session.send = watching  # type: ignore[method-assign]
        self.host.current.main_frame.focused = None
        with mock.patch.object(_livehub, "CAPTURE_DELAY", 30):
            for text, key in (("secret-one", "Enter"), ("secret-two", "Tab")):
                await self.ask(reader, writer, {"t": "input", "id": "t", "input": {"kind": "text", "text": text}})
                await self.ask(reader, writer, {"t": "input", "id": "k", "input": {"kind": "key", "type": "down", "key": key, "code": key}})
            await self.ask(reader, writer, {"t": "input", "id": "t", "input": {"kind": "text", "text": "secret-six"}})
            await self.ask(reader, writer, {"t": "input", "id": "m", "input": {"kind": "mouse", "type": "down", "x": 10, "y": 10,
                                                                              "button": "left", "clickCount": 1}})
        self.assertEqual(seen, [("Enter", "[hidden] secret-two secret-six"), ("Tab", "[hidden] [hidden] secret-six"),
                                ("mousePressed", "[hidden] [hidden] [hidden]")])

    async def test_a_handoff_survives_its_streamer_leaving(self) -> None:
        with mock.patch.object(_live, "CONTROL_GRACE_SECONDS", 0.05):
            reader, writer = await self.open_view()
            await self.ask(reader, writer, {"t": "handoff", "id": "h1", "action": "begin"})
            writer.close()
            self.views.clear()
            await asyncio.sleep(0.2)
        self.assertEqual((self.main.controller, self.main.handoff), ("user", True))


class StreamerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        _paths.use_test_root(self.root, python=sys.executable)
        (self.root / "tmp" / "aiqsa-browser").mkdir(parents=True)

    def tearDown(self) -> None:
        _paths.use_test_root(None)
        self.directory.cleanup()

    def run_streamer(self, lines: List[str], host: Any = None) -> List[Dict[str, Any]]:
        read_end, write_end = os.pipe()
        source = os.fdopen(read_end, "r")
        out = io.StringIO()

        def feed() -> None:
            with os.fdopen(write_end, "w") as sink:
                for line in lines:
                    if line.startswith("#sleep "):
                        threading.Event().wait(float(line.split()[1]))
                        continue
                    sink.write(line + "\n")
                    sink.flush()

        async def main() -> int:
            server = await host() if host else None
            threading.Thread(target=feed, daemon=True).start()
            try:
                return await asyncio.wait_for(live.run(source, out), 10)
            finally:
                if server is not None:
                    server.close()

        try:
            self.assertEqual(asyncio.run(main()), 0)
        finally:
            source.close()
        messages = []
        for line in out.getvalue().splitlines():
            message = _live.decode_line(line)
            self.assertIsNotNone(message, line[:80])
            messages.append(message)
        return messages

    def test_without_a_host_it_reports_absent_refuses_commands_and_ends_with_stdin(self) -> None:
        messages = self.run_streamer([json.dumps({"t": "frames", "on": True}), "#sleep 0.2",
                                      json.dumps({"t": "handoff", "id": "h1", "action": "begin"}), "not json"])
        self.assertEqual(messages[0], {"t": "state", "browser": "absent"})
        self.assertIn({"t": "ack", "id": "h1", "ok": False, "code": "browser_not_running"}, messages)

    def test_a_command_written_right_after_start_waits_for_the_host(self) -> None:
        """AIQSA writes `begin` right after it starts the streamer, and the host may come up only for its retry."""
        path = str(self.root / "tmp" / "aiqsa-browser" / "control.sock")
        received: List[Dict[str, Any]] = []

        async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            received.append(json.loads(await reader.readline()))
            writer.write(b'{"t":"state","browser":"running"}\n')
            while True:
                line = await reader.readline()
                if not line:
                    break
                message = json.loads(line)
                received.append(message)
                writer.write(json.dumps({"t": "ack", "id": message["id"], "ok": True}).encode() + b"\n")
                await writer.drain()
            writer.close()

        async def main() -> List[Dict[str, Any]]:
            env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(Path(__file__).resolve().parents[1]), os.environ.get("PYTHONPATH", "")])}
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "aiqsa.browser.live", "--test-root", str(self.root), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env=env)
            assert process.stdin is not None and process.stdout is not None
            process.stdin.write(b'{"t":"handoff","action":"begin","id":"b1"}\n')
            await process.stdin.drain()
            # Its first attempt finds no host; the host listens before the retry.
            await asyncio.sleep(0.2)
            server = await asyncio.start_unix_server(serve, path=path)
            messages: List[Dict[str, Any]] = []
            try:
                while not any(message.get("t") == "ack" for message in messages):
                    line = await asyncio.wait_for(process.stdout.readline(), 8)
                    self.assertTrue(line, "the streamer ended early")
                    message = _live.decode_line(line.decode().rstrip("\n"))
                    if message is not None:
                        messages.append(message)
                process.stdin.close()
                await asyncio.wait_for(process.stdout.read(), 10)
                self.assertEqual(await asyncio.wait_for(process.wait(), 10), 0)
            finally:
                server.close()
                await server.wait_closed()
            return messages

        messages = asyncio.run(main())
        self.assertEqual([message for message in messages if message["t"] == "ack"], [{"t": "ack", "id": "b1", "ok": True}])
        self.assertEqual(received[1], {"t": "handoff", "action": "begin", "id": "b1"})

    def test_it_relays_both_ways_and_never_starts_a_host(self) -> None:
        received: List[Dict[str, Any]] = []
        path = str(self.root / "tmp" / "aiqsa-browser" / "control.sock")

        async def host() -> asyncio.AbstractServer:
            async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
                received.append(json.loads(await reader.readline()))
                frame = {"t": "frame", "seq": 1, "data": jpeg(1280, 800), "width": 1280, "height": 800}
                for message in ({"t": "state", "browser": "running"}, frame):
                    writer.write(json.dumps(message, separators=(",", ":")).encode() + b"\n")
                await writer.drain()
                while True:
                    line = await reader.readline()
                    if not line:
                        break
                    message = json.loads(line)
                    received.append(message)
                    if message.get("id"):
                        writer.write(json.dumps({"t": "ack", "id": message["id"], "ok": True}).encode() + b"\n")
                        await writer.drain()
                writer.close()
            return await asyncio.start_unix_server(serve, path=path)

        messages = self.run_streamer(["#sleep 0.3", json.dumps({"t": "control", "id": "c1", "action": "take"}), "#sleep 0.3",
                                      json.dumps({"t": "bye"})], host=host)
        self.assertEqual(received[0], {"v": 1, "op": "live", "args": {"frames": False, "agent": "main"}})
        self.assertEqual(received[1], {"t": "control", "id": "c1", "action": "take"})
        self.assertEqual([message["t"] for message in messages], ["state", "frame", "ack"])
        self.assertEqual(messages[1]["data"], jpeg(1280, 800))
        self.assertFalse((self.root / "tmp" / "aiqsa-browser" / "host.log").exists())

    def test_the_selected_agent_is_kept_and_sent_to_each_host_it_reaches(self) -> None:
        received: List[Dict[str, Any]] = []
        path = str(self.root / "tmp" / "aiqsa-browser" / "control.sock")

        async def host() -> asyncio.AbstractServer:
            async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
                received.append(json.loads(await reader.readline()))
                writer.write(b'{"t":"state","browser":"running"}\n')
                await writer.drain()
                while True:
                    line = await reader.readline()
                    if not line:
                        break
                    received.append(json.loads(line))
                writer.close()
            return await asyncio.start_unix_server(serve, path=path)

        # The choice reaches the host, forwarded or in the arguments of a connection made after it; a malformed one never.
        self.run_streamer([json.dumps({"t": "select", "agent": "thread_7"}), json.dumps({"t": "select", "agent": "bad id"}),
                           "#sleep 0.4", json.dumps({"t": "bye"})], host=host)
        args = received[0]["args"]
        self.assertTrue(args["agent"] == "thread_7" or {"t": "select", "agent": "thread_7"} in received[1:], received)
        self.assertNotIn("bad id", json.dumps(received))

        # Chosen while connected, it is forwarded as it came.
        received.clear()
        self.run_streamer(["#sleep 0.3", json.dumps({"t": "select", "agent": "thread_8"}), "#sleep 0.3", json.dumps({"t": "bye"})],
                          host=host)
        self.assertEqual((received[0]["args"]["agent"], received[1]), ("main", {"t": "select", "agent": "thread_8"}))


if __name__ == "__main__":
    unittest.main()
