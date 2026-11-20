"""The browser's screen: one Xvfb per browser host, so Chromium runs headed inside the guest.

Operator decision 2026-11-20 (bot-check matrix): Cloudflare's Turnstile accepted a click from the headed browser
(3 of 3) and never from the headless one (0 of 5). The guest has no display, so the host starts its own X server
before the browser and stops it with the browser. Xvfb picks a free display itself (`-displayfd`), listens on no TCP
port, and its screen is the one the browser reports (`_identity.SCREEN`). Only the browser's environment names it
(`DISPLAY`); guest commands never get it. An X server that exits under a running browser takes the browser with it,
so the host treats that as a crash. Nothing here imports Playwright.
"""

from __future__ import annotations

import asyncio
import os
import shutil
from typing import Callable, Optional, Sequence, Tuple

from . import _identity

XVFB = "Xvfb"
#: Colour depth of the screen: what an ordinary desktop reports (`screen.colorDepth` 24).
DEPTH = 24
START_SECONDS = 10.0
STOP_SECONDS = 5.0


class DisplayError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def xvfb_args(fd: int, screen: Tuple[int, int] = _identity.SCREEN) -> Sequence[str]:
    """Any free display, announced on `fd`; a desktop-sized screen; no TCP; kept as it is between browsers."""
    return ("-displayfd", str(fd), "-screen", "0", f"{screen[0]}x{screen[1]}x{DEPTH}", "-nolisten", "tcp", "-noreset")


class Display:
    """This host's X server: started once, before the first browser, and stopped with the host."""

    def __init__(self, executable: str = XVFB, screen: Tuple[int, int] = _identity.SCREEN):
        self.executable = executable
        self.screen = screen
        self.process: Optional[asyncio.subprocess.Process] = None
        #: `:N`, once the server listens.
        self.name: Optional[str] = None
        self._watch: Optional[asyncio.Task] = None
        self._stopping = False

    def env(self) -> dict:
        """What the browser's environment adds: the display, when there is one."""
        return {"DISPLAY": self.name} if self.name else {}

    async def start(self, on_exit: Callable[[], None]) -> str:
        """Start the server and return its display; `on_exit` runs if it ends before `stop`."""
        if self.name is not None:
            return self.name
        executable = shutil.which(self.executable)
        if executable is None:
            raise DisplayError("browser_display_unavailable", "The guest has no Xvfb, so the browser cannot start.")
        read, write = os.pipe()
        try:
            # The server needs none of the host's environment, which carries the starting command's saved values.
            self.process = await asyncio.create_subprocess_exec(
                executable, *xvfb_args(write, self.screen), stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL, pass_fds=(write,), start_new_session=True,
                env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
        except OSError as error:
            os.close(read)
            raise DisplayError("browser_display_unavailable", f"Xvfb could not start ({error.strerror}).") from None
        finally:
            os.close(write)
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), os.fdopen(read, "rb", buffering=0))
        try:
            line = await asyncio.wait_for(reader.readline(), START_SECONDS)
        except asyncio.TimeoutError:
            line = b""
        finally:
            transport.close()
        number = line.strip()
        if not number.isdigit():
            await self._end()
            raise DisplayError("browser_display_unavailable", "Xvfb did not start, so the browser cannot start.")
        self.name = f":{int(number)}"
        process = self.process

        async def watch() -> None:
            await process.wait()
            if not self._stopping:
                self.name = None
                on_exit()

        self._watch = asyncio.ensure_future(watch())
        return self.name

    async def _end(self) -> None:
        process, self.process = self.process, None
        if process is None or process.returncode is not None:
            return
        try:
            process.terminate()
            await asyncio.wait_for(process.wait(), STOP_SECONDS)
        except ProcessLookupError:
            return
        except asyncio.TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                return
            await process.wait()

    async def stop(self) -> None:
        """End the server after its browser; nothing is reported as a crash."""
        self._stopping = True
        self.name = None
        try:
            await self._end()
        finally:
            if self._watch is not None:
                self._watch.cancel()
                self._watch = None
