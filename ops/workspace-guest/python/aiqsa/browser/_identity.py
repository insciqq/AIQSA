"""How the Workspace browser presents itself (operator decision 2026-11-20, replacing 2026-10-26).

The AIQSA browser is a person's AI-assisted browser, not a bot, and sites should meet it as that person's browser.
It is the full Chromium build driven by Patchright (a Playwright build without the CDP traces detectors read), headed
on the guest's own X server (`_display.py`) with WebGL on SwiftShader, as the bot-check matrix chose: pixelscan and
deviceandbrowserinfo flagged the CDP traces, and Cloudflare's Turnstile accepted a click only from a headed browser.
What it reports is its own: the running build's user agent and client hints (read from a probe of the same build in
the same mode), a desktop window on a screen the X server really has, the user's language and time zone (frozen at
admission, arriving as environment values; anything malformed falls back to the documented defaults). No renderer,
plugin, platform or hardware value is overridden, since detectors read overrides as lies; input that moves like a
person's lives in `_human.py`. The identity's launch flags are here, in one place; `Host._launch_options` adds the
profile's bounds (`_profile.LAUNCH_ARGS`) and the display.
"""

from __future__ import annotations

import re
from typing import Dict, List, Mapping, Optional, Tuple

LOCALE_ENV = "AIQSA_BROWSER_LOCALE"
TIMEZONE_ENV = "AIQSA_BROWSER_TIMEZONE"
#: No interface language is stored for users yet; the browser then speaks US English.
DEFAULT_LOCALE = "en-US"
DEFAULT_TIMEZONE = "UTC"
#: A normal desktop window on a larger screen; the X server's screen is `SCREEN` (`_display.py`).
WINDOW = (1440, 900)
SCREEN = (1920, 1080)
#: Playwright's own default flag that turns `navigator.webdriver` on.
IGNORED_DEFAULT_ARGS = ["--enable-automation"]
#: Command values the browser process must not inherit. Agent identity travels in the browser protocol instead.
DROPPED_ENV = frozenset({
    "AIQSA_INVOCATION_ID", "AIQSA_RUN_TOKEN", "AIQSA_GATEWAY_URL", "AIQSA_AGENT_ID", "AIQSA_AGENT_NAME"
})
AGENT_ENV_PREFIX = "AIQSA_AGENT_"

_LOCALE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$")
#: An IANA name: one segment (`CET`, `EST5EDT`) or more (`America/Argentina/Buenos_Aires`); AIQSA checked it exists.
_ZONE = re.compile(r"^[A-Za-z0-9_+-]+(?:/[A-Za-z0-9_+-]+)*$")
#: The high-entropy client hints a page may request.
HIGH_ENTROPY_HINTS = ["architecture", "bitness", "fullVersionList", "model", "platformVersion", "wow64", "formFactors"]


def browser_locale(environ: Mapping[str, str]) -> str:
    value = environ.get(LOCALE_ENV, "")
    return value if len(value) <= 35 and _LOCALE.fullmatch(value) else DEFAULT_LOCALE


def browser_timezone(environ: Mapping[str, str]) -> str:
    value = environ.get(TIMEZONE_ENV, "")
    return value if len(value) <= 64 and _ZONE.fullmatch(value) else DEFAULT_TIMEZONE


def launch_args(locale: str, user_agent: Optional[str] = None, proxy_port: Optional[int] = None) -> List[str]:
    """Flags only: no automation blink feature, the user's language, a desktop window, WebGL.

    The screen is the X server's (`_display.py`, `SCREEN`): headed Chromium ignores `--screen-info`. The VM has no GPU,
    and headed Chromium then turns WebGL off altogether; SwiftShader keeps it, as headless had it, because sites need it
    (maps) and a browser without WebGL is itself rare.

    A run with proxies adds the local forwarder, and WebRTC keeps to it: its UDP would show a site the VM's own
    address beside the proxy's. Chromium itself bypasses the proxy for loopback, so a local page still opens.
    """
    args = [
        "--disable-blink-features=AutomationControlled",
        f"--lang={locale}",
        f"--window-size={WINDOW[0]},{WINDOW[1]}",
        "--enable-unsafe-swiftshader",
    ]
    if user_agent:
        args.append(f"--user-agent={user_agent}")
    if proxy_port is not None:
        args += [f"--proxy-server=http://127.0.0.1:{proxy_port}", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]
    return args


def presentation_for_proxy(country: Optional[str], locale: str, timezone: str) -> Tuple[str, str]:
    """The language and time zone a page opened through a proxy of this country presents.

    Unchanged today: the user's own. `proxy-acceptance` tests whether they should follow the proxy's country (a
    Russian shop through a Russian address with en-US and UTC is a mismatch a site can read); this function is the
    one place to change, and `Host._present_for_proxy` applies whatever it returns to the page before it navigates.
    """
    return locale, timezone


def launch_env(environ: Mapping[str, str], locale: str, timezone: str) -> Dict[str, str]:
    """The browser's own process environment: the user's zone and language, no command secrets of AIQSA."""
    env = {key: value for key, value in environ.items() if key not in DROPPED_ENV and not key.startswith(AGENT_ENV_PREFIX)}
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
