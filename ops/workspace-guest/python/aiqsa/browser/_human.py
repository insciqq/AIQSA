"""Human-like input for the agent's own browser actions.

The AIQSA browser is a person's AI-assisted browser, not a bot (operator decision 2026-11-20), so the agent's
clicks, typing and scrolling reach a page the way a person's do: the pointer travels a slightly curved path with
a minimum-jerk velocity profile, sometimes passes a far target and comes back, rests a moment and holds the
button for a human time; keys come one by one at an uneven pace, a long text is pasted; the wheel turns in
notches. Behavioural checks (reCAPTCHA scores, Turnstile, Cloudflare) read instant input as a bot.

One behaviour profile per chat: its seed is kept beside the chat's screenshots (`PROFILE_FILE`), so a site meets
the same motor habits on every visit of that chat, and two chats differ. Each action still varies within the
profile. The live view's input (`_livehub.py`) is the user's own and never passes through here.

Standard library only: the drivers take Playwright's `page.mouse` and `page.keyboard`, or any object with the
same coroutines, and an injectable `sleep`, so tests drive them with fakes and no browser.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import random
import secrets
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Tuple

Point = Tuple[float, float]
Sleep = Callable[[float], Awaitable[None]]

PROFILE_FILE = "input-profile.json"
#: Longer texts, and any with a line break or tab, are pasted rather than typed key by key: a person pastes a
#: paragraph, and a typed Enter would submit a single-line field.
TYPE_KEYS_MAX = 48
#: How far the wheel scrolls towards an element before a person would rather jump (in viewport heights).
WHEEL_REACH_VIEWPORTS = 4.0
EDGE = 2.0

#: How a click at fractions (fx, fy) of element `el`'s box lands, read in the element's own document: `ok` when
#: the element (or its label) is what the point hits, `covered` when something else is on top, `outside` when
#: the point is off its document's viewport, `disabled` or `hidden` when no click would do anything.
AIM = r"""
(el, [fx, fy]) => {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return 'hidden';
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return 'disabled';
  const x = r.left + r.width * fx, y = r.top + r.height * fy;
  const root = el.getRootNode();
  const scope = root && typeof root.elementFromPoint === 'function' ? root : el.ownerDocument;
  const hit = scope.elementFromPoint(x, y);
  if (!hit) return 'outside';
  if (hit === el || el.contains(hit)) return 'ok';
  const labels = el.labels ? Array.from(el.labels) : [];
  return labels.some((label) => label === hit || label.contains(hit)) ? 'ok' : 'covered';
}
"""

#: What a point (x, y) of the element's own document hits: `ok` when it is the element, inside it or its label (for a
#: frame's element: the frame itself), `covered` when something else is on top there, `outside` off that document's
#: viewport, `detached` once the element left the page. The host checks each document from the element up to the
#: top page (`Host._hit`), since a frame cannot see what covers it in its parent.
HIT_AT = r"""
(el, [x, y]) => {
  if (!el.isConnected) return 'detached';
  const root = el.getRootNode();
  const scope = root && typeof root.elementFromPoint === 'function' ? root : el.ownerDocument;
  const hit = scope.elementFromPoint(x, y);
  if (!hit) return 'outside';
  if (hit === el || el.contains(hit)) return 'ok';
  const labels = el.labels ? Array.from(el.labels) : [];
  return labels.some((label) => label === hit || label.contains(hit)) ? 'ok' : 'covered';
}
"""

#: The element's top-left corner in its own document's viewport.
RECT = "(el) => { const r = el.getBoundingClientRect(); return [r.left, r.top]; }"

#: The field's text as it stands (read inside the host only, never answered).
VALUE = "(el) => String((el.value !== undefined ? el.value : el.textContent) || '')"

#: The element has the keyboard focus (through open shadow roots).
FOCUSED = r"""
(el) => {
  let active = el.ownerDocument.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  return !!active && (active === el || el.contains(active));
}
"""

#: The field holds any text.
HAS_VALUE = r"""
(el) => String((el.value !== undefined ? el.value : el.textContent) || '').length > 0
"""

#: Whether a wheel turned at the point would scroll the page rather than zoom a map or play with an embed.
WHEEL_SAFE = r"""
([x, y]) => {
  const el = document.elementFromPoint(x, y);
  return !el || !el.closest('iframe, canvas, embed, object, video, select, [role="application"]');
}
"""

VIEWPORT = "() => [window.innerWidth, window.innerHeight]"
SCROLL_TOP = "() => Math.round((document.scrollingElement || document.documentElement).scrollTop)"


class Profile:
    """One chat's motor habits, all drawn from its seed."""

    def __init__(self, seed: int) -> None:
        rng = random.Random(seed)
        self.seed = seed
        #: Multiplies the time a pointer move takes.
        self.pace = rng.uniform(0.85, 1.2)
        #: How far a path bows, as a share of its length.
        self.bend = rng.uniform(0.08, 0.22)
        #: Chance that a long move passes its target and comes back.
        self.overshoot = rng.uniform(0.2, 0.45)
        #: Spread of the click point around an element's centre, as a share of its size.
        self.aim = rng.uniform(0.1, 0.17)
        #: Rest on the target before pressing, and how long the button stays down (ms ranges).
        self.settle_ms = (rng.uniform(40, 80), rng.uniform(110, 190))
        self.hold_ms = (rng.uniform(45, 70), rng.uniform(85, 130))
        #: Mean gap between keys (ms) and its relative spread; how long a key stays down.
        self.key_ms = rng.uniform(60, 100)
        self.key_spread = rng.uniform(0.25, 0.45)
        self.key_hold_ms = (rng.uniform(25, 45), rng.uniform(60, 95))
        #: One wheel notch (px) and the gap between notches of one flick (ms range).
        self.tick_px = rng.choice((100.0, 100.0, 120.0))
        self.tick_ms = (rng.uniform(18, 35), rng.uniform(55, 90))


