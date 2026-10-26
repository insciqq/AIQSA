"""The browser host's side of the live view: frames, the user's input, Take control and handoff.

A streamer (`live.py`) connects with `{"op": "live"}` and stays connected; the host sends it the panel's state,
the turn's steps and, while a view wants them, frames of the current tab from CDP `Page.startScreencast`, paced
to at most `_live.FRAME_INTERVAL` and skipped when nothing changed. Input is applied only while the user holds
control, through the tab's own CDP session, never through Playwright's agent actions.

Control lives here, so it survives a streamer's rotation. While the user holds it (Take control, or a handoff
the agent asked for), the agent's browser actions wait `_live.CONTROL_WAIT_SECONDS` and then fail with
`user_in_control`; the action after the user gives it back says so with the page the user left. Control the
user took returns to the agent `_live.CONTROL_GRACE_SECONDS` after the last view closed; a handoff's ends only
with its own end message. Whenever control leaves the user, the mouse buttons and keys the user's input left
pressed are let go first: the panel sends its own ups, but a closed tab or a dropped network loses them. What the
user typed never reaches the agent: each value joins the host's hidden values and the field reads as a hidden
value, as for values typed from the environment. The panel's own address line masks only those
(`Host.env_hidden`): the user sees their own input.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

from . import _format, _live

if TYPE_CHECKING:  # pragma: no cover
    from ._host import Host

#: The focused field of a frame, through open shadow roots; none when focus is on the page itself or in a child frame.
FOCUSED_FIELD = r"""
() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement || el.tagName === 'IFRAME' || el.tagName === 'FRAME') return null;
  return el;
}
"""
FIELD_VALUE = r"""
(el) => String(el.value !== undefined && el.value !== null ? el.value : (el.isContentEditable ? el.innerText : '')).slice(0, 2000)
"""
#: Fields the user typed into that one frame keeps marked: older ones go first.
MASKED_PER_FRAME = 64
#: Typing settles this long before its field is read and marked.
CAPTURE_DELAY = 0.4
#: A view whose socket buffer holds this much skips frames; this much more drops the view.
FRAME_BUFFER_BYTES = 2 * 1024 * 1024
VIEW_BUFFER_BYTES = 16 * 1024 * 1024
FRAME_SEARCH_LIMIT = 8
#: Keys the user's input holds down at once; one more first lets the oldest go.
HELD_KEYS_MAX = 16
#: Seconds one release may take: a tab that went away holds nothing down.
RELEASE_TIMEOUT = 1.0


class Connection:
    """One streamer: writes are never awaited, so a slow reader costs frames, not the host's loop."""

    def __init__(self, writer: asyncio.StreamWriter, frames: bool):
        self.writer = writer
        self.frames = frames
        self.closed = False

    def send(self, message: Dict[str, Any], frame: bool = False) -> bool:
        if self.closed:
            return False
        transport = self.writer.transport
        buffered = transport.get_write_buffer_size() if transport is not None else 0
        if buffered > VIEW_BUFFER_BYTES:
            self.close()
            return False
        if frame and buffered > FRAME_BUFFER_BYTES:
            return False
        try:
            self.writer.write(json.dumps(message, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n")
        except (ConnectionError, OSError, RuntimeError):
            self.close()
            return False
        return True

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            try:
                self.writer.close()
            except (ConnectionError, OSError, RuntimeError):
                pass


class LiveHub:
    def __init__(self, host: "Host"):
        self.host = host
        #: Open views, oldest first.
        self.connections: Dict[Connection, None] = {}
        self.controller = "agent"
        self.handoff = False
        self.agent_turn = asyncio.Event()
        self.agent_turn.set()
        self.note: Optional[str] = None
        self.grace: Optional[asyncio.TimerHandle] = None
        self.watcher: Optional[asyncio.Task] = None
        self.state: Optional[Dict[str, Any]] = None
        self.steps: Optional[List[Dict[str, Any]]] = None
        self.cast: Optional[Tuple[Any, Any]] = None
        #: CDP sessions that already deliver frames here, held so their ids stay theirs.
        self.hooked: Dict[int, Any] = {}
        self.pending: Optional[Tuple[Any, Dict[str, Any], Any, Any]] = None
        self.pump: Optional[asyncio.TimerHandle] = None
        self.sent_at = 0.0
        self.digest: Optional[bytes] = None
        self.seq = 0
        self.frame: Optional[Dict[str, Any]] = None
        self.frame_size: Optional[Tuple[int, int]] = None
        self.device: Optional[Tuple[float, float]] = None
        self.pressed = 0
        #: Where the user's pointer input last went: the tab's CDP session and the page point.
        self.pointer: Optional[Tuple[Any, float, float]] = None
        #: Keys the user's input pressed and did not let go, by `code` (or `key`): the tab's session and the key up.
        self.keys: Dict[str, Tuple[Any, Dict[str, Any]]] = {}
        #: What the user typed since the last capture.
        self.typed = ""
        self.capture: Optional[asyncio.TimerHandle] = None

    # Agent side --------------------------------------------------------------------------------------------------

    def busy(self) -> bool:
        """The user holds the browser or watches it: the host must not idle out."""
        return self.controller == "user" or bool(self.connections)

    async def wait_for_agent(self, seconds: float = _live.CONTROL_WAIT_SECONDS) -> bool:
        if self.controller == "agent":
            return True
        try:
            await asyncio.wait_for(self.agent_turn.wait(), seconds)
        except asyncio.TimeoutError:
            return False
        return True

    def take_note(self) -> Optional[str]:
        note, self.note = self.note, None
        return note

    # Streamers ---------------------------------------------------------------------------------------------------

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, args: Dict[str, Any]) -> None:
        if len(self.connections) >= _live.LIVE_CONNECTIONS_MAX:
            oldest = next(iter(self.connections))
            oldest.close()
            self.connections.pop(oldest, None)
        connection = Connection(writer, args.get("frames") is True)
        self.connections[connection] = None
        if self.grace is not None:
            self.grace.cancel()
            self.grace = None
        try:
            connection.send(await self.current_state())
            connection.send({"t": "steps", "steps": _live.steps_view(self.host.steps)})
            if connection.frames and self.frame is not None:
                connection.send(self.frame, frame=True)
            await self.update_cast()
            if self.watcher is None or self.watcher.done():
                self.watcher = asyncio.ensure_future(self.watch())
            while not connection.closed:
                line = await reader.readline()
                if not line:
                    break
                try:
                    message = json.loads(line.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    continue
                if isinstance(message, dict):
                    await self.handle(connection, message)
        except (ConnectionError, OSError, asyncio.LimitOverrunError, ValueError):
            pass
        finally:
            connection.close()
            self.connections.pop(connection, None)
            await self.update_cast()
            if not self.connections and self.controller == "user" and not self.handoff:
                loop = asyncio.get_running_loop()
                self.grace = loop.call_later(_live.CONTROL_GRACE_SECONDS, lambda: asyncio.ensure_future(self.grace_ended()))

    async def handle(self, connection: Connection, message: Dict[str, Any]) -> None:
        kind = message.get("t")
        reply = message.get("id") if isinstance(message.get("id"), str) else None
        result: Dict[str, Any] = {}
        try:
            if kind == "frames":
                connection.frames = message.get("on") is True
                if connection.frames and self.frame is not None:
                    connection.send(self.frame, frame=True)
                await self.update_cast()
            elif kind == "input":
                await self.apply_input(message.get("input"))
            elif kind == "control":
                await self.control(message.get("action"))
            elif kind == "handoff":
                result = await self.handoff_message(message)
            elif kind != "ping":
                raise _live.LiveError("message_invalid")
        except _live.LiveError as error:
            if reply:
                connection.send({"t": "ack", "id": reply[:64], "ok": False, "code": error.code})
            return
        except Exception:  # noqa: BLE001 - a page that went away mid-input; the code says only that
            if reply:
                connection.send({"t": "ack", "id": reply[:64], "ok": False, "code": "browser_error"})
            return
        if reply:
            connection.send({"t": "ack", "id": reply[:64], "ok": True, **result})

    async def watch(self) -> None:
        """While a view is open: the state when it changes, the steps when they change, the cast on the current tab."""
        while self.connections:
            try:
                await self.refresh()
            except Exception:  # noqa: BLE001 - one failed look at the page must not end the views
                pass
            await asyncio.sleep(0.5)

    async def refresh(self) -> None:
        state = await self.current_state()
        if state != self.state:
            self.state = state
            self.broadcast(state)
        steps = _live.steps_view(self.host.steps)
        if steps != self.steps:
            self.steps = steps
            self.broadcast({"t": "steps", "steps": steps})
        await self.update_cast()

    def broadcast(self, message: Dict[str, Any]) -> None:
        for connection in list(self.connections):
            if not connection.send(message) and connection.closed:
                self.connections.pop(connection, None)

    def page(self) -> Any:
        page = self.host.current
        return page if page is not None and not page.is_closed() else None

    async def title(self, page: Any) -> str:
        try:
            return str(await asyncio.wait_for(page.title(), 1.0) or "")
        except Exception:  # noqa: BLE001 - a busy page keeps the title it showed last
            last = (self.state or {}).get("page") or {}
            return str(last.get("title") or "")

    async def current_state(self) -> Dict[str, Any]:
        page = self.page()
        view = None
        if page is not None:
            view = _live.page_view(self.host.env_hidden.text(page.url or ""), self.host.env_hidden.text(await self.title(page)))
        return {"t": "state", "browser": "running", "controller": self.controller, "handoff": self.handoff, "page": view}

    async def close(self) -> None:
        """The host stops: what the user held is let go, views end (their streamers report the browser gone) and the
        cast stops with the browser."""
        for timer in (self.grace, self.capture, self.pump):
            if timer is not None:
                timer.cancel()
        self.grace = self.capture = self.pump = None
        if self.watcher is not None:
            self.watcher.cancel()
        self.controller, self.handoff = "agent", False
        if not getattr(self.host, "crashed", False):
            try:
                await asyncio.wait_for(self.release_held(), 2 * RELEASE_TIMEOUT)
            except asyncio.TimeoutError:
                pass
        self.pressed, self.keys = 0, {}
        for connection in list(self.connections):
            connection.close()
        self.connections.clear()
        self.cast = None
        self.agent_turn.set()

    # Control and handoff -----------------------------------------------------------------------------------------

    def give_user(self) -> None:
        if self.grace is not None:
            self.grace.cancel()
            self.grace = None
        self.controller = "user"
        self.agent_turn.clear()

    async def control(self, action: Any) -> None:
        if action == "take":
            if not self.handoff:
                self.give_user()
        elif action == "return":
            if self.handoff:
                raise _live.LiveError("handoff_pending")
            if self.controller == "user":
                await self.return_control()
        else:
            raise _live.LiveError("message_invalid")
        await self.refresh()

    async def return_control(self) -> None:
        await self.release_held()
        await self.capture_now()
        self.note = await self.returned_note()
        self.controller = "agent"
        self.agent_turn.set()

    async def release_held(self) -> None:
        """Lets go of what the user's input left pressed before the agent gets the page back: each held mouse button
        at the last pointer position, then each held key, newest first."""
        pressed, pointer, keys = self.pressed, self.pointer, self.keys
        self.pressed, self.keys = 0, {}
        if pressed and pointer is not None:
            session, x, y = pointer
            for name, bit in _live.MOUSE_BUTTONS.items():
                if bit and pressed & bit:
                    pressed &= ~bit
                    release = {"type": "mouseReleased", "x": x, "y": y, "button": name, "buttons": pressed, "clickCount": 1,
                               "modifiers": 0}
                    await self.dispatch(session, "Input.dispatchMouseEvent", release)
        for session, release in reversed(list(keys.values())):
            await self.dispatch(session, "Input.dispatchKeyEvent", release)

    @staticmethod
    async def dispatch(session: Any, method: str, params: Dict[str, Any]) -> None:
        try:
            await asyncio.wait_for(session.send(method, params), RELEASE_TIMEOUT)
        except Exception:  # noqa: BLE001 - a tab that went away holds nothing down
            pass

    async def grace_ended(self) -> None:
        self.grace = None
        if not self.connections and self.controller == "user" and not self.handoff:
            await self.return_control()

    async def returned_note(self) -> str:
        page = self.page()
        if page is None:
            return "The user gave the browser back to you; no tab is open now."
        url = _format.clean(self.host.hidden.text(_format.without_userinfo(page.url or "")), 300)
        title = _format.clean(self.host.hidden.text(await self.title(page)), 120)
        return f"The user gave the browser back to you after using it. The page is now {url}" + (f" ({_format.quoted(title, 120)})." if title else ".")

    async def handoff_message(self, message: Dict[str, Any]) -> Dict[str, Any]:
        action = message.get("action")
        if action == "begin":
            if self.page() is None:
                raise _live.LiveError("no_page")
            self.handoff = True
            self.give_user()
            await self.refresh()
            return {}
        if action != "end":
            raise _live.LiveError("message_invalid")
        outcome = message.get("outcome")
        if outcome not in ("completed", "cancelled", "timed_out"):
            raise _live.LiveError("message_invalid")
        await self.release_held()
        await self.capture_now()
        saved: Optional[str] = None
        if outcome == "completed":
            saved = await self.host.save_site_session()
        self.handoff = False
        self.controller = "agent"
        self.agent_turn.set()
        page = self.page()
        view = None
        if page is not None:
            # What the agent reads: values typed from the environment and by the user are masked.
            view = {"url": _format.clean(self.host.hidden.text(_format.without_userinfo(page.url or "")), _live.URL_CHARS),
                    "title": _format.clean(self.host.hidden.text(await self.title(page)), _live.TITLE_CHARS)}
        await self.refresh()
        return {"page": view, "saved": saved}

    # Input -------------------------------------------------------------------------------------------------------

    async def apply_input(self, event: Any) -> None:
        if not isinstance(event, dict):
            raise _live.LiveError("input_invalid")
        if self.controller != "user":
            raise _live.LiveError("not_in_control")
        page = self.page()
        session = self.host.cdp.get(page) if page is not None else None
        if session is None:
            raise _live.LiveError("no_page")
        self.host.last_used = time.monotonic()
        kind = event.get("kind")
        if kind == "mouse":
            if self.frame_size is None or self.device is None:
                raise _live.LiveError("no_frame")
            params, pressed = _live.mouse_event(event, self.frame_size, self.device, self.pressed)
            if params["type"] == "mousePressed" and self.typed:
                # A click may move focus: what was typed so far belongs to the field that had it.
                await self.capture_now()
            await session.send("Input.dispatchMouseEvent", params)
            self.pressed = pressed
            self.pointer = (session, params["x"], params["y"])
        elif kind == "key":
            params, typed = _live.key_event(event)
            if params["type"] != "keyUp" and params["key"] in ("Tab", "Enter") and self.typed:
                await self.capture_now()
            await session.send("Input.dispatchKeyEvent", params)
            await self.track_key(session, params)
            if typed is not None:
                self.typed += typed
                self.schedule_capture()
            elif params["type"] == "rawKeyDown" and params["key"] == "Backspace":
                self.typed = self.typed[:-1]
        elif kind == "text":
            text = _live.text_input(event)
            await session.send("Input.insertText", {"text": text})
            self.typed += text
            self.schedule_capture()
        else:
            raise _live.LiveError("input_invalid")

    async def track_key(self, session: Any, params: Dict[str, Any]) -> None:
        held = params["code"] or params["key"]
        self.keys.pop(held, None)
        if params["type"] == "keyUp":
            return
        self.keys[held] = (session, {"type": "keyUp", "key": params["key"], "code": params["code"], "modifiers": 0,
                                     "windowsVirtualKeyCode": params["windowsVirtualKeyCode"],
                                     "nativeVirtualKeyCode": params["nativeVirtualKeyCode"]})
        while len(self.keys) > HELD_KEYS_MAX:
            oldest = next(iter(self.keys))
            old_session, release = self.keys.pop(oldest)
            await self.dispatch(old_session, "Input.dispatchKeyEvent", release)

    def schedule_capture(self) -> None:
        if self.capture is not None:
            self.capture.cancel()
        loop = asyncio.get_running_loop()
        self.capture = loop.call_later(CAPTURE_DELAY, lambda: asyncio.ensure_future(self.capture_now()))

    async def capture_now(self) -> None:
        """Marks the field the user typed into as hidden and adds what it holds, and what was typed, to the mask."""
        if self.capture is not None:
            self.capture.cancel()
            self.capture = None
        typed, self.typed = self.typed, ""
        if not typed:
            return
        self.host.hidden.add(typed)
        page = self.page()
        found = await self.focused_field(page) if page is not None else None
        if found is None:
            return
        frame, element = found
        try:
            value = await asyncio.wait_for(element.evaluate(FIELD_VALUE), 2.0)
        except Exception:  # noqa: BLE001 - the field went away; what was typed is masked already
            value = ""
        if isinstance(value, str) and value:
            self.host.hidden.add(value)
        fields = self.host.masked.setdefault(frame, [])
        fields.append((frame.url, element))
        del fields[:-MASKED_PER_FRAME]

    async def focused_field(self, page: Any) -> Optional[Tuple[Any, Any]]:
        frames = [page.main_frame, *page.frames[1:FRAME_SEARCH_LIMIT]]
        for frame in frames:
            try:
                if frame.is_detached():
                    continue
                handle = await asyncio.wait_for(frame.evaluate_handle(FOCUSED_FIELD), 2.0)
            except Exception:  # noqa: BLE001 - a frame that navigated away holds no focus
                continue
            element = handle.as_element()
            if element is not None:
                return frame, element
            try:
                await handle.dispose()
            except Exception:  # noqa: BLE001
                pass
        return None

    # Frames ------------------------------------------------------------------------------------------------------

    async def update_cast(self) -> None:
        """The screencast runs on the current tab while some view wants frames, and nowhere otherwise."""
        wanted = self.page() if any(connection.frames for connection in self.connections) else None
        current = self.cast[0] if self.cast is not None else None
        if wanted is current:
            return
        if self.cast is not None:
            _page, session = self.cast
            self.cast = None
            try:
                await session.send("Page.stopScreencast")
            except Exception:  # noqa: BLE001 - the tab closed
                pass
        if wanted is None:
            return
        session = self.host.cdp.get(wanted)
        if session is None:
            return
        live_sessions = {id(value) for value in self.host.cdp.values()}
        for key in [key for key in self.hooked if key not in live_sessions]:
            del self.hooked[key]
        if self.hooked.get(id(session)) is not session:
            self.hooked[id(session)] = session
            session.on("Page.screencastFrame", lambda params, source=session: self.on_frame(source, params))
        self.cast = (wanted, session)
        self.digest = None
        try:
            await session.send("Page.startScreencast", {"format": "jpeg", "quality": _live.FRAME_QUALITY,
                                                         "maxWidth": _live.FRAME_MAX[0], "maxHeight": _live.FRAME_MAX[1],
                                                         "everyNthFrame": 1})
        except Exception:  # noqa: BLE001 - the tab closed meanwhile; the watcher moves the cast
            self.cast = None

    def on_frame(self, session: Any, params: Dict[str, Any]) -> None:
        sid = params.get("sessionId")
        if self.cast is None or self.cast[1] is not session:
            asyncio.ensure_future(self.ack(session, sid))
            return
        if self.pending is not None:
            asyncio.ensure_future(self.ack(self.pending[3], self.pending[2]))
        self.pending = (params.get("data"), params.get("metadata") or {}, sid, session)
        if self.pump is None:
            loop = asyncio.get_running_loop()
            self.pump = loop.call_later(max(0.0, self.sent_at + _live.FRAME_INTERVAL - loop.time()), self.send_frame)

    def send_frame(self) -> None:
        self.pump = None
        pending, self.pending = self.pending, None
        if pending is None:
            return
        data, metadata, sid, session = pending
        # Consumed now: the next frame may come and waits for the next slot.
        asyncio.ensure_future(self.ack(session, sid))
        if not isinstance(data, str) or not 4 <= len(data) <= _live.FRAME_BASE64_MAX:
            return
        digest = hashlib.blake2b(data.encode("ascii", "replace"), digest_size=16).digest()
        if digest == self.digest:
            return
        size = _live.jpeg_size(data)
        width, height = metadata.get("deviceWidth"), metadata.get("deviceHeight")
        if size is None or not isinstance(width, (int, float)) or not isinstance(height, (int, float)) or width <= 0 or height <= 0:
            return
        loop = asyncio.get_running_loop()
        self.digest, self.sent_at = digest, loop.time()
        self.seq += 1
        self.frame_size, self.device = size, (float(width), float(height))
        self.frame = {"t": "frame", "seq": self.seq, "data": data, "width": size[0], "height": size[1]}
        for connection in list(self.connections):
            if connection.frames:
                connection.send(self.frame, frame=True)

    async def ack(self, session: Any, sid: Any) -> None:
        if sid is None:
            return
        try:
            await session.send("Page.screencastFrameAck", {"sessionId": sid})
        except Exception:  # noqa: BLE001 - the tab closed
            pass
