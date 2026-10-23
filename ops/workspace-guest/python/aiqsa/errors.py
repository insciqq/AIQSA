"""Typed errors of the AIQSA guest client. Every error has a stable ``code``."""

from __future__ import annotations

from typing import Any, Dict, Optional


class AiqsaMcpError(Exception):
    """Base class: ``code`` is stable, ``message`` is for people."""

    code = "aiqsa_mcp_error"

    def __init__(self, message: str, *, code: Optional[str] = None, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        if code:
            self.code = code
        self.message = message
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        return {"code": self.code, "message": self.message, **({"details": self.details} if self.details else {})}


class McpUnavailable(AiqsaMcpError):
    """No MCP access from code in this context; nothing was sent."""

    code = "mcp_unavailable"


class NotInWorkspace(McpUnavailable):
    code = "not_in_workspace"


class InternetOff(McpUnavailable):
    code = "internet_off"


class McpOff(McpUnavailable):
    code = "mcp_off"


class GatewayUnavailable(McpUnavailable):
    code = "gateway_unavailable"


class AgentModeUnsupported(McpUnavailable):
    """The operation exists only for ordinary Workspace runs, not inside an Agent run."""

    code = "agent_mode_unsupported"


class TokenRevoked(AiqsaMcpError):
    """The run ended, was stopped, or its access was replaced: start a new request."""

    code = "token_revoked"


class InvocationClosed(AiqsaMcpError):
    """Only a process of a running Workspace command may call; background leftovers may not."""

    code = "code_invocation_closed"


class BudgetExhausted(AiqsaMcpError):
    """The run's MCP call budget for code is used up; later calls are refused too."""

    code = "code_mcp_call_limit"


class RateLimited(AiqsaMcpError):
    """Too many calls in progress or per second, still after retrying."""

    code = "code_mcp_rate_limited"


class ToolUnavailable(AiqsaMcpError):
    code = "tool_unavailable"


class ToolDefinitionChanged(AiqsaMcpError):
    code = "tool_definition_changed"


class InvalidArguments(AiqsaMcpError):
    """``details["input_schema"]`` holds the tool's schema when the gateway knows it."""

    code = "invalid_arguments"


class AuthorizationRequired(AiqsaMcpError):
    """The MCP server needs the user to sign in again in AIQSA."""

    code = "authorization_required"


class UpstreamUnavailable(AiqsaMcpError):
    code = "upstream_unavailable"


class OutcomeUnknown(AiqsaMcpError):
    """The call was sent but its outcome is unknown: never repeat a write because of it."""

    code = "execution_outcome_unknown"


class ResultUnsupported(AiqsaMcpError):
    """The tool ran, but its response was unreadable: do not repeat a write because of it."""

    code = "result_unsupported"


class Cancelled(AiqsaMcpError):
    code = "request_cancelled"


class RequestTooLarge(AiqsaMcpError):
    code = "request_too_large"


class ToolError(AiqsaMcpError):
    """The tool itself answered with an error; ``result`` holds its answer."""

    code = "tool_error"

    def __init__(self, message: str, *, result: Any = None, **kwargs: Any):
        super().__init__(message, **kwargs)
        self.result = result


class ProtocolError(AiqsaMcpError):
    code = "protocol_error"


_BY_CODE = {
    "agent_mcp_call_limit": BudgetExhausted,
    "authorization_required": AuthorizationRequired,
    "code_invocation_closed": InvocationClosed,
    "code_invocation_required": InvocationClosed,
    "code_mcp_busy": RateLimited,
    "code_mcp_call_limit": BudgetExhausted,
    "code_mcp_rate_limited": RateLimited,
    "code_token_revoked": TokenRevoked,
    "discovery_unavailable": UpstreamUnavailable,
    "execution_outcome_unknown": OutcomeUnknown,
    "invalid_arguments": InvalidArguments,
    "mcp_response_too_large": OutcomeUnknown,
    "request_cancelled": Cancelled,
    "result_unsupported": ResultUnsupported,
    "tool_definition_changed": ToolDefinitionChanged,
    "tool_unavailable": ToolUnavailable,
    "upstream_unavailable": UpstreamUnavailable,
}

#: Refusals before anything was sent that clear up by waiting.
RETRYABLE_CODES = frozenset({"code_mcp_busy", "code_mcp_rate_limited"})


def error_for(code: str, message: str, details: Optional[Dict[str, Any]] = None) -> AiqsaMcpError:
    """The typed error of a stable gateway code; unknown codes stay generic."""
    cls = _BY_CODE.get(code, AiqsaMcpError)
    return cls(message or code, code=code, details=details)
