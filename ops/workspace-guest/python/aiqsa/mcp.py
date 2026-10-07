"""Call the current AIQSA Workspace run's MCP tools from code.

Standard library only. The run's own authority applies: exactly the MCP
tools the chat run may use, with the run's budgets, and nothing after the
run ends. Arguments and results are never stored by AIQSA; it keeps only
content-free receipts.

    import aiqsa
    for tool in aiqsa.mcp.list_tools():
        print(tool.name, tool.server, tool.tool)
    result = aiqsa.mcp.call("GitLab/list_commits", {"project": "group/app"})
    print(result.json())

Names are exact tool names from ``list_tools()``, ``"<server>/<tool>"``, or
``"<server>.<tool>"`` as the run's summary line shows them.
Errors are typed (see ``aiqsa.errors``); ``OutcomeUnknown`` and
``ResultUnsupported`` mean a call may have run: never repeat a write
because of them.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Dict, List, Mapping, Optional

from .errors import (
    RETRYABLE_CODES,
    AgentModeUnsupported,
    AiqsaMcpError,
    GatewayUnavailable,
    InternetOff,
    InvocationClosed,
    McpOff,
    NotInWorkspace,
    ProjectUnsupported,
    ProtocolError,
    RateLimited,
    RequestTooLarge,
    TokenRevoked,
    ToolError,
    ToolUnavailable,
    error_for,
)

TOKEN_ENV = "AIQSA_RUN_TOKEN"
GATEWAY_ENV = "AIQSA_GATEWAY_URL"
INVOCATION_ENV = "AIQSA_INVOCATION_ID"
UNAVAILABLE_ENV = "AIQSA_MCP_UNAVAILABLE"
AGENT_TOKEN_ENV = "AIQSA_AGENT_TOKEN"
INVOCATION_HEADER = "x-aiqsa-invocation-id"
#: The runner relay as guests reach it; Agent runs use it without a URL variable.
DEFAULT_GATEWAY = "http://host.microsandbox.internal:4311"
#: Marks a gateway refusal, as opposed to an error answered by the tool itself.
ERROR_META = "aiqsa/error"
#: The response bound of one MCP call, with room for the JSON envelope.
RESPONSE_MAX_BYTES = 40 * 1024 * 1024

_UNAVAILABLE = {
    "internet_off": (InternetOff, "Internet is off for this Workspace, so code cannot reach MCP tools."),
    "mcp_off": (McpOff, "MCP tools are off for this chat run, or none are connected."),
    "gateway_unavailable": (GatewayUnavailable,
                            "This AIQSA installation or run cannot give code access to MCP tools."),
    "project_unsupported": (ProjectUnsupported,
                            "Code can call MCP tools in personal chats only, because members share a Project chat's "
                            "Workspace."),
}
_AGENT_INTERNAL_TOOLS = frozenset({"find_tools", "call_tool"})


class Tool:
    """One MCP tool of the run: ``name`` is the exact name to call."""

    def __init__(self, raw: Mapping[str, Any]):
        meta = raw.get("_meta") if isinstance(raw.get("_meta"), dict) else {}
        self.name: str = str(raw.get("name", ""))
        self.server: Optional[str] = meta.get("aiqsa/server") if isinstance(meta.get("aiqsa/server"), str) else None
        self.tool: str = meta.get("aiqsa/tool") if isinstance(meta.get("aiqsa/tool"), str) else str(raw.get("title") or self.name)
        self.description: str = str(raw.get("description") or "")
        schema = raw.get("inputSchema")
        self.input_schema: Dict[str, Any] = schema if isinstance(schema, dict) else {"type": "object"}
        self.raw = dict(raw)

    def __repr__(self) -> str:
        return f"Tool(name={self.name!r}, server={self.server!r}, tool={self.tool!r})"


class ToolResult:
    """A tool's answer: ``structured`` (a dict or None) and ``text`` (joined text parts)."""

    def __init__(self, raw: Mapping[str, Any]):
        content = raw.get("content")
        self.content: List[Dict[str, Any]] = [part for part in content if isinstance(part, dict)] if isinstance(content, list) else []
        structured = raw.get("structuredContent")
        self.structured: Optional[Dict[str, Any]] = structured if isinstance(structured, dict) else None
        self.text: str = "\n".join(part["text"] for part in self.content
                                   if part.get("type") == "text" and isinstance(part.get("text"), str))
        self.is_error: bool = raw.get("isError") is True
        self.raw = dict(raw)

    def json(self) -> Any:
        """Structured content, else the text parsed as JSON."""
        if self.structured is not None:
            return self.structured
        try:
            return json.loads(self.text)
        except ValueError as error:
            raise ProtocolError("The tool answered with text that is not JSON.") from error

    def __str__(self) -> str:
        return self.text if self.text or self.structured is None else json.dumps(self.structured, ensure_ascii=False)

    def __repr__(self) -> str:
        return f"ToolResult(is_error={self.is_error!r}, text={self.text[:80]!r})"


