"""The live view's wire, shared by the browser host and the streamer. Standard library only.

While the agent's browser runs in a turn, the run owner can watch it in the chat, take control, and answer a
handoff the agent asked for (`lib/contracts/browserLive.ts`). AIQSA starts the streamer
(`python3 -I -m aiqsa.browser.live`) through the exec channel under the run's operation and polls its output;
the streamer relays between AIQSA and this boot's browser host over the host's private socket. Every message,
in both directions, is one JSON object; on the streamer's stdout each is one length-tagged line
`@<length> <json>`, so AIQSA drops a line the channel cut. Frames are the page's own JPEG from CDP
`Page.startScreencast`, base64 as CDP gives it. Nothing here is logged, written to a file or printed to the
agent; what the user types reaches the page through CDP only.
"""

from __future__ import annotations

import base64
import binascii
import json
import math
from typing import Any, Dict, List, Mapping, Optional, Tuple
from urllib.parse import urlsplit

from . import _format

PROTOCOL = 1
#: The largest frame the screencast asks for (`lib/contracts/browserLive.ts` allows more; the decision keeps this).
FRAME_MAX = (1280, 800)
FRAME_QUALITY = 55
#: At most eight frames a second; a single change goes out at once, a burst waits for the next slot.
FRAME_INTERVAL = 0.125
#: Base64 characters of one frame (`BROWSER_LIVE_LIMITS.frameBase64Chars`); a larger one is skipped.
FRAME_BASE64_MAX = 512 * 1024
#: Steps one `steps` message carries (`BROWSER_LIVE_LIMITS.stepsPerEvent`).
STEPS_PER_MESSAGE = 50
STEP_TEXT_CHARS = 200
URL_CHARS = 2048
TITLE_CHARS = 300
TEXT_CHARS = 1024
KEY_CHARS = 32
#: A side of the frame coordinate space (`BROWSER_LIVE_LIMITS.frameMaxSide`).
COORDINATE_MAX = 1920
WHEEL_MAX = 10_000
#: One line from AIQSA: an input, a control or a handoff message.
INPUT_LINE_MAX = 16 * 1024
#: The agent's next browser action waits this long for the user to give control back, then reports it.
CONTROL_WAIT_SECONDS = 10.0
#: After the last live view closes, control taken by the user returns to the agent this much later (a view that
#: reconnects, or a rotated streamer, keeps it).
CONTROL_GRACE_SECONDS = 20.0
LIVE_CONNECTIONS_MAX = 4

MODIFIER_ALT, MODIFIER_CTRL, MODIFIER_META, MODIFIER_SHIFT = 1, 2, 4, 8
#: Handoff reasons whose Done saves the current site's sign-in (`lib/contracts/browserLive.ts`); a choice or another
#: look at the page saves nothing (operator decision 2026-10-27).
SAVE_SESSION_REASONS = frozenset({"sign_in", "verification_code", "captcha", "consent"})
#: CDP mouse buttons and their bits in `buttons`.
MOUSE_BUTTONS = {"none": 0, "left": 1, "right": 2, "middle": 4}
_MOUSE_TYPES = {"move": "mouseMoved", "down": "mousePressed", "up": "mouseReleased", "wheel": "mouseWheel"}
#: Windows virtual key codes Chromium needs to act on a key that inserts no text.
_VIRTUAL_KEYS = {
    "Backspace": 8, "Tab": 9, "Enter": 13, "Shift": 16, "Control": 17, "Alt": 18, "Pause": 19, "CapsLock": 20,
    "Escape": 27, " ": 32, "PageUp": 33, "PageDown": 34, "End": 35, "Home": 36, "ArrowLeft": 37, "ArrowUp": 38,
    "ArrowRight": 39, "ArrowDown": 40, "Insert": 45, "Delete": 46, "Meta": 91, "ContextMenu": 93,
    **{f"F{index}": 111 + index for index in range(1, 13)},
}
_CODE_KEYS = {
    "Semicolon": 186, "Equal": 187, "Comma": 188, "Minus": 189, "Period": 190, "Slash": 191, "Backquote": 192,
    "BracketLeft": 219, "Backslash": 220, "BracketRight": 221, "Quote": 222, "Space": 32,
}


