"""The browser host's side of the live view: frames, the user's input, Take control and handoff, per agent.

A streamer (`live.py`) connects with `{"op": "live"}` and stays connected; the host sends it the browsing agents
(`agents`), the state and steps of the agent it selected (`select`, the main agent until then) and, while a view
wants them, frames of that agent's current tab from CDP `Page.startScreencast`, paced to at most
`_live.FRAME_INTERVAL` and skipped when nothing changed. Input is applied only while the user holds that agent's
control, through the tab's own CDP session, never through Playwright's agent actions. Every message names its
agent in `agents.LIVE_AGENT_FIELD`; a message without one is the main agent's, as protocol 1 had it.

Which agents browse, and each one's current tab, action lock, CDP sessions, hidden values, masked fields and steps,
are the host's (`Host.live_targets`, `Target`; `Host.save_site_session(agent)` saves the site of that agent's tab); a
host without per-agent tabs serves the main agent alone on `Host.current` under `Host.lock`. Control, the pending
handoff, the admission of actions and the return notice are kept here per agent, so they survive a streamer's
rotation and one agent never waits for, or consumes, another's; AIQSA keeps its own record and never takes the
guest's word that the user holds it.

While the user holds an agent's control (Take control, or a handoff that agent asked for), that agent's browser
actions wait `_live.CONTROL_WAIT_SECONDS` without its lock and then fail with `user_in_control`; the other agents go
on. An action checks again once it holds the lock, and control passes to the user only between two of that agent's
actions (or after `TAKE_WAIT_SECONDS` of a long one), so no action of that agent starts while the user holds its
tab. The action after the user gives it back says so with the page the user left. Control the user took returns to
the agent `_live.CONTROL_GRACE_SECONDS` after the last view closed; a handoff's ends only with its own end message.
Whenever control leaves the user, the mouse buttons and keys the user's input left pressed are let go first: the
panel sends its own ups, but a closed tab or a dropped network loses them.

What the user typed never reaches the agent: the whole value typed since the user last moved focus (pauses do not
split it) and the focused field's value join the host's hidden values before a key or click that can submit or
navigate goes out, and the field reads as a hidden value, as for values typed from the environment. The panel's
own address line masks only those (`Host.env_hidden`): the user sees their own input. Best effort: agent code in
the same VM can read the page itself.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import re
import time
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable, Dict, List, Optional, Tuple

from .. import agents as _agents
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
#: Take control and a handoff wait this long for the agent's action under way; a longer one (a `wait`) goes on.
TAKE_WAIT_SECONDS = 5.0
#: Characters of the value being typed that are kept for masking; older ones go first.
TYPED_MAX_CHARS = 1024
#: Agents one `agents` message lists (`BROWSER_LIVE_LIMITS.agentsPerEvent`): the browser's slots and a few more
#: whose control or handoff outlived their slot.
AGENTS_LISTED_MAX = 8
#: Keys that move the caret (with Shift, the selection): what is typed after them may land anywhere in the field.
CARET_KEYS = frozenset({"ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"})
MODIFIER_KEYS = frozenset({"Alt", "AltGraph", "CapsLock", "Control", "Meta", "Shift"})

MAIN = _agents.MAIN_AGENT_ID
_AGENT_ID = re.compile(_agents.AGENT_ID_PATTERN)


class UserInControl(Exception):
    """The user held the agent's tab for the whole wait: the agent's action did not run."""


class Target:
    """One browsing agent as the host reports it: its id, its name (a sub-agent's), its current tab (None before it
    opened one), the lock its actions run under, `acted`, a number that grows with each of its actions, so the panel
    can pick the agent that acted last, and the agent's own tab state: CDP sessions by tab, hidden values (all, and
    those typed from the environment), masked fields and steps. State the host leaves out is the host's one set.
    `touch`, when given, marks the agent's tab as used now: the user working it keeps its slot from idling out."""

    __slots__ = ("agent", "name", "page", "lock", "acted", "cdp", "hidden", "env_hidden", "masked", "steps", "touch")

    def __init__(self, agent: str, name: Optional[str], page: Any, lock: Optional[asyncio.Lock], acted: int = 0, *,
                 cdp: Optional[Dict[Any, Any]] = None, hidden: Any = None, env_hidden: Any = None,
                 masked: Optional[Dict[Any, Any]] = None, steps: Optional[List[Dict[str, Any]]] = None,
                 touch: Optional[Callable[[], None]] = None):
        self.agent = agent
        self.name = name
        self.page = page
        self.lock = lock
        self.acted = acted
        self.cdp = cdp
        self.hidden = hidden
        self.env_hidden = env_hidden
        self.masked = masked
        self.steps = steps
        self.touch = touch


