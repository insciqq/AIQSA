"""Opening one connection for the forwarder: to a site directly, or through an HTTP, HTTPS or SOCKS5 proxy.

Every socket here is an ordinary one of the VM, so the session's egress policy applies to it as to any command:
default deny, public networks only, and Internet Off stops all of it. On top of that, each connection repeats the
address rule first and connects only to the addresses it checked. Failures carry stable codes and no text from a
peer, so nothing a proxy says, and no credential, reaches a log or an answer.
"""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import re
import socket
import ssl
from typing import Any, Awaitable, Callable, List, Mapping, Optional, Sequence, Tuple

from . import address

#: Each read buffer; also bounds a response head.
STREAM_LIMIT = 256 * 1024
HEAD_END = b"\r\n\r\n"
_STATUS = re.compile(rb"HTTP/1\.[01] (\d{3})(?: [^\r\n]*)?")

Stream = Tuple[asyncio.StreamReader, asyncio.StreamWriter]
Resolver = Callable[[str, int], Awaitable[List[str]]]


class UpstreamFailure(Exception):
    """One connection attempt failed; `code` is stable (`PROXY_CONNECTION_FAILURE_CODES` and the `site_*` codes)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


async def system_resolver(host: str, port: int) -> List[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


def authority(host: str, port: int) -> str:
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


def _basic(login: Optional[str], password: Optional[str]) -> str:
    return base64.b64encode(f"{login or ''}:{password or ''}".encode("utf-8")).decode("ascii")


def _close(writer: asyncio.StreamWriter) -> None:
    try:
        writer.transport.abort()
    except (OSError, RuntimeError):
        pass


class Network:
    """`resolver`, `allow_local` and `tls` are test seams; the forwarder's `main` only ever sets them under a test root."""

    def __init__(self, resolver: Optional[Resolver] = None, allow_local: bool = False, tls: Optional[ssl.SSLContext] = None):
        self.resolver = resolver or system_resolver
        self.allow_local = allow_local
        self.tls = tls

    def _tls(self) -> ssl.SSLContext:
        # Certificates and the name are always verified: a proxy's password never goes to whoever answers.
        return self.tls or ssl.create_default_context()

    async def addresses(self, host: str, port: int, *, dns_code: str, forbidden_code: str) -> List[str]:
        """The addresses to connect to: every one must pass, so a name with one public and one private answer is refused."""
        if self.allow_local:
            literal = address.literal_address(host)
            return [literal] if isinstance(literal, str) else await self.resolver(host, port)
        if not host.isascii() or address.is_local_name(host):
            raise UpstreamFailure(forbidden_code)
        literal = address.literal_address(host)
        if literal is address.INVALID:
            raise UpstreamFailure(forbidden_code)
        if isinstance(literal, str):
            answers = [literal]
        else:
            try:
                answers = await self.resolver(host, port)
            except (OSError, UnicodeError):
                raise UpstreamFailure(dns_code) from None
            if not answers:
                raise UpstreamFailure(dns_code)
        if not all(address.is_public_address(answer) for answer in answers):
            raise UpstreamFailure(forbidden_code)
        return answers

    async def _tcp(self, answers: Sequence[str], port: int, *, connect_code: str, tls: Optional[ssl.SSLContext] = None,
                   server_hostname: Optional[str] = None) -> Stream:
        code = connect_code
        for answer in answers:
            try:
                return await asyncio.open_connection(answer, port, limit=STREAM_LIMIT, ssl=tls, server_hostname=server_hostname)
            except ssl.SSLError:
                code = "proxy_tls_failed"
            except OSError:
                code = connect_code
        raise UpstreamFailure(code)

    async def open_direct(self, host: str, port: int) -> Stream:
        answers = await self.addresses(host, port, dns_code="site_dns_failed", forbidden_code="proxy_target_refused")
        return await self._tcp(answers, port, connect_code="site_connect_failed")

    async def open_proxy(self, proxy: Mapping[str, Any], host: str, port: int, *, tunnel: bool = True) -> Stream:
        """A stream to `host:port` through `proxy`; with `tunnel=False` an HTTP proxy's own socket, for an absolute-form request."""
        answers = await self.addresses(proxy["host"], proxy["port"], dns_code="proxy_dns_failed", forbidden_code="proxy_address_forbidden")
        secure = proxy["protocol"] == "https"
        reader, writer = await self._tcp(answers, proxy["port"], connect_code="proxy_connect_failed",
                                         tls=self._tls() if secure else None, server_hostname=proxy["host"] if secure else None)
        try:
            if proxy["protocol"] == "socks5":
                await _socks5(reader, writer, proxy, host, port)
            elif tunnel:
                await _http_connect(reader, writer, proxy, host, port)
        except UpstreamFailure:
            _close(writer)
            raise
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            _close(writer)
            raise UpstreamFailure("proxy_protocol_error") from None
        except ssl.SSLError:
            _close(writer)
            raise UpstreamFailure("proxy_tls_failed") from None
        except OSError:
            _close(writer)
            raise UpstreamFailure("proxy_connect_failed") from None
        except BaseException:
            _close(writer)
            raise
        return reader, writer