def _parse_message(body: bytes) -> Dict[str, Any]:
    """One JSON-RPC message, sent either as JSON or as one SSE event."""
    text = body.decode("utf-8")
    stripped = text.lstrip()
    if stripped.startswith("{"):
        payload = stripped
    else:
        lines = [line[5:].lstrip() for line in text.splitlines() if line.startswith("data:")]
        if not lines:
            raise ProtocolError("The gateway sent no JSON-RPC message.")
        payload = lines[-1]
    try:
        message = json.loads(payload)
    except ValueError as error:
        raise ProtocolError("The gateway sent malformed JSON.") from error
    if not isinstance(message, dict):
        raise ProtocolError("The gateway sent an unexpected message.")
    return message


class Client:
    """MCP access of the current run, configured from the environment by default."""

    def __init__(self, *, environ: Optional[Mapping[str, str]] = None, timeout: float = 660.0,
                 retry_seconds: float = 30.0):
        env = os.environ if environ is None else environ
        self.timeout = timeout
        self.retry_seconds = retry_seconds
        self._tools: Optional[List[Tool]] = None
        token = env.get(TOKEN_ENV)
        agent_token = env.get(AGENT_TOKEN_ENV)
        if token:
            self.mode = "code"
            self.token = token
            self.gateway = (env.get(GATEWAY_ENV) or DEFAULT_GATEWAY).rstrip("/")
            self.invocation = env.get(INVOCATION_ENV) or None
        elif agent_token:
            self.mode = "agent"
            self.token = agent_token
            self.gateway = (env.get(GATEWAY_ENV) or DEFAULT_GATEWAY).rstrip("/")
            self.invocation = None
        else:
            self.mode = "unavailable"
            self.token = ""
            self.gateway = ""
            self.invocation = None
            self._reason = env.get(UNAVAILABLE_ENV) or ""

    # --- public API -----------------------------------------------------

    def list_tools(self) -> List[Tool]:
        """The run's MCP tools, as the run's current permissions allow."""
        self._require_access()
        if self.mode == "agent":
            tools = self._list()
            if any(tool.name == "call_tool" for tool in tools):
                raise AgentModeUnsupported(
                    "This Agent run uses MCP Auto: tools are not listed. call(name, arguments) with an exact "
                    "tool name or \"<server>/<tool>\" still works.")
            return [tool for tool in tools if tool.name not in _AGENT_INTERNAL_TOOLS]
        return list(self._list())

    def call(self, name: str, arguments: Optional[Mapping[str, Any]] = None, *, timeout: Optional[float] = None) -> ToolResult:
        """Call one tool by exact name, ``"<server>/<tool>"`` or ``"<server>.<tool>"``; raises a typed error on failure."""
        if not isinstance(name, str) or not name:
            raise ToolUnavailable("A tool name is required.")
        if arguments is not None and not isinstance(arguments, Mapping):
            raise AiqsaMcpError("Arguments must be a JSON object.", code="invalid_arguments")
        args = dict(arguments or {})
        self._require_access()
        if self.mode == "agent":
            return self._agent_call(name, args, timeout)
        return self._tool_call(self._resolve(name), args, timeout)

    # --- internals ------------------------------------------------------

    def _require_access(self) -> None:
        if self.mode == "unavailable":
            reason = self._reason
            if reason in _UNAVAILABLE:
                cls, message = _UNAVAILABLE[reason]
                raise cls(message)
            raise NotInWorkspace("Not inside an AIQSA Workspace command: no run token is set.")
        if self.mode == "code" and not self.invocation:
            raise InvocationClosed(
                f"{INVOCATION_ENV} is missing: only processes started by a Workspace command of this run can call MCP tools.")

    def _list(self) -> List[Tool]:
        if self._tools is None:
            result = self._rpc("tools/list", {}, self.timeout)
            tools = result.get("tools")
            if not isinstance(tools, list):
                raise ProtocolError("The gateway sent no tool list.")
            self._tools = [Tool(tool) for tool in tools if isinstance(tool, dict)]
        return self._tools

    def _resolve(self, name: str) -> str:
        """Exact names pass; ``server/tool``, ``server.tool`` or a unique tool name is looked up once."""
        if "/" not in name and name.startswith("mcp_"):
            return name
        tools = self._list()
        if any(tool.name == name for tool in tools):
            return name
        wanted = name.casefold()
        if "/" in name:
            server, _, tool_name = name.rpartition("/")
            matches = [tool for tool in tools if (tool.server or "").casefold() == server.strip().casefold()
                       and tool.tool.casefold() == tool_name.strip().casefold()]
        else:
            matches = [tool for tool in tools if tool.tool.casefold() == wanted]
            if not matches and "." in name:
                # The form the run's summary line shows: "<server>.<tool>".
                matches = [tool for tool in tools if tool.server is not None
                           and f"{tool.server}.{tool.tool}".casefold() == wanted]
        if len(matches) == 1:
            return matches[0].name
        if len(matches) > 1:
            raise ToolUnavailable(f"{name!r} matches several tools; use \"<server>/<tool>\" or the exact name.")
        raise ToolUnavailable(f"No MCP tool {name!r} in this run. list_tools() shows the available names.")

    def _tool_call(self, name: str, arguments: Dict[str, Any], timeout: Optional[float]) -> ToolResult:
        deadline = time.monotonic() + self.retry_seconds
        delay = 0.2
        while True:
            try:
                return self._settled(self._rpc("tools/call", {"name": name, "arguments": arguments}, timeout or self.timeout))
            except AiqsaMcpError as error:
                # Refused before anything was sent: waiting can clear it.
                if error.code not in RETRYABLE_CODES or time.monotonic() + delay > deadline:
                    if error.code in RETRYABLE_CODES:
                        raise RateLimited(error.message, code=error.code, details=error.details) from None
                    raise
            time.sleep(delay)
            delay = min(delay * 2, 2.0)

    def _settled(self, result: Dict[str, Any]) -> ToolResult:
        if result.get("isError") is not True:
            return ToolResult(result)
        structured = result.get("structuredContent")
        meta = result.get("_meta") if isinstance(result.get("_meta"), dict) else {}
        if meta.get(ERROR_META) is True and isinstance(structured, dict) and isinstance(structured.get("code"), str):
            details = {key: value for key, value in structured.items() if key not in ("code", "message")}
            raise error_for(structured["code"], str(structured.get("message") or ""), details)
        if self.mode == "agent":
            refusal = self._agent_refusal(result)
            if refusal:
                raise refusal
        tool_result = ToolResult(result)
        raise ToolError(tool_result.text or "The tool answered with an error.", result=tool_result)

    @staticmethod
    def _agent_refusal(result: Dict[str, Any]) -> Optional[AiqsaMcpError]:
        """The Agent gateway reports its own refusals as JSON text with a code."""
        text = ToolResult(result).text
        try:
            value = json.loads(text) if text.lstrip().startswith("{") else None
        except ValueError:
            value = None
        if isinstance(value, dict) and isinstance(value.get("code"), str) and \
                (value["code"].startswith("agent_") or value["code"] in ("tool_unavailable", "tool_definition_changed",
                                                                         "invalid_arguments", "upstream_unavailable",
                                                                         "authorization_required", "result_unsupported",
                                                                         "discovery_unavailable")):
            return error_for(value["code"], str(value.get("message") or ""))
        return None

    def _agent_call(self, name: str, arguments: Dict[str, Any], timeout: Optional[float]) -> ToolResult:
        """Agent runs keep their own MCP surface: exact tools, or find_tools and call_tool in Auto."""
        tools = self._list()
        names = {tool.name for tool in tools}
        if name in names and name not in _AGENT_INTERNAL_TOOLS:
            return self._settled(self._rpc("tools/call", {"name": name, "arguments": arguments}, timeout or self.timeout))
        if "call_tool" not in names:
            raise ToolUnavailable(f"No MCP tool {name!r} in this Agent run.")
        found = ToolResult(self._rpc("tools/call", {"name": "find_tools", "arguments": {"query": f"select:{name}"}},
                                     self.timeout))
        if found.is_error:
            self._settled(found.raw)
        try:
            descriptors = found.json().get("tools", [])
        except (ProtocolError, AttributeError):
            descriptors = []
        matches = [item for item in descriptors if isinstance(item, dict) and isinstance(item.get("tool_id"), str)
                   and isinstance(item.get("tool_version"), str)]
        exact = [item for item in matches if item["tool_id"] == name]
        chosen = exact or (matches if len(matches) == 1 else [])
        if not chosen:
            raise ToolUnavailable(f"No MCP tool {name!r} in this Agent run.")
        return self._settled(self._rpc("tools/call", {"name": "call_tool", "arguments": {
            "tool_id": chosen[0]["tool_id"], "tool_version": chosen[0]["tool_version"], "arguments": arguments}},
            timeout or self.timeout))

    def _rpc(self, method: str, params: Dict[str, Any], timeout: float) -> Dict[str, Any]:
        body = json.dumps({"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method, "params": params},
                          ensure_ascii=False).encode("utf-8")
        headers = {"authorization": f"Bearer {self.token}", "content-type": "application/json",
                   "accept": "application/json, text/event-stream"}
        if self.invocation:
            headers[INVOCATION_HEADER] = self.invocation
        request = urllib.request.Request(f"{self.gateway}/mcp", data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed relay origin
                raw = response.read(RESPONSE_MAX_BYTES + 1)
        except urllib.error.HTTPError as error:
            raise self._http_error(error) from None
        except (urllib.error.URLError, OSError) as error:
            raise GatewayUnavailable(
                "Cannot reach the AIQSA run gateway from this Workspace (Internet off, or the installation has no "
                f"code access to MCP): {getattr(error, 'reason', error)}") from None
        if len(raw) > RESPONSE_MAX_BYTES:
            raise ProtocolError("The gateway response is too large.")
        message = _parse_message(raw)
        if isinstance(message.get("error"), dict):
            error = message["error"]
            text = str(error.get("message") or "")
            if error.get("code") == -32602 and "not found" in text:
                raise ToolUnavailable(f"No MCP tool with this exact name in this run: {text}")
            raise ProtocolError(text or "The gateway refused the request.", details={"rpc_code": error.get("code")})
        result = message.get("result")
        if not isinstance(result, dict):
            raise ProtocolError("The gateway sent no result.")
        return result

    @staticmethod
    def _http_error(error: urllib.error.HTTPError) -> AiqsaMcpError:
        try:
            value = json.loads(error.read(65536).decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError, OSError):
            value = {}
        value = value if isinstance(value, dict) else {}
        if error.code == 401:
            return TokenRevoked("The run's MCP access has ended: the run finished or was stopped, or this token was replaced.")
        if error.code == 403:
            return InvocationClosed("Only a process of a running Workspace command of this run can call MCP tools.")
        if error.code == 404:
            return McpOff("MCP tools are off for this run.")
        if error.code == 413:
            return RequestTooLarge("The call's arguments exceed the MCP request limit.", details={"maxBytes": value.get("maxBytes")})
        if isinstance(value.get("code"), str):
            return error_for(value["code"], str(value.get("message") or ""))
        return GatewayUnavailable(f"The AIQSA run gateway answered HTTP {error.code}.")


_default: Optional[Client] = None


def client() -> Client:
    """The process-wide client configured from this process's environment."""
    global _default
    if _default is None:
        _default = Client()
    return _default


def list_tools() -> List[Tool]:
    """The run's MCP tools. See ``Client.list_tools``."""
    return client().list_tools()


def call(name: str, arguments: Optional[Mapping[str, Any]] = None, *, timeout: Optional[float] = None) -> ToolResult:
    """Call one MCP tool of the run. See ``Client.call``."""
    return client().call(name, arguments, timeout=timeout)