def load_profile(directory: Path) -> Profile:
    """The chat's profile from its seed file, written once with a fresh seed when missing or unreadable."""
    path = directory / PROFILE_FILE
    try:
        seed = json.loads(path.read_text("utf-8"))["seed"]
        if isinstance(seed, int) and not isinstance(seed, bool) and 0 <= seed < 2 ** 63:
            return Profile(seed)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    seed = secrets.randbits(63)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{PROFILE_FILE}.{os.getpid()}")
        temporary.write_text(json.dumps({"seed": seed}), "utf-8")
        os.replace(temporary, path)
    except OSError:
        pass  # A read-only disk keeps the profile for this browser only.
    return Profile(seed)


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _inside(point: Point, bounds: Optional[Point]) -> Point:
    if not bounds:
        return point
    return _clamp(point[0], EDGE, max(EDGE, bounds[0] - EDGE)), _clamp(point[1], EDGE, max(EDGE, bounds[1] - EDGE))


def _segment(start: Point, end: Point, duration_ms: float, steps: int, bend: float, rng: random.Random,
             bounds: Optional[Point]) -> List[Tuple[float, float, float]]:
    distance = math.hypot(end[0] - start[0], end[1] - start[1])
    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    normal = (math.cos(angle + math.pi / 2), math.sin(angle + math.pi / 2))
    bow = rng.uniform(-1.0, 1.0) * min(140.0, bend * distance)
    first, second = rng.uniform(0.2, 0.4), rng.uniform(0.6, 0.85)
    c1 = (start[0] + (end[0] - start[0]) * first + normal[0] * bow, start[1] + (end[1] - start[1]) * first + normal[1] * bow)
    c2 = (start[0] + (end[0] - start[0]) * second + normal[0] * bow * 0.4,
          start[1] + (end[1] - start[1]) * second + normal[1] * bow * 0.4)
    pause = duration_ms / steps
    points: List[Tuple[float, float, float]] = []
    for index in range(1, steps + 1):
        t = index / steps
        s = 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5  # minimum jerk: slow start, fast middle, slow arrival
        u = 1 - s
        x = u ** 3 * start[0] + 3 * u * u * s * c1[0] + 3 * u * s * s * c2[0] + s ** 3 * end[0]
        y = u ** 3 * start[1] + 3 * u * u * s * c1[1] + 3 * u * s * s * c2[1] + s ** 3 * end[1]
        if index < steps:
            x += rng.uniform(-0.6, 0.6)
            y += rng.uniform(-0.6, 0.6)
        else:
            x, y = end
        x, y = _inside((x, y), bounds)
        points.append((x, y, pause * rng.uniform(0.8, 1.2)))
    return points


