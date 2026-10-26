"""Text the agent and the user read: page summaries and the step log lines.

A step line is one stable line per browser action. The agent reads it, and
the answer's Workspace activity shows it as "what the agent did"
(`features/run-lifecycle-v2/workspaceActivityPresentation.ts` parses exactly
this shape, so change both together):

    [browser #3] click: button "Add to cart" @ www.saucedemo.com/inventory.html

Typed text never appears in a step line, except in a search box, and a value
typed from the environment appears nowhere (`HiddenValues`); a URL shows only
its host and path. Only an action prints a step line at the start of a line:
page text that looks like one is indented, and so is the turn's step list.
"""

from __future__ import annotations

import html
import html.entities
import re
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import quote, quote_plus, urlsplit, urlunsplit

STEP_PREFIX = "[browser #"
#: Characters of one element name, value or link shown to the agent.
NAME_CHARS = 100
VALUE_CHARS = 60
LINK_CHARS = 80
WHERE_CHARS = 100
#: Total characters of one page summary.
INFO_CHARS = 16_000

_CONTROL = re.compile(r"[\x00-\x1f\x7f  ]+")
_SPACE = re.compile(r"\s+")
#: A line of page text that would read as an action's step line.
_STEP_LIKE = re.compile(r"^(?=\[browser #)", re.M)


def clean(value: Any, limit: int) -> str:
    text = _SPACE.sub(" ", _CONTROL.sub(" ", str(value if value is not None else ""))).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def quoted(value: Any, limit: int = NAME_CHARS) -> str:
    return '"' + clean(value, limit).replace('"', "'") + '"'


def where(url: Optional[str]) -> Optional[str]:
    """Host and path of a page, without query or fragment, which may carry tokens."""
    if not url:
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return clean(parts.scheme + ":", WHERE_CHARS) if parts.scheme else None
    host = parts.hostname + (f":{parts.port}" if parts.port else "")
    return clean(host + (parts.path or "/"), WHERE_CHARS).replace(" ", "%20")


def page_address(url: Optional[str]) -> Optional[str]:
    """A step's page: scheme, host and path. Query, fragment and user info may carry credentials."""
    if not url:
        return None
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return parts.scheme + ":" if parts.scheme else None
    return f"{parts.scheme}://{parts.hostname}{f':{port}' if port else ''}{parts.path or '/'}"


def without_userinfo(url: Any) -> Any:
    """A page address as the agent reads it, without a user name or password in it."""
    if not isinstance(url, str) or "@" not in url:
        return url
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if "@" not in parts.netloc:
        return url
    return urlunsplit(parts._replace(netloc=parts.netloc.rsplit("@", 1)[1]))


def _html_names() -> Dict[str, List[str]]:
    names: Dict[str, List[str]] = {}
    for name, text in html.entities.html5.items():
        if len(text) == 1:
            names.setdefault(text, []).append(name)
    return names


