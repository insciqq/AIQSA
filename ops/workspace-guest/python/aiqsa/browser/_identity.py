"""How the Workspace browser presents itself (operator decision 2026-10-26).

A full Chromium that does not advertise automation, inside one boundary
(`agent_docs/SECURITY.md`, Workspace): launch flags, the browser's own user
agent without the headless product name, and the browser's own client-hint
metadata. Nothing is forged: no WebGL, plugin, platform, hardware or worker
values, no input emulation. The user's language and time zone, frozen at
admission, arrive as environment values; anything malformed falls back to the
documented defaults.
"""

from __future__ import annotations

import re
from typing import Dict, List, Mapping, Optional

LOCALE_ENV = "AIQSA_BROWSER_LOCALE"
TIMEZONE_ENV = "AIQSA_BROWSER_TIMEZONE"
#: No interface language is stored for users yet; the browser then speaks US English.
DEFAULT_LOCALE = "en-US"
DEFAULT_TIMEZONE = "UTC"
#: A normal desktop window on a larger screen.
WINDOW = (1440, 900)
SCREEN = (1920, 1080)
#: Playwright's own default flag that turns `navigator.webdriver` on.
IGNORED_DEFAULT_ARGS = ["--enable-automation"]
#: Command values the browser process must not inherit.
DROPPED_ENV = frozenset({"AIQSA_INVOCATION_ID", "AIQSA_RUN_TOKEN", "AIQSA_GATEWAY_URL"})

_LOCALE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$")
_ZONE = re.compile(r"^(?:UTC|[A-Za-z][A-Za-z0-9_+-]{0,30}(?:/[A-Za-z0-9_+-]{1,30}){1,2})$")
#: The high-entropy client hints a page may request.
HIGH_ENTROPY_HINTS = ["architecture", "bitness", "fullVersionList", "model", "platformVersion", "wow64", "formFactors"]


def browser_locale(environ: Mapping[str, str]) -> str:
    value = environ.get(LOCALE_ENV, "")
    return value if len(value) <= 35 and _LOCALE.match(value) else DEFAULT_LOCALE


def browser_timezone(environ: Mapping[str, str]) -> str:
    value = environ.get(TIMEZONE_ENV, "")
    return value if len(value) <= 64 and _ZONE.match(value) else DEFAULT_TIMEZONE


def launch_args(locale: str, user_agent: Optional[str] = None) -> List[str]:
    """Flags only: no automation blink feature, the user's language, a desktop window and screen."""
    args = [
        "--disable-blink-features=AutomationControlled",
        f"--lang={locale}",
        f"--window-size={WINDOW[0]},{WINDOW[1]}",
        f"--screen-info={{{SCREEN[0]}x{SCREEN[1]}}}",
    ]
    if user_agent:
        args.append(f"--user-agent={user_agent}")
    return args


def launch_env(environ: Mapping[str, str], locale: str, timezone: str) -> Dict[str, str]:
    """The browser's own process environment: the user's zone and language, no command secrets of AIQSA."""
    env = {key: value for key, value in environ.items() if key not in DROPPED_ENV}
    posix = locale.replace("-", "_")
    env.update({"TZ": timezone, "LANG": f"{posix}.UTF-8", "LANGUAGE": posix})
    return env


def native_user_agent(headless_user_agent: str) -> str:
    """The running build's own user agent with the headless product name removed, nothing else."""
    if "HeadlessChrome/" not in headless_user_agent and "Chrome/" not in headless_user_agent:
        raise ValueError("unexpected_user_agent")
    return headless_user_agent.replace("HeadlessChrome/", "Chrome/")


def user_agent_metadata(reported: Mapping[str, object]) -> Dict[str, object]:
    """The browser's own client hints, as `navigator.userAgentData` reported them without overrides.

    Full Chromium reports no headless brand; a brand that still names it would
    be a build this boundary does not cover, so it is refused rather than renamed.
    """
    brands = reported.get("brands")
    full = reported.get("fullVersionList")
    if not isinstance(brands, list) or not isinstance(full, list) or not brands or not full:
        raise ValueError("client_hints_unavailable")
    for entry in [*brands, *full]:
        if not isinstance(entry, dict) or not isinstance(entry.get("brand"), str) or not isinstance(entry.get("version"), str):
            raise ValueError("client_hints_unavailable")
        if "headless" in entry["brand"].lower():
            raise ValueError("client_hints_headless")
    text = lambda key: reported.get(key) if isinstance(reported.get(key), str) else ""  # noqa: E731
    factors = reported.get("formFactors")
    return {
        "brands": [{"brand": entry["brand"], "version": entry["version"]} for entry in brands],
        "fullVersionList": [{"brand": entry["brand"], "version": entry["version"]} for entry in full],
        "platform": text("platform"),
        "platformVersion": text("platformVersion"),
        "architecture": text("architecture"),
        "model": text("model"),
        "mobile": reported.get("mobile") is True,
        "bitness": text("bitness"),
        "wow64": reported.get("wow64") is True,
        "formFactors": [value for value in factors if isinstance(value, str)] if isinstance(factors, list) else [],
    }
