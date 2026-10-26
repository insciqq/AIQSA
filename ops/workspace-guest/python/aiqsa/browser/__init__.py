"""Drive the Workspace browser from Python. Standard library only; Playwright runs in the browser host.

    from aiqsa import browser as b
    print(b.open("https://www.saucedemo.com"))   # the page: URL, title, numbered elements on screen
    b.type(1, os.environ["SHOP_LOGIN"])          # act by element number; each action prints one step line
    b.type(2, os.environ["SHOP_PASSWORD"], submit=True)
    print(b.find("Add to cart"))                 # numbered matches anywhere on the page
    path = b.screenshot()                        # look at it with view_workspace_image, else analyze_image
    b.save_session()                             # keep the sign-in for later requests

One full Chromium per turn stays open between your commands: tabs, cookies and
the current page survive, your Python variables do not. An element keeps its
number while it stays on the page. The `aiqsa-browser` command does the same
from a shell. Errors raise `BrowserError` with a stable `code`.
"""

from __future__ import annotations

import builtins
from typing import Any, Dict, List, Optional

from ._client import BrowserError, call
from ._format import step_line

__all__ = ["BrowserError", "Page", "back", "click", "close", "close_tab", "find", "forward", "js", "new_tab", "open",
           "page_info", "press", "reload", "save_session", "screenshot", "scroll", "select", "status", "steps",
           "switch_tab", "tabs", "text", "type", "upload", "wait_for"]


class Page(str):
    """A page summary: prints as text; `url`, `title` and `items` (dicts with `n`, `role`, `name`) for code."""

    url: str
    title: str
    items: List[Dict[str, Any]]

    def __new__(cls, text: str, info: Optional[Dict[str, Any]] = None) -> "Page":
        page = super().__new__(cls, text)
        info = info or {}
        page.url = builtins.str(info.get("url") or "")
        page.title = builtins.str(info.get("title") or "")
        page.items = list(info.get("items") or [])
        return page


def _run(op: str, **args: Any) -> Dict[str, Any]:
    result = call(op, args)
    if result.get("step"):
        print(step_line(result["step"]), flush=True)
    return result


def _page(result: Dict[str, Any]) -> Page:
    return Page(builtins.str(result.get("text") or ""), result.get("info"))


def open(url: str) -> Page:  # noqa: A001 - the helper's verb
    """Open a web address in the current tab."""
    return _page(_run("open", url=url))


def page_info(all: bool = False, limit: Optional[int] = None) -> Page:  # noqa: A002
    """The current page: URL, title and the numbered elements on screen (or all of them)."""
    return _page(call("info", {"all": all, "limit": limit}))


def find(text: str) -> Page:
    """Numbered elements anywhere on the page whose name, value or link contains the text."""
    return _page(call("find", {"text": text}))


def click(n: int) -> Page:
    return _page(_run("click", n=n))


def type(n: int, text: str, submit: bool = False, clear: bool = True) -> Page:  # noqa: A001
    """Type into element n (replacing its value unless clear=False); submit presses Enter afterwards."""
    return _page(_run("type", n=n, text=text, submit=submit, clear=clear))


def select(n: int, option: str) -> Page:
    """Choose an option of list box n by its visible label (or value, or part of the label)."""
    return _page(_run("select", n=n, option=option))


def upload(n: int, path: str) -> Page:
    """Choose a Workspace file for file input n."""
    return _page(_run("upload", n=n, path=path))


def press(key: str) -> Page:
    """Press a key in the page, such as Enter, Escape, Tab, ArrowDown or Control+A."""
    return _page(_run("press", key=key))


def scroll(direction: str = "down", n: Optional[int] = None) -> Page:
    """Scroll down, up, top or bottom, or to element n."""
    return _page(_run("scroll", direction=direction, n=n))


def back() -> Page:
    return _page(_run("back"))


def forward() -> Page:
    return _page(_run("forward"))


def reload() -> Page:
    return _page(_run("reload"))


def wait_for(text: Optional[str] = None, selector: Optional[str] = None, url: Optional[str] = None, timeout: int = 15) -> Page:
    """Wait until the page shows a text, a CSS selector or an address, up to `timeout` seconds."""
    return _page(_run("wait", text=text, selector=selector, url=url, timeout=timeout))


def text(n: Optional[int] = None, start: int = 0, max_chars: int = 6000) -> str:
    """Visible text of the page (or of element n), from `start`, at most `max_chars` characters."""
    return builtins.str(call("text", {"n": n, "start": start, "max": max_chars}).get("text") or "")


def js(expression: str) -> str:
    """Evaluate a JavaScript expression in the page and return its JSON value as text (bounded)."""
    return builtins.str(call("js", {"expression": expression}).get("text") or "")


def screenshot(n: Optional[int] = None, full_page: bool = False, path: Optional[str] = None) -> str:
    """Save a PNG of the viewport (or the full page, or element n) and return its path."""
    result = _run("screenshot", n=n, full=full_page, path=path)
    print(result.get("text"), flush=True)
    return builtins.str((result.get("data") or {}).get("path") or "")


def tabs() -> str:
    return builtins.str(call("tabs").get("text") or "")


def switch_tab(index: int) -> Page:
    return _page(_run("tab", index=index))


def new_tab(url: Optional[str] = None) -> Page:
    return _page(_run("new_tab", url=url))


def close_tab(index: Optional[int] = None) -> Page:
    return _page(_run("close_tab", index=index))


def save_session(name: Optional[str] = None) -> str:
    """Save the current site's sign-in (cookies and local storage) for later requests; it then stays current."""
    result = _run("save_session", name=name)
    return builtins.str(result.get("text") or "")


def steps() -> str:
    """This turn's browser steps, one line each."""
    return builtins.str(call("steps").get("text") or "")


def status(markers: bool = False) -> Dict[str, Any]:
    """Chromium version, language, time zone, open tabs and saved sessions (and automation markers when asked)."""
    return dict(call("status", {"markers": markers}).get("data") or {})


def close() -> str:
    """Close the browser now; the next call starts a new one from the saved sessions."""
    return builtins.str(call("close").get("text") or "")
