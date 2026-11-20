"""The Workspace browser host: one full Chromium per turn, shared by up to five agent identities.

The first `aiqsa.browser` call of a boot starts this process detached from the
command (`_client.py`). It owns Playwright and the browser, answers requests
on a private Unix socket, keeps site sessions current and isolates each
agent's tabs, current page, lock and steps. The agent id is a coordination key
supplied by the server, not a security boundary. It is no registered execution: every run that executed a
command ends with a disk-preserving VM stop (`lib/server/workspace/quiescence.ts`),
which ends this process and Chromium with it on success, Stop, deadline and
failure alike. So nothing waits for a save at the end: sessions are written as
they change. Nothing it prints carries a value typed from the environment
(`type N --env NAME`) or by the user in the live view: such a field reads as a
hidden value, and the value itself is masked in every answer. The live view
(`_livehub.py`) is served on the same socket; while the user holds control,
the agent's actions wait for it (`user_in_control`), and the first page action
after the user gives it back does not run (`user_returned_control`).

    python3 -m aiqsa.browser._host
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import os
import re
import signal
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

from . import _dom, _format, _human, _identity, _livehub, _paths, _sessions
from ..proxy import client as _proxy
from ..proxy import selection as _proxy_selection
from ..agents import AGENT_ID_ENV, AGENT_ID_PATTERN, AGENT_NAME_ENV, AGENT_NAME_MAX_CHARS, BROWSER_AGENT_SLOTS, BROWSER_BUSY_CODE, BROWSER_MEMORY_LOW_CODE, MAIN_AGENT_ID

PROTOCOL = 1
#: Requests the agent may make while the user holds the browser: they read no page.
CONTROL_FREE_OPS = frozenset({"status", "steps"})
USER_IN_CONTROL = ("The user took control of the browser in the chat and is using it, so this was not done. Do not act on "
                   "the page meanwhile: wait a little and try again (your next browser command says when the user gives it "
                   "back), or answer with what you have.")
USER_RETURNED = ("Nothing of this request ran: it was planned before the user's changes. What changed while the user had the "
                 "browser is theirs: look at the page, keep their changes, continue from it and say in your answer what they "
                 "changed.")
REQUEST_MAX_BYTES = 1024 * 1024
#: The turn's browser idles out after this; the next call starts a new one from the saved sessions.
IDLE_SECONDS = 1800
# A browser slot is deliberately shorter than the VM's idle stop. A crashed
# command or a forgotten sub-agent must not pin a tab for an entire turn.
AGENT_IDLE_SECONDS = 120
SLOT_WAIT_SECONDS = 5.0
MAX_AGENT_TABS = 3
# Chromium's actual RSS varies by site. Reserve a bounded per-tab allowance
# and keep a small line for the guest's Python/MCP processes.
TAB_MEMORY_RESERVE_MIB = 256
MEMORY_SAFE_MIB = 512
MAX_ELEMENTS = 500
MAX_FRAMES = 8
MAX_STEPS = 500
KEEP_SHOTS = 20
#: Marks the forwarder's own answer among a site's headers; what it means is read from the forwarder, never the header.
PROXY_CODE_HEADER = "x-aiqsa-proxy-code"
#: How soon a browser with no forwarder notices that the VM's plan now has proxies, and stops opening pages directly.
PROXY_PLAN_WATCH_SECONDS = 1.0
PROXY_RESTART_RETRY_SECONDS = 5.0
PROXY_RESTART_PENDING = "proxy_browser_restart_pending"
#: Chromium's errors that read as a site or a network refusing this address, so the failure names proxies to try.
REFUSAL_ERRORS = ("ERR_CONNECTION_REFUSED", "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_EMPTY_RESPONSE", "ERR_TIMED_OUT",
                  "ERR_CONNECTION_TIMED_OUT", "ERR_TUNNEL_CONNECTION_FAILED", "ERR_SSL_PROTOCOL_ERROR", "ERR_HTTP2_PROTOCOL_ERROR")
TEXT_MAX_CHARS = 20_000
JS_MAX_CHARS = 8_000
ACTION_TIMEOUT_MS = 10_000
NAVIGATION_TIMEOUT_MS = 45_000
#: Failed tries at one site's check per agent and turn: `captcha` calls, and inputs into a challenge (clicks, drags,
#: typing on its elements or inside its frames; a picture task takes a dozen per round). A check that passes clears
#: them. Past either bound the agent hands the check over or reports it: never a loop.
CAPTCHA_ATTEMPTS = 3
CAPTCHA_INPUTS = 50
CAPTCHA_WAIT_SECONDS = 20
CAPTCHA_EXHAUSTED = ("You have tried the check on {site} {count} times in this turn without passing it. Stop trying: in a web chat "
                     "call browser_handoff with reason captcha so the user can pass it; where nobody can take over (Telegram, "
                     "Discord, an unattended run) or in research, say that the site's check stopped you and go on with what you have.")
#: False for a request that asked for no page summary (`page: false`, a quiet or chained command): the action is
#: done and recorded, and the next summary shows its notes.
_SUMMARY: contextvars.ContextVar[bool] = contextvars.ContextVar("browser_summary", default=True)
#: The tries of this boot's turns, in the run directory, so a browser closed and opened again keeps them.
CAPTCHA_TRIES_FILE = "captcha-tries.json"
CAPTCHA_TRIES_KEPT = 200
#: A turn as the client names it (`_client.py`): never the bearer itself.
_TURN = re.compile(r"^[a-f0-9]{32}$")
_KEY = re.compile(r"^(?:(?:Control|Shift|Alt|Meta)\+){0,3}(?:[A-Za-z0-9]|F[1-9]|F1[0-2]|Enter|Escape|Tab|Backspace|Delete|Space|"
                  r"ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Insert)$")


class HostError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class AgentState:
    """All browser state that must never be shared by two agents."""

    def __init__(self, agent_id: str, name: str = "") -> None:
        self.agent_id = agent_id
        self.name = name
        self.tabs: List[Any] = []
        self.current: Any = None
        self.setups: Dict[Any, asyncio.Future] = {}
        self.cdp: Dict[Any, Any] = {}
        self.snapshots: Dict[Any, Dict[str, Any]] = {}
        self.activity: Dict[Any, List[int]] = {}
        self.steps: List[Dict[str, Any]] = []
        self.step_count = 0
        self.masked: Dict[Any, List[Tuple[str, Any]]] = {}
        self.hidden = _format.HiddenValues()
        self.env_hidden = _format.HiddenValues()
        self.notes: List[str] = []
        self.acting = False
        self.lock = asyncio.Lock()
        self.last_used = time.monotonic()
        self.slot = False
        self.expiry_task: Optional[asyncio.Task] = None
        #: The turn of this agent's latest request, when the client knows it (`_client.py`).
        self.turn: Optional[str] = None


class _Missed(Exception):
    """The point the pointer reached no longer hits the element: nothing is pressed there."""


def _boot_id() -> str:
    """This VM boot: tries of an earlier boot never count, whatever the run directory kept."""
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text("utf-8").strip()[:64]
    except OSError:
        return ""


def _first_line(error: BaseException, limit: int = 300) -> str:
    text = str(error).strip().splitlines()
    return _format.clean(text[0] if text else type(error).__name__, limit)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _int(args: Dict[str, Any], key: str, default: Optional[int] = None, low: int = 0, high: int = 1_000_000) -> int:
    value = args.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise HostError("invalid_arguments", f"`{key}` must be a whole number from {low} to {high}.")
    return value


def _text(args: Dict[str, Any], key: str, limit: int, required: bool = True) -> Optional[str]:
    value = args.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str) or (required and not value) or len(value) > limit:
        raise HostError("invalid_arguments", f"`{key}` must be text of at most {limit} characters.")
    return value


def _web_url(value: str) -> str:
    candidate = value.strip()
    if "://" not in candidate and not candidate.startswith("about:"):
        candidate = "https://" + candidate
    try:
        parts = urlsplit(candidate)
    except ValueError:
        raise HostError("invalid_url", "This is not a web address.") from None
    if candidate != "about:blank" and (parts.scheme not in ("http", "https") or not parts.hostname):
        raise HostError("invalid_url", "Only http and https addresses can be opened.")
    return candidate


def _within(path: Path, roots: Any) -> bool:
    return any(path == root or root in path.parents for root in roots)


def _readable_path(value: str) -> Path:
    """A file to upload: anything the Workspace holds."""
    path = Path(os.path.realpath(value))
    if not _within(path, [Path(os.path.realpath(_paths.workspace_dir()))]):
        raise HostError("invalid_path", "Choose a file inside the Workspace.")
    return path


def _writable_path(value: str) -> Path:
    """A screenshot the agent places itself: the project, this turn's output or tmp, never inbox or secrets."""
    path = Path(os.path.realpath(value))
    if not _within(path, [Path(os.path.realpath(root)) for root in _paths.writable_roots()]):
        raise HostError("invalid_path", "Save screenshots under /workspace/project, the output directory or /workspace/tmp.")
    return path


