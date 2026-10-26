"""Text the agent and the user read: page summaries and the step log lines.

A step line is one stable line per browser action. The agent reads it, and
the answer's Workspace activity shows it as "what the agent did"
(`features/run-lifecycle-v2/workspaceActivityPresentation.ts` parses exactly
this shape, so change both together):

    [browser #3] click: button "Add to cart" @ www.saucedemo.com/inventory.html

Typed text never appears in a step line, except in a search box; a URL shows
only its host and path.
"""

from __future__ import annotations

import re
from typing import Any, List, Mapping, Optional, Sequence
from urllib.parse import urlsplit

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
    return body + suffix


def render_tabs(tabs: Sequence[Mapping[str, Any]]) -> str:
    if not tabs:
        return "No open tabs."
    return "\n".join(f"{'*' if tab.get('current') else ' '} tab {int(tab['index'])}: "
                     f"{clean(tab.get('title'), 80) or '(no title)'} — {where(tab.get('url')) or clean(tab.get('url'), 80)}"
                     for tab in tabs)


def render_steps(steps: Sequence[Mapping[str, Any]]) -> str:
    return "\n".join(step_line(step) for step in steps) if steps else "No browser steps yet."
