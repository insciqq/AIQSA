"""Which proxy opens a site: `lib/domain/proxySelection.ts` in Python, rule for rule.

Both languages pass `lib/domain/proxySelection.vectors.json`, so a rule changes
there and in both together (`tests/test_proxy_selection.py`). Pure: no clock,
randomness or I/O, and the state goes in and comes out as plain JSON, never
changed in place. An entry and a selection are the dictionaries the vectors show.

The IDNA conversion differs from the TypeScript's in rare spellings (Python's is
IDNA 2003, so `ß` becomes `ss`). It only reaches text an agent types: hints arrive
canonical in the plan, and a browser or a client sends a host as ASCII already.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

State = Mapping[str, Any]
Entry = Mapping[str, Any]

HOST_MAX_LENGTH = 253
#: Longer text cannot shorten into a hostname by more than this; refused before any parsing.
RAW_MAX_LENGTH = HOST_MAX_LENGTH * 4
#: `PROXY_BLOCKED_HTTP_STATUSES` of `lib/contracts/proxies.ts`.
BLOCKED_HTTP_STATUSES = (401, 403, 407, 451, 498)
#: What JavaScript's `trim` removes; Python's own `strip` differs in a few characters.
_JS_SPACE = "\t\n\v\f\r                  　﻿"
#: Underscores occur in real hostnames, and a site that loses its hint must not go direct.
_LABEL = re.compile(r"[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?")
#: What WHATWG URL parsing reads as an IPv4 address, whatever comes before it.
_NUMERIC_LAST_LABEL = re.compile(r"\d+|0x[0-9a-f]*")
#: Would be read as URL syntax instead of a hostname when the IDNA conversion parses it.
_URL_SYNTAX = re.compile(r"[\s/\\?#@:\[\]%]")
#: The second level of a public zone such as `co.uk` or `com.kz`, under a two-letter country.
_PUBLIC_SECOND_LEVEL = frozenset({"ac", "co", "com", "edu", "gov", "net", "org"})


def empty_state() -> Dict[str, Dict[str, Any]]:
    return {"cursors": {}, "failed": {}, "sites": {}}


def _ascii_hostname(value: str) -> Optional[str]:
    host = value.lower()
    if host.endswith("."):
        host = host[:-1]
    if not host.isascii():
        if _URL_SYNTAX.search(host):
            return None
        try:
            host = host.encode("idna").decode("ascii").lower()
        except UnicodeError:
            return None
    if not host or len(host) > HOST_MAX_LENGTH:
        return None
    labels = host.split(".")
    if not all(_LABEL.fullmatch(label) for label in labels):
        return None
    return None if _NUMERIC_LAST_LABEL.fullmatch(labels[-1]) else host


def _trimmed(value: Any) -> Optional[str]:
    if not isinstance(value, str) or len(value) > RAW_MAX_LENGTH:
        return None
    return value.strip(_JS_SPACE) or None


def normalize_hint(value: Any) -> Optional[str]:
    """The canonical hint, or None: one label is a zone with its dot (`.kz`), more stand without one (`ozon.ru`)."""
    text = _trimmed(value)
    if text is None:
        return None
    domain = _ascii_hostname(text[1:] if text.startswith(".") else text)
    if domain is None:
        return None
    return domain if "." in domain else "." + domain


def normalize_site_host(value: Any) -> Optional[str]:
    """A hostname in the form hints match, or None: IP addresses and single labels are no domains."""
    text = _trimmed(value)
    if text is None:
        return None
    host = _ascii_hostname(text)
    return host if host is not None and "." in host else None


def site_key(host: str) -> str:
    """What stays on one proxy: the last two labels, or three under a public second level."""
    labels = host.split(".")
    count = 3 if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in _PUBLIC_SECOND_LEVEL else 2
    return ".".join(labels[-count:])


def site_of(host: str) -> str:
    """The key a host's route and outcome live under: its site, or the host itself when it is no domain."""
    normalized = normalize_site_host(host)
    return site_key(normalized) if normalized is not None else host.lower().rstrip(".")


def _hint_domain(hint: str) -> str:
    return hint[1:] if hint.startswith(".") else hint


def _hint_matches(hint: str, host: str) -> bool:
    domain = _hint_domain(hint)
    return host == domain or host.endswith("." + domain)


def _specificity(hint: str) -> int:
    return len(_hint_domain(hint).split("."))


def _best_hint(hints: Sequence[str], host: str) -> Optional[str]:
    best = None
    for hint in hints:
        if _hint_matches(hint, host) and (best is None or _specificity(hint) > _specificity(best)):
            best = hint
    return best