class LiveError(Exception):
    """A live message that cannot be applied: a stable code, never page or input content."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def encode_line(message: Mapping[str, Any]) -> str:
    """One message as the streamer prints it: ASCII JSON behind its length."""
    text = json.dumps(message, ensure_ascii=True, separators=(",", ":"))
    return f"@{len(text)} {text}\n"


def decode_line(line: str) -> Optional[Dict[str, Any]]:
    """The message of one `@<length> <json>` line, or None for anything else (a cut or foreign line)."""
    if not line.startswith("@"):
        return None
    head, _, text = line.partition(" ")
    if not head[1:].isdigit() or int(head[1:]) != len(text):
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def jpeg_size(data: str) -> Optional[Tuple[int, int]]:
    """Width and height of a base64 JPEG from its frame header, or None when it is not one."""
    for chars in (4096, 65536):
        prefix = data[:chars]
        prefix = prefix[: len(prefix) - len(prefix) % 4]
        try:
            raw = base64.b64decode(prefix, validate=True)
        except (binascii.Error, ValueError):
            return None
        size = _sof_size(raw)
        if size is not None or len(data) <= chars:
            return size
    return None


def _sof_size(raw: bytes) -> Optional[Tuple[int, int]]:
    if raw[:2] != b"\xff\xd8":
        return None
    index = 2
    while index + 4 <= len(raw):
        if raw[index] != 0xFF:
            return None
        marker = raw[index + 1]
        if marker == 0xFF:
            index += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            index += 2
            continue
        length = int.from_bytes(raw[index + 2:index + 4], "big")
        if length < 2:
            return None
        # SOF0..SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if index + 9 > len(raw):
                return None
            height = int.from_bytes(raw[index + 5:index + 7], "big")
            width = int.from_bytes(raw[index + 7:index + 9], "big")
            return (width, height) if width > 0 and height > 0 else None
        if marker == 0xDA:
            return None
        index += 2 + length
    return None


def _number(event: Mapping[str, Any], key: str, low: float, high: float, default: Optional[float] = None) -> float:
    value = event.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise LiveError("input_invalid")
    return float(value)


def _int(event: Mapping[str, Any], key: str, low: int, high: int, default: int) -> int:
    value = event.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise LiveError("input_invalid")
    return value


def page_point(x: float, y: float, frame: Tuple[int, int], device: Tuple[float, float]) -> Tuple[float, float]:
    """A point in frame pixels as CSS pixels of the page viewport the frame shows."""
    width, height = frame
    return x * device[0] / width, y * device[1] / height


def mouse_event(event: Mapping[str, Any], frame: Tuple[int, int], device: Tuple[float, float], pressed: int) -> Tuple[Dict[str, Any], int]:
    """CDP `Input.dispatchMouseEvent` parameters for one pointer input, and the buttons held after it."""
    kind = _MOUSE_TYPES.get(event.get("type"))  # type: ignore[arg-type]
    if kind is None:
        raise LiveError("input_invalid")
    x = _number(event, "x", 0, COORDINATE_MAX)
    y = _number(event, "y", 0, COORDINATE_MAX)
    if x > frame[0] or y > frame[1]:
        raise LiveError("input_outside_frame")
    page_x, page_y = page_point(x, y, frame, device)
    button = event.get("button", "none" if kind in ("mouseMoved", "mouseWheel") else "left")
    if button not in MOUSE_BUTTONS:
        raise LiveError("input_invalid")
    modifiers = _int(event, "modifiers", 0, 15, 0)
    params: Dict[str, Any] = {"type": kind, "x": round(page_x, 2), "y": round(page_y, 2), "modifiers": modifiers}
    if kind == "mousePressed":
        pressed |= MOUSE_BUTTONS[button]
    elif kind == "mouseReleased":
        pressed &= ~MOUSE_BUTTONS[button]
    if kind in ("mousePressed", "mouseReleased"):
        params.update(button=button, clickCount=_int(event, "clickCount", 0, 3, 1))
    elif kind == "mouseWheel":
        params.update(deltaX=_number(event, "deltaX", -WHEEL_MAX, WHEEL_MAX, 0), deltaY=_number(event, "deltaY", -WHEEL_MAX, WHEEL_MAX, 0))
    else:
        held = next((name for name, bit in MOUSE_BUTTONS.items() if bit and pressed & bit), "none")
        params["button"] = held
    params["buttons"] = pressed
    return params, pressed


def virtual_key(key: str, code: str) -> int:
    if key in _VIRTUAL_KEYS:
        return _VIRTUAL_KEYS[key]
    if code.startswith("Key") and len(code) == 4 and code[3].isalpha():
        return ord(code[3].upper())
    if code.startswith("Digit") and len(code) == 6 and code[5].isdigit():
        return ord(code[5])
    if code.startswith("Numpad") and len(code) == 7 and code[6].isdigit():
        return 96 + int(code[6])
    if code in _CODE_KEYS:
        return _CODE_KEYS[code]
    if len(key) == 1 and key.isascii() and key.isalnum():
        return ord(key.upper())
    return 0


def key_event(event: Mapping[str, Any]) -> Tuple[Dict[str, Any], Optional[str]]:
    """CDP `Input.dispatchKeyEvent` parameters for one key input, and the text it types (None for none)."""
    kind = event.get("type")
    key = event.get("key")
    code = event.get("code", "")
    if kind not in ("down", "up") or not isinstance(key, str) or not 1 <= len(key) <= KEY_CHARS or \
            not isinstance(code, str) or len(code) > KEY_CHARS or any(ord(char) < 32 or ord(char) == 127 for char in key + code):
        raise LiveError("input_invalid")
    modifiers = _int(event, "modifiers", 0, 15, 0)
    code_value = virtual_key(key, code)
    params: Dict[str, Any] = {"key": key, "code": code, "modifiers": modifiers, "windowsVirtualKeyCode": code_value,
                              "nativeVirtualKeyCode": code_value}
    if kind == "up":
        params["type"] = "keyUp"
        return params, None
    # One character without Ctrl or Meta types itself; Enter types a return; anything else is a raw key.
    typed = key if len(key) == 1 and not modifiers & (MODIFIER_CTRL | MODIFIER_META) else None
    if typed is not None:
        params.update(type="keyDown", text=typed, unmodifiedText=typed)
    elif key == "Enter" and not modifiers & (MODIFIER_CTRL | MODIFIER_META | MODIFIER_ALT):
        params.update(type="keyDown", text="\r", unmodifiedText="\r")
    else:
        params["type"] = "rawKeyDown"
    return params, typed


def text_input(event: Mapping[str, Any]) -> str:
    """The text of one insertion: a phone keyboard sends whole words through a real text field."""
    text = event.get("text")
    if not isinstance(text, str) or not 1 <= len(text) <= TEXT_CHARS or \
            any((ord(char) < 32 and char not in "\t\n\r") or ord(char) == 127 for char in text):
        raise LiveError("input_invalid")
    return text


def step_view(step: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """One step as the panel's step log shows it (`browserLiveStepSchema`): no query, no user info, no typed value."""
    action = str(step.get("action") or "")
    if not action or len(action) > 20 or not action[0].isalpha() or not all(char.islower() or char == "_" for char in action):
        return None
    host, path = "", ""
    url = step.get("url")
    if isinstance(url, str):
        try:
            parts = urlsplit(url)
            port = parts.port
        except ValueError:
            parts, port = None, None
        if parts is not None and parts.hostname:
            host = parts.hostname + (f":{port}" if port else "")
            path = parts.path or "/"
        elif parts is not None and parts.scheme:
            host = parts.scheme + ":"
    try:
        number = int(step.get("n") or 0)
    except (TypeError, ValueError):
        return None
    if not 1 <= number <= 99_999:
        return None
    return {"n": number, "action": action, "target": _format.clean(step.get("target") or "", STEP_TEXT_CHARS),
            "host": _format.clean(host, 253), "path": _format.clean(path, STEP_TEXT_CHARS)}


def steps_view(steps: List[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    viewed = [step_view(step) for step in steps[-STEPS_PER_MESSAGE:]]
    return [step for step in viewed if step is not None]


def page_view(url: Optional[str], title: Optional[str]) -> Optional[Dict[str, str]]:
    """The panel's address line: the page's address without user info, and its title, each one bounded line."""
    if url is None:
        return None
    address = _format.without_userinfo(url)
    return {"url": _format.clean(address, URL_CHARS), "title": _format.clean(title or "", TITLE_CHARS)}