def plan_move(start: Point, end: Point, profile: Profile, rng: random.Random, *, width: float = 24.0,
              bounds: Optional[Point] = None, drag: bool = False) -> List[Tuple[float, float, float]]:
    """The points of one pointer move, each with the pause after it (ms); the last point is `end` exactly.

    Its time follows Fitts's law (farther and smaller takes longer), bounded to stay small; a drag is slower and
    straighter, as a hand holding a button is.
    """
    end = _inside(end, bounds)
    distance = math.hypot(end[0] - start[0], end[1] - start[1])
    if distance < 1:
        return [(end[0], end[1], 0.0)]
    duration = profile.pace * (80 + 95 * math.log2(1 + distance / max(width, 6.0))) * rng.uniform(0.9, 1.1)
    duration = _clamp(duration * (1.8 if drag else 1.0), 70.0, 1100.0 if drag else 650.0)
    bend = profile.bend * (0.25 if drag else 1.0)
    steps = int(_clamp(distance / 22 + 5, 12 if drag else 5, 40 if drag else 28))
    if distance > 150 and rng.random() < profile.overshoot:
        past = min(rng.uniform(4, 12), distance * 0.06)
        angle = math.atan2(end[1] - start[1], end[0] - start[0]) + rng.uniform(-0.3, 0.3)
        beyond = _inside((end[0] + math.cos(angle) * past, end[1] + math.sin(angle) * past), bounds)
        return (_segment(start, beyond, duration * 0.85, steps, bend, rng, bounds) +
                _segment(beyond, end, rng.uniform(60, 120), rng.randint(3, 5), 0.0, rng, bounds))
    return _segment(start, end, duration, steps, bend, rng, bounds)


def aim(profile: Profile, rng: random.Random) -> Point:
    """Where on an element to click, as fractions of its box: near the centre, never at the edge."""
    return (_clamp(rng.gauss(0.5, profile.aim), 0.25, 0.75), _clamp(rng.gauss(0.5, profile.aim), 0.3, 0.7))


def key_gaps(text: str, profile: Profile, rng: random.Random) -> List[float]:
    """The pause before each character after the first (ms): uneven, longer after a word, now and then a thought."""
    gaps = []
    for index in range(1, len(text)):
        gap = rng.lognormvariate(math.log(profile.key_ms), profile.key_spread)
        if text[index - 1] in " .,;:-_@/" or text[index - 1].isupper() != text[index].isupper():
            gap *= 1.3
        if rng.random() < 0.04:
            gap += rng.uniform(150, 450)
        gaps.append(_clamp(gap, 25.0, 900.0))
    return gaps


def wheel_ticks(distance: float, profile: Profile, rng: random.Random) -> List[Tuple[float, float]]:
    """The notches of one flick covering `distance` px (signed), each with the pause after it (ms)."""
    if abs(distance) < 1:
        return []
    count = int(_clamp(round(abs(distance) / profile.tick_px), 1, 14))
    sizes = [abs(distance) / count * rng.uniform(0.92, 1.08) for _ in range(count)]
    scale = abs(distance) / sum(sizes)
    sign = 1.0 if distance > 0 else -1.0
    ticks = []
    for index, size in enumerate(sizes):
        pause = rng.uniform(*profile.tick_ms)
        if index and index % 5 == 0:
            pause += rng.uniform(80, 200)  # the finger finds the wheel again
        ticks.append((sign * size * scale, pause))
    return ticks


async def _pace(sleep: Sleep, milliseconds: float, spent: float = 0.0) -> None:
    rest = milliseconds / 1000 - spent
    if rest > 0:
        await sleep(rest)


async def move(mouse: Any, start: Point, end: Point, profile: Profile, rng: random.Random, *, width: float = 24.0,
               bounds: Optional[Point] = None, drag: bool = False, sleep: Sleep = asyncio.sleep) -> Point:
    """Move the pointer from `start` to `end` along a planned path; returns where it stopped."""
    last = start
    for x, y, pause in plan_move(start, end, profile, rng, width=width, bounds=bounds, drag=drag):
        began = time.perf_counter()
        await mouse.move(x, y)
        last = (x, y)
        await _pace(sleep, pause, time.perf_counter() - began)
    return last


async def press(mouse: Any, profile: Profile, rng: random.Random, *, hold_ms: Optional[float] = None,
                sleep: Sleep = asyncio.sleep, ready: Optional[Callable[[], Awaitable[None]]] = None) -> None:
    """Rest on the target, then press and release the left button (held `hold_ms` when given). `ready` runs right
    before the button goes down and may refuse the press by raising; a press stopped while held still lets go."""
    await _pace(sleep, rng.uniform(*profile.settle_ms))
    if ready is not None:
        await ready()
    await mouse.down()
    try:
        await _pace(sleep, hold_ms if hold_ms is not None else rng.uniform(*profile.hold_ms))
    finally:
        await mouse.up()