def valid_agent(value: Any) -> bool:
    return isinstance(value, str) and _AGENT_ID.fullmatch(value) is not None


def agent_of(message: Dict[str, Any]) -> str:
    """The agent a message names; absent means the main agent (protocol 1)."""
    value = message.get(_agents.LIVE_AGENT_FIELD, MAIN)
    if not valid_agent(value):
        raise _live.LiveError("message_invalid")
    return value


class Connection:
    """One streamer: writes are never awaited, so a slow reader costs frames, not the host's loop."""

    def __init__(self, writer: asyncio.StreamWriter, frames: bool, agent: str = MAIN):
        self.writer = writer
        self.frames = frames
        self.closed = False
        #: The agent whose tab this view streams (`select`).
        self.agent = agent
        #: What this view was last sent, so only changes go out.
        self.state: Optional[Dict[str, Any]] = None
        self.steps: Optional[List[Dict[str, Any]]] = None

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


class Cast:
    """The screencast of one tab while a view streams it, paced on its own."""

    def __init__(self, page: Any, session: Any):
        self.page = page
        self.session = session
        self.pending: Optional[Tuple[Any, Dict[str, Any], Any]] = None
        self.pump: Optional[asyncio.TimerHandle] = None
        self.sent_at = 0.0
        self.digest: Optional[bytes] = None
        #: The latest frame of this tab, without its agent (each view gets the agent it selected).
        self.frame: Optional[Dict[str, Any]] = None


