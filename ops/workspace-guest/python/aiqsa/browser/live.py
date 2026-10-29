"""The live view's streamer: relays between AIQSA and this boot's browser host. Standard library only.

    /opt/aiqsa-python/bin/python3 -I -m aiqsa.browser.live

AIQSA starts it through the exec channel under the run's operation (`lib/server/workspace/browserLive.ts`),
never as the agent's command. Each stdin line is one message for the host (`frames`, `select`, `input`,
`control`, `handoff`, `ping`); each host message goes to stdout as one `@<length> <json>` line
(`_live.encode_line`). The frame wish and the selected agent (`select`, `agents.py`) are kept and sent again to
each host it reaches, so a restarted host streams the agent the view chose. It
never starts the browser: while no host answers it reports `absent` and waits, and when the host goes away it
says so and waits for the next one. AIQSA writes its first command right after starting it, so a command that
comes before the first attempt to reach the host (and one retry) has resolved waits for that; only then is it
refused. It ends when stdin closes, on `{"t": "bye"}` or on SIGTERM. It prints nothing else: no log, no input
echo, no page content beyond the host's own messages.
"""

from __future__ import annotations

import asyncio
import json
import re
import signal
import sys
import threading
from typing import Any, Dict, Optional, TextIO

from .. import agents as _agents
from . import _live, _paths

#: How often a missing host is looked for.
HOST_RETRY_SECONDS = 0.5
CONNECT_TIMEOUT_SECONDS = 2.0
#: Commands answer only with the host; while there is none they are refused (`browser_not_running`).
COMMANDS = ("control", "handoff", "ping")
#: A command that comes before the first connection attempt and one retry resolved waits at most this long.
HOLD_SECONDS = 2 * CONNECT_TIMEOUT_SECONDS + HOST_RETRY_SECONDS + 0.5


class Streamer:
    def __init__(self, out: TextIO):
        self.out = out
        self.frames = False
        #: The agent whose tab the view streams; the main agent until AIQSA selects another.
        self.agent = _agents.MAIN_AGENT_ID
        self.writer: Optional[asyncio.StreamWriter] = None
        self.inbox: "asyncio.Queue[Optional[Dict[str, Any]]]" = asyncio.Queue()
        self.stopping = asyncio.Event()
        self.reported: Optional[str] = None
        #: Set once a connection is up, or the first attempt and one retry failed: before that a command waits.
        self.settled = asyncio.Event()
        self.failed_attempts = 0

    def emit(self, message: Dict[str, Any]) -> None:
        self.out.write(_live.encode_line(message))
        self.out.flush()

    def relay(self, line: bytes) -> None:
        """One host message as it came (compact ASCII JSON), behind its length; frames are not parsed again."""
        text = line.rstrip(b"\r\n")
        if not text.startswith(b"{") or not text.endswith(b"}") or not text.isascii():
            return
        if len(text) < 4096 and text.startswith(b'{"t":"state"'):
            try:
                self.reported = str(json.loads(text).get("browser") or "")
            except ValueError:
                return
        self.out.write(f"@{len(text)} {text.decode('ascii')}\n")
        self.out.flush()

    def report(self, browser: str) -> None:
        if self.reported == browser:
            return
        self.reported = browser
        self.emit({"t": "state", "browser": browser})

    def refuse(self, message: Dict[str, Any], code: str) -> None:
        if isinstance(message.get("id"), str):
            self.emit({"t": "ack", "id": message["id"][:64], "ok": False, "code": code})

    async def forward(self) -> None:
        """AIQSA's messages to the host; while none answers, commands are refused and the frame wish kept."""
        while True:
            message = await self.inbox.get()
            if message is None or message.get("t") == "bye":
                self.stopping.set()
                return
            if message.get("t") == "frames":
                self.frames = message.get("on") is True
            elif message.get("t") == _agents.LIVE_SELECT_MESSAGE:
                agent = message.get(_agents.LIVE_AGENT_FIELD, _agents.MAIN_AGENT_ID)
                if not isinstance(agent, str) or re.fullmatch(_agents.AGENT_ID_PATTERN, agent) is None:
                    continue
                self.agent = agent
            writer = self.writer
            if writer is None and message.get("t") in COMMANDS and not self.settled.is_set():
                # Started a moment ago: the host may answer the first attempt, or the retry.
                try:
                    await asyncio.wait_for(self.settled.wait(), HOLD_SECONDS)
                except asyncio.TimeoutError:
                    pass
                writer = self.writer
            if writer is None:
                if message.get("t") in COMMANDS:
                    self.refuse(message, "browser_not_running")
                continue
            try:
                writer.write(json.dumps(message, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n")
                await writer.drain()
            except (ConnectionError, OSError):
                self.refuse(message, "browser_not_running")

    async def connect(self) -> None:
        """Holds one connection to the host at a time and prints what it sends."""
        path = str(_paths.run_dir() / "control.sock")
        while not self.stopping.is_set():
            try:
                reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path, limit=4 * 1024 * 1024),
                                                        CONNECT_TIMEOUT_SECONDS)
            except (OSError, asyncio.TimeoutError):
                self.report("absent")
                self.failed_attempts += 1
                if self.failed_attempts >= 2:
                    self.settled.set()
                await self.pause(HOST_RETRY_SECONDS)
                continue
            try:
                writer.write(json.dumps({"v": _live.PROTOCOL, "op": "live",
                                         "args": {"frames": self.frames, _agents.LIVE_AGENT_FIELD: self.agent}}).encode("ascii") + b"\n")
                await writer.drain()
                self.writer = writer
                self.settled.set()
                while not self.stopping.is_set():
                    line = await reader.readline()
                    if not line:
                        break
                    self.relay(line)
            except (ConnectionError, OSError, asyncio.LimitOverrunError, ValueError):
                pass
            finally:
                self.writer = None
                writer.close()
            if not self.stopping.is_set():
                self.report("absent")
                await self.pause(HOST_RETRY_SECONDS)

    async def pause(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self.stopping.wait(), seconds)
        except asyncio.TimeoutError:
            pass


def _read_stdin(loop: asyncio.AbstractEventLoop, streamer: Streamer, source: TextIO) -> None:
    for raw in source:
        if len(raw) > _live.INPUT_LINE_MAX:
            continue
        try:
            message = json.loads(raw)
        except ValueError:
            continue
        if isinstance(message, dict):
            loop.call_soon_threadsafe(streamer.inbox.put_nowait, message)
    loop.call_soon_threadsafe(streamer.inbox.put_nowait, None)


async def run(source: TextIO, out: TextIO) -> int:
    streamer = Streamer(out)
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        try:
            loop.add_signal_handler(signum, streamer.stopping.set)
        except (NotImplementedError, RuntimeError, ValueError):
            pass
    threading.Thread(target=_read_stdin, args=(loop, streamer, source), daemon=True).start()
    forward = asyncio.ensure_future(streamer.forward())
    connect = asyncio.ensure_future(streamer.connect())
    await streamer.stopping.wait()
    for task in (forward, connect):
        task.cancel()
    await asyncio.gather(forward, connect, return_exceptions=True)
    return 0


def main(argv: Optional[list] = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) == 2 and args[0] == _paths.TEST_ROOT_FLAG:
        _paths.use_test_root(args[1])
    elif args:
        sys.exit(2)
    sys.exit(asyncio.run(run(sys.stdin, sys.stdout)))


if __name__ == "__main__":
    main()