#: Every HTML5 entity name of one character (`/` is `&sol;`, `"` is `&quot;` or `&QUOT;`).
_HTML_NAMES = _html_names()
_JSON_SHORT = {'"': '\\"', "\\": "\\\\", "/": "\\/", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _hex(digits: str) -> str:
    """Hex digits in either case."""
    return "".join(f"[{digit.lower()}{digit.upper()}]" if digit.isalpha() else digit for digit in digits)


def _spellings(char: str) -> Tuple[str, int]:
    """A pattern for one character in any spelling a page or URL may use, and its longest match."""
    code = ord(char)
    options = [(re.escape(char), 1)]
    if char == " ":
        options.append((r"\+", 1))
    encoded = char.encode("utf-8")
    options.append(("".join("%" + _hex(f"{byte:02x}") for byte in encoded), 3 * len(encoded)))
    if code > 0xFFFF:
        high, low = 0xD800 + ((code - 0x10000) >> 10), 0xDC00 + ((code - 0x10000) & 0x3FF)
        options.append((r"\\u" + _hex(f"{high:04x}") + r"\\u" + _hex(f"{low:04x}"), 12))
    else:
        options.append((r"\\u" + _hex(f"{code:04x}"), 6))
    if char in _JSON_SHORT:
        options.append((re.escape(_JSON_SHORT[char]), 2))
    options.append((f"&#0{{0,8}}{code};", 3 + 8 + len(str(code))))
    options.append((f"&#[xX]0{{0,8}}{_hex(f'{code:x}')};", 4 + 8 + len(f"{code:x}")))
    for name in _HTML_NAMES.get(char, []):
        options.append(("&" + re.escape(name), 1 + len(name)))
    options.sort(key=lambda option: -len(option[0]))
    return "(?:" + "|".join(pattern for pattern, _ in options) + ")", max(reach for _, reach in options)


class HiddenValues:
    """Values typed from the environment in this turn: no answer of the browser carries them.

    The field such a value went into reads as a hidden value; this catches the value where the page
    or an address repeats it, in any mix of the spellings per character: as is, percent-encoded in
    either hex case (a space also as `+`), JSON-escaped (`\\uXXXX`, `\\/`) or as an HTML entity, named or
    numeric. Callers mask raw page data before they normalize whitespace, replace quotes or cut it
    (`page_string`, `page_items`, `page_text`); answers are masked once more as a whole. Best effort
    (operator-accepted residual): a page that changes the value (case, partial echoes) is not caught.
    Values shorter than `MIN_CHARS` are not searched for: masking every such string would garble pages.
    """

    MIN_CHARS = 4
    MASK = "[hidden]"
    #: Longer values are matched in their plain and percent-encoded spellings only.
    PATTERN_CHARS = 512

    def __init__(self) -> None:
        self.patterns: List[Tuple[int, Any]] = []
        #: The most characters one hidden value can span in any spelling.
        self.reach = 0

    def add(self, value: str) -> None:
        # Browsers collapse and strip whitespace (`document.title`, `innerText`): the value's own runs of
        # whitespace match any run, and its edges are not needed to find it.
        core = value.strip()
        if len(core) < self.MIN_CHARS or any(len(core) == size and pattern.fullmatch(core) for size, pattern in self.patterns):
            return
        if len(core) <= self.PATTERN_CHARS:
            parts = []
            for run in re.findall(r"\s+|\S", core):
                if run.isspace():
                    spellings = [_spellings(char) for char in sorted(set(run) | {" ", "\u00a0"})]
                    parts.append(("(?:\\s|" + "|".join(part for part, _ in spellings) + ")+", max(size for _, size in spellings) * len(run)))
                else:
                    parts.append(_spellings(run))
            pattern = re.compile("".join(part for part, _ in parts))
            reach = sum(size for _, size in parts)
        else:
            forms = sorted({core, quote(core, safe=""), quote(core, safe="").lower(), quote_plus(core)}, key=len, reverse=True)
            pattern = re.compile("|".join(re.escape(form) for form in forms))
            reach = max(len(form) for form in forms)
        self.patterns.append((len(core), pattern))
        self.patterns.sort(key=lambda entry: -entry[0])
        self.reach = max(self.reach, reach)

    def text(self, value: str) -> str:
        for _, pattern in self.patterns:
            value = pattern.sub(self.MASK, value)
        return value

    def raw(self, value: str, truncated: bool = False) -> str:
        """Raw page data cut by the page script: its tail may hold part of a value, so that goes first."""
        if truncated and self.patterns:
            value = value[:max(0, len(value) - self.reach)]
        return self.text(value)

    def mask(self, value: Any) -> Any:
        if not self.patterns:
            return value
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, dict):
            return {key: self.mask(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.mask(item) for item in value]
        return value


#: Characters of a page-provided string the page script hands over: masking runs on them, display cuts follow.
RAW_CHARS = 2000
#: Characters of a name, value or link kept in an element list.
ITEM_CHARS = 200


def page_string(raw: Any, hidden: HiddenValues, limit: int, truncated: bool = False) -> str:
    """A string from the page as the agent reads it: masked raw, then one line, then cut."""
    return clean(hidden.raw(str(raw if raw is not None else ""), truncated), limit)


def page_items(items: List[Dict[str, Any]], hidden: HiddenValues) -> List[Dict[str, Any]]:
    """The element list's names, values and links, masked raw before they become one bounded line."""
    for item in items:
        cut = set(item.pop("cut", None) or [])
        for key in ("name", "value", "href"):
            if item.get(key) is not None:
                item[key] = page_string(item[key], hidden, ITEM_CHARS, key in cut)
    return items


def page_text(raw: str, hidden: HiddenValues, start: int, limit: int) -> Tuple[str, int]:
    """Visible text as `text` shows it: masked first, then whitespace-normalized, then paged."""
    text = re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t\u00a0]+", " ", hidden.text(raw or ""))).strip()
    return render_text(text, start, limit), len(text)


def step_line(step: Mapping[str, Any]) -> str:
    line = f"{STEP_PREFIX}{int(step['n'])}] {step['action']}"
    if step.get("target"):
        line += ": " + clean(step["target"], 160)
    place = where(step.get("url"))
    if place:
        line += " @ " + place
    return line


def element_label(item: Mapping[str, Any]) -> str:
    """`button "Add to cart"`: the role and accessible name the agent and the user recognize."""
    role = clean(item.get("role") or "element", 24)
    name = item.get("name") or ""
    return f"{role} {quoted(name)}" if name else role


def _states(item: Mapping[str, Any]) -> List[str]:
    states = []
    if item.get("secret"):
        states.append("hidden value, filled" if item.get("filled") else "hidden value, empty")
    if item.get("checked") is True:
        states.append("checked")
    elif item.get("checked") is False:
        states.append("not checked")
    elif item.get("checked") == "mixed":
        states.append("partly checked")
    if item.get("expanded") is True:
        states.append("expanded")
    elif item.get("expanded") is False:
        states.append("collapsed")
    if item.get("selected"):
        states.append("selected")
    if item.get("disabled"):
        states.append("disabled")
    if item.get("required"):
        states.append("required")
    if isinstance(item.get("files"), int):
        states.append(f"{item['files']} file(s) chosen")
    if item.get("frame"):
        states.append("in a frame")
    return states