class AgentLive:
    """The live view's hold on one agent's tab: who controls it, a pending handoff, and the user's input into it."""

    def __init__(self, hub: "LiveHub", agent: str):
        self.hub = hub
        self.agent = agent
        self.controller = "agent"
        self.handoff = False
        self.agent_turn = asyncio.Event()
        self.agent_turn.set()
        self.note: Optional[str] = None
        self.grace: Optional[asyncio.TimerHandle] = None
        self.pressed = 0
        #: Where the user's pointer input last went: the tab's CDP session and the page point.
        self.pointer: Optional[Tuple[Any, float, float]] = None
        #: Keys the user's input pressed and did not let go, by `code` (or `key`): the tab's session and the key up.
        self.keys: Dict[str, Tuple[Any, Dict[str, Any]]] = {}
        #: The value the user's typing gives the field, as far as their keys tell: kept across pauses, so a value typed
        #: in parts, or into one-character fields a page advances through itself, is hidden whole. A new value starts
        #: after Tab, Enter, a click or a key that moves the caret.
        self.typed = ""
        #: Select all came last: the next text or deletion replaces the whole value.
        self.replace_next = False
        #: A run of deletions is under way: the value as it stood before it is hidden for good already.
        self.deleting = False
        #: The user typed or deleted since the last capture.
        self.typed_new = False
        self.capture: Optional[asyncio.TimerHandle] = None

        #: Where what the user typed is hidden once the agent has no tab any more (its slot went meanwhile).
        self.spare_hidden = _format.HiddenValues()
        self.spare_masked: Dict[Any, Any] = {}

    @property
    def hidden(self) -> Any:
        target = self.hub.target(self.agent)
        return target.hidden if target is not None else self.spare_hidden

    @property
    def masked(self) -> Dict[Any, Any]:
        target = self.hub.target(self.agent)
        return target.masked if target is not None else self.spare_masked

    def idle(self) -> bool:
        """Holds nothing the view must keep: an entry for an agent that stopped browsing may go."""
        return self.controller == "agent" and not self.handoff and self.note is None and not self.pressed and not self.keys \
            and self.grace is None and self.capture is None

    def page(self) -> Any:
        return self.hub.page(self.agent)

    def cancel_timers(self) -> None:
        for timer in (self.grace, self.capture):
            if timer is not None:
                timer.cancel()
        self.grace = self.capture = None

    # Control -----------------------------------------------------------------------------------------------------

    async def wait_for_agent(self, seconds: float) -> bool:
        if self.agent_turn.is_set():
            return True
        try:
            await asyncio.wait_for(self.agent_turn.wait(), max(0.0, seconds))
        except asyncio.TimeoutError:
            return False
        return True

    async def hand_to_user(self) -> None:
        """Control goes to the user between two of this agent's actions: from now on none of them starts, and one
        under way may finish first, for at most `TAKE_WAIT_SECONDS` (a longer one, such as a `wait`, goes on)."""
        if self.grace is not None:
            self.grace.cancel()
            self.grace = None
        self.agent_turn.clear()
        target = self.hub.target(self.agent)
        lock = target.lock if target is not None else None
        acquired = False
        try:
            if lock is not None:
                try:
                    await asyncio.wait_for(lock.acquire(), TAKE_WAIT_SECONDS)
                    acquired = True
                except asyncio.TimeoutError:
                    pass
            self.controller = "user"
        finally:
            if acquired and lock is not None:
                lock.release()
            if self.controller != "user":
                self.agent_turn.set()

    async def control(self, action: Any) -> None:
        self.hub.touched(self.agent)
        if action == "take":
            if getattr(self.hub.host, "_closing", False):
                raise _live.LiveError("browser_unavailable")
            if self.hub.target(self.agent) is None:
                raise _live.LiveError("no_page")
            if not self.handoff and self.controller != "user":
                await self.hand_to_user()
        elif action == "return":
            if self.handoff:
                raise _live.LiveError("handoff_pending")
            if self.controller == "user":
                await self.return_control()
        else:
            raise _live.LiveError("message_invalid")

    async def return_control(self) -> None:
        await self.release_held()
        await self.capture_now(focus_moves=True)
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
                    await LiveHub.dispatch(session, "Input.dispatchMouseEvent", release)
        for session, release in reversed(list(keys.values())):
            await LiveHub.dispatch(session, "Input.dispatchKeyEvent", release)

    async def grace_ended(self) -> None:
        self.grace = None
        if not self.hub.connections and self.controller == "user" and not self.handoff:
            await self.return_control()

    async def returned_note(self) -> str:
        page = self.page()
        if page is None:
            return "The user gave the browser back to you; no tab is open now."
        url = _format.clean(self.hidden.text(_format.without_userinfo(page.url or "")), 300)
        title = _format.clean(self.hidden.text(await self.hub.title(self.agent, page)), 120)
        return f"The user gave the browser back to you after using it. The page is now {url}" + (f" ({_format.quoted(title, 120)})." if title else ".")

    async def handoff_message(self, message: Dict[str, Any]) -> Dict[str, Any]:
        self.hub.touched(self.agent)
        action = message.get("action")
        if action == "begin":
            if getattr(self.hub.host, "_closing", False):
                raise _live.LiveError("browser_unavailable")
            if self.page() is None:
                raise _live.LiveError("no_page")
            self.handoff = True
            if self.controller != "user":
                await self.hand_to_user()
            return {}
        if action != "end":
            raise _live.LiveError("message_invalid")
        outcome = message.get("outcome")
        if outcome not in ("completed", "cancelled", "timed_out"):
            raise _live.LiveError("message_invalid")
        await self.release_held()
        await self.capture_now(focus_moves=True)
        saved: Optional[str] = None
        # Done saves the site's sign-in only for a handoff about signing in (operator decision 2026-10-27): a choice
        # or a look at the page never adds a browser session to the user's Secrets. It is this agent's tab's site.
        if outcome == "completed" and message.get("reason") in _live.SAVE_SESSION_REASONS:
            saved = await self.hub.save_site_session(self.agent)
        self.handoff = False
        self.controller = "agent"
        self.agent_turn.set()
        page = self.page()
        view = None
        if page is not None:
            # What the agent reads: values typed from the environment and by the user are masked.
            view = {"url": _format.clean(self.hidden.text(_format.without_userinfo(page.url or "")), _live.URL_CHARS),
                    "title": _format.clean(self.hidden.text(await self.hub.title(self.agent, page)), _live.TITLE_CHARS)}
        return {"page": view, "saved": saved}

    # Input -------------------------------------------------------------------------------------------------------

    async def apply_input(self, event: Any) -> None:
        if not isinstance(event, dict):
            raise _live.LiveError("input_invalid")
        if self.controller != "user":
            raise _live.LiveError("not_in_control")
        page = self.page()
        session = self.hub.session(self.agent, page) if page is not None else None
        if session is None:
            raise _live.LiveError("no_page")
        self.hub.touched(self.agent)
        kind = event.get("kind")
        if kind == "mouse":
            geometry = self.hub.geometry.get(page)
            if geometry is None:
                raise _live.LiveError("no_frame")
            frame_size, device = geometry
            params, pressed = _live.mouse_event(event, frame_size, device, self.pressed)
            if params["type"] == "mousePressed":
                # A click may submit or move focus: what was typed is hidden first, and a new value starts.
                await self.capture_now(focus_moves=True)
            await session.send("Input.dispatchMouseEvent", params)
            self.pressed = pressed
            self.pointer = (session, params["x"], params["y"])
        elif kind == "key":
            params, typed = _live.key_event(event)
            if params["type"] != "keyUp":
                key, modifiers = params["key"], params["modifiers"]
                if key in ("Tab", "Enter"):
                    # Enter may submit and navigate, Tab moves focus: masking is updated before either goes out, and
                    # what is typed next is a new value.
                    await self.capture_now(focus_moves=True)
                elif typed is not None:
                    self.edit(typed)
                elif key in ("Backspace", "Delete"):
                    self.delete(key, modifiers)
                elif key in MODIFIER_KEYS:
                    pass
                elif modifiers & (_live.MODIFIER_CTRL | _live.MODIFIER_META) and key.lower() == "a":
                    self.select_all()
                elif key in CARET_KEYS or modifiers & (_live.MODIFIER_CTRL | _live.MODIFIER_META):
                    # The caret or the selection moved, or a shortcut cut, undid or pasted: the value is not known now.
                    self.close_value()
            await session.send("Input.dispatchKeyEvent", params)
            await self.track_key(session, params)
        elif kind == "text":
            text = _live.text_input(event)
            self.edit(text)
            await session.send("Input.insertText", {"text": text})
        else:
            raise _live.LiveError("input_invalid")

    # What the user types -----------------------------------------------------------------------------------------

    def edit(self, text: str) -> None:
        """The value the field holds once `text` goes in, hidden before it goes out: a page may submit on this very
        character (a code field on its last digit). After Select all the text replaces the value."""
        value = text if self.replace_next else self.typed + text
        self.typed = value[-TYPED_MAX_CHARS:]
        self.replace_next = self.deleting = False
        self.updated()

    def delete(self, key: str, modifiers: int) -> None:
        if modifiers & (_live.MODIFIER_CTRL | _live.MODIFIER_ALT | _live.MODIFIER_META):
            # A word or a line goes: what is left is not known.
            self.close_value()
            return
        if self.replace_next:
            # Select all, then delete: the field is empty (its old value was kept hidden at Select all).
            self.typed, self.replace_next = "", False
        elif key == "Backspace" and self.typed:
            if not self.deleting:
                # The value as it stood before this run of deletions stays hidden; the shorter one is the new value.
                self.hidden.commit()
                self.deleting = True
            self.typed = self.typed[:-1]
        else:
            # Delete at the end of the value takes nothing.
            return
        self.updated()

    def select_all(self) -> None:
        self.hidden.commit()
        self.replace_next, self.deleting = True, False

    def close_value(self) -> None:
        """Keeps the value so far hidden for good and starts a new one; the page is read at the next capture."""
        self.hidden.commit()
        self.typed, self.replace_next, self.deleting = "", False, False
        self.typed_new = True
        self.schedule_capture()

    def updated(self) -> None:
        # One replaceable pattern while the value grows or shrinks, not one per keystroke.
        self.hidden.provisional(self.typed)
        self.typed_new = True
        self.schedule_capture()

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
            await LiveHub.dispatch(old_session, "Input.dispatchKeyEvent", release)

    def schedule_capture(self) -> None:
        if self.capture is not None:
            self.capture.cancel()
        loop = asyncio.get_running_loop()
        self.capture = loop.call_later(CAPTURE_DELAY, lambda: asyncio.ensure_future(self.capture_now()))

    async def capture_now(self, focus_moves: bool = False) -> None:
        """Hides what the focused field holds (read from the page) and marks that field hidden; the value being typed
        is hidden already. With `focus_moves` (a Tab, an Enter or a click is about to go out, or the user's control
        ends) that value is kept for good and the next one starts empty."""
        if self.capture is not None:
            self.capture.cancel()
            self.capture = None
        fresh = self.typed_new
        self.typed_new = False
        if focus_moves:
            self.hidden.commit()
            self.typed, self.replace_next, self.deleting = "", False, False
        if not fresh:
            return
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
            self.hidden.add(value)
        fields = self.masked.setdefault(frame, [])
        fields.append((frame.url, element))
        del fields[:-MASKED_PER_FRAME]

    @staticmethod
    async def focused_field(page: Any) -> Optional[Tuple[Any, Any]]:
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


