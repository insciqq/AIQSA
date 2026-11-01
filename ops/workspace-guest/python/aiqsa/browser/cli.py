"""`aiqsa-browser`: drive the Workspace browser from any shell, one action per command.

    aiqsa-browser open https://www.saucedemo.com
    aiqsa-browser type 1 --env SHOP_LOGIN
    aiqsa-browser type 2 --env SHOP_PASSWORD --submit
    aiqsa-browser click 7

An action prints its step line, then the page with numbered elements. A
failure prints `error[<code>]: <what to do>` on stderr with a stable exit code.
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any, Dict, List, Optional, TextIO
from urllib.parse import urlsplit

from ..proxy import client as proxy_client
from ..proxy import selection as proxy_selection
from ._client import BrowserError, call
from ._format import step_line

VERSION = "1.0.0"
EXIT_USAGE = 2
EXIT_UNAVAILABLE = 3
EXIT_ELEMENT = 4
EXIT_PAGE = 5
EXIT_CAPTCHA = 6
EXIT_SESSION = 7
#: The user holds the browser in the chat's live view; try again after a pause.
EXIT_USER_IN_CONTROL = 8
_ELEMENT = {"element_not_found", "stale_element", "element_not_actionable", "not_a_select", "option_not_found"}
_PAGE = {"invalid_url", "navigation_failed", "navigation_timeout", "wait_timeout", "timeout", "tab_not_found", "script_error"}
_UNAVAILABLE = {"browser_unavailable", "browser_start_failed", "browser_crashed", "protocol_error", "proxy_browser_restart_pending",
                proxy_client.UNAVAILABLE}
#: What a shell answers when a command is missing or not executable.
EXIT_COMMAND_NOT_RUN = 127
_PROXY_HELP = "A proxy's name or id, `direct`, or `auto` to follow its hints again (a proxy called direct or auto is named by id)."


def exit_code(code: str) -> int:
    if code in _UNAVAILABLE:
        return EXIT_UNAVAILABLE
    if code.startswith("proxy_"):
        return EXIT_PAGE
    if code in _ELEMENT:
        return EXIT_ELEMENT
    if code in _PAGE:
        return EXIT_PAGE
    if code == "captcha_requires_user":
        return EXIT_CAPTCHA
    if code in ("user_in_control", "user_returned_control"):
        return EXIT_USER_IN_CONTROL
    if code in ("browser_busy", "browser_memory_low"):
        return EXIT_UNAVAILABLE
    if code.startswith("session_") or code.startswith("browser_session_"):
        return EXIT_SESSION
    if code in ("invalid_arguments", "invalid_path"):
        return EXIT_USAGE
    return 1


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # type: ignore[override]
        raise _UsageError(message)


class _UsageError(Exception):
    pass


def _parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="aiqsa-browser", description="Drive this turn's Workspace browser (full Chromium, kept between commands).")
    parser.add_argument("--version", action="version", version=f"aiqsa-browser {VERSION}")
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    quiet = argparse.ArgumentParser(add_help=False)
    quiet.add_argument("--quiet", action="store_true", help="Print only the step line, not the page.")
    command = commands.add_parser("open", parents=[quiet], help="Open a web address in the current tab.")
    command.add_argument("url")
    command.add_argument("--proxy", metavar="NAME", help=_PROXY_HELP)
    command = commands.add_parser("info", help="The page: URL, title and numbered elements on screen.")
    command.add_argument("--all", action="store_true", help="List the elements of the whole page.")
    command.add_argument("--limit", type=int)
    command = commands.add_parser("find", help="Numbered elements whose name, value or link contains TEXT.")
    command.add_argument("text")
    command = commands.add_parser("click", parents=[quiet], help="Click element N.")
    command.add_argument("n", type=int)
    command = commands.add_parser("type", parents=[quiet], help="Type into element N, replacing its value.")
    command.add_argument("n", type=int)
    command.add_argument("text", nargs="?")
    command.add_argument("--env", metavar="NAME", help="Type the value of this environment variable; it is never printed.")
    command.add_argument("--submit", action="store_true", help="Press Enter afterwards.")
    command.add_argument("--append", action="store_true", help="Keep the current value and type after it.")
    command = commands.add_parser("select", parents=[quiet], help="Choose OPTION in list box N.")
    command.add_argument("n", type=int)
    command.add_argument("option")
    command = commands.add_parser("upload", parents=[quiet], help="Choose a Workspace file for file input N.")
    command.add_argument("n", type=int)
    command.add_argument("path")
    command = commands.add_parser("press", parents=[quiet], help="Press a key: Enter, Escape, Tab, ArrowDown, Control+A ...")
    command.add_argument("key")
    command = commands.add_parser("scroll", parents=[quiet], help="Scroll down (default), up, top, bottom or to element N.")
    command.add_argument("where", nargs="?", default="down")
    for name in ("back", "forward", "reload"):
        commands.add_parser(name, parents=[quiet], help=f"{name.capitalize()} in the current tab.")
    command = commands.add_parser("wait", parents=[quiet], help="Wait until the page shows a text, selector or address.")
    target = command.add_mutually_exclusive_group(required=True)
    target.add_argument("--text")
    target.add_argument("--selector")
    target.add_argument("--url")
    command.add_argument("--timeout", type=int, default=15, help="Seconds, at most 120.")
    command = commands.add_parser("text", help="Visible text of the page or of element N.")
    command.add_argument("n", type=int, nargs="?")
    command.add_argument("--start", type=int, default=0)
    command.add_argument("--max", type=int, default=6000)
    command = commands.add_parser("js", help="Read page data: evaluate a JavaScript expression and print its JSON value. Only for "
                                  "reading; never to click, solve a challenge or change how the browser identifies itself. "
                                  "Refused while the page shows a CAPTCHA.")
    command.add_argument("expression")
    command = commands.add_parser("shot", help="Save a PNG screenshot and print its path.")
    command.add_argument("n", type=int, nargs="?")
    command.add_argument("--full", action="store_true", help="The whole page, not only the viewport.")
    command.add_argument("--path", help="Where to save it, for example in this turn's output directory for the user.")
    commands.add_parser("tabs", help="List the open tabs.")
    command = commands.add_parser("tab", parents=[quiet], help="Switch to tab INDEX.")
    command.add_argument("index", type=int)
    command = commands.add_parser("new-tab", parents=[quiet], help="Open a new tab, optionally at URL.")
    command.add_argument("url", nargs="?")
    command.add_argument("--proxy", metavar="NAME", help=_PROXY_HELP)
    command = commands.add_parser("close-tab", parents=[quiet], help="Close tab INDEX (default: the current one).")
    command.add_argument("index", type=int, nargs="?")
    command = commands.add_parser("save-session", help="Save the current site's sign-in for later requests.")
    command.add_argument("name", nargs="?", help="Site name such as shop.example.com (default: the current site).")
    commands.add_parser("steps", help="This turn's browser steps.")
    command = commands.add_parser("status", help="Chromium version, language, time zone, tabs and saved sessions.")
    command.add_argument("--markers", action="store_true", help="Also check automation markers in the page and a worker.")
    commands.add_parser("close", help="Close the browser now.")
    commands.add_parser("release", help="Release this agent's browser slot and close its tabs.")
    command = commands.add_parser("proxies", help="This chat's proxies; with HOST, what opens it and which proxies to try.")
    command.add_argument("host", nargs="?")
    command = commands.add_parser("proxied", help="Run a command with its network through this chat's proxies, chosen per site as the browser's are: "
                                  "aiqsa-browser proxied curl -sS https://shop.kz/")
    command.add_argument("--proxy", metavar="NAME", help=_PROXY_HELP)
    command.add_argument("argv", nargs=argparse.REMAINDER, metavar="COMMAND")
    return parser


def _request(parsed: argparse.Namespace) -> tuple:
    name = parsed.command
    if name == "type":
        if parsed.env and parsed.text is not None:
            raise _UsageError("give either TEXT or --env NAME, not both")
        if parsed.env:
            if parsed.env not in os.environ:
                raise _UsageError(f"environment variable {parsed.env} is not set")
            value = os.environ[parsed.env]
        elif parsed.text is not None:
            value = parsed.text
        else:
            raise _UsageError("give TEXT or --env NAME")
        return "type", {"n": parsed.n, "text": value, "submit": parsed.submit, "clear": not parsed.append, "masked": bool(parsed.env)}
    if name == "scroll":
        where = parsed.where
        if where.isdigit():
            return "scroll", {"n": int(where)}
        return "scroll", {"direction": where}
    if name == "wait":
        return "wait", {"text": parsed.text, "selector": parsed.selector, "url": parsed.url, "timeout": parsed.timeout}
    if name == "text":
        return "text", {"n": parsed.n, "start": parsed.start, "max": parsed.max}
    if name == "shot":
        return "screenshot", {"n": parsed.n, "full": parsed.full, "path": os.path.abspath(parsed.path) if parsed.path else None}
    if name == "info":
        return "info", {"all": parsed.all, "limit": parsed.limit}
    if name == "save-session":
        return "save_session", {"name": parsed.name}
    if name in ("new-tab", "close-tab"):
        return name.replace("-", "_"), {key: value for key, value in vars(parsed).items() if key in ("url", "index", "proxy")}
    if name == "status":
        return "status", {"markers": parsed.markers}
    if name == "upload":
        return "upload", {"n": parsed.n, "path": os.path.abspath(parsed.path)}
    keys = {"open": ("url", "proxy"), "find": ("text",), "click": ("n",), "select": ("n", "option"), "press": ("key",),
            "tab": ("index",), "js": ("expression",)}
    return name, {key: getattr(parsed, key) for key in keys.get(name, ())}


def _listed(proxy: Dict[str, Any], names: List[str]) -> str:
    """One proxy, by what names it: a name a choice cannot mean, or that two proxies share, also shows its id."""
    name = str(proxy["name"])
    ambiguous = name.lower() in (proxy_client.DIRECT, proxy_client.AUTO) or names.count(name.lower()) > 1
    states = [] if proxy["active"] and proxy["available"] else ["switched off" if not proxy["active"] else "unavailable now"]
    return "- " + ", ".join([name + (f" (id {proxy['id']})" if ambiguous else ""), str(proxy["protocol"]),
                             *([f"country {proxy['country']}"] if proxy["country"] else []),
                             "hints " + " ".join(proxy["domainHints"]) if proxy["domainHints"] else "no hints",
                             "shared by an administrator" if proxy["owner"] == "administrator" else "personal", *states])


def _proxies_text(value: Optional[str]) -> str:
    plan = proxy_client.load_plan()
    if plan is None:
        return "This chat has no proxies."
    listed = plan.public()
    names = [str(proxy["name"]).lower() for proxy in listed]
    lines = ["Proxies of this chat. Hints are advice: any of them opens any site when named. Logins and passwords, for a program that needs "
             "its own, are in /workspace/secrets/.proxy-plan.json.", *(_listed(proxy, names) for proxy in listed)]
    if value:
        host = (urlsplit(value).hostname if "://" in value else value) or value
        peek = proxy_client.call("peek", {"host": host})
        decision = peek.get("decision") or {}
        if decision.get("kind") == "proxy":
            lines.append(f"{host} opens through {proxy_client.labels([decision])}.")
        elif decision.get("kind") == "direct":
            lines.append(f"{host} opens directly.")
        else:
            lines.append(f"{host} has no proxy left to open it ({decision.get('code')}); its next request tries them again.")
        outcome = peek.get("outcome") or {}
        if outcome.get("code"):
            lines.append(f"Its last connection failed: {outcome['code']}.")
        lines.append(f"Proxies to try: {proxy_client.labels(peek.get('toTry') or []) or 'none'}.")
    return "\n".join(lines)


def _run_proxied(parsed: argparse.Namespace, stderr: TextIO) -> int:
    command = list(parsed.argv)
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        raise _UsageError("give the command to run")
    choice = proxy_client.parse_choice(parsed.proxy)
    plan = proxy_client.load_plan()
    route = None
    if plan is None:
        if choice not in (None, proxy_client.AUTO) and choice["kind"] == "proxy":
            raise proxy_client.ProxyError("proxy_not_found", "This chat has no proxies, so `--proxy` has nothing to name.")
    elif choice not in (None, proxy_client.AUTO):
        decision, _ = proxy_selection.select(plan.proxies, "", proxy_selection.empty_state(), choice)
        if decision["kind"] == "failed":
            raise proxy_client.ProxyError(decision["code"], "That is no usable proxy of this chat; `aiqsa-browser proxies` lists them.")
        route = decision["proxyId"] if decision["kind"] == "proxy" else proxy_client.DIRECT
    env = proxy_client.command_environment(os.environ, route) if plan is not None else dict(os.environ)
    try:
        os.execvpe(command[0], command, env)
    except OSError as error:
        stderr.write(f"error[command_not_run]: {command[0]}: {error.strerror}.\n")
    return EXIT_COMMAND_NOT_RUN


def main(argv: Optional[List[str]] = None, *, stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr) -> int:
    try:
        parsed = _parser().parse_args(argv)
        if parsed.command == "proxied":
            return _run_proxied(parsed, stderr)
        if parsed.command == "proxies":
            stdout.write(_proxies_text(parsed.host) + "\n")
            return 0
        op, args = _request(parsed)
    except _UsageError as error:
        stderr.write(f"error[usage]: {error}. See `aiqsa-browser --help`.\n")
        return EXIT_USAGE
    except proxy_client.ProxyError as error:
        stderr.write(f"error[{error.code}]: {error.message}\n")
        return exit_code(error.code)
    try:
        result: Dict[str, Any] = call(op, args)
    except BrowserError as error:
        stderr.write(f"error[{error.code}]: {error.message}\n")
        return exit_code(error.code)
    if result.get("step"):
        stdout.write(step_line(result["step"]) + "\n")
    text = str(result.get("text") or "")
    if text and not (getattr(parsed, "quiet", False) and result.get("step")):
        stdout.write(text + ("" if text.endswith("\n") else "\n"))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
