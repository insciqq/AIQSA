"""``aiqsa-mcp``: the current Workspace run's MCP tools from any language.

    aiqsa-mcp list [--json]
    aiqsa-mcp call NAME [--json ARGS | --json-file PATH | --stdin] [--raw] [--timeout SECONDS]

A result goes to stdout (structured content as JSON, else the text); a
failure goes to stderr as JSON ``{"error": {"code": ..., "message": ...}}``
with a stable exit code.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, List, Optional, TextIO

from . import __version__
from .errors import (
    AiqsaMcpError,
    AuthorizationRequired,
    BudgetExhausted,
    InvalidArguments,
    InvocationClosed,
    McpUnavailable,
    OutcomeUnknown,
    RateLimited,
    ResultUnsupported,
    TokenRevoked,
    ToolDefinitionChanged,
    ToolError,
    ToolUnavailable,
)
from .mcp import Client

EXIT_USAGE = 2
EXIT_UNAVAILABLE = 3
EXIT_ACCESS = 4
EXIT_BUDGET = 5
EXIT_TOOL = 6
EXIT_TOOL_ERROR = 7
EXIT_UNKNOWN_OUTCOME = 8


def exit_code(error: AiqsaMcpError) -> int:
    if isinstance(error, McpUnavailable):
        return EXIT_UNAVAILABLE
    if isinstance(error, (TokenRevoked, InvocationClosed, AuthorizationRequired)):
        return EXIT_ACCESS
    if isinstance(error, (BudgetExhausted, RateLimited)):
        return EXIT_BUDGET
    if isinstance(error, (ToolUnavailable, ToolDefinitionChanged, InvalidArguments)):
        return EXIT_TOOL
    if isinstance(error, ToolError):
        return EXIT_TOOL_ERROR
    if isinstance(error, (OutcomeUnknown, ResultUnsupported)):
        return EXIT_UNKNOWN_OUTCOME
    return 1


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # type: ignore[override]
        raise _UsageError(message)


class _UsageError(Exception):
    pass


def _parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="aiqsa-mcp", description="Call the current AIQSA Workspace run's MCP tools.")
    parser.add_argument("--version", action="version", version=f"aiqsa-mcp {__version__}")
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    listing = commands.add_parser("list", help="List the run's MCP tools.")
    listing.add_argument("--json", action="store_true", help="Print the tools as a JSON array.")
    calling = commands.add_parser("call", help="Call one tool by exact name or <server>/<tool>.")
    calling.add_argument("name")
    source = calling.add_mutually_exclusive_group()
    source.add_argument("--json", dest="arguments", metavar="ARGS", help="Arguments as a JSON object.")
    source.add_argument("--json-file", metavar="PATH", help="Read the arguments JSON object from a file.")
    source.add_argument("--stdin", action="store_true", help="Read the arguments JSON object from stdin.")
    calling.add_argument("--raw", action="store_true", help="Print the whole MCP result as JSON.")
    calling.add_argument("--timeout", type=float, default=None, metavar="SECONDS")
    return parser


def _arguments(parsed: argparse.Namespace, stdin: TextIO) -> Any:
    if parsed.json_file:
        with open(parsed.json_file, "r", encoding="utf-8") as stream:
            text = stream.read()
    elif parsed.stdin:
        text = stdin.read()
    else:
        text = parsed.arguments if parsed.arguments is not None else "{}"
    try:
        value = json.loads(text)
    except ValueError as error:
        raise _UsageError(f"arguments are not valid JSON: {error}") from None
    if not isinstance(value, dict):
        raise _UsageError("arguments must be a JSON object")
    return value


def _fail(error: AiqsaMcpError, stderr: TextIO) -> int:
    stderr.write(json.dumps({"error": error.to_dict()}, ensure_ascii=False) + "\n")
    return exit_code(error)


def main(argv: Optional[List[str]] = None, *, client: Optional[Client] = None,
         stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr, stdin: TextIO = sys.stdin) -> int:
    try:
        parsed = _parser().parse_args(argv)
        arguments = _arguments(parsed, stdin) if parsed.command == "call" else None
    except _UsageError as error:
        stderr.write(json.dumps({"error": {"code": "usage", "message": str(error)}}) + "\n")
        return EXIT_USAGE
    except OSError as error:
        stderr.write(json.dumps({"error": {"code": "usage", "message": f"cannot read arguments: {error.strerror}"}}) + "\n")
        return EXIT_USAGE
    active = client or Client()
    try:
        if parsed.command == "list":
            tools = active.list_tools()
            if parsed.json:
                stdout.write(json.dumps([{"description": tool.description, "input_schema": tool.input_schema,
                                          "name": tool.name, "server": tool.server, "tool": tool.tool}
                                         for tool in tools], ensure_ascii=False) + "\n")
            else:
                for tool in tools:
                    label = f"{tool.server}/{tool.tool}" if tool.server else tool.tool
                    summary = " ".join(tool.description.split())[:120]
                    stdout.write(f"{tool.name}\t{label}\t{summary}\n")
            return 0
        result = active.call(parsed.name, arguments, timeout=parsed.timeout)
        if parsed.raw:
            stdout.write(json.dumps(result.raw, ensure_ascii=False) + "\n")
        elif result.structured is not None:
            stdout.write(json.dumps(result.structured, ensure_ascii=False) + "\n")
        else:
            stdout.write(result.text + ("" if result.text.endswith("\n") else "\n"))
        return 0
    except AiqsaMcpError as error:
        return _fail(error, stderr)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