async def key(keyboard: Any, combo: str, profile: Profile, rng: random.Random, *, sleep: Sleep = asyncio.sleep) -> None:
    """Press one key or combination with a human hold, then a short pause."""
    await keyboard.press(combo, delay=rng.uniform(*profile.key_hold_ms))
    await _pace(sleep, rng.uniform(40, 120))


async def type_text(keyboard: Any, text: str, profile: Profile, rng: random.Random, *, sleep: Sleep = asyncio.sleep) -> None:
    """Type `text` key by key at the profile's pace, or paste it when it is long or has a line break or tab."""
    if not text:
        return
    if len(text) > TYPE_KEYS_MAX or any(char in text for char in "\r\n\t"):
        await _pace(sleep, rng.uniform(150, 400))
        await keyboard.insert_text(text)
        return
    gaps = key_gaps(text, profile, rng)
    held = 0.0
    for index, char in enumerate(text):
        if index:
            # A gap runs from one key going down to the next; the previous key's hold is part of it.
            await _pace(sleep, max(10.0, gaps[index - 1] - held))
        if " " <= char <= "~":
            held = rng.uniform(*profile.key_hold_ms)
            await keyboard.down(char)
            try:
                await _pace(sleep, held)
            finally:
                await keyboard.up(char)
        else:
            # No key of the US layout makes it: the character arrives as an input method would send it.
            held = 0.0
            await keyboard.insert_text(char)


async def wheel(mouse: Any, distance: float, profile: Profile, rng: random.Random, *, sleep: Sleep = asyncio.sleep) -> None:
    """Turn the wheel at the pointer by about `distance` px (positive scrolls down)."""
    for delta, pause in wheel_ticks(distance, profile, rng):
        await mouse.wheel(0, delta)
        await _pace(sleep, pause)


class Guarded:
    """A mouse or keyboard whose input stops between two events once `check` raises (the user took the tab). Letting
    go (`up`) always passes, so a button or key the agent holds is never left pressed."""

    def __init__(self, device: Any, check: Callable[[], None]) -> None:
        self._device = device
        self._check = check

    async def move(self, x: float, y: float) -> None:
        self._check()
        await self._device.move(x, y)

    async def down(self, *args: Any, **kwargs: Any) -> None:
        self._check()
        await self._device.down(*args, **kwargs)

    async def up(self, *args: Any, **kwargs: Any) -> None:
        await self._device.up(*args, **kwargs)

    async def wheel(self, dx: float, dy: float) -> None:
        self._check()
        await self._device.wheel(dx, dy)

    async def insert_text(self, text: str) -> None:
        self._check()
        await self._device.insert_text(text)

    async def press(self, key: str, **kwargs: Any) -> None:
        self._check()
        await self._device.press(key, **kwargs)


def guarded_sleep(check: Callable[[], None], sleep: Sleep = asyncio.sleep, slice_seconds: float = 0.1) -> Sleep:
    """A sleep that checks in short slices, so a long hold or wait stops soon after `check` raises."""

    async def pause(seconds: float) -> None:
        loop = asyncio.get_running_loop()
        end = loop.time() + seconds
        while True:
            check()
            rest = end - loop.time()
            if rest <= 0:
                return
            await sleep(min(rest, slice_seconds))

    return pause


class Input:
    """The chat's profile, loaded on first use, and where the pointer is on each page."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.rng = random.Random()
        self._profile: Optional[Profile] = None
        self._pointers: Dict[Any, Point] = {}

    @property
    def profile(self) -> Profile:
        if self._profile is None:
            self._profile = load_profile(self.directory)
        return self._profile

    def aim(self) -> Point:
        return aim(self.profile, self.rng)

    def where(self, page: Any) -> Optional[Point]:
        return self._pointers.get(page)

    def resting_point(self, bounds: Point) -> Point:
        """Somewhere a pointer rests on a page before its first move: inside, away from the edges."""
        return (self.rng.uniform(0.25, 0.75) * bounds[0], self.rng.uniform(0.3, 0.7) * bounds[1])

    def moved(self, page: Any, point: Optional[Point]) -> None:
        if point is None:
            self._pointers.pop(page, None)
        else:
            self._pointers[page] = point
        if len(self._pointers) > 16:
            for known in [known for known in self._pointers if getattr(known, "is_closed", lambda: False)()]:
                del self._pointers[known]


def within(point: Point, boxes: Sequence[Dict[str, float]]) -> bool:
    """Whether a viewport point falls inside any of the boxes (`x`, `y`, `width`, `height`)."""
    return any(box["x"] <= point[0] <= box["x"] + box["width"] and box["y"] <= point[1] <= box["y"] + box["height"]
               for box in boxes)