def proxy_authorization(proxy: Mapping[str, Any]) -> Optional[str]:
    """The header line's value, or None for a proxy without a login."""
    return None if proxy["login"] is None else "Basic " + _basic(proxy["login"], proxy["password"])


async def _http_connect(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, proxy: Mapping[str, Any], host: str, port: int) -> None:
    target = authority(host, port)
    lines = [f"CONNECT {target} HTTP/1.1", f"Host: {target}", "Proxy-Connection: keep-alive"]
    credentials = proxy_authorization(proxy)
    if credentials is not None:
        lines.append(f"Proxy-Authorization: {credentials}")
    writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
    await writer.drain()
    head = await reader.readuntil(HEAD_END)
    match = _STATUS.fullmatch(head.split(b"\r\n", 1)[0])
    if match is None:
        raise UpstreamFailure("proxy_protocol_error")
    status = int(match.group(1))
    if status == 407:
        raise UpstreamFailure("proxy_auth_failed")
    if not 200 <= status < 300:
        # The proxy refused the tunnel: the site never answered, so this is the proxy's failure, never the site's.
        raise UpstreamFailure("proxy_connect_failed")


async def _socks5(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, proxy: Mapping[str, Any], host: str, port: int) -> None:
    login = proxy["login"]
    writer.write(b"\x05\x02\x02\x00" if login is not None else b"\x05\x01\x00")
    await writer.drain()
    version, method = await reader.readexactly(2)
    if version != 5:
        raise UpstreamFailure("proxy_protocol_error")
    if method == 0xFF:
        raise UpstreamFailure("proxy_auth_failed")
    if method == 2:
        if login is None:
            raise UpstreamFailure("proxy_auth_failed")
        name, secret = login.encode("utf-8"), (proxy["password"] or "").encode("utf-8")
        if len(name) > 255 or len(secret) > 255:
            raise UpstreamFailure("proxy_auth_failed")
        writer.write(b"\x01" + bytes([len(name)]) + name + bytes([len(secret)]) + secret)
        await writer.drain()
        _, status = await reader.readexactly(2)
        if status != 0:
            raise UpstreamFailure("proxy_auth_failed")
    elif method != 0:
        raise UpstreamFailure("proxy_protocol_error")
    writer.write(b"\x05\x01\x00" + _socks_address(host) + port.to_bytes(2, "big"))
    await writer.drain()
    version, reply, _, kind = await reader.readexactly(4)
    if version != 5:
        raise UpstreamFailure("proxy_protocol_error")
    if reply != 0:
        raise UpstreamFailure("proxy_connect_failed")
    if kind == 1:
        await reader.readexactly(4 + 2)
    elif kind == 4:
        await reader.readexactly(16 + 2)
    elif kind == 3:
        await reader.readexactly((await reader.readexactly(1))[0] + 2)
    else:
        raise UpstreamFailure("proxy_protocol_error")


def _socks_address(host: str) -> bytes:
    """A name goes as a name, so the proxy resolves it and the guest's DNS never sees it."""
    try:
        parsed = ipaddress.ip_address(host)
    except ValueError:
        name = host.encode("ascii")
        if len(name) > 255:
            raise UpstreamFailure("proxy_protocol_error") from None
        return b"\x03" + bytes([len(name)]) + name
    return (b"\x01" if parsed.version == 4 else b"\x04") + parsed.packed