class Host:
    def __init__(self, environ: Dict[str, str]):
        self.environ = environ
        self.locale = _identity.browser_locale(environ)
        self.timezone = _identity.browser_timezone(environ)
        self.store = _sessions.SessionStore(_paths.sessions_dir())
        self.shots_dir = _paths.shots_dir()
        self.downloads_dir = _paths.downloads_dir()
        self.playwright = None
        self.browser = None
        self.context = None
        self.version = ""
        self.user_agent = ""
        self.metadata: Dict[str, Any] = {}
        self._states: Dict[str, AgentState] = {}
        self._pages: Dict[Any, AgentState] = {}
        self._setups: Dict[Any, asyncio.Future] = {}
        self._page_creation_lock = asyncio.Lock()
        self._pending_page_owner: Optional[AgentState] = None
        self._agent_context: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("browser_agent", default=None)
        self._start_agent_id = self._valid_agent_id(environ.get(AGENT_ID_ENV, MAIN_AGENT_ID))
        self._start_agent_name = self._valid_agent_name(environ.get(AGENT_NAME_ENV, ""))
        self._selected_agent_id = self._start_agent_id
        self._state_for(self._start_agent_id, self._start_agent_name)
        self.local_storage: Dict[str, List[Dict[str, str]]] = {}
        self.live = _livehub.LiveHub(self)
        self.crashed = False
        self.browser_lock = asyncio.Lock()
        self.slot_condition = asyncio.Condition()
        self.command_condition = asyncio.Condition()
        self._active_commands = 0
        self._closing = False
        self.stopped = asyncio.Event()
        self.shot_count = 0
        #: The chat's behaviour profile and the pointer of each page, for the agent's own input only.
        self.input = _human.Input(_paths.shots_dir())
        self._captcha_tries: Dict[Tuple[str, ...], List[int]] = {}
        #: The local forwarder's port when this browser started on a plan; None means no forwarder and no flag.
        self.proxy_port: Optional[int] = None
        self._proxy_restart_lock = asyncio.Lock()

    @staticmethod
    def _valid_agent_id(value: str) -> str:
        return value if re.fullmatch(AGENT_ID_PATTERN, value or "") else MAIN_AGENT_ID

    @staticmethod
    def _valid_agent_name(value: str) -> str:
        return value if value and len(value) <= AGENT_NAME_MAX_CHARS and re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value) else ""

    def _state_for(self, agent_id: str, name: str = "") -> AgentState:
        state = self._states.get(agent_id)
        if state is None:
            state = AgentState(agent_id, name)
            self._states[agent_id] = state
        elif name and not state.name:
            state.name = name
        return state

    def _active_state(self) -> AgentState:
        agent_id = self._agent_context.get() or self._selected_agent_id
        return self._state_for(agent_id)

    # Existing browser operations use these names. Context-local properties
    # make their state agent-scoped without duplicating every operation.
    def _state_property(name: str):
        def get(host: "Host") -> Any:
            return getattr(host._active_state(), name)
        def set_(host: "Host", value: Any) -> None:
            setattr(host._active_state(), name, value)
        return property(get, set_)

    tabs = _state_property("tabs")
    current = _state_property("current")
    setups = _state_property("setups")
    cdp = _state_property("cdp")
    snapshots = _state_property("snapshots")
    activity = _state_property("activity")
    steps = _state_property("steps")
    step_count = _state_property("step_count")
    masked = _state_property("masked")
    hidden = _state_property("hidden")
    env_hidden = _state_property("env_hidden")
    notes = _state_property("notes")
    acting = _state_property("acting")
    lock = _state_property("lock")
    last_used = _state_property("last_used")

    def _request_agent(self, request: Dict[str, Any]) -> AgentState:
        raw = request.get("agent")
        if not isinstance(raw, dict):
            raw = request.get("args", {}).get("agent") if isinstance(request.get("args"), dict) else None
        if not isinstance(raw, dict):
            raw = {"id": self._start_agent_id, "name": self._start_agent_name}
        agent_id = self._valid_agent_id(raw.get("id") if isinstance(raw.get("id"), str) else MAIN_AGENT_ID)
        name = self._valid_agent_name(raw.get("name") if isinstance(raw.get("name"), str) else "")
        if agent_id == MAIN_AGENT_ID:
            name = ""
        state = self._state_for(agent_id, name)
        turn = raw.get("turn")
        state.turn = turn if isinstance(turn, str) and _TURN.fullmatch(turn) else None
        return state

    def _memory_available_mib(self) -> Optional[int]:
        """Return the VM's bounded available memory, when procfs exposes it."""
        try:
            for line in Path("/proc/meminfo").read_text("utf-8").splitlines():
                if line.startswith("MemAvailable:"):
                    value = line.split()[1]
                    return int(value) // 1024
        except (OSError, ValueError, IndexError):
            return None
        return None

    def _check_memory(self) -> None:
        available = self._memory_available_mib()
        if available is not None and available < MEMORY_SAFE_MIB + TAB_MEMORY_RESERVE_MIB:
            raise HostError(BROWSER_MEMORY_LOW_CODE,
                            f"The Workspace has about {available} MiB available; opening another tab would cross the safe memory line. "
                            "Close a tab or try again later.")

    async def _acquire_slot(self, state: AgentState) -> None:
        if state.slot:
            state.last_used = time.monotonic()
            return
        deadline = time.monotonic() + SLOT_WAIT_SECONDS
        async with self.slot_condition:
            while True:
                self._expire_agents_locked()
                holders = sum(1 for candidate in self._states.values() if candidate.slot)
                if holders < BROWSER_AGENT_SLOTS:
                    state.slot = True
                    state.last_used = time.monotonic()
                    return
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise HostError(BROWSER_BUSY_CODE,
                                    f"The browser is busy with {holders} agents (maximum {BROWSER_AGENT_SLOTS}); try again later.")
                try:
                    await asyncio.wait_for(self.slot_condition.wait(), remaining)
                except asyncio.TimeoutError:
                    raise HostError(BROWSER_BUSY_CODE,
                                    f"The browser is busy with {holders} agents (maximum {BROWSER_AGENT_SLOTS}); try again later.") from None

    def _expire_agents_locked(self) -> None:
        now = time.monotonic()
        for state in list(self._states.values()):
            if state.slot and state.agent_id != MAIN_AGENT_ID and now - state.last_used > AGENT_IDLE_SECONDS and state.expiry_task is None:
                state.expiry_task = asyncio.create_task(self._expire_agent(state, state.last_used))

    def _agent_held_by_user(self, agent_id: str) -> bool:
        held = getattr(self.live, "agent_held_by_user", None)
        if not callable(held):
            return False
        try:
            return held(agent_id) is True
        except Exception:  # noqa: BLE001 - a missing/old live hub cannot block cleanup
            return False

    async def _expire_agent(self, state: AgentState, observed_last_used: float) -> None:
        try:
            async with state.lock:
                if (not state.slot or state.last_used != observed_last_used or
                        time.monotonic() - state.last_used <= AGENT_IDLE_SECONDS or
                        self._agent_held_by_user(state.agent_id)):
                    return
                async with self.browser_lock:
                    # The lease may have been released and reacquired while the
                    # expiry task waited. Never close that new lease's tabs.
                    if (not state.slot or state.last_used != observed_last_used or
                            self._agent_held_by_user(state.agent_id)):
                        return
                    await self._close_agent_tabs(state)
                    state.slot = False
                    state.notes.append("The browser slot expired after two minutes without an action; its tabs were closed.")
                    async with self.slot_condition:
                        self.slot_condition.notify_all()
        finally:
            state.expiry_task = None

    async def _close_agent_tabs(self, state: AgentState) -> None:
        for page in list(state.tabs):
            try:
                await asyncio.wait_for(page.close(), 5)
            except Exception:  # noqa: BLE001 - expiry is best effort
                pass
        state.current = None

    async def release_agent(self, agent_id: str, *, close_tabs: bool = True) -> None:
        state = self._states.get(agent_id)
        if state is None:
            return
        async with state.lock:
            async with self.browser_lock:
                # Control can arrive while this release waits for either lock.
                if self._agent_held_by_user(agent_id):
                    raise _livehub.UserInControl()
                if not state.slot:
                    return
                if close_tabs and agent_id != MAIN_AGENT_ID:
                    await self._close_agent_tabs(state)
                state.slot = False
                async with self.slot_condition:
                    self.slot_condition.notify_all()

    async def _enter_command(self) -> None:
        async with self.command_condition:
            while self._closing:
                await self.command_condition.wait()
            self._active_commands += 1

    async def _leave_command(self) -> None:
        async with self.command_condition:
            self._active_commands = max(0, self._active_commands - 1)
            self.command_condition.notify_all()

    async def _begin_browser_close(self) -> None:
        async with self.command_condition:
            # No await between checking every agent and closing admission. The
            # live hub checks this gate before starting Take control or a handoff.
            if any(self._agent_held_by_user(agent) for agent in self._states):
                raise _livehub.UserInControl()
            self._closing = True
            # The caller is itself counted as an active command.
            while self._active_commands > 1:
                await self.command_condition.wait()

    async def _end_browser_close(self) -> None:
        async with self.command_condition:
            self._closing = False
            self.command_condition.notify_all()

    def live_targets(self) -> List[_livehub.Target]:
        """Each browsing agent's current tab, action lock and state for the live view."""
        result = []
        for state in self._states.values():
            page = state.current if state.current is not None and not state.current.is_closed() else None
            if page is None and not state.slot:
                continue
            result.append(_livehub.Target(state.agent_id, state.name or None, page, state.lock, int(state.last_used * 1000),
                                          cdp=state.cdp, hidden=state.hidden, env_hidden=state.env_hidden,
                                          masked=state.masked, steps=state.steps,
                                          touch=lambda used=state: setattr(used, "last_used", time.monotonic())))
        return result

    def select_live_agent(self, agent_id: str) -> None:
        self._selected_agent_id = self._valid_agent_id(agent_id)
        self._state_for(self._selected_agent_id)

    # Lifecycle -------------------------------------------------------------------------------------------------

    async def start(self) -> None:
        if _proxy.has_plan():
            # Failing to start it fails the browser: a browser without it would open hinted sites directly.
            self.proxy_port = await asyncio.to_thread(_proxy.ensure)
        self.playwright = await async_playwright().start()
        chromium = self.playwright.chromium
        env = _identity.launch_env(self.environ, self.locale, self.timezone)
        # The build's own user agent and client hints, read once without any override.
        probe = await chromium.launch(channel="chromium", headless=True, ignore_default_args=_identity.IGNORED_DEFAULT_ARGS,
                                      args=_identity.launch_args(self.locale), env=env)
        try:
            cdp = await probe.new_browser_cdp_session()
            headless_ua = (await cdp.send("Browser.getVersion"))["userAgent"]
            context = await probe.new_context()
            page = await context.new_page()
            await page.route("https://aiqsa.invalid/**", lambda route: route.fulfill(
                status=200, content_type="text/html", body="<!doctype html><title>aiqsa</title>"))
            await page.goto("https://aiqsa.invalid/")
            reported = await page.evaluate(_dom.READ_CLIENT_HINTS, _identity.HIGH_ENTROPY_HINTS)
            self.version = probe.version
        finally:
            await probe.close()
        self.user_agent = _identity.native_user_agent(headless_ua)
        self.metadata = _identity.user_agent_metadata(reported)
        state = self.store.load()
        self.local_storage = {origin["origin"]: origin["localStorage"] for origin in state["origins"]}
        await self._launch(state)
        self._reset_steps()
        page = await self._new_page(self._state_for(self._start_agent_id, self._start_agent_name))
        await self._setup(page)
        self.current = page
        restored = ", ".join(name[: -len(".json")] for name in sorted(self.store.tracked)) or "none"
        self.notes.append(f"Started a new browser (Chromium {self.version}, language {self.locale}, time zone {self.timezone}); "
                          f"saved sign-ins restored: {restored}.")
        if self.store.skipped:
            self.notes.append(f"Saved session files not loaded (invalid or over the limits): {', '.join(sorted(self.store.skipped))}.")

    async def _launch(self, state: Dict[str, Any]) -> None:
        """The browser of this host and its one context, from the build's identity read in `start`."""
        self.browser = await self.playwright.chromium.launch(
            channel="chromium", headless=True, ignore_default_args=_identity.IGNORED_DEFAULT_ARGS,
            args=_identity.launch_args(self.locale, self.user_agent, self.proxy_port),
            env=_identity.launch_env(self.environ, self.locale, self.timezone))
        self.browser.on("disconnected", self._on_disconnected)
        self.context = await self.browser.new_context(no_viewport=True, accept_downloads=True, storage_state=state)
        self.context.on("page", self._on_page)

    def _on_disconnected(self, *_: Any) -> None:
        self.crashed = True
        self.stopped.set()

    async def stop(self) -> None:
        if self.stopped.is_set() and self.browser is None:
            return
        await self.live.close()
        try:
            if self.context is not None and not self.crashed:
                await asyncio.wait_for(self._autosave(), 20)
        except Exception:  # noqa: BLE001 - the VM stop may already be under way
            pass
        try:
            if self.browser is not None and not self.crashed:
                await asyncio.wait_for(self.browser.close(), 20)
        except Exception:  # noqa: BLE001
            pass
        try:
            if self.playwright is not None:
                await asyncio.wait_for(self.playwright.stop(), 10)
        except Exception:  # noqa: BLE001
            pass
        self.browser = None
        self.stopped.set()

    def _error_text(self, error: BaseException, limit: int = 300) -> str:
        """An error's first line, masked raw before it is cut (it may quote the page)."""
        text = str(error).strip().splitlines()
        return _format.page_string(text[0] if text else type(error).__name__, self.hidden, limit)

    def _said(self, value: Optional[str], limit: int = 100) -> str:
        """Quoted text the agent or the page supplied, masked before quotes and cuts change it."""
        return _format.quoted(self.hidden.text(value or ""), limit)

    # Pages -----------------------------------------------------------------------------------------------------

    def _on_page(self, page: Any) -> None:
        # Playwright invokes this callback from its transport task, outside the
        # request's contextvar. Only the explicit page-creation owner or the
        # opener's popup callback may assign a page; an unknown page is ignored
        # until its owner is known.
        state = self._pages.get(page) or self._pending_page_owner
        if state is None:
            return
        self._pages[page] = state
        future = self._setup_future(page)
        if state.acting:
            # A page the agent's own action opened becomes the current tab.
            def adopt(_: Any) -> None:
                if not page.is_closed():
                    state.current = page
                    state.notes.append("The action opened a new tab; it is now the current tab.")
            future.add_done_callback(adopt)

    def _on_popup(self, opener: Any, page: Any) -> None:
        state = self._pages.get(opener)
        if state is None:
            return
        self._pages[page] = state
        future = self._setup_future(page)
        if state.acting:
            def adopt(_: Any) -> None:
                if not page.is_closed():
                    state.current = page
                    state.notes.append("The action opened a popup; it is now the current tab.")
            future.add_done_callback(adopt)

    async def _new_page(self, state: AgentState) -> Any:
        """Create a page with its owner registered before Playwright emits `page`."""
        async with self._page_creation_lock:
            previous = self._pending_page_owner
            self._pending_page_owner = state
            try:
                page = await self.context.new_page()
                self._pages.setdefault(page, state)
                return page
            finally:
                self._pending_page_owner = previous

    def _setup_future(self, page: Any) -> asyncio.Future:
        if page not in self._setups:
            future = asyncio.ensure_future(self._prepare(page))
            # A page that closes while it is set up fails here; whoever awaits it sees that, nobody else must.
            future.add_done_callback(lambda done: done.cancelled() or done.exception())
            self._setups[page] = future
        return self._setups[page]

    async def _setup(self, page: Any) -> None:
        await self._setup_future(page)

    async def _prepare(self, page: Any) -> None:
        state = self._pages.get(page)
        if state is None:
            raise HostError("browser_page_unowned", "The browser page has no agent owner.")
        # The CDP session must stay attached: its user agent override ends with it.
        session = await self.context.new_cdp_session(page)
        await session.send("Emulation.setUserAgentOverride", {"userAgent": self.user_agent, "userAgentMetadata": self.metadata})
        state.cdp[page] = session
        counters = [0, 0]  # requests seen, requests in flight
        state.activity[page] = counters

        def started(_: Any) -> None:
            counters[0] += 1
            counters[1] += 1

        def ended(_: Any) -> None:
            counters[0] += 1
            counters[1] = max(0, counters[1] - 1)

        page.on("request", started)
        page.on("requestfinished", ended)
        page.on("requestfailed", ended)
        page.on("dialog", self._on_dialog)
        page.on("download", self._on_download)
        page.on("close", self._on_close)
        page.on("popup", lambda popup, opener=page: self._on_popup(opener, popup))
        if page not in state.tabs:
            state.tabs.append(page)

    def _on_close(self, page: Any) -> None:
        state = self._pages.pop(page, None)
        if state is None:
            return
        state.tabs = [tab for tab in state.tabs if tab is not page]
        state.snapshots.pop(page, None)
        state.masked = {frame: fields for frame, fields in state.masked.items() if frame.page is not page}
        state.cdp.pop(page, None)
        state.activity.pop(page, None)
        self._setups.pop(page, None)
        if state.current is page:
            state.current = state.tabs[-1] if state.tabs else None

    async def _on_dialog(self, dialog: Any) -> None:
        page = getattr(dialog, "page", None)
        state = self._pages.get(page)
        if state is None:
            return
        kind = dialog.type
        accept = kind in ("alert", "beforeunload")
        try:
            await (dialog.accept() if accept else dialog.dismiss())
        except PlaywrightError:
            return
        state.notes.append(f"A {kind} dialog was {'accepted' if accept else 'dismissed'}: "
                          f"{_format.quoted(state.hidden.text(dialog.message or ''), 200)}.")

    async def _on_download(self, download: Any) -> None:
        page = getattr(download, "page", None)
        state = self._pages.get(page)
        if state is None:
            return
        name = _sessions.safe_basename(state.hidden.text(download.suggested_filename or "download"))[:120] or "download"
        try:
            self.downloads_dir.mkdir(parents=True, exist_ok=True)
            target = self.downloads_dir / name
            stem, suffix = os.path.splitext(name)
            index = 1
            while target.exists():
                index += 1
                target = self.downloads_dir / f"{stem}-{index}{suffix}"
            await download.save_as(str(target))
        except (OSError, PlaywrightError) as error:
            state.notes.append(f"A download could not be saved ({_format.page_string(_first_line(error), state.hidden, 120)}).")
            return
        state.notes.append(f"Downloaded {target}.")
        step = self._record("download", target.name, getattr(page, "url", None), state=state)
        await self._finish_step(step, None)

    async def _page(self) -> Any:
        if self.current is None or self.current.is_closed():
            open_tabs = [tab for tab in self.tabs if not tab.is_closed()]
            if open_tabs:
                self.current = open_tabs[-1]
            else:
                self._check_memory()
                page = await self._new_page(self._active_state())
                await self._setup(page)
                self.current = page
        await self._setup(self.current)
        return self.current

    # Proxies ---------------------------------------------------------------------------------------------------

    async def _proxy_call(self, op: str, **args: Any) -> Dict[str, Any]:
        try:
            return await asyncio.to_thread(_proxy.call, op, args)
        except _proxy.ProxyError as error:
            raise HostError(error.code, error.message) from None

    def _no_forwarder(self, choice: Any) -> None:
        """This browser has no forwarder. Proxies that arrived since its last check wait for the restart, like any other request."""
        if _proxy.has_plan():
            raise HostError(PROXY_RESTART_PENDING, "This chat's proxies have just arrived and the browser is restarting through them. Try again in a moment.")
        if choice is not None and choice != _proxy.AUTO and choice["kind"] == "proxy":
            raise HostError("proxy_not_found", "This chat has no proxies, so `--proxy` has nothing to name.")

    def _raise_if_user_holds_browser(self) -> None:
        if any(self._agent_held_by_user(agent) for agent in self._states):
            raise HostError(PROXY_RESTART_PENDING, "This chat's proxies have arrived and the browser restarts through them once the user "
                            "finishes in the live view, where they hold a tab. Nothing else opens until then; try again in a moment.")

    async def _close_tabs_not_held_by_user(self) -> None:
        """Pages already open would keep going directly, by scripts, redirects and workers: they stop now. A tab the user holds
        (Take control or a handoff) stays with them, because closing it would lose what they typed, and its traffic stays direct until they give it back."""
        for state in list(self._states.values()):
            if self._agent_held_by_user(state.agent_id):
                continue
            tabs = [tab for tab in state.tabs if not tab.is_closed()]
            if not tabs:
                continue
            addresses = ", ".join(state.hidden.text(_format.where(tab.url) or "blank page") for tab in tabs)
            for tab in tabs:
                try:
                    await asyncio.wait_for(tab.close(), 5)
                except Exception:  # noqa: BLE001 - the restart closes it if this cannot
                    pass
            state.notes.append(f"This chat's proxies have arrived, so the browser restarted through them and closed your open tabs: {addresses}. "
                               "Sign-ins stay; open what you need again.")

    async def _ensure_proxied(self) -> None:
        """A plan with proxies has become active over a browser with no forwarder: restart Chromium through it, keeping sign-ins."""
        if self.proxy_port is not None or not _proxy.has_plan():
            return
        await self._close_tabs_not_held_by_user()
        async with self._proxy_restart_lock:
            if self.proxy_port is not None:
                return
            self._raise_if_user_holds_browser()
            async with self.command_condition:
                # No await between this check and closing admission: the live hub checks the gate before giving control.
                self._raise_if_user_holds_browser()
                self._closing = True
                while self._active_commands > 0:
                    await self.command_condition.wait()
            try:
                async with self.browser_lock:
                    await self._restart_through_forwarder()
            finally:
                await self._end_browser_close()

    async def _restart_through_forwarder(self) -> None:
        try:
            port = await asyncio.to_thread(_proxy.ensure)
        except _proxy.ProxyError as error:
            raise HostError(error.code, error.message) from None
        await self._autosave()
        try:
            # Every cookie and known origin, not only saved sites': sign-ins made in this browser outlive this restart too.
            state = await asyncio.wait_for(self.context.storage_state(), 20)
        except (PlaywrightError, asyncio.TimeoutError):
            state = await self._storage_state()
        old = self.browser
        old.remove_listener("disconnected", self._on_disconnected)
        self.proxy_port = port
        try:
            await asyncio.wait_for(old.close(), 20)
        except (PlaywrightError, asyncio.TimeoutError):
            pass
        self.local_storage.update({origin["origin"]: origin["localStorage"] for origin in state.get("origins", [])})
        self._pages.clear()
        self._setups.clear()
        for agent in self._states.values():
            agent.tabs, agent.current = [], None
            agent.cdp, agent.snapshots, agent.activity, agent.masked = {}, {}, {}, {}
        try:
            await self._launch(state)
        except Exception:  # noqa: BLE001 - with no browser the host ends; the next command starts one through the forwarder from the saved sessions
            self.crashed = True
            self.stopped.set()
            raise HostError("browser_crashed", "The browser could not restart through this chat's proxies; the next command starts a new one.") from None

    async def watch_proxy_plan(self) -> None:
        """Requests are not the only traffic: open pages keep loading, so the plan is noticed without waiting for a command."""
        while self.proxy_port is None and not self.stopped.is_set():
            await asyncio.sleep(PROXY_PLAN_WATCH_SECONDS)
            try:
                await self._ensure_proxied()
            except HostError as error:
                if error.code != PROXY_RESTART_PENDING:
                    await asyncio.sleep(PROXY_RESTART_RETRY_SECONDS)
            except Exception:  # noqa: BLE001 - the next tick or command tries again, and only a command can report it
                await asyncio.sleep(PROXY_RESTART_RETRY_SECONDS)

    async def _route_navigation(self, page: Any, url: str, value: Optional[str]) -> None:
        """Before a navigation: the agent's choice reaches the forwarder, and the page presents itself for the proxy it will use."""
        host = urlsplit(url).hostname
        if not host:
            return
        choice = _proxy.parse_choice(value)
        if self.proxy_port is None:
            self._no_forwarder(choice)
            return
        if choice is not None:
            routed = await self._proxy_call("route", host=host, choice=None if choice == _proxy.AUTO else choice)
            decision = routed.get("decision") or {}
            if decision.get("kind") == "failed" and choice != _proxy.AUTO:
                raise HostError(decision["code"], f"No proxy of this chat is called {self._said(value, 64)}, or it is switched off; `aiqsa-browser proxies` lists them.")
            if routed.get("moved"):
                self._tell_other_agents(str(routed.get("site")), decision)
        peek = await self._proxy_call("peek", host=host)
        await self._present_for_proxy(page, (peek.get("decision") or {}).get("country"))

    async def _present_for_proxy(self, page: Any, country: Optional[str]) -> None:
        """The seam for language and time zone following a proxy's country (`_identity.presentation_for_proxy`)."""
        locale, zone = _identity.presentation_for_proxy(country, self.locale, self.timezone)
        session = self.cdp.get(page)
        if (locale, zone) == (self.locale, self.timezone) or session is None:
            return
        await session.send("Emulation.setUserAgentOverride", {"userAgent": self.user_agent, "userAgentMetadata": self.metadata, "acceptLanguage": locale})
        await session.send("Emulation.setLocaleOverride", {"locale": locale})
        await session.send("Emulation.setTimezoneOverride", {"timezoneId": zone})

    def _tell_other_agents(self, site: str, decision: Mapping[str, Any]) -> None:
        """A site has one exit, because Chromium pools its connections by host: another agent's tabs on it move too."""
        me = self._active_state()
        for state in self._states.values():
            if state is me:
                continue
            if any(not tab.is_closed() and self._site_of(tab.url) == site for tab in state.tabs):
                state.notes.append(f"Another agent chose {self._via(decision)} for {site}; your tabs on it use that now too.")

    @staticmethod
    def _site_of(url: Optional[str]) -> Optional[str]:
        try:
            host = urlsplit(url or "").hostname
        except ValueError:
            return None
        return _proxy_selection.site_of(host) if host else None

    @staticmethod
    def _via(outcome: Mapping[str, Any]) -> str:
        if outcome.get("kind") == "proxy":
            moved = outcome.get("movedFrom") or []
            after = f" after {_proxy.labels(moved)} failed" if moved else ""
            return f"proxy {_proxy.labels([outcome])}{after}"
        return "direct"

    def _try_text(self, to_try: Sequence[Mapping[str, Any]], excluded: Sequence[Optional[str]]) -> str:
        others = [entry for entry in to_try if entry.get("id") not in excluded]
        if not others:
            return "This chat has no other proxy to try."
        return f"Proxies to try: {_proxy.labels(others)}, with `aiqsa-browser open ADDRESS --proxy NAME`."

    async def _outcome_failure(self, host: str) -> Optional[HostError]:
        """What the forwarder knows went wrong for this host: nothing else may be reported as its failure."""
        info = await self._proxy_call("outcome", host=host)
        outcome = info.get("outcome") or {}
        to_try = info.get("toTry") or []
        if outcome.get("kind") == "failed":
            attempts = outcome.get("attempts") or []
            tried = ", ".join(f"{entry['name']} ({entry['code']})" for entry in attempts)
            return HostError(outcome["code"], f"{host} did not open" + (f" through {tried}" if tried else "") + ". Nothing was sent directly. " +
                             self._try_text(to_try, [entry["id"] for entry in attempts]) + " `--proxy direct` opens it without a proxy.")
        if outcome.get("kind") == "refused":
            return HostError(outcome["code"], f"{host} is a private or local address, which is not opened from here.")
        if outcome.get("kind") == "direct" and outcome.get("code"):
            return HostError("navigation_failed", f"The direct connection to {host} failed ({outcome['code']}). " + self._try_text(to_try, []))
        return None

    async def _proxy_navigation_failure(self, page: Any, url: str, error: BaseException) -> Optional[HostError]:
        """A navigation Chromium could not finish, in a browser on the forwarder; None leaves the error as it is."""
        if self.proxy_port is None:
            return None
        text = self._error_text(error)
        # Its error page commits a moment later and would interrupt the next address tried, which is what this failure suggests.
        try:
            await page.wait_for_url("chrome-error://**", timeout=1000)
        except PlaywrightError:
            pass
        if "ERR_PROXY_CONNECTION_FAILED" in text:
            return HostError(_proxy.UNAVAILABLE, "The local proxy forwarder did not answer, so nothing was sent. Try again; the next command restarts it.")
        host = urlsplit(url).hostname or ""
        failure = await self._outcome_failure(host)
        if failure is not None:
            return failure
        if any(marker in text for marker in REFUSAL_ERRORS):
            info = await self._proxy_call("outcome", host=host)
            outcome = info.get("outcome") or {}
            return HostError("navigation_failed", f"{text} ({self._via(outcome)}). {self._try_text(info.get('toTry') or [], [outcome.get('id')])}")
        return None

    async def _goto(self, page: Any, url: str) -> Optional[int]:
        """Navigates and returns the status. What went wrong on the way to the site is reported as that."""
        try:
            response = await page.goto(url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
        except PlaywrightTimeoutError:
            raise
        except PlaywrightError as error:
            failure = await self._proxy_navigation_failure(page, url, error)
            if failure is not None:
                raise failure from None
            raise
        if response is None:
            return None
        # A plain-http request's failure is the forwarder's own response; a site sending this header only makes this look.
        if self.proxy_port is not None and response.headers.get(PROXY_CODE_HEADER):
            failure = await self._outcome_failure(urlsplit(url).hostname or "")
            if failure is not None:
                raise failure
        return response.status

    async def _blocked_note(self, url: str, status: Optional[int]) -> str:
        """A site's answer that reads as a block names the proxies to try; the site answered, so moving on is the agent's call."""
        if self.proxy_port is None or status not in _proxy_selection.BLOCKED_HTTP_STATUSES:
            return ""
        info = await self._proxy_call("outcome", host=urlsplit(url).hostname or "")
        outcome = info.get("outcome") or {}
        return (f"This site refused the request ({status}, {self._via(outcome)}), which may be a block on the address it sees. "
                f"{self._try_text(info.get('toTry') or [], [outcome.get('id')])}\n")

    async def _note_proxy(self, step: Dict[str, Any], page: Any, action: str, before: Optional[str]) -> None:
        """The step line shows what opened a site: on opening one, and on arriving at another."""
        site = self._site_of(getattr(page, "url", None))
        if site is None or (action not in ("open", "new_tab") and site == before):
            return
        try:
            host = urlsplit(page.url).hostname or ""
            outcome = (await self._proxy_call("outcome", host=host)).get("outcome")
        except HostError:
            return
        if outcome is None or outcome.get("kind") not in ("proxy", "direct"):
            return
        via = self.hidden.text(self._via(outcome))
        shown = f"through {via}" if outcome["kind"] == "proxy" else via
        step["target"] = f"{step['target']} {shown}" if step.get("target") else shown

    # Waiting ---------------------------------------------------------------------------------------------------

    async def _settle(self, page: Any, quiet_seconds: float = 0.4, budget: float = 2.0) -> None:
        """Wait for what an action started: a document load, then a short network quiet."""
        await asyncio.sleep(0.25)
        if page.is_closed():
            return
        for state, timeout in (("domcontentloaded", 15_000), ("load", 5_000)):
            try:
                await page.wait_for_load_state(state, timeout=timeout)
            except PlaywrightError:
                pass
        counters = self.activity.get(page)
        if counters is None:
            return
        loop = asyncio.get_running_loop()
        end = loop.time() + budget
        seen, since = counters[0], loop.time()
        while loop.time() < end and not page.is_closed():
            await asyncio.sleep(0.1)
            if counters[0] != seen:
                seen, since = counters[0], loop.time()
            elif counters[1] == 0 and loop.time() - since >= quiet_seconds:
                break

    # Element lists ---------------------------------------------------------------------------------------------

    async def _frames(self, page: Any) -> List[Tuple[Any, Optional[Dict[str, float]]]]:
        frames: List[Tuple[Any, Optional[Dict[str, float]]]] = [(page.main_frame, None)]
        for frame in page.frames[1:]:
            if len(frames) > MAX_FRAMES:
                break
            if frame.is_detached():
                continue
            try:
                element = await frame.frame_element()
                box = await element.bounding_box()
                visible = await element.is_visible()
            except PlaywrightError:
                continue
            if box and visible and box["width"] >= 20 and box["height"] >= 20:
                frames.append((frame, box))
        return frames

    def _captcha_frame(self, frame: Any) -> Optional[str]:
        url = (frame.url or "").lower()
        if any(part in url for part in _dom.CAPTCHA_FRAMES_IGNORED):
            return None
        address = url.split("://", 1)[-1]
        for kind, prefixes in _dom.CAPTCHA_FRAMES:
            if any(address.startswith(prefix) or ("." + prefix) in address[: len(prefix) + 64] for prefix in prefixes):
                return kind
        return None

    async def _snapshot(self, page: Any) -> Dict[str, Any]:
        previous = self.snapshots.get(page) or {}
        frames_before: Dict[Any, Dict[str, Any]] = previous.get("frames", {})
        main_url = page.main_frame.url
        if previous.get("url") != main_url:
            frames_before = {}
        next_number = previous.get("next", 1) if frames_before else 1
        items: List[Dict[str, Any]] = []
        refs: Dict[int, Tuple[Any, Any, int]] = {}
        frames_after: Dict[Any, Dict[str, Any]] = {}
        meta: Dict[str, Any] = {"title": "", "scroll": {}, "loading": False, "truncated": False}
        captcha: List[str] = []
        viewport = None
        for index, (frame, box) in enumerate(await self._frames(page)):
            kind = self._captcha_frame(frame) if index else None
            if kind and kind not in captcha:
                captcha.append(kind)
            budget = MAX_ELEMENTS - len(items)
            if budget <= 0:
                meta["truncated"] = True
                break
            before = frames_before.get(frame)
            options: Dict[str, Any] = {"max": budget, "next": next_number}
            if before and before.get("doc") == frame.url:
                options["previous"] = {"elements": before["elements"], "numbers": before["numbers"]}
            masked = [handle for document, handle in self.masked.get(frame, []) if document == frame.url]
            if masked:
                options["masked"] = masked
            # A handle of a document that is gone fails the list: number afresh, then forget fields that left with it.
            attempts = [options]
            if "previous" in options:
                attempts.append({key: value for key, value in options.items() if key != "previous"})
            if masked:
                attempts.append({key: value for key, value in options.items() if key not in ("previous", "masked")})
            result = None
            for attempt in attempts:
                try:
                    result = await frame.evaluate_handle(_dom.COLLECT, attempt)
                    break
                except PlaywrightError:
                    continue
            if result is None:
                continue
            if masked and "masked" not in attempt:
                self.masked.pop(frame, None)
            try:
                data = await result.evaluate("r => ({ items: r.items, next: r.next, truncated: r.truncated, title: r.title, "
                                             "titleCut: r.titleCut, scroll: r.scroll, loading: r.loading })")
                elements = await result.get_property("elements")
                numbers = await result.get_property("numbers")
            except PlaywrightError:
                continue
            next_number = max(next_number, int(data["next"]))
            frames_after[frame] = {"elements": elements, "numbers": numbers, "doc": frame.url}
            _format.page_items(data["items"], self.hidden)
            if index == 0:
                meta.update({key: data[key] for key in ("scroll", "loading")})
                meta["title"] = _format.page_string(data["title"], self.hidden, 200, bool(data.get("titleCut")))
                viewport = (data.get("scroll") or {}).get("viewport")
            meta["truncated"] = meta["truncated"] or bool(data["truncated"])
            for local, item in enumerate(data["items"]):
                if index:
                    item["frame"] = True
                    if kind:
                        item["captcha"] = True
                    if box and viewport:
                        if box["y"] + box["height"] <= 0:
                            item["position"], item["inView"] = "above", False
                        elif box["y"] >= viewport[1]:
                            item["position"], item["inView"] = "below", False
                refs[int(item["n"])] = (frame, elements, local)
                items.append(item)
        for kind in await self._captcha_forms(page):
            if kind not in captcha:
                captcha.append(kind)
        captcha, passed = await self._captcha_open(page, captcha)
        await self._mark_captcha_items(page, frames_after, items)
        # The previous list's handles were only needed to keep numbers; release them all.
        for before in (previous.get("frames") or {}).values():
            for name in ("elements", "numbers"):
                try:
                    await before[name].dispose()
                except PlaywrightError:
                    pass
        self.snapshots[page] = {"url": main_url, "frames": frames_after, "next": next_number, "refs": refs,
                                "items": {int(item["n"]): item for item in items}, "captcha": captcha}
        notes, self.notes = self.notes, []
        tabs = [tab for tab in self.tabs if not tab.is_closed()]
        return {"url": self.hidden.text(_format.without_userinfo(page.url)), "title": meta["title"], "scroll": meta["scroll"], "loading": meta["loading"],
                "truncated": meta["truncated"], "items": items, "captcha": captcha, "captchaPassed": passed, "notes": notes,
                "tabs": len(tabs), "tab": (tabs.index(page) + 1) if page in tabs else 1}

    async def _captcha_forms(self, page: Any) -> List[str]:
        """CAPTCHA or bot-check widgets and forms in the page's own document."""
        try:
            return [str(kind) for kind in await page.main_frame.evaluate(_dom.CAPTCHA, [_dom.CAPTCHA_SELECTORS, _dom.CAPTCHA_GLOBALS])]
        except PlaywrightError:
            return []

    async def _mark_captcha_items(self, page: Any, frames: Dict[Any, Dict[str, Any]], items: List[Dict[str, Any]]) -> None:
        """Mark the top document's elements that belong to a CAPTCHA widget or form, as frame items of a check are
        marked, so the summary shows them as part of it and their inputs count towards its bound."""
        listed = frames.get(page.main_frame)
        if listed is None:
            return
        try:
            inside = await listed["elements"].evaluate(_dom.IN_CAPTCHA_LIST, _dom.CAPTCHA_CONTAINERS)
        except PlaywrightError:
            return
        # The top document is listed first, in the order of its elements.
        for item, marked in zip((item for item in items if not item.get("frame")), inside if isinstance(inside, list) else []):
            if marked is True:
                item["captcha"] = True

    async def _captcha_open(self, page: Any, kinds: List[str]) -> Tuple[List[str], List[str]]:
        """The kinds still to pass, and those whose widget already holds its answer (it still shows until the form is sent)."""
        try:
            answered = [str(kind) for kind in await page.main_frame.evaluate(_dom.CAPTCHA_PASSED, _dom.CAPTCHA_TOKENS)]
        except PlaywrightError:
            answered = []
        return [kind for kind in kinds if kind not in answered], [kind for kind in kinds if kind in answered]

    async def _captcha_in_page(self, page: Any) -> List[str]:
        """What the page shows now, the same detection as the element list: frames of known services and forms."""
        kinds: List[str] = []
        for index, (frame, _box) in enumerate(await self._frames(page)):
            kind = self._captcha_frame(frame) if index else None
            if kind and kind not in kinds:
                kinds.append(kind)
        for kind in await self._captcha_forms(page):
            if kind not in kinds:
                kinds.append(kind)
        return kinds

    async def _element(self, number: int) -> Tuple[Any, Dict[str, Any]]:
        _frame, element, item = await self._element_ref(number)
        return element, item

    async def _element_ref(self, number: int) -> Tuple[Any, Any, Dict[str, Any]]:
        page = await self._page()
        snapshot = self.snapshots.get(page)
        if not snapshot or snapshot.get("url") != page.main_frame.url:
            raise HostError("stale_element", "The page changed since its last element list; run `info` and use the new numbers.")
        reference = snapshot["refs"].get(number)
        if reference is None:
            raise HostError("element_not_found", f"There is no element [{number}] in the latest list of this tab; run `info` or `find`.")
        frame, elements, local = reference
        try:
            handle = await elements.evaluate_handle("(list, index) => list[index]", local)
            element = handle.as_element()
            connected = element is not None and await element.evaluate("el => el.isConnected")
        except PlaywrightError:
            connected = False
        if not connected:
            raise HostError("stale_element", f"Element [{number}] is no longer on the page; run `info` and use the new numbers.")
        item = snapshot["items"][number]
        if item.get("captcha") is not True:
            try:
                if await element.evaluate(_dom.IN_CAPTCHA, _dom.CAPTCHA_CONTAINERS):
                    item["captcha"] = True  # an input into the check counts towards its bound (`_captcha_try`)
            except PlaywrightError:
                pass
        return frame, element, item

    # Steps and sessions ----------------------------------------------------------------------------------------

    def _reset_steps(self) -> None:
        self.steps, self.step_count = [], 0

    def _record(self, action: str, target: Optional[str], url: Optional[str], *, state: Optional[AgentState] = None) -> Dict[str, Any]:
        """One step of the turn's list (kept in memory only), with the page's address and no query."""
        owner = state or self._active_state()
        owner.step_count += 1
        step = {"n": owner.step_count, "action": action, "target": owner.hidden.text(target) if target else target,
                "url": _format.page_address(owner.hidden.text(url) if url else url), "at": _now(),
                "agent": owner.name or None}
        owner.steps.append(step)
        del owner.steps[:-MAX_STEPS]
        return step

    def _drop_step(self, step: Dict[str, Any]) -> None:
        """An action that failed is no step: the log lists what the browser did."""
        if self.steps and self.steps[-1] is step:
            self.steps.pop()
            self.step_count -= 1

    async def _finish_step(self, step: Dict[str, Any], page: Any) -> None:
        if page is not None and not page.is_closed():
            step["url"] = _format.page_address(page.url)

    async def _storage_state(self) -> Dict[str, Any]:
        """Cookies of the whole browser, and the kept sites' local storage read from their open documents.

        Unlike Playwright's own `storage_state()`, this never opens hidden pages on
        every origin the turn visited and reads only frames of sites whose sessions
        are kept, so it stays cheap enough to run after every action. Origins not
        open now keep what was restored or last read.
        """
        cookies = await self.context.cookies()
        sites = self.store.sites()
        for page in [tab for tab in self._pages if not tab.is_closed()]:
            for frame in page.frames:
                try:
                    parts = urlsplit(frame.url)
                    if parts.scheme not in ("http", "https") or not parts.hostname:
                        continue
                    if not _sessions.domain_matches(parts.hostname, sites):
                        continue
                    origin = f"{parts.scheme}://{parts.netloc}"
                    entries = await frame.evaluate(_dom.LOCAL_STORAGE)
                except (PlaywrightError, ValueError):
                    continue
                if isinstance(entries, list):
                    self.local_storage[origin] = entries
        return {"cookies": cookies, "origins": [{"origin": origin, "localStorage": entries}
                                                for origin, entries in self.local_storage.items() if entries]}

    async def _autosave(self) -> List[str]:
        """Rewrite the saved sessions whose cookies or local storage changed; the turn may end at any moment."""
        if not self.store.tracked or self.context is None:
            return []
        try:
            state = await self._storage_state()
        except PlaywrightError:
            return []
        saved = []
        for name in self.store.changed(state):
            try:
                if self.store.save(name, state)["changed"]:
                    saved.append(name)
            except _sessions.SessionError as error:
                self.notes.append(f"The session {name} was not saved: {error.message}")
        return saved

    # Request handling ------------------------------------------------------------------------------------------

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        response: Dict[str, Any]
        context_token: Optional[contextvars.Token] = None
        close_gate = False
        try:
            raw = await asyncio.wait_for(reader.readline(), 30)
            request = json.loads(raw.decode("utf-8"))
            if not isinstance(request, dict) or request.get("v") != PROTOCOL or not isinstance(request.get("op"), str) \
                    or not isinstance(request.get("args", {}), dict):
                raise HostError("protocol_error", "Unsupported request.")
            state = self._request_agent(request)
            context_token = self._agent_context.set(state.agent_id)
            if request["op"] == "live":
                if self.crashed or self.stopped.is_set():
                    raise HostError("browser_crashed", "The browser stopped.")
                # The connection stays open; the hub owns and closes it.
                args = dict(request.get("args", {}))
                args.setdefault("agent", state.agent_id)
                await self.live.serve(reader, writer, args)
                return
            op = request["op"]
            if op == "release":
                response = {"ok": True, "result": await self.dispatch(op, request.get("args", {}))}
            else:
                # Taking the per-agent lock before admission serializes slot
                # acquisition, release and tab cleanup with that agent's work.
                async with self.live.agent_action(state.lock, control_free=op in CONTROL_FREE_OPS, agent=state.agent_id):
                    note = None if op in CONTROL_FREE_OPS else self.live.take_note(state.agent_id)
                    if note:
                        raise HostError("user_returned_control", note + " " + USER_RETURNED)
                    if op not in CONTROL_FREE_OPS and op != "close":
                        await self._ensure_proxied()
                    if op not in CONTROL_FREE_OPS:
                        await self._acquire_slot(state)
                    await self._enter_command()
                    try:
                        self.last_used = time.monotonic()
                        if op == "close":
                            await self._begin_browser_close()
                            close_gate = True
                            async with self.browser_lock:
                                response = {"ok": True, "result": await self.dispatch(op, request.get("args", {}))}
                        elif op == "save_session":
                            async with self.browser_lock:
                                response = {"ok": True, "result": await self.dispatch(op, request.get("args", {}))}
                        else:
                            response = {"ok": True, "result": await self.dispatch(op, request.get("args", {}))}
                        self.last_used = time.monotonic()
                    finally:
                        await self._leave_command()
        except _livehub.UserInControl:
            response = {"ok": False, "error": {"code": "user_in_control", "message": USER_IN_CONTROL}}
        except HostError as error:
            response = {"ok": False, "error": {"code": error.code, "message": error.message}}
        except (ValueError, UnicodeDecodeError, asyncio.LimitOverrunError, asyncio.TimeoutError):
            response = {"ok": False, "error": {"code": "protocol_error", "message": "The request could not be read."}}
        except Exception as error:  # noqa: BLE001 - one failed request must not end the browser
            response = {"ok": False, "error": {"code": "browser_error", "message": self._error_text(error)}}
        # A value typed from the environment may come back in a field, an address, page text or a script result.
        response = self.hidden.mask(response)
        try:
            writer.write(json.dumps(response, ensure_ascii=False).encode("utf-8") + b"\n")
            await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()
            if context_token is not None:
                self._agent_context.reset(context_token)
        if response.get("result", {}).get("closing"):
            try:
                await self.stop()
            finally:
                if close_gate:
                    await self._end_browser_close()
        elif close_gate:
            await self._end_browser_close()

    async def dispatch(self, op: str, args: Dict[str, Any]) -> Dict[str, Any]:
        if self.crashed:
            raise HostError("browser_crashed", "The browser stopped unexpectedly; the next command starts a new one with the saved sessions.")
        handler = getattr(self, "op_" + op, None) if re.fullmatch(r"[a-z_]{1,24}", op) else None
        if handler is None:
            raise HostError("unknown_operation", f"Unknown browser operation {_format.quoted(op, 40)}.")
        timeout = 75.0 if op in ("open", "wait", "back", "forward", "reload", "new_tab") else 45.0
        if op == "wait":
            timeout = _int(args, "timeout", 15, 1, 120) + 15.0
        elif op == "captcha":
            timeout = _int(args, "wait", CAPTCHA_WAIT_SECONDS, 1, 60) + 45.0
        summary = _SUMMARY.set(args.get("page") is not False)
        try:
            return await asyncio.wait_for(handler(args), timeout)
        except asyncio.TimeoutError:
            raise HostError("timeout", f"The browser did not finish `{op}` within {int(timeout)} seconds.") from None
        except PlaywrightError as error:
            if self.crashed:
                raise HostError("browser_crashed", "The browser stopped unexpectedly; the next command starts a new one.") from None
            raise HostError("browser_error", self._error_text(error)) from None
        finally:
            _SUMMARY.reset(summary)

    async def _act(self, action: str, target: Optional[str], run: Any, *, settle: bool = True, info: bool = True) -> Dict[str, Any]:
        """Run one agent action, record its step, keep sessions current and summarize the page."""
        page = await self._page()
        step = self._record(action, target, page.url)
        site_before = self._site_of(page.url)
        self.acting = True
        try:
            await run(page)
            if settle:
                await self._settle(page)
        except BaseException:
            self._drop_step(step)
            raise
        finally:
            self.acting = False
        await asyncio.sleep(0)
        page = await self._page()
        await self._finish_step(step, page)
        if self.proxy_port is not None:
            await self._note_proxy(step, page, action, site_before)
        await self._autosave()
        result: Dict[str, Any] = {"step": step, "text": ""}
        if info and _SUMMARY.get():
            summary = await self._snapshot(page)
            result.update({"info": summary, "text": _format.render_info(summary)})
        return result

    # Human-like input (`_human.py`) ----------------------------------------------------------------------------

    def _check_turn(self) -> None:
        """The user took this agent's tab (or is taking it, or a handoff waits): its input stops between two events
        and the command answers `user_in_control`, so nothing of the agent reaches the page while the user has it."""
        if self._agent_held_by_user(self._active_state().agent_id):
            raise _livehub.UserInControl()

    def _mouse(self, page: Any) -> Any:
        return _human.Guarded(page.mouse, self._check_turn)

    def _keyboard(self, page: Any) -> Any:
        return _human.Guarded(page.keyboard, self._check_turn)

    async def _sleep(self, seconds: float) -> None:
        await _human.guarded_sleep(self._check_turn)(seconds)

    async def _bounds(self, page: Any) -> Tuple[float, float]:
        try:
            width, height = await page.evaluate(_human.VIEWPORT)
            return float(width), float(height)
        except (PlaywrightError, TypeError, ValueError):
            return 1440.0, 813.0

    async def _pointer(self, page: Any, bounds: Tuple[float, float]) -> Tuple[float, float]:
        """Where the pointer is; on a page it never moved over, it first comes to rest somewhere inside."""
        where = self.input.where(page)
        if where is None:
            where = self.input.resting_point(bounds)
            await self._mouse(page).move(*where)
            self.input.moved(page, where)
        return where

    async def _pointer_to(self, page: Any, x: float, y: float, width: float = 24.0, *, drag: bool = False) -> None:
        bounds = await self._bounds(page)
        start = await self._pointer(page, bounds)
        end = await _human.move(self._mouse(page), start, (x, y), self.input.profile, self.input.rng, width=width, bounds=bounds,
                                drag=drag, sleep=self._sleep)
        self.input.moved(page, end)

    async def _press(self, page: Any, *, hold_ms: Optional[float] = None, ready: Any = None) -> None:
        await _human.press(self._mouse(page), self.input.profile, self.input.rng, hold_ms=hold_ms, sleep=self._sleep, ready=ready)

    async def _box(self, element: Any) -> Optional[Dict[str, float]]:
        try:
            return await element.bounding_box()
        except PlaywrightError:
            return None

    async def _wheel_into_view(self, page: Any, element: Any) -> None:
        """Bring the element into view with the wheel, as a person scrolls to it. Far away, over a map or an embed, or
        where the wheel does not move it (a fixed bar, an inner list), Playwright scrolls it into view as before."""
        bounds = await self._bounds(page)
        for _ in range(4):
            box = await self._box(element)
            if box is None:
                return
            fits = box["height"] <= bounds[1] * 0.9
            seen = (box["y"] >= 0 and box["y"] + box["height"] <= bounds[1]) if fits else \
                (box["y"] < bounds[1] / 2 < box["y"] + box["height"])
            if seen and 0 <= box["x"] + box["width"] / 2 <= bounds[0]:
                return
            distance = box["y"] + box["height"] / 2 - bounds[1] * self.input.rng.uniform(0.35, 0.55)
            if seen or abs(distance) > bounds[1] * _human.WHEEL_REACH_VIEWPORTS:
                break
            at = await self._pointer(page, bounds)
            try:
                safe = await page.evaluate(_human.WHEEL_SAFE, list(at))
            except PlaywrightError:
                safe = False
            if not safe:
                break
            await _human.wheel(self._mouse(page), distance, self.input.profile, self.input.rng, sleep=self._sleep)
            moved = await self._settled_box(element)
            if moved is None or abs(moved["y"] - box["y"]) < 2:
                break
        await element.scroll_into_view_if_needed(timeout=ACTION_TIMEOUT_MS)

    async def _settled_box(self, element: Any) -> Optional[Dict[str, float]]:
        """The element's box once the wheel's scrolling stopped: smooth scrolling runs on after the last notch."""
        box = await self._box(element)
        for _ in range(6):
            await self._sleep(0.08)
            latest = await self._box(element)
            if latest is None or (box is not None and abs(latest["y"] - box["y"]) < 1):
                return latest
            box = latest
        return box

    async def _hit(self, element: Any, x: float, y: float) -> str:
        """What a press at viewport point x, y reaches: `ok` only when the element (or its label) is on top in its own
        document and each frame around it is on top in its parent's document at that point, so a dialog of the top
        page over a frame's button takes no click meant for the button. Otherwise `covered`, `outside`, `hidden` or
        `detached`."""
        current = element
        try:
            for _ in range(MAX_FRAMES + 2):
                box = await current.bounding_box()
                if box is None:
                    return "hidden"
                rect = await current.evaluate(_human.RECT)
                # The same point in the coordinates of the document that holds `current`.
                seen = await current.evaluate(_human.HIT_AT, [x - (box["x"] - rect[0]), y - (box["y"] - rect[1])])
                if seen != "ok":
                    return str(seen)
                frame = await current.owner_frame()
                if frame is None or frame.parent_frame is None:
                    return "ok"
                current = await frame.frame_element()
        except PlaywrightError:
            return "detached"
        return "covered"

    async def _aim(self, page: Any, element: Any) -> Optional[Tuple[float, float, float]]:
        """A point a person would click on the element once it is in view, with the element's smaller side; None
        where only Playwright's own click can wait for it or say what is wrong (covered, disabled, off screen)."""
        await self._wheel_into_view(page, element)
        bounds = await self._bounds(page)
        for fx, fy in (self.input.aim(), (0.5, 0.5)):
            try:
                seen = await element.evaluate(_human.AIM, [fx, fy])
            except PlaywrightError:
                return None
            if seen in ("disabled", "hidden"):
                return None
            box = await self._box(element)
            if not box:
                return None
            x, y = box["x"] + box["width"] * fx, box["y"] + box["height"] * fy
            if 0 <= x < bounds[0] and 0 <= y < bounds[1] and await self._hit(element, x, y) == "ok":
                return x, y, min(box["width"], box["height"])
        return None

    async def _human_click(self, page: Any, element: Any, *, move_only: bool = False, fallback: bool = True) -> bool:
        """Move the pointer to the element as a person would and click it (or only come to rest on it). The point is
        checked through every frame right before the button goes down; where it does not reach the element (covered,
        moved away, gone), nothing is pressed there: Playwright's own click runs instead, whose waiting and errors stay
        as they were, or with `fallback` off nothing is clicked. Returns whether the pointer pressed the element."""
        target = await self._aim(page, element)
        if target is not None:
            x, y, size = target
            await self._pointer_to(page, x, y, size)
            box = await self._box(element)
            if box and not _human.within((x, y), [box]):
                # It moved while the pointer travelled (an animation, a late layout): follow it once.
                x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                await self._pointer_to(page, x, y, size)
            if move_only:
                return False

            async def ready() -> None:
                if await self._hit(element, x, y) != "ok":
                    raise _Missed()

            try:
                await self._press(page, ready=ready)
                return True
            except _Missed:
                pass
        if move_only or not fallback:
            return False
        self._check_turn()
        box = await self._box(element)
        await element.click(timeout=ACTION_TIMEOUT_MS)
        self.input.moved(page, (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2) if box else None)
        return False

    async def _human_key(self, page: Any, combo: str) -> None:
        await _human.key(self._keyboard(page), combo, self.input.profile, self.input.rng, sleep=self._sleep)

    # CAPTCHAs and bot checks -----------------------------------------------------------------------------------

    def _tries(self, page: Any, url: Optional[str] = None) -> Tuple[List[Any], List[List[Any]], List[Any], str]:
        """The key of this turn's tries at the page's site (or `url`'s), every stored entry of this boot, and the key's entry."""
        site = self._site_of(url or page.url) or "this page"
        state = self._active_state()
        key = [_boot_id(), state.turn or "", state.agent_id, site]
        try:
            stored = json.loads((_paths.run_dir() / CAPTCHA_TRIES_FILE).read_text("utf-8"))
            entries = [entry for entry in stored if isinstance(entry, list) and len(entry) == 6 and entry[0] == key[0] and
                       all(isinstance(value, str) for value in entry[:4]) and
                       all(isinstance(value, int) and not isinstance(value, bool) for value in entry[4:])]
        except (OSError, ValueError, TypeError):
            entries = []
        entry = next((entry for entry in entries if entry[:4] == key), None)
        if entry is None:
            entry = [*key, 0, 0]
            entries.append(entry)
        # This browser's own count stands where the file was lost or could not be written.
        known = self._captcha_tries.get(tuple(key), [0, 0])
        entry[4], entry[5] = max(entry[4], known[0]), max(entry[5], known[1])
        return key, entries, entry, site

    def _store_tries(self, key: List[Any], entries: List[List[Any]], entry: List[Any]) -> None:
        self._captcha_tries[tuple(key)] = [entry[4], entry[5]]
        path = _paths.run_dir() / CAPTCHA_TRIES_FILE
        try:
            temporary = path.with_name(f".{CAPTCHA_TRIES_FILE}.{os.getpid()}")
            temporary.write_text(json.dumps(entries[-CAPTCHA_TRIES_KEPT:]), "utf-8")
            os.replace(temporary, path)
        except OSError:
            pass

    def _captcha_try(self, page: Any, kind: str) -> Tuple[int, str]:
        """Count one failed try at the check of the page's site until it passes (`attempt`: a `captcha` call; `input`:
        an input into a challenge); past the bound the try is refused. Returns the count with this try, and the site.

        The tries belong to the agent's turn, not to this browser: they are kept in the boot's run directory, so closing
        and reopening the browser keeps them, and a later turn of the same agent on a VM that stayed up (a background
        sub-agent holds it) starts afresh. A turn is known by the run's code bearer when the run has one (`_client.py`);
        without one, by this boot. A check that passes clears them (`_captcha_passed`).
        """
        key, entries, entry, site = self._tries(page)
        index = 4 if kind == "attempt" else 5
        if entry[index] >= (CAPTCHA_ATTEMPTS if kind == "attempt" else CAPTCHA_INPUTS):
            raise HostError("captcha_attempts_exhausted", CAPTCHA_EXHAUSTED.format(site=site, count=entry[index]))
        entry[index] += 1
        self._store_tries(key, entries, entry)
        return entry[index], site

    def _captcha_passed(self, page: Any, url: Optional[str] = None) -> None:
        """The site's check passed: the tries that led there were not failures, and the next check starts afresh."""
        key, entries, entry, _site = self._tries(page, url)
        if entry[4] or entry[5]:
            entry[4] = entry[5] = 0
            self._store_tries(key, entries, entry)

    async def _captcha_boxes(self, page: Any) -> List[Dict[str, float]]:
        """Where checks show on the page: their frames, and the widgets and forms of the top document."""
        boxes = [box for frame, box in (await self._frames(page))[1:] if box and self._captcha_frame(frame)]
        try:
            boxes.extend(await page.main_frame.evaluate(_dom.CAPTCHA_BOXES, _dom.CAPTCHA_CONTAINERS))
        except PlaywrightError:
            pass
        return boxes

    async def _check_state(self, page: Any) -> Dict[str, Any]:
        """What the page's check needs now: the kinds still open and those passed, a checkbox to tick (or a button
        to hold), and a picture, slider or text task with its box."""
        open_kinds, passed = await self._captcha_open(page, await self._captcha_in_page(page))
        state: Dict[str, Any] = {"open": open_kinds, "passed": passed, "checkbox": None, "challenge": None}
        bounds = await self._bounds(page)
        for frame, box in (await self._frames(page))[1:]:
            kind = self._captcha_frame(frame)
            if not kind or kind in state["passed"] or not box:
                continue
            role, selector = _dom.captcha_widget(kind, (frame.url or "").lower())
            if role == "challenge" and state["challenge"] is None and box["y"] + box["height"] > 0 and box["y"] < bounds[1]:
                state["challenge"] = {"kind": kind, "box": box}
            elif role == "checkbox" and state["checkbox"] is None:
                element = None
                if selector:
                    try:
                        element = await frame.query_selector(selector)
                        if element is not None and await element.get_attribute("aria-checked") == "true":
                            state["open"] = [other for other in state["open"] if other != kind]
                            state["passed"].append(kind)
                            continue
                    except PlaywrightError:
                        element = None
                    if element is None:
                        continue
                state["checkbox"] = {"kind": kind, "element": element, "box": box, "hold": False}
        for kind, role, selector in _dom.CAPTCHA_PAGE_WIDGETS:
            if kind in state["passed"]:
                continue
            try:
                element = await page.main_frame.query_selector(selector)
                if element is None or not await element.is_visible():
                    continue
                checked = await element.get_attribute("aria-checked") == "true"
            except PlaywrightError:
                continue
            box = await self._box(element)
            if role == "challenge" and state["challenge"] is None and box:
                state["challenge"] = {"kind": kind, "box": box}
            elif role in ("checkbox", "hold") and state["checkbox"] is None and not checked:
                state["checkbox"] = {"kind": kind, "element": element, "box": box, "hold": role == "hold"}
        return state

    async def _tick(self, page: Any, target: Dict[str, Any]) -> bool:
        """Tick a checkbox widget as a person does; a press-and-hold button is held until it lets the page go. Returns
        whether it pressed: a box covered, off screen or gone is left alone, never pressed where the pointer rests."""
        element, box = target["element"], target["box"]
        if target["hold"]:
            point = await self._aim(page, element)
            if point is None:
                return False
            await self._pointer_to(page, point[0], point[1], point[2])
            if await self._hit(element, point[0], point[1]) != "ok":
                return False
            self._check_turn()
            await page.mouse.down()
            loop = asyncio.get_running_loop()
            end = loop.time() + self.input.rng.uniform(9.0, 13.0)
            try:
                while loop.time() < end:
                    await self._sleep(0.5)
                    try:
                        if page.is_closed() or not await element.is_visible():
                            break
                    except PlaywrightError:
                        break
            finally:
                await page.mouse.up()
            return True
        if element is not None:
            return await self._human_click(page, element, fallback=False)
        if box:
            # A box in a closed shadow root (Turnstile) is clicked by its place: at the left of the frame, centred.
            x = box["x"] + (min(30.0, box["width"] * 0.15) if box["width"] >= 120 else box["width"] / 2)
            y = box["y"] + box["height"] / 2
            await self._pointer_to(page, x + self.input.rng.uniform(-3, 3), y + self.input.rng.uniform(-3, 3), 20)
            await self._press(page)
            return True
        return False

    async def _pass_check(self, page: Any, wait: int) -> Dict[str, Any]:
        """Wait for a check that passes by itself and tick its box when one shows, as a person would, until it passes,
        a task shows or `wait` seconds are over. Each box is ticked once; reading a page that navigates away is retried.
        The user taking the tab ends it between two steps (`_check_turn`)."""
        loop = asyncio.get_running_loop()
        end = loop.time() + wait
        first_seen: Dict[str, float] = {}
        tried: List[str] = []
        ticked: List[str] = []
        open_kinds: List[str] = []
        while True:
            self._check_turn()
            try:
                state = await self._check_state(page)
            except PlaywrightError:
                state = None
            now = loop.time()
            if state is not None:
                open_kinds = state["open"]
                if not open_kinds:
                    return {"outcome": "passed", "passed": state["passed"], "ticked": ticked}
                if state["challenge"]:
                    return {"outcome": "challenge", "challenge": state["challenge"], "open": open_kinds, "ticked": ticked}
                target = state["checkbox"]
                if target and target["kind"] not in tried:
                    # A person reads the box before ticking it; Turnstile often passes alone while it says "Verifying".
                    linger = self.input.rng.uniform(0.8, 1.8) + (1.5 if target["kind"].startswith("Cloudflare") else 0.0)
                    if now - first_seen.setdefault(target["kind"], now) >= linger:
                        tried.append(target["kind"])
                        try:
                            if await self._tick(page, target):
                                ticked.append(target["kind"])
                        except PlaywrightError:
                            pass
                        continue
            if now >= end:
                return {"outcome": "still", "open": open_kinds, "ticked": ticked}
            if self.input.rng.random() < 0.3:
                # A waiting person's hand is not still.
                try:
                    bounds = await self._bounds(page)
                    x, y = await self._pointer(page, bounds)
                    await self._pointer_to(page, x + self.input.rng.uniform(-40, 40), y + self.input.rng.uniform(-25, 25), 40)
                except PlaywrightError:
                    pass
            await self._sleep(0.5)

    def _shot_path(self) -> Path:
        self.shots_dir.mkdir(parents=True, exist_ok=True)
        existing = sorted(self.shots_dir.glob("shot-*.png"))
        self.shot_count = max([self.shot_count] + [int(entry.stem[5:]) for entry in existing if entry.stem[5:].isdigit()]) + 1
        return self.shots_dir / f"shot-{self.shot_count:04d}.png"

    def _prune_shots(self) -> None:
        for old in sorted(self.shots_dir.glob("shot-*.png"))[:-KEEP_SHOTS]:
            try:
                old.unlink()
            except OSError:
                pass

    # Operations ------------------------------------------------------------------------------------------------

    async def op_status(self, args: Dict[str, Any]) -> Dict[str, Any]:
        state = self._active_state()
        page = state.current if state.current is not None and not state.current.is_closed() else None
        markers = None
        if args.get("markers") and page is not None:
            markers = self.hidden.mask(await page.evaluate(_dom.MARKERS))
        data = {"version": self.version, "pinned": _pinned_chromium(), "locale": self.locale, "timezone": self.timezone,
                "userAgentHeadless": "Headless" in self.user_agent, "tabs": len([t for t in self.tabs if not t.is_closed()]),
                "otherAgentTabs": sum(len([tab for tab in state.tabs if not tab.is_closed()]) for state in self._states.values()
                                       if state is not self._active_state()),
                "agent": state.agent_id, "sessions": sorted(self.store.tracked),
                "skippedSessions": sorted(self.store.skipped), "steps": self.step_count, "markers": markers}
        lines = [f"Chromium {self.version} (pinned {data['pinned'] or 'unknown'}), language {self.locale}, time zone {self.timezone}.",
                 f"Open tabs: {data['tabs']} for this agent (other agents: {data['otherAgentTabs']}). Saved sessions kept current: {', '.join(data['sessions']) or 'none'}."]
        if data["skippedSessions"]:
            lines.append(f"Saved session files not loaded: {', '.join(data['skippedSessions'])}.")
        for scope in ("page", "worker") if markers else ():
            seen = markers.get(scope) if isinstance(markers, dict) else None
            if not isinstance(seen, dict):
                lines.append(f"Markers in {scope} scope: not measured.")
                continue
            # The page reports these values, so each stays on its own bounded line.
            brands = ", ".join(str(brand) for brand in seen.get("brands") or [])
            languages = ", ".join(str(code) for code in seen.get("languages") or [])
            lines.append(f"Markers in {scope} scope: webdriver={json.dumps(seen.get('webdriver'))}, "
                         f"headless user agent={json.dumps('Headless' in str(seen.get('userAgent') or ''))}, "
                         f"brands={_format.clean(brands, 300)}, time zone={_format.clean(seen.get('timeZone'), 64)}, "
                         f"languages={_format.clean(languages, 200)}.")
        return {"data": data, "text": "\n".join(lines)}

    async def op_open(self, args: Dict[str, Any]) -> Dict[str, Any]:
        url = _web_url(_text(args, "url", 4096))
        choice = _text(args, "proxy", 128, required=False)
        status: Dict[str, Any] = {}

        async def run(page: Any) -> None:
            await self._route_navigation(page, url, choice)
            try:
                status["code"] = await self._goto(page, url)
            except PlaywrightTimeoutError:
                raise HostError("navigation_timeout", "The page did not start loading within 45 seconds.") from None
            except PlaywrightError as error:
                raise HostError("navigation_failed", self._error_text(error)) from None

        result = await self._act("open", None, run)
        if status.get("code") and status["code"] >= 400:
            result["text"] = f"HTTP status {status['code']}.\n" + await self._blocked_note((result.get("info") or {}).get("url") or url, status["code"]) + result["text"]
        result["data"] = status
        return result

    async def op_info(self, args: Dict[str, Any]) -> Dict[str, Any]:
        page = await self._page()
        summary = await self._snapshot(page)
        every = args.get("all") is True
        limit = _int(args, "limit", 300 if every else 80, 1, 500)
        return {"info": summary, "text": _format.render_info(summary, every=every, limit=limit)}

    async def op_find(self, args: Dict[str, Any]) -> Dict[str, Any]:
        query = self.hidden.text(_text(args, "text", 200) or "")
        page = await self._page()
        summary = await self._snapshot(page)
        return {"info": summary, "text": _format.render_find(query, summary["items"])}

    async def op_click(self, args: Dict[str, Any]) -> Dict[str, Any]:
        element, item = await self._element(_int(args, "n", None, 1, 100_000))
        if item.get("captcha"):
            self._captcha_try(await self._page(), "input")

        async def run(page: Any) -> None:
            try:
                await self._human_click(page, element)
            except PlaywrightTimeoutError as error:
                raise HostError("element_not_actionable", f"Element [{item['n']}] could not be clicked within 10 seconds: "
                                f"{self._error_text(error, 240)} Look at the page (`shot`) for a covering banner or dialog.") from None

        return await self._act("click", _format.element_label(item), run)

    async def op_type(self, args: Dict[str, Any]) -> Dict[str, Any]:
        frame, element, item = await self._element_ref(_int(args, "n", None, 1, 100_000))
        text = _text(args, "text", 20_000, required=False) or ""
        submit = args.get("submit") is True
        replace = args.get("clear", True) is not False
        masked = args.get("masked") is True
        if masked:
            # Before acting: even an error about this field must not carry the value.
            self.hidden.add(text)
            self.env_hidden.add(text)
            self.masked.setdefault(frame, []).append((frame.url, element))
        detail = f"{len(text)} characters"
        if item.get("search") and not item.get("secret") and not masked:
            detail = self._said(text, 40)
        label = f"{_format.element_label(item)} ({detail})"

        fillable = item.get("role") in ("textbox", "searchbox", "combobox", "spinbutton") or "value" in item or item.get("secret")
        # Text fields are clicked and typed into key by key; a date, colour or list box takes its value as before.
        typeable = not item.get("select") and (item.get("role") in ("textbox", "searchbox", "combobox", "spinbutton") or
                                                bool(item.get("secret")))
        if item.get("captcha"):
            self._captcha_try(await self._page(), "input")

        async def run(page: Any) -> None:
            try:
                if replace and fillable and not typeable:
                    await element.fill(text, timeout=ACTION_TIMEOUT_MS)
                else:
                    # A field under a floating label or another layer is not pressed through: it takes the focus instead.
                    await self._human_click(page, element, fallback=not fillable)
                    if not await element.evaluate(_human.FOCUSED):
                        await element.focus()
                    before = await element.evaluate(_human.VALUE) if fillable else ""
                    if not await element.evaluate(_human.FOCUSED):
                        # The click went elsewhere and nothing takes the focus: keys would land on the wrong thing.
                        if not fillable:
                            raise HostError("element_not_actionable", f"Element [{item['n']}] does not take typing; click it "
                                            "first or look at the page (`shot`).")
                        await element.fill(text if replace else before + text, timeout=ACTION_TIMEOUT_MS)
                    else:
                        if replace and fillable and before:
                            await self._human_key(page, "Control+A")
                            await self._human_key(page, "Backspace")
                        elif not replace and fillable:
                            await self._human_key(page, "End")
                        await _human.type_text(self._keyboard(page), text, self.input.profile, self.input.rng, sleep=self._sleep)
                        if fillable and text:
                            # Keys or a paste the page ignored (a site that refuses pasting): the value is set as before.
                            after = await element.evaluate(_human.VALUE)
                            if (replace and not after) or (not replace and after == before):
                                await element.fill(text if replace else before + text, timeout=ACTION_TIMEOUT_MS)
                if submit:
                    await self._sleep(self.input.rng.uniform(0.15, 0.4))
                    self._check_turn()
                    await element.press("Enter", delay=self.input.rng.uniform(*self.input.profile.key_hold_ms),
                                        timeout=ACTION_TIMEOUT_MS)
            except PlaywrightTimeoutError as error:
                raise HostError("element_not_actionable", f"Could not type into element [{item['n']}]: {self._error_text(error, 240)}") from None
            except PlaywrightError as error:
                raise HostError("element_not_actionable", f"Could not type into element [{item['n']}]: {self._error_text(error, 240)}") from None

        return await self._act("type", label, run, settle=submit)

    async def op_select(self, args: Dict[str, Any]) -> Dict[str, Any]:
        element, item = await self._element(_int(args, "n", None, 1, 100_000))
        option = _text(args, "option", 500)
        if not item.get("select"):
            raise HostError("not_a_select", f"Element [{item['n']}] is not a list box; click it and choose the option by its number.")
        chosen: Dict[str, Any] = {}

        async def run(page: Any) -> None:
            # The pointer comes to the list box as a person's would; the option is then chosen as the list's own popup does.
            await self._human_click(page, element, move_only=True)
            labels = await element.evaluate("el => Array.from(el.options).map(o => [o.label || o.textContent.trim(), o.value])")
            pick = next((value for label, value in labels if label == option or value == option), None)
            if pick is None:
                needle = option.casefold()
                pick = next((value for label, value in labels if needle in label.casefold()), None)
            if pick is None:
                shown = ", ".join(self._said(label, 40) for label, _ in labels[:20])
                raise HostError("option_not_found", f"No option of [{item['n']}] matches {self._said(option)}. Options: {shown}.")
            chosen["value"] = pick
            await element.select_option(value=pick, timeout=ACTION_TIMEOUT_MS)

        return await self._act("select", f"{self._said(option, 60)} in {_format.element_label(item)}", run)

    async def op_upload(self, args: Dict[str, Any]) -> Dict[str, Any]:
        element, item = await self._element(_int(args, "n", None, 1, 100_000))
        path = _readable_path(_text(args, "path", 4096))
        if not path.is_file():
            raise HostError("invalid_path", "The file to upload does not exist.")

        async def run(_: Any) -> None:
            await element.set_input_files(str(path), timeout=ACTION_TIMEOUT_MS)

        return await self._act("upload", f"{self._said(path.name, 60)} to {_format.element_label(item)}", run)

    async def op_press(self, args: Dict[str, Any]) -> Dict[str, Any]:
        key = _text(args, "key", 40)
        if not _KEY.fullmatch(key):
            raise HostError("invalid_arguments", "Use a key such as Enter, Escape, Tab, ArrowDown or Control+A.")

        async def run(page: Any) -> None:
            await self._human_key(page, key)

        return await self._act("press", key, run)

    async def op_scroll(self, args: Dict[str, Any]) -> Dict[str, Any]:
        number = args.get("n")
        if number is not None:
            element, item = await self._element(_int(args, "n", None, 1, 100_000))

            async def to_element(page: Any) -> None:
                await self._wheel_into_view(page, element)

            return await self._act("scroll", f"to {_format.element_label(item)}", to_element, settle=False)
        direction = args.get("direction", "down")
        if direction not in ("down", "up", "top", "bottom"):
            raise HostError("invalid_arguments", "Scroll down, up, top or bottom, or to an element number.")

        async def run(page: Any) -> None:
            if direction in ("down", "up"):
                # A screen's worth with the wheel at the pointer, as a person scrolls. Where that moved nothing (the pointer
                # rests over an inner list, a map or an embed, or the page scrolls in its own element), the page scrolls as before.
                bounds = await self._bounds(page)
                at = await self._pointer(page, bounds)
                before = await page.evaluate(_human.SCROLL_TOP)
                if await page.evaluate(_human.WHEEL_SAFE, list(at)):
                    sign = 1 if direction == "down" else -1
                    await _human.wheel(self._mouse(page), sign * bounds[1] * 0.85 * self.input.rng.uniform(0.93, 1.05),
                                       self.input.profile, self.input.rng, sleep=self._sleep)
                    await self._sleep(0.4)
                    if await page.evaluate(_human.SCROLL_TOP) != before:
                        return
            self._check_turn()
            await page.evaluate(_dom.SCROLL, direction)
            await asyncio.sleep(0.4)

        return await self._act("scroll", direction, run, settle=False)

    async def op_back(self, args: Dict[str, Any]) -> Dict[str, Any]:
        async def run(page: Any) -> None:
            await page.go_back(wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)

        return await self._act("back", None, run)

    async def op_forward(self, args: Dict[str, Any]) -> Dict[str, Any]:
        async def run(page: Any) -> None:
            await page.go_forward(wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)

        return await self._act("forward", None, run)

    async def op_reload(self, args: Dict[str, Any]) -> Dict[str, Any]:
        status: Dict[str, Any] = {}

        async def run(page: Any) -> None:
            response = await page.reload(wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
            status["code"] = response.status if response else None

        result = await self._act("reload", None, run)
        note = await self._blocked_note((result.get("info") or {}).get("url") or "", status.get("code"))
        if note:
            result["text"] = f"HTTP status {status['code']}.\n" + note + result["text"]
        return result

    async def op_wait(self, args: Dict[str, Any]) -> Dict[str, Any]:
        timeout = _int(args, "timeout", 15, 1, 120) * 1000
        text = _text(args, "text", 500, required=False)
        selector = _text(args, "selector", 500, required=False)
        url = _text(args, "url", 2000, required=False)
        if sum(value is not None for value in (text, selector, url)) != 1:
            raise HostError("invalid_arguments", "Wait for exactly one of text, selector or url.")
        target = f"text {self._said(text, 60)}" if text is not None else \
            f"selector {self._said(selector, 60)}" if selector is not None else f"address {self._said(url, 60)}"

        async def run(page: Any) -> None:
            try:
                if text is not None:
                    await page.get_by_text(text).first.wait_for(state="visible", timeout=timeout)
                elif selector is not None:
                    await page.wait_for_selector(selector, state="visible", timeout=timeout)
                else:
                    await page.wait_for_url(url if any(ch in url for ch in "*?") else f"**{url}**", timeout=timeout)
            except PlaywrightTimeoutError:
                raise HostError("wait_timeout", f"The page did not show {target} within {timeout // 1000} seconds.") from None

        return await self._act("wait", target, run)

    async def op_text(self, args: Dict[str, Any]) -> Dict[str, Any]:
        start = _int(args, "start", 0, 0, 50_000_000)
        limit = _int(args, "max", 6000, 100, TEXT_MAX_CHARS)
        if args.get("n") is not None:
            element, _item = await self._element(_int(args, "n", None, 1, 100_000))
            raw = await element.evaluate(_dom.TEXT)
        else:
            page = await self._page()
            raw = await page.main_frame.evaluate(_dom.TEXT, None)
        text, length = _format.page_text(raw if isinstance(raw, str) else "", self.hidden, start, limit)
        return {"text": text, "data": {"length": length}}

    async def op_js(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Evaluate a script in the page and return its JSON value, bounded and masked."""
        expression = _text(args, "expression", 20_000)
        page = await self._page()
        try:
            value = self.hidden.mask(await page.evaluate(expression))
        except PlaywrightError as error:
            raise HostError("script_error", self._error_text(error)) from None
        text = json.dumps(value, ensure_ascii=False, default=str)
        return {"text": text if len(text) <= JS_MAX_CHARS else text[:JS_MAX_CHARS] + f"… ({len(text) - JS_MAX_CHARS} more characters)"}

    async def op_captcha(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Pass the page's check as a person would: wait while it checks the browser, tick its box, and when a picture,
        slider or text task follows, save a screenshot for the agent to answer it with `click`, `click_at`, `drag` or
        `type`. Bounded per site (`CAPTCHA_ATTEMPTS`)."""
        wait = _int(args, "wait", CAPTCHA_WAIT_SECONDS, 1, 60)
        page = await self._page()
        open_kinds, passed = await self._captcha_open(page, await self._captcha_in_page(page))
        if not open_kinds:
            if passed:
                self._captcha_passed(page)
            lead = "No CAPTCHA or bot check is open on this page" + (f"; {', '.join(passed)} already passed" if passed else "") + "."
            if not _SUMMARY.get():
                return {"text": lead}
            summary = await self._snapshot(page)
            return {"info": summary, "text": lead + "\n" + _format.render_info(summary)}
        url = page.url
        attempt, site = self._captcha_try(page, "attempt")
        outcome: Dict[str, Any] = {}

        async def run(current: Any) -> None:
            outcome.update(await self._pass_check(current, wait))
            if outcome["outcome"] == "challenge":
                path = self._shot_path()
                await current.screenshot(path=str(path), timeout=30_000)
                self._prune_shots()
                outcome["shot"] = str(path)

        result = await self._act("captcha", ", ".join(open_kinds), run)
        tries = f"Attempt {attempt} of {CAPTCHA_ATTEMPTS} at the check on {site} in this turn."
        ticked = f" Ticked: {', '.join(outcome['ticked'])}." if outcome.get("ticked") else ""
        if outcome["outcome"] == "passed":
            self._captcha_passed(page, url)
            lead = f"The check passed.{ticked}"
        elif outcome["outcome"] == "challenge":
            challenge = outcome["challenge"]
            box = challenge["box"]
            lead = (f"A task of the {challenge['kind']} shows (pictures, a slider or text).{ticked} Screenshot of the page: "
                    f"{outcome['shot']}; the task is at x {round(box['x'])}–{round(box['x'] + box['width'])}, "
                    f"y {round(box['y'])}–{round(box['y'] + box['height'])} of it. Look at it (view_workspace_image, or "
                    "analyze_image where you cannot view images) and answer as a person would: click a tile or point with "
                    "`click N` or `click-at X Y` (the screenshot's pixels), drag a slider with `drag X1 Y1 X2 Y2`, or type "
                    "the text with `type N TEXT`; then press its Verify, Next or Submit button and run `captcha` again. " + tries)
        else:
            lead = (f"The check still shows after {wait} seconds ({', '.join(outcome.get('open') or open_kinds)}).{ticked} "
                    "Look at it (`shot`) to see what it asks, then answer it as a person would (`click`, `click-at X Y`, `drag`, "
                    "`type`) or run `captcha` once more. " + tries)
        result["text"] = lead + ("\n" + result["text"] if result.get("text") else "")
        result["data"] = {"outcome": outcome["outcome"], "attempt": attempt, "screenshot": outcome.get("shot")}
        return result

    async def _point(self, args: Dict[str, Any], page: Any, *names: str) -> List[int]:
        """Viewport points named by the request, each inside the visible page."""
        bounds = await self._bounds(page)
        values = [_int(args, name, None, 0, 20_000) for name in names]
        for x, y in zip(values[::2], values[1::2]):
            if x >= bounds[0] or y >= bounds[1]:
                raise HostError("invalid_arguments", f"The point {x},{y} is outside the visible page ({int(bounds[0])}x{int(bounds[1])}). "
                                "Points are viewport pixels, as in a `shot` of the page; scroll first to reach another part.")
        return values

    async def op_click_at(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Click a point of the viewport as a person would: for a picture task, a canvas or a map. Held for `hold_ms` when given."""
        page = await self._page()
        x, y = await self._point(args, page, "x", "y")
        hold = _int(args, "hold_ms", 0, 0, 20_000)
        if _human.within((x, y), await self._captcha_boxes(page)):
            self._captcha_try(page, "input")

        async def run(current: Any) -> None:
            await self._pointer_to(current, x, y, 12)
            await self._press(current, hold_ms=hold or None)

        return await self._act("click_at", f"{x},{y}" + (f" held {hold / 1000:g} s" if hold else ""), run)

    async def op_drag(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Press at one viewport point, move to another with the button held, and let go: a slider, a puzzle piece."""
        page = await self._page()
        x1, y1, x2, y2 = await self._point(args, page, "x1", "y1", "x2", "y2")
        if _human.within((x1, y1), await self._captcha_boxes(page)):
            self._captcha_try(page, "input")

        async def run(current: Any) -> None:
            rng = self.input.rng
            await self._pointer_to(current, x1, y1, 16)
            await self._sleep(rng.uniform(*self.input.profile.settle_ms) / 1000)
            await self._mouse(current).down()
            try:
                await self._sleep(rng.uniform(0.08, 0.18))
                await self._pointer_to(current, x2, y2, 16, drag=True)
                await self._sleep(rng.uniform(0.05, 0.15))
            finally:
                # Stopped half way (the user took the tab, a timeout): the button is never left held.
                await current.mouse.up()

        return await self._act("drag", f"{x1},{y1} to {x2},{y2}", run)

    async def op_screenshot(self, args: Dict[str, Any]) -> Dict[str, Any]:
        page = await self._page()
        full = args.get("full") is True
        given = _text(args, "path", 4096, required=False)
        element = None
        label = "page"
        if args.get("n") is not None:
            element, item = await self._element(_int(args, "n", None, 1, 100_000))
            label = _format.element_label(item)
        if given:
            path = _writable_path(given)
            if path.suffix.lower() != ".png":
                raise HostError("invalid_path", "Screenshots are PNG files; use a path ending in .png.")
        else:
            path = self._shot_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        if element is not None:
            await element.screenshot(path=str(path), timeout=ACTION_TIMEOUT_MS)
        else:
            await page.screenshot(path=str(path), full_page=full, timeout=30_000)
        if not given:
            self._prune_shots()
        step = self._record("screenshot", label, page.url)
        await self._finish_step(step, page)
        return {"step": step, "text": f"Screenshot saved: {path}", "data": {"path": str(path)}}

    async def op_tabs(self, args: Dict[str, Any]) -> Dict[str, Any]:
        tabs = []
        for index, tab in enumerate([tab for tab in self.tabs if not tab.is_closed()], start=1):
            try:
                title = self.hidden.text(await tab.title())
            except PlaywrightError:
                title = ""
            tabs.append({"index": index, "title": title, "url": self.hidden.text(_format.without_userinfo(tab.url)),
                         "current": tab is self.current})
        others = sum(len([tab for tab in state.tabs if not tab.is_closed()]) for state in self._states.values()
                     if state is not self._active_state())
        text = _format.render_tabs(tabs)
        if others:
            text += f"\nOther agents have {others} tab{'s' if others != 1 else ''}; they are not available to you."
        return {"data": {"tabs": tabs, "otherAgents": others}, "text": text}

    def _tab(self, args: Dict[str, Any]) -> Any:
        tabs = [tab for tab in self.tabs if not tab.is_closed()]
        index = _int(args, "index", None, 1, 1000)
        if index > len(tabs):
            raise HostError("tab_not_found", f"There is no tab {index}; `tabs` lists {len(tabs)}.")
        return tabs[index - 1]

    async def op_tab(self, args: Dict[str, Any]) -> Dict[str, Any]:
        tab = self._tab(args)

        async def run(_: Any) -> None:
            self.current = tab
            await tab.bring_to_front()

        return await self._act("tab", str(args["index"]), run, settle=False)

    async def op_new_tab(self, args: Dict[str, Any]) -> Dict[str, Any]:
        url = _web_url(_text(args, "url", 4096)) if args.get("url") else None
        choice = _text(args, "proxy", 128, required=False)
        if choice is not None and url is None:
            raise HostError("invalid_arguments", "`--proxy` needs the address to open.")
        self._check_memory()
        state = self._active_state()
        while len([tab for tab in state.tabs if not tab.is_closed()]) >= MAX_AGENT_TABS:
            oldest = next((tab for tab in state.tabs if not tab.is_closed() and tab is not state.current), None)
            if oldest is None:
                oldest = next((tab for tab in state.tabs if not tab.is_closed()), None)
            if oldest is None:
                break
            old_url = oldest.url
            await oldest.close()
            step = self._record("close_tab", "oldest tab", old_url)
            await self._finish_step(step, state.current)
            state.notes.append(f"Closed the oldest tab to keep this agent's tab limit at {MAX_AGENT_TABS}: {_format.where(old_url) or 'blank page'}.")
        page = await self._new_page(state)
        await self._setup(page)
        self.current = page

        status: Dict[str, Any] = {}

        async def run(current: Any) -> None:
            if url:
                await self._route_navigation(current, url, choice)
                status["code"] = await self._goto(current, url)

        result = await self._act("new_tab", None, run, settle=url is not None)
        note = await self._blocked_note((result.get("info") or {}).get("url") or url or "", status.get("code"))
        if note:
            result["text"] = f"HTTP status {status['code']}.\n" + note + result["text"]
        return result

    async def op_close_tab(self, args: Dict[str, Any]) -> Dict[str, Any]:
        tab = self._tab(args) if args.get("index") is not None else await self._page()
        await tab.close()
        page = await self._page()
        step = self._record("close_tab", None, page.url)
        await self._finish_step(step, page)
        summary = await self._snapshot(page)
        return {"step": step, "info": summary, "text": _format.render_info(summary)}

    async def op_save_session(self, args: Dict[str, Any]) -> Dict[str, Any]:
        page = await self._page()
        site = _sessions.site_of(urlsplit(page.url).hostname or "")
        name = _text(args, "name", 200, required=False)
        if name:
            name = name if name.endswith(".json") else name + ".json"
        elif site:
            name = _sessions.session_name(site)
        if not name or not _sessions.is_session_filename(name):
            raise HostError("session_name_invalid", "Open the signed-in site first, or name the session like shop.example.com.")
        sites = {value for value in (site, _sessions.site_of(name[: -len(".json")])) if value}
        self.store.track(name, sites)
        state = await self._storage_state()
        try:
            saved = self.store.save(name, state)
        except _sessions.SessionError as error:
            raise HostError(error.code, error.message) from None
        step = self._record("save_session", name[: -len(".json")], page.url)
        await self._finish_step(step, page)
        verb = "Saved" if saved["changed"] else "Unchanged"
        return {"step": step, "data": saved,
                "text": f"{verb}: /workspace/secrets/browser/{name} ({saved['bytes']} bytes). It stays current while you browse in this turn."}

    async def save_site_session(self, agent: str = MAIN_AGENT_ID) -> Optional[str]:
        """After the user's handoff, save that agent's site and keep it current (`op_save_session`).

        Returns the site's name, or None if the tab has no site or saving failed; the previous version then stays.
        Two agents saving one site keep the last complete save.
        """
        token = self._agent_context.set(self._valid_agent_id(agent))
        try:
            return await self._save_site_session()
        finally:
            self._agent_context.reset(token)

    async def _save_site_session(self) -> Optional[str]:
        try:
            await asyncio.wait_for(self.lock.acquire(), 20)
        except asyncio.TimeoutError:
            return None
        try:
            page = self.current if self.current is not None and not self.current.is_closed() else None
            site = _sessions.site_of(urlsplit(page.url).hostname or "") if page is not None else None
            if page is None or not site:
                return None
            name = _sessions.session_name(site)
            if not _sessions.is_session_filename(name):
                return None
            self.store.track(name, {site})
            self.store.save(name, await self._storage_state())
            step = self._record("save_session", name[: -len(".json")], page.url)
            await self._finish_step(step, page)
            return name[: -len(".json")]
        except (_sessions.SessionError, PlaywrightError, OSError, ValueError):
            return None
        finally:
            self.lock.release()

    async def op_steps(self, args: Dict[str, Any]) -> Dict[str, Any]:
        steps = [dict(step) for step in self.steps]
        return {"data": steps, "text": _format.render_steps(steps)}

    async def op_close(self, args: Dict[str, Any]) -> Dict[str, Any]:
        if self._active_state().agent_id != MAIN_AGENT_ID:
            raise HostError("browser_release_required", "Only the main agent can close the shared browser; run `release` to free this agent's slot.")
        saved = await self._autosave()
        return {"closing": True, "text": "The browser is closed" + (f"; saved {', '.join(saved)}." if saved else ".")}

    async def op_release(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Release this agent's browser slot; other agents keep their tabs."""
        state = self._active_state()
        await self.release_agent(state.agent_id)
        return {"text": "Released this agent's browser slot; its tabs are closed." if state.agent_id != MAIN_AGENT_ID
                else "Released the main agent's browser slot; its tabs remain open."}


def _pinned_chromium() -> Optional[str]:
    """The Chromium version Playwright pins (its browsers.json), to compare with the running build."""
    try:
        import playwright

        registry = Path(playwright.__file__).parent / "driver" / "package" / "browsers.json"
        data = json.loads(registry.read_text("utf-8"))
        return next(entry.get("browserVersion") for entry in data["browsers"] if entry.get("name") == "chromium")
    except (OSError, ValueError, KeyError, StopIteration, ImportError):
        return None


async def _main() -> int:
    run_dir = _paths.run_dir()
    socket_path = run_dir / "control.sock"
    status_path = run_dir / "host.status"
    host = Host(dict(os.environ))
    try:
        await host.start()
    except Exception as error:  # noqa: BLE001 - reported to the waiting client as a stable code
        status_path.write_text(json.dumps({"code": "browser_start_failed", "error": type(error).__name__,
                                           "detail": _first_line(error, 300)}), encoding="utf-8")
        await host.stop()
        return 1
    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass
    server = await asyncio.start_unix_server(host.serve, path=str(socket_path), limit=REQUEST_MAX_BYTES)
    os.chmod(socket_path, 0o600)
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        loop.add_signal_handler(signum, lambda: asyncio.ensure_future(host.stop()))

    async def idle() -> None:
        while not host.stopped.is_set():
            await asyncio.sleep(15)
            expired = [(state, state.last_used) for state in host._states.values()
                       if state.slot and state.agent_id != MAIN_AGENT_ID and time.monotonic() - state.last_used > AGENT_IDLE_SECONDS]
            await asyncio.gather(*(host._expire_agent(state, observed) for state, observed in expired))
            # A browser the user watches or holds is in use.
            if not any(state.lock.locked() for state in host._states.values()) and not host.live.busy() and \
                    time.monotonic() - max((state.last_used for state in host._states.values()), default=time.monotonic()) > IDLE_SECONDS:
                await host.stop()

    watcher = asyncio.ensure_future(idle())
    plan_watcher = asyncio.ensure_future(host.watch_proxy_plan())
    await host.stopped.wait()
    watcher.cancel()
    plan_watcher.cancel()
    server.close()
    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass
    if host.crashed:
        status_path.write_text(json.dumps({"code": "browser_crashed"}), encoding="utf-8")
        await host.stop()
    return 0


def main(argv: Optional[List[str]] = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) == 2 and args[0] == _paths.TEST_ROOT_FLAG:
        _paths.use_test_root(args[1])
    elif args:
        sys.exit(2)
    socket.setdefaulttimeout(None)
    sys.exit(asyncio.run(_main()))


if __name__ == "__main__":
    main()