class LiveHub:
    def __init__(self, host: "Host"):
        self.host = host
        #: Open views, oldest first.
        self.connections: Dict[Connection, None] = {}
        #: Control and input per agent, made on first use; an idle one of an agent that stopped browsing goes.
        self.agents: Dict[str, AgentLive] = {}
        self.watcher: Optional[asyncio.Task] = None
        #: The `agents` message last sent.
        self.listed: Optional[Dict[str, Any]] = None
        #: Screencasts by tab, while some view streams that tab.
        self.casts: Dict[Any, Cast] = {}
        #: CDP sessions that already deliver frames here, held so their ids stay theirs.
        self.hooked: Dict[int, Any] = {}
        #: Per tab: the latest frame's size and the page viewport it shows, which map the user's pointer input.
        self.geometry: Dict[Any, Tuple[Tuple[int, int], Tuple[float, float]]] = {}
        #: Per agent: the title its tab showed last, kept while a busy page does not answer.
        self.titles: Dict[str, str] = {}
        self.seq = 0

    # The host's agents -------------------------------------------------------------------------------------------

    def targets(self) -> List[Target]:
        """The browsing agents, as the host reports them; a host without per-agent tabs has the main agent alone."""
        provider = getattr(self.host, "live_targets", None)
        found: List[Target] = []
        seen = set()
        for target in provider() if provider is not None else [Target(MAIN, None, self.host.current, self.host.lock, 0)]:
            agent = getattr(target, "agent", None)
            if valid_agent(agent) and agent not in seen:
                seen.add(agent)
                for name in ("cdp", "hidden", "env_hidden", "masked", "steps"):
                    if getattr(target, name, None) is None:
                        setattr(target, name, getattr(self.host, name))
                found.append(target)
        return found

    def target(self, agent: str) -> Optional[Target]:
        return next((target for target in self.targets() if target.agent == agent), None)

    def page(self, agent: str) -> Any:
        target = self.target(agent)
        page = target.page if target is not None else None
        return page if page is not None and not page.is_closed() else None

    def control_of(self, agent: str) -> AgentLive:
        live = self.agents.get(agent)
        if live is None:
            live = self.agents[agent] = AgentLive(self, agent)
        return live

    def steps_of(self, agent: str) -> List[Dict[str, Any]]:
        target = self.target(agent)
        return list(target.steps or []) if target is not None else []

    def session(self, agent: str, page: Any) -> Any:
        """The CDP session of one of the agent's tabs."""
        target = self.target(agent)
        return target.cdp.get(page) if target is not None and target.cdp is not None else None

    def touched(self, agent: str) -> None:
        """The user works the agent's tab (input, control, a handoff): the host counts it as that agent's use, so
        neither the agent's slot nor the browser idles out under the user."""
        target = self.target(agent)
        touch = getattr(target, "touch", None) if target is not None else None
        if touch is not None:
            touch()
            return
        try:
            self.host.last_used = time.monotonic()
        except AttributeError:
            pass

    def agent_held_by_user(self, agent: str) -> bool:
        """Whether the user holds or is taking the agent's tab, or its handoff is pending: the host must not
        expire that agent's slot or close its tabs meanwhile."""
        live = self.agents.get(agent)
        return live is not None and (live.controller == "user" or live.handoff or not live.agent_turn.is_set())

    def selected_by_user(self, agent: str) -> None:
        """Tabs the user's own input opens belong to the agent whose tab the view shows (the host's choice)."""
        select = getattr(self.host, "select_live_agent", None)
        if select is not None:
            select(agent)

    async def save_site_session(self, agent: str) -> Optional[str]:
        if getattr(self.host, "live_targets", None) is None:
            return await self.host.save_site_session() if agent == MAIN else None
        return await self.host.save_site_session(agent)

    # Agent side --------------------------------------------------------------------------------------------------

    def busy(self) -> bool:
        """The user holds a tab or watches the browser: the host must not idle out."""
        return any(live.controller == "user" for live in self.agents.values()) or bool(self.connections)

    async def wait_for_agent(self, seconds: float = _live.CONTROL_WAIT_SECONDS, agent: str = MAIN) -> bool:
        """Whether the agent has its tab now or gets it back within `seconds`; Take control in progress counts as the
        user's."""
        live = self.agents.get(agent)
        return True if live is None else await live.wait_for_agent(seconds)

    @contextlib.asynccontextmanager
    async def agent_action(self, lock: asyncio.Lock, control_free: bool = False, agent: str = MAIN) -> AsyncIterator[None]:
        """Holds `lock` (the agent's own) for one action of `agent`, only while that agent has its tab.

        The wait for the user to give the tab back (at most `_live.CONTROL_WAIT_SECONDS` in all) never holds the
        lock, which a handoff's end needs to save the site; control is checked again once the lock is held, so an
        action queued behind another never starts after the user took control. `control_free` actions (they read no
        page) skip the wait. Raises `UserInControl` when the user kept the tab for the whole wait. Other agents'
        control never holds this agent.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _live.CONTROL_WAIT_SECONDS
        while True:
            if not control_free and not await self.wait_for_agent(deadline - loop.time(), agent):
                raise UserInControl()
            await lock.acquire()
            live = self.agents.get(agent)
            if control_free or live is None or live.agent_turn.is_set():
                break
            lock.release()
        try:
            yield
        finally:
            lock.release()

    def take_note(self, agent: str = MAIN) -> Optional[str]:
        live = self.agents.get(agent)
        if live is None:
            return None
        note, live.note = live.note, None
        return note

    # Streamers ---------------------------------------------------------------------------------------------------

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, args: Dict[str, Any]) -> None:
        if len(self.connections) >= _live.LIVE_CONNECTIONS_MAX:
            oldest = next(iter(self.connections))
            oldest.close()
            self.connections.pop(oldest, None)
        selected = args.get(_agents.LIVE_AGENT_FIELD)
        connection = Connection(writer, args.get("frames") is True, selected if valid_agent(selected) else MAIN)
        self.connections[connection] = None
        self.selected_by_user(connection.agent)
        for live in self.agents.values():
            if live.grace is not None:
                live.grace.cancel()
                live.grace = None
        try:
            connection.send(await self.agents_message())
            await self.send_view(connection)
            await self.update_casts()
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
            await self.update_casts()
            if not self.connections:
                loop = asyncio.get_running_loop()
                for live in self.agents.values():
                    if live.controller == "user" and not live.handoff and live.grace is None:
                        live.grace = loop.call_later(_live.CONTROL_GRACE_SECONDS,
                                                     lambda held=live: asyncio.ensure_future(held.grace_ended()))

    async def handle(self, connection: Connection, message: Dict[str, Any]) -> None:
        kind = message.get("t")
        reply = message.get("id") if isinstance(message.get("id"), str) else None
        result: Dict[str, Any] = {}
        try:
            if kind == "frames":
                connection.frames = message.get("on") is True
                cast = self.casts.get(self.page(connection.agent))
                if connection.frames and cast is not None and cast.frame is not None:
                    connection.send({**cast.frame, _agents.LIVE_AGENT_FIELD: connection.agent}, frame=True)
                await self.update_casts()
            elif kind == _agents.LIVE_SELECT_MESSAGE:
                connection.agent = agent_of(message)
                self.selected_by_user(connection.agent)
                connection.state = connection.steps = None
                await self.send_view(connection)
                await self.update_casts()
            elif kind == "input":
                await self.control_of(agent_of(message)).apply_input(message.get("input"))
            elif kind == "control":
                await self.control_of(agent_of(message)).control(message.get("action"))
                await self.refresh()
            elif kind == "handoff":
                result = await self.control_of(agent_of(message)).handoff_message(message)
                await self.refresh()
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
        """While a view is open: the agents, each view's state and steps when they change, the casts on their tabs."""
        while self.connections:
            try:
                await self.refresh()
            except Exception:  # noqa: BLE001 - one failed look at the page must not end the views
                pass
            await asyncio.sleep(0.5)

    async def refresh(self) -> None:
        listed = await self.agents_message()
        if listed != self.listed:
            self.listed = listed
            self.broadcast(listed)
        for connection in list(self.connections):
            await self.send_view(connection)
        await self.update_casts()
        self.prune()

    async def send_view(self, connection: Connection) -> None:
        """The state and steps of the agent this view streams, when they changed, and its latest frame on a select."""
        fresh = connection.state is None
        state = await self.current_state(connection.agent)
        if state != connection.state and connection.send(state):
            connection.state = state
        steps = _live.steps_view(self.steps_of(connection.agent))
        if steps != connection.steps and connection.send({"t": "steps", _agents.LIVE_AGENT_FIELD: connection.agent, "steps": steps}):
            connection.steps = steps
        cast = self.casts.get(self.page(connection.agent))
        if fresh and connection.frames and cast is not None and cast.frame is not None:
            connection.send({**cast.frame, _agents.LIVE_AGENT_FIELD: connection.agent}, frame=True)
        if connection.closed:
            self.connections.pop(connection, None)

    def broadcast(self, message: Dict[str, Any]) -> None:
        for connection in list(self.connections):
            if not connection.send(message) and connection.closed:
                self.connections.pop(connection, None)

    def prune(self) -> None:
        """Forgets idle control of agents that stopped browsing, so ids the host no longer reports do not pile up."""
        browsing = {target.agent for target in self.targets()}
        for agent in [agent for agent, live in self.agents.items() if agent not in browsing and live.idle()]:
            del self.agents[agent]
        for page in [page for page in self.geometry if page.is_closed()]:
            del self.geometry[page]

    async def title(self, agent: str, page: Any) -> str:
        try:
            title = str(await asyncio.wait_for(page.title(), 1.0) or "")
        except Exception:  # noqa: BLE001 - a busy page keeps the title it showed last
            return self.titles.get(agent, "")
        self.titles[agent] = title
        return title

    async def page_view(self, agent: str) -> Optional[Dict[str, str]]:
        page = self.page(agent)
        if page is None:
            return None
        target = self.target(agent)
        env_hidden = target.env_hidden if target is not None else self.host.env_hidden
        return _live.page_view(env_hidden.text(page.url or ""), env_hidden.text(await self.title(agent, page)))

    async def current_state(self, agent: str = MAIN) -> Dict[str, Any]:
        # Control is read after the page: a Take answered meanwhile is not reported as the agent's by a stale look.
        view = await self.page_view(agent)
        live = self.agents.get(agent)
        return {"t": "state", "browser": "running", _agents.LIVE_AGENT_FIELD: agent,
                "controller": live.controller if live is not None else "agent",
                "handoff": live.handoff if live is not None else False, "page": view}

    async def agents_message(self) -> Dict[str, Any]:
        """The browsing agents, then agents whose control or handoff outlived their slot, at most `AGENTS_LISTED_MAX`."""
        targets = self.targets()
        known = {target.agent for target in targets}
        held = [Target(agent, None, None, None, 0) for agent, live in self.agents.items()
                if agent not in known and (live.controller == "user" or live.handoff)]
        listed = (targets + held)[:AGENTS_LISTED_MAX]
        views = await asyncio.gather(*(self.page_view(target.agent) for target in listed), return_exceptions=True)
        entries = []
        for target, view in zip(listed, views):
            live = self.agents.get(target.agent)
            name = target.name if target.agent != MAIN and isinstance(target.name, str) else None
            acted = target.acted if isinstance(target.acted, int) and not isinstance(target.acted, bool) else 0
            entries.append({_agents.LIVE_AGENT_FIELD: target.agent,
                            "name": _format.clean(name, _agents.AGENT_NAME_MAX_CHARS) if name else None,
                            "page": view if isinstance(view, dict) else None,
                            "controller": live.controller if live is not None else "agent",
                            "handoff": live.handoff if live is not None else False,
                            "acted": max(0, acted)})
        return {"t": _agents.LIVE_AGENTS_MESSAGE, _agents.LIVE_AGENTS_FIELD: entries}

    async def close(self) -> None:
        """The host stops: what the user held is let go, views end (their streamers report the browser gone) and the
        casts stop with the browser."""
        for cast in self.casts.values():
            if cast.pump is not None:
                cast.pump.cancel()
        if self.watcher is not None:
            self.watcher.cancel()
        for live in self.agents.values():
            live.cancel_timers()
            live.controller, live.handoff = "agent", False
            if not getattr(self.host, "crashed", False):
                try:
                    await asyncio.wait_for(live.release_held(), 2 * RELEASE_TIMEOUT)
                except asyncio.TimeoutError:
                    pass
            live.pressed, live.keys = 0, {}
            live.agent_turn.set()
        for connection in list(self.connections):
            connection.close()
        self.connections.clear()
        self.casts.clear()

    @staticmethod
    async def dispatch(session: Any, method: str, params: Dict[str, Any]) -> None:
        try:
            await asyncio.wait_for(session.send(method, params), RELEASE_TIMEOUT)
        except Exception:  # noqa: BLE001 - a tab that went away holds nothing down
            pass

    # Frames ------------------------------------------------------------------------------------------------------

    async def update_casts(self) -> None:
        """A screencast runs on each tab some view streams with frames on, and nowhere else."""
        wanted: List[Any] = []
        for connection in self.connections:
            page = self.page(connection.agent) if connection.frames else None
            if page is not None and page not in wanted:
                wanted.append(page)
        for page in [page for page in self.casts if page not in wanted]:
            cast = self.casts.pop(page)
            if cast.pump is not None:
                cast.pump.cancel()
            try:
                await cast.session.send("Page.stopScreencast")
            except Exception:  # noqa: BLE001 - the tab closed
                pass
        sessions: Dict[Any, Any] = {}
        for target in self.targets():
            sessions.update(target.cdp or {})
        for page in wanted:
            if page in self.casts:
                continue
            session = sessions.get(page)
            if session is None:
                continue
            live_sessions = {id(value) for value in sessions.values()}
            for key in [key for key in self.hooked if key not in live_sessions]:
                del self.hooked[key]
            if self.hooked.get(id(session)) is not session:
                self.hooked[id(session)] = session
                session.on("Page.screencastFrame", lambda params, source=session: self.on_frame(source, params))
            cast = self.casts[page] = Cast(page, session)
            try:
                await session.send("Page.startScreencast", {"format": "jpeg", "quality": _live.FRAME_QUALITY,
                                                             "maxWidth": _live.FRAME_MAX[0], "maxHeight": _live.FRAME_MAX[1],
                                                             "everyNthFrame": 1})
            except Exception:  # noqa: BLE001 - the tab closed meanwhile; the watcher moves the cast
                if self.casts.get(page) is cast:
                    del self.casts[page]

    def on_frame(self, session: Any, params: Dict[str, Any]) -> None:
        sid = params.get("sessionId")
        cast = next((cast for cast in self.casts.values() if cast.session is session), None)
        if cast is None:
            asyncio.ensure_future(self.ack(session, sid))
            return
        if cast.pending is not None:
            asyncio.ensure_future(self.ack(session, cast.pending[2]))
        cast.pending = (params.get("data"), params.get("metadata") or {}, sid)
        if cast.pump is None:
            loop = asyncio.get_running_loop()
            cast.pump = loop.call_later(max(0.0, cast.sent_at + _live.FRAME_INTERVAL - loop.time()), lambda: self.send_frame(cast))

    def send_frame(self, cast: Cast) -> None:
        cast.pump = None
        pending, cast.pending = cast.pending, None
        if pending is None:
            return
        data, metadata, sid = pending
        # Consumed now: the next frame may come and waits for the next slot.
        asyncio.ensure_future(self.ack(cast.session, sid))
        if self.casts.get(cast.page) is not cast:
            return
        if not isinstance(data, str) or not 4 <= len(data) <= _live.FRAME_BASE64_MAX:
            return
        digest = hashlib.blake2b(data.encode("ascii", "replace"), digest_size=16).digest()
        if digest == cast.digest:
            return
        size = _live.jpeg_size(data)
        width, height = metadata.get("deviceWidth"), metadata.get("deviceHeight")
        if size is None or not isinstance(width, (int, float)) or not isinstance(height, (int, float)) or width <= 0 or height <= 0:
            return
        loop = asyncio.get_running_loop()
        cast.digest, cast.sent_at = digest, loop.time()
        self.seq += 1
        self.geometry[cast.page] = (size, (float(width), float(height)))
        cast.frame = {"t": "frame", "seq": self.seq, "data": data, "width": size[0], "height": size[1]}
        for connection in list(self.connections):
            if connection.frames and self.page(connection.agent) is cast.page:
                connection.send({**cast.frame, _agents.LIVE_AGENT_FIELD: connection.agent}, frame=True)

    @staticmethod
    async def ack(session: Any, sid: Any) -> None:
        if sid is None:
            return
        try:
            await session.send("Page.screencastFrameAck", {"sessionId": sid})
        except Exception:  # noqa: BLE001 - the tab closed
            pass