def item_line(item: Mapping[str, Any]) -> str:
    line = f"[{int(item['n'])}] {element_label(item)}"
    if not item.get("secret") and item.get("value") not in (None, ""):
        line += " = " + quoted(item["value"], VALUE_CHARS)
    states = _states(item)
    if states:
        line += " (" + ", ".join(states) + ")"
    if item.get("href"):
        line += " → " + clean(item["href"], LINK_CHARS)
    return line


def _bounded(lines: List[str], budget: int = INFO_CHARS) -> str:
    out: List[str] = []
    used = 0
    for index, line in enumerate(lines):
        if used + len(line) + 1 > budget:
            out.append(f"… {len(lines) - index} more lines not shown (output limit).")
            break
        out.append(line)
        used += len(line) + 1
    return "\n".join(out)


def render_info(info: Mapping[str, Any], *, every: bool = False, limit: int = 80) -> str:
    """The page summary: where the page is, warnings, and the numbered elements on screen (or all)."""
    lines = [f"URL: {clean(info.get('url'), 2000)}", f"Title: {clean(info.get('title'), 200) or '(none)'}"]
    tabs = int(info.get("tabs") or 1)
    if tabs > 1:
        lines.append(f"Tabs: {tabs}, this is tab {int(info.get('tab') or 1)} (see `tabs`).")
    scroll = info.get("scroll") or {}
    height, viewport = int(scroll.get("height") or 0), scroll.get("viewport") or [0, 0]
    if height > int(viewport[1] or 0) > 0:
        top = int(scroll.get("y") or 0)
        lines.append(f"Scroll: {round(100 * top / max(1, height - int(viewport[1])))}% of a {height}px page "
                     f"(viewport {int(viewport[0])}x{int(viewport[1])}).")
    for note in info.get("notes") or []:
        lines.append(clean(note, 400))
    captcha = info.get("captcha") or []
    if captcha:
        lines.append("Warning: this page shows a CAPTCHA or bot check (" + ", ".join(clean(kind, 40) for kind in captcha) +
                     "). Do not try to solve or get around it; stop and tell the user.")
    items: Sequence[Mapping[str, Any]] = info.get("items") or []
    shown = [item for item in items if every or item.get("inView")]
    above = sum(1 for item in items if item.get("position") == "above")
    below = sum(1 for item in items if item.get("position") == "below")
    if not items:
        lines.append("No interactive elements found." + (" The page may still be loading; try `wait` or `info` again."
                                                          if info.get("loading") else ""))
    else:
        scope = "All elements" if every else "On screen"
        extra = [] if every else [part for part in (f"{above} above" if above else "", f"{below} below" if below else "") if part]
        lines.append(f"{scope} ({min(len(shown), limit)} of {len(items)} elements"
                     + (f"; {', '.join(extra)}" if extra else "") + "):")
        lines.extend(item_line(item) for item in shown[:limit])
        if len(shown) > limit:
            lines.append(f"… {len(shown) - limit} more not listed; use `find TEXT` or `info --all`.")
        elif not every and (above or below):
            lines.append("Scroll, `find TEXT` or `info --all` for the rest; clicking an element scrolls to it.")
    if info.get("truncated"):
        lines.append("Only the first elements of a very large page were numbered.")
    return _bounded(lines)


def render_find(query: str, items: Sequence[Mapping[str, Any]], limit: int = 30) -> str:
    needle = query.casefold()
    found = [item for item in items
             if needle in str(item.get("name") or "").casefold() or
             (not item.get("secret") and needle in str(item.get("value") or "").casefold()) or
             needle in str(item.get("href") or "").casefold()]
    if not found:
        return f"No element matches {quoted(query)}. Try other words, `text` or `info --all`."
    lines = [f"Elements matching {quoted(query)} ({min(len(found), limit)} of {len(found)}):"]
    lines.extend(item_line(item) for item in found[:limit])
    return _bounded(lines)


def render_text(text: str, start: int, limit: int) -> str:
    body = text[start:start + limit]
    rest = len(text) - start - len(body)
    suffix = f"\n… {rest} more characters; continue with start={start + len(body)}." if rest > 0 else ""
    return _STEP_LIKE.sub(" ", body) + suffix


def render_tabs(tabs: Sequence[Mapping[str, Any]]) -> str:
    if not tabs:
        return "No open tabs."
    return "\n".join(f"{'*' if tab.get('current') else ' '} tab {int(tab['index'])}: "
                     f"{clean(tab.get('title'), 80) or '(no title)'} — {where(tab.get('url')) or clean(tab.get('url'), 80)}"
                     for tab in tabs)


def render_steps(steps: Sequence[Mapping[str, Any]]) -> str:
    """The turn's steps so far, indented: listing them again is not doing them again."""
    if not steps:
        return "No browser steps yet."
    return "Browser steps of this turn:\n" + "\n".join("  " + step_line(step) for step in steps)
