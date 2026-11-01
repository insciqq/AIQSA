"""The address rule inside the guest: `networkAddressScope` and `isRefusedProxyTarget` in Python.

The server checked a proxy's own address at admission (`lib/server/proxies/address.ts`); the guest repeats it
before every connection, because a name can change. A target going through a proxy is resolved by the proxy, so
only a target that names its address can be refused here. The lists equal those of `lib/server/mcp/safeFetch.ts`
(`tests/test_proxy_forwarder.py` reads them from there).
"""

from __future__ import annotations

import ipaddress
import re
from typing import Optional

#: `ipv4AddressScope` calls every one of these other than public.
BLOCKED_IPV4 = tuple(ipaddress.ip_network(cidr) for cidr in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
    "192.0.2.0/24", "192.31.196.0/24", "192.52.193.0/24", "192.88.99.0/24", "192.168.0.0/16", "192.175.48.0/24",
    "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"))
BLOCKED_IPV6 = tuple(ipaddress.ip_network(cidr) for cidr in (
    "::/96", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16",
    "2620:4f:8000::/48", "3fff::/20", "5f00::/16", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"))
_IPV6_LOOPBACK = ipaddress.ip_address("::1")
_IPV4_MAPPED = ipaddress.ip_network("::ffff:0:0/96")
#: A last label that WHATWG URL parsing reads as a number, so the whole host is an IPv4 address or invalid.
_ENDS_IN_NUMBER = re.compile(r"\d+|0[xX][0-9a-fA-F]*")


def is_public_address(value: str) -> bool:
    """True only for a global unicast address; anything unparseable, or with a zone id, is not one."""
    if "%" in value:
        return False
    try:
        parsed = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(parsed, ipaddress.IPv6Address):
        if parsed == _IPV6_LOOPBACK:
            return False
        if parsed in _IPV4_MAPPED:
            return not any(parsed.ipv4_mapped in cidr for cidr in BLOCKED_IPV4)
        return not any(parsed in cidr for cidr in BLOCKED_IPV6)
    return not any(parsed in cidr for cidr in BLOCKED_IPV4)


def _ipv4_number(part: str) -> Optional[int]:
    if not part:
        return None
    try:
        if part[:2] in ("0x", "0X"):
            return int(part[2:], 16) if part[2:] else 0
        if len(part) > 1 and part[0] == "0":
            return int(part[1:], 8)
        return int(part, 10)
    except ValueError:
        return None


def _whatwg_ipv4(host: str) -> Optional[str]:
    """`2130706433`, `0x7f.1`, `127.1` and `0177.0.0.1` mean the addresses a URL parser reads in them; None when invalid."""
    parts = host.split(".")
    if len(parts) > 4:
        return None
    numbers = [_ipv4_number(part) for part in parts]
    if any(number is None for number in numbers):
        return None
    if any(number > 255 for number in numbers[:-1]) or numbers[-1] >= 256 ** (5 - len(numbers)):  # type: ignore[operator]
        return None
    value = numbers[-1]
    for index, number in enumerate(numbers[:-1]):
        value += number * 256 ** (3 - index)  # type: ignore[operator]
    return str(ipaddress.IPv4Address(value))


class _Invalid:
    """A host that reads as an address but is none: never a name to pass on."""


INVALID = _Invalid()


def literal_address(value: str):
    """The canonical address a host field names, `INVALID` for a malformed one, or None for a name."""
    host = value.strip().lower()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    if host.endswith("."):
        host = host[:-1]
    if ":" in host:
        if "%" in host:
            return INVALID
        try:
            return str(ipaddress.IPv6Address(host))
        except ValueError:
            return INVALID
    if _ENDS_IN_NUMBER.fullmatch(host.rsplit(".", 1)[-1]):
        return _whatwg_ipv4(host) or INVALID
    return None


def is_local_name(host: str) -> bool:
    name = host.strip().lower().rstrip(".")
    return name == "localhost" or name.endswith(".localhost")


def is_refused_target(host: str) -> bool:
    """Never send a private address, or a local name, to a proxy. Hostnames are the proxy's to resolve."""
    if not host.isascii() or is_local_name(host):
        return True
    literal = literal_address(host)
    if literal is None:
        return False
    return literal is INVALID or not is_public_address(literal)
