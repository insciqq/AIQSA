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
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

from . import _dom, _format, _identity, _livehub, _paths, _sessions
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
TEXT_MAX_CHARS = 20_000
JS_MAX_CHARS = 8_000
ACTION_TIMEOUT_MS = 10_000
NAVIGATION_TIMEOUT_MS = 45_000
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
        self.stopped = asyncio.Event()
        self.shot_count = 0

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
        return self._state_for(agent_id, name)

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
            if state.slot and state.agent_id != MAIN_AGENT_ID and now - state.last_used > AGENT_IDLE_SECONDS:
                # Closing is scheduled by the async watcher; the lock only
                # drops the slot now so a waiting agent can proceed.
                state.slot = False
                state.notes.append("The browser slot expired after two minutes without an action; its tabs were closed.")
                asyncio.create_task(self._close_agent_tabs(state))

    async def _close_agent_tabs(self, state: AgentState) -> None:
        for page in list(state.tabs):
            try:
                await page.close()
            except Exception:  # noqa: BLE001 - expiry is best effort
                pass
        state.current = None

    async def release_agent(self, agent_id: str, *, close_tabs: bool = True) -> None:
        state = self._states.get(agent_id)
        if state is None:
            return
        async with self.browser_lock:
            state.slot = False
            if close_tabs and agent_id != MAIN_AGENT_ID:
                await self._close_agent_tabs(state)
            async with self.slot_condition:
                self.slot_condition.notify_all()

    def live_agents(self) -> List[Dict[str, Any]]:
        """Per-agent stream targets consumed by the live-panel worker."""
        result = []
        for state in self._states.values():
            page = state.current if state.current is not None and not state.current.is_closed() else None
            result.append({"agent": state.agent_id, "name": state.name or None,
                           "page": page.url if page is not None else None,
                           "controller": "agent", "handoff": False})
        return result

    def select_live_agent(self, agent_id: str) -> None:
        self._selected_agent_id = self._valid_agent_id(agent_id)
        self._state_for(self._selected_agent_id)

    # Lifecycle -------------------------------------------------------------------------------------------------

    async def start(self) -> None:
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
        self.browser = await chromium.launch(channel="chromium", headless=True, ignore_default_args=_identity.IGNORED_DEFAULT_ARGS,
                                             args=_identity.launch_args(self.locale, self.user_agent), env=env)
        self.browser.on("disconnected", self._on_disconnected)
        state = self.store.load()
        self.local_storage = {origin["origin"]: origin["localStorage"] for origin in state["origins"]}
        self.context = await self.browser.new_context(no_viewport=True, accept_downloads=True, storage_state=state)
        self.context.on("page", self._on_page)
        self._reset_steps()
        page = await self.context.new_page()
        self._pages[page] = self._state_for(self._start_agent_id, self._start_agent_name)
        await self._setup(page)
        self.current = page
        restored = ", ".join(name[: -len(".json")] for name in sorted(self.store.tracked)) or "none"
        self.notes.append(f"Started a new browser (Chromium {self.version}, language {self.locale}, time zone {self.timezone}); "
                          f"saved sign-ins restored: {restored}.")
        if self.store.skipped:
            self.notes.append(f"Saved session files not loaded (invalid or over the limits): {', '.join(sorted(self.store.skipped))}.")

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
        state = self._pages.get(page)
        if state is None:
            state = self._active_state() if self.acting else self._state_for(self._selected_agent_id)
            self._pages[page] = state
        future = self._setup_future(page)
        if self.acting:
            # A page the agent's own action opened becomes the current tab.
            def adopt(_: Any) -> None:
                if not page.is_closed():
                    state.current = page
                    state.notes.append("The action opened a new tab; it is now the current tab.")
            future.add_done_callback(adopt)

    def _setup_future(self, page: Any) -> asyncio.Future:
        if page not in self.setups:
            future = asyncio.ensure_future(self._prepare(page))
            # A page that closes while it is set up fails here; whoever awaits it sees that, nobody else must.
            future.add_done_callback(lambda done: done.cancelled() or done.exception())
            self.setups[page] = future
        return self.setups[page]

    async def _setup(self, page: Any) -> None:
        await self._setup_future(page)

    async def _prepare(self, page: Any) -> None:
        state = self._pages.get(page) or self._active_state()
        self._pages[page] = state
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
        state.setups.pop(page, None)
        if state.current is page:
            state.current = state.tabs[-1] if state.tabs else None

    async def _on_dialog(self, dialog: Any) -> None:
        kind = dialog.type
        accept = kind in ("alert", "beforeunload")
        try:
            await (dialog.accept() if accept else dialog.dismiss())
        except PlaywrightError:
            return
        self.notes.append(f"A {kind} dialog was {'accepted' if accept else 'dismissed'}: {self._said(dialog.message, 200)}.")

    async def _on_download(self, download: Any) -> None:
        name = _sessions.safe_basename(self.hidden.text(download.suggested_filename or "download"))[:120] or "download"
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
            self.notes.append(f"A download could not be saved ({self._error_text(error, 120)}).")
            return
        self.notes.append(f"Downloaded {target}.")
        step = self._record("download", target.name, getattr(self.current, "url", None))
        await self._finish_step(step, None)

    async def _page(self) -> Any:
        if self.current is None or self.current.is_closed():
            open_tabs = [tab for tab in self.tabs if not tab.is_closed()]
            if open_tabs:
                self.current = open_tabs[-1]
            else:
                self._check_memory()
                page = await self.context.new_page()
                self._pages[page] = self._active_state()
                await self._setup(page)
                self.current = page
        await self._setup(self.current)
        return self.current

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
        if "invisible" in url:
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
                "truncated": meta["truncated"], "items": items, "captcha": captcha, "notes": notes,
                "tabs": len(tabs), "tab": (tabs.index(page) + 1) if page in tabs else 1}

    async def _captcha_forms(self, page: Any) -> List[str]:
        """CAPTCHA or bot-check widgets and forms in the page's own document."""
        try:
            return [str(kind) for kind in await page.main_frame.evaluate(_dom.CAPTCHA, _dom.CAPTCHA_SELECTORS)]
        except PlaywrightError:
            return []

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
        in_captcha = item.get("captcha") is True
        if not in_captcha:
            try:
                in_captcha = await element.evaluate(_dom.IN_CAPTCHA, _dom.CAPTCHA_CONTAINERS)
            except PlaywrightError:
                in_captcha = False
        if in_captcha:
            raise HostError("captcha_requires_user",
                            "This element belongs to a CAPTCHA or bot check. Do not try to solve or get around it; stop and tell the user.")
        return frame, element, item

    # Steps and sessions ----------------------------------------------------------------------------------------

    def _reset_steps(self) -> None:
        self.steps, self.step_count = [], 0

    def _record(self, action: str, target: Optional[str], url: Optional[str]) -> Dict[str, Any]:
        """One step of the turn's list (kept in memory only), with the page's address and no query."""
        self.step_count += 1
        step = {"n": self.step_count, "action": action, "target": self.hidden.text(target) if target else target,
                "url": _format.page_address(self.hidden.text(url) if url else url), "at": _now(),
                "agent": self._active_state().name or None}
        self.steps.append(step)
        del self.steps[:-MAX_STEPS]
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
                self._selected_agent_id = state.agent_id
                await self.live.serve(reader, writer, args)
                return
            op = request["op"]
            if op not in CONTROL_FREE_OPS and op != "release":
                await self._acquire_slot(state)
            if op == "close":
                async with self.browser_lock:
                    response = {"ok": True, "result": await self.dispatch(op, request.get("args", {}))}
            elif op == "release":
                response = {"ok": True, "result": await self.dispatch(op, request.get("args", {}))}
            else:
                # One agent's actions are ordered, while other agents use their
                # own lock and can drive their own tabs concurrently.
                async with self.live.agent_action(self.lock, control_free=op in CONTROL_FREE_OPS or op == "release"):
                    self.last_used = time.monotonic()
                    note = None if op in CONTROL_FREE_OPS or op == "release" else self.live.take_note()
                    if note:
                        raise HostError("user_returned_control", note + " " + USER_RETURNED)
                    if op == "save_session":
                        async with self.browser_lock:
                            response = {"ok": True, "result": await self.dispatch(op, request.get("args", {}))}
                    else:
                        response = {"ok": True, "result": await self.dispatch(op, request.get("args", {}))}
                    self.last_used = time.monotonic()
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
            await self.stop()

    async def dispatch(self, op: str, args: Dict[str, Any]) -> Dict[str, Any]:
        if self.crashed:
            raise HostError("browser_crashed", "The browser stopped unexpectedly; the next command starts a new one with the saved sessions.")
        handler = getattr(self, "op_" + op, None) if re.fullmatch(r"[a-z_]{1,24}", op) else None
        if handler is None:
            raise HostError("unknown_operation", f"Unknown browser operation {_format.quoted(op, 40)}.")
        timeout = 75.0 if op in ("open", "wait", "back", "forward", "reload", "new_tab") else 45.0
        if op == "wait":
            timeout = _int(args, "timeout", 15, 1, 120) + 15.0
        try:
            return await asyncio.wait_for(handler(args), timeout)
        except asyncio.TimeoutError:
            raise HostError("timeout", f"The browser did not finish `{op}` within {int(timeout)} seconds.") from None
        except PlaywrightError as error:
            if self.crashed:
                raise HostError("browser_crashed", "The browser stopped unexpectedly; the next command starts a new one.") from None
            raise HostError("browser_error", self._error_text(error)) from None

    async def _act(self, action: str, target: Optional[str], run: Any, *, settle: bool = True, info: bool = True) -> Dict[str, Any]:
        """Run one agent action, record its step, keep sessions current and summarize the page."""
        page = await self._page()
        step = self._record(action, target, page.url)
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
        await self._autosave()
        result: Dict[str, Any] = {"step": step}
        if info:
            summary = await self._snapshot(page)
            result.update({"info": summary, "text": _format.render_info(summary)})
        return result

    # Operations ------------------------------------------------------------------------------------------------

    async def op_status(self, args: Dict[str, Any]) -> Dict[str, Any]:
        page = await self._page()
        markers = None
        if args.get("markers"):
            markers = self.hidden.mask(await page.evaluate(_dom.MARKERS))
        data = {"version": self.version, "pinned": _pinned_chromium(), "locale": self.locale, "timezone": self.timezone,
                "userAgentHeadless": "Headless" in self.user_agent, "tabs": len([t for t in self.tabs if not t.is_closed()]),
                "otherAgentTabs": sum(len([tab for tab in state.tabs if not tab.is_closed()]) for state in self._states.values()
                                       if state is not self._active_state()),
                "agent": self._active_state().agent_id, "sessions": sorted(self.store.tracked),
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
        status: Dict[str, Any] = {}

        async def run(page: Any) -> None:
            try:
                response = await page.goto(url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)
            except PlaywrightTimeoutError:
                raise HostError("navigation_timeout", "The page did not start loading within 45 seconds.") from None
            except PlaywrightError as error:
                raise HostError("navigation_failed", self._error_text(error)) from None
            status["code"] = response.status if response else None

        result = await self._act("open", None, run)
        if status.get("code") and status["code"] >= 400:
            result["text"] = f"HTTP status {status['code']}.\n" + result["text"]
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

        async def run(_: Any) -> None:
            try:
                await element.click(timeout=ACTION_TIMEOUT_MS)
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

        async def run(page: Any) -> None:
            try:
                if replace and fillable:
                    await element.fill(text, timeout=ACTION_TIMEOUT_MS)
                else:
                    await element.click(timeout=ACTION_TIMEOUT_MS)
                    if fillable:
                        await element.press("End", timeout=ACTION_TIMEOUT_MS)
                    await page.keyboard.type(text)
                if submit:
                    await element.press("Enter", timeout=ACTION_TIMEOUT_MS)
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

        async def run(_: Any) -> None:
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
            await page.keyboard.press(key)

        return await self._act("press", key, run)

    async def op_scroll(self, args: Dict[str, Any]) -> Dict[str, Any]:
        number = args.get("n")
        if number is not None:
            element, item = await self._element(_int(args, "n", None, 1, 100_000))

            async def to_element(_: Any) -> None:
                await element.scroll_into_view_if_needed(timeout=ACTION_TIMEOUT_MS)

            return await self._act("scroll", f"to {_format.element_label(item)}", to_element, settle=False)
        direction = args.get("direction", "down")
        if direction not in ("down", "up", "top", "bottom"):
            raise HostError("invalid_arguments", "Scroll down, up, top or bottom, or to an element number.")

        async def run(page: Any) -> None:
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
        async def run(page: Any) -> None:
            await page.reload(wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)

        return await self._act("reload", None, run)

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
        """Read page data with a script. Not while the page shows a CAPTCHA or bot check (same detection as clicks)."""
        expression = _text(args, "expression", 20_000)
        page = await self._page()
        kinds = await self._captcha_in_page(page)
        if kinds:
            raise HostError("captcha_requires_user", f"This page shows a CAPTCHA or bot check ({', '.join(kinds)}). "
                            "Do not run scripts on it or try to get around it; stop and tell the user.")
        try:
            value = self.hidden.mask(await page.evaluate(expression))
        except PlaywrightError as error:
            raise HostError("script_error", self._error_text(error)) from None
        text = json.dumps(value, ensure_ascii=False, default=str)
        return {"text": text if len(text) <= JS_MAX_CHARS else text[:JS_MAX_CHARS] + f"… ({len(text) - JS_MAX_CHARS} more characters)"}

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
            self.shots_dir.mkdir(parents=True, exist_ok=True)
            existing = sorted(self.shots_dir.glob("shot-*.png"))
            self.shot_count = max([self.shot_count] + [int(entry.stem[5:]) for entry in existing if entry.stem[5:].isdigit()]) + 1
            path = self.shots_dir / f"shot-{self.shot_count:04d}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        if element is not None:
            await element.screenshot(path=str(path), timeout=ACTION_TIMEOUT_MS)
        else:
            await page.screenshot(path=str(path), full_page=full, timeout=30_000)
        if not given:
            for old in sorted(self.shots_dir.glob("shot-*.png"))[:-KEEP_SHOTS]:
                try:
                    old.unlink()
                except OSError:
                    pass
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
        page = await self.context.new_page()
        self._pages[page] = state
        await self._setup(page)
        self.current = page

        async def run(current: Any) -> None:
            if url:
                await current.goto(url, wait_until="domcontentloaded", timeout=NAVIGATION_TIMEOUT_MS)

        return await self._act("new_tab", None, run, settle=url is not None)

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

    async def save_site_session(self) -> Optional[str]:
        """After the user finished a handoff: the current site's sign-in, kept current from now on (`op_save_session`).

        The site's name, or None when the tab shows no site or the save failed; the previous version then stays.
        """
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
            expired = [state.agent_id for state in host._states.values()
                       if state.slot and state.agent_id != MAIN_AGENT_ID and time.monotonic() - state.last_used > AGENT_IDLE_SECONDS]
            for agent_id in expired:
                await host.release_agent(agent_id)
            # A browser the user watches or holds is in use.
            if not any(state.lock.locked() for state in host._states.values()) and not host.live.busy() and \
                    time.monotonic() - max((state.last_used for state in host._states.values()), default=time.monotonic()) > IDLE_SECONDS:
                await host.stop()

    watcher = asyncio.ensure_future(idle())
    await host.stopped.wait()
    watcher.cancel()
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