def _tiers(entries: Sequence[Entry], host: str) -> List[Dict[str, Any]]:
    """Two matching hints of equal length are the same string, so one hint and owner name a tier."""
    tiers: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        if not entry["active"]:
            continue
        hint = _best_hint(entry["domainHints"], host)
        if hint is None:
            continue
        key = f"{hint}|{entry['owner']}"
        tiers.setdefault(key, {"hint": hint, "key": key, "members": [], "owner": entry["owner"]})["members"].append(entry["id"])
    return sorted(tiers.values(), key=lambda tier: (-_specificity(tier["hint"]), 0 if tier["owner"] == "personal" else 1))


def _without(record: Mapping[str, Any], key: str) -> Dict[str, Any]:
    return {name: value for name, value in record.items() if name != key}


def _explicit(entries: Sequence[Entry], ref: str) -> Dict[str, Any]:
    lowered = ref.lower()
    named = sorted((entry for entry in entries if entry["name"].lower() == lowered),
                   key=lambda entry: 0 if entry["owner"] == "personal" else 1)
    entry = next((candidate for candidate in entries if candidate["id"] == ref), None) \
        or next((candidate for candidate in named if candidate["active"]), None) \
        or (named[0] if named else None)
    if entry is None:
        return {"code": "proxy_not_found", "kind": "failed", "tried": []}
    if not entry["active"]:
        return {"code": "proxy_inactive", "kind": "failed", "tried": []}
    return {"hint": None, "kind": "proxy", "proxyId": entry["id"], "reason": "explicit"}


def select(entries: Sequence[Entry], host_value: Any, state: State,
           explicit: Optional[Mapping[str, str]] = None) -> Tuple[Dict[str, Any], State]:
    """One decision and the state after it. An explicit choice reads and writes no state and is never moved on from."""
    if explicit is not None and explicit.get("kind") == "direct":
        return {"kind": "direct", "reason": "explicit"}, state
    if explicit is not None and explicit.get("kind") == "proxy":
        return _explicit(entries, explicit["ref"]), state

    host = normalize_site_host(host_value)
    if host is None:
        return {"kind": "direct", "reason": "no_match"}, state

    tiers = _tiers(entries, host)
    site = site_key(host)
    failed = state["failed"].get(site, [])
    stayed_on = state["sites"].get(site)
    if not tiers:
        if stayed_on is not None and stayed_on not in failed and any(
                entry["id"] == stayed_on and entry["active"] for entry in entries):
            return {"hint": None, "kind": "proxy", "proxyId": stayed_on, "reason": "site"}, state
        return {"kind": "direct", "reason": "no_match"}, state
    if stayed_on is not None and stayed_on not in failed:
        for tier in tiers:
            if stayed_on in tier["members"]:
                return {"hint": tier["hint"], "kind": "proxy", "proxyId": stayed_on, "reason": "site"}, state

    for tier in tiers:
        size = len(tier["members"])
        start = state["cursors"].get(tier["key"], 0) % size
        for offset in range(size):
            proxy_id = tier["members"][(start + offset) % size]
            if proxy_id in failed:
                continue
            return ({"hint": tier["hint"], "kind": "proxy", "proxyId": proxy_id, "reason": "hint"},
                    {**state, "cursors": {**state["cursors"], tier["key"]: (start + offset + 1) % size},
                     "sites": {**state["sites"], site: proxy_id}})

    # Reported once: the site's next request tries again, because no clock can say when a failed proxy has recovered.
    return ({"code": "proxy_all_failed", "kind": "failed", "tried": [member for tier in tiers for member in tier["members"]]},
            {**state, "failed": _without(state["failed"], site), "sites": _without(state["sites"], site)})


def record_failure(host_value: Any, proxy_id: str, state: State) -> State:
    """A connection through a proxy failed: the site's next selection moves on. A site that answers is no failure."""
    host = normalize_site_host(host_value)
    if host is None:
        return state
    site = site_key(host)
    failed = state["failed"].get(site, [])
    return {**state,
            "failed": state["failed"] if proxy_id in failed else {**state["failed"], site: [*failed, proxy_id]},
            "sites": _without(state["sites"], site) if state["sites"].get(site) == proxy_id else state["sites"]}


def proxies_to_try(entries: Sequence[Entry], host_value: Any) -> List[str]:
    """The active proxies a blocked result names, by id: those matching the site in selection order, then the rest."""
    host = normalize_site_host(host_value)
    matching = [] if host is None else [member for tier in _tiers(entries, host) for member in tier["members"]]
    return [*matching, *(entry["id"] for entry in entries if entry["active"] and entry["id"] not in matching)]
