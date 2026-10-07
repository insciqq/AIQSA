"""Guest client tests against a local fake of the run gateway (standard library only).

Run: python3 -m unittest discover -s ops/workspace-guest/python/tests -t ops/workspace-guest/python
"""

from __future__ import annotations

import io
import json
import os
import socket
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa import errors, mcp  # noqa: E402
from aiqsa.cli import main  # noqa: E402

TOKEN = "T" * 43
INVOCATION = "a" * 32
COMMITS = "mcp_gitlab_list_commits_0000000000"
TOOLS = [
    {"name": COMMITS, "title": "list_commits", "description": "List commits", "inputSchema": {"type": "object"},
     "_meta": {"aiqsa/server": "GitLab", "aiqsa/tool": "list_commits"}},
    {"name": "mcp_gitlab_get_job_log_1111111111", "title": "get_job_log", "description": "Job log",
     "inputSchema": {"type": "object"}, "_meta": {"aiqsa/server": "GitLab", "aiqsa/tool": "get_job_log"}},
    {"name": "mcp_wiki_list_commits_2222222222", "title": "list_commits", "description": "Wiki history",
     "inputSchema": {"type": "object"}, "_meta": {"aiqsa/server": "Wiki", "aiqsa/tool": "list_commits"}},
]


def refusal(code: str, message: str = "refused", **detail: Any) -> Dict[str, Any]:
    value = {"code": code, "dispatched": False, "message": message, **detail}
    return {"content": [{"type": "text", "text": json.dumps(value)}], "structuredContent": value, "isError": True,
            "_meta": {"aiqsa/error": True}}


class FakeGateway:
    """Answers like the run gateway behind the relay: SSE-framed JSON-RPC."""

    def __init__(self, agent: bool = False):
        self.agent = agent
        self.requests: List[Dict[str, Any]] = []
        self.busy = 0
        self.status = 200
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: Any) -> None:
                pass

            def do_POST(self) -> None:  # noqa: N802 - http.server API
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                gateway.requests.append({"body": body, "headers": {key.lower(): value for key, value in self.headers.items()},
                                         "path": self.path})
                if gateway.status != 200:
                    return self.reply(gateway.status, {"error": "refused"})
                if self.headers.get("authorization") != f"Bearer {TOKEN}":
                    return self.reply(401, {"error": "agent_authorization_required"})
                if not gateway.agent and self.headers.get("x-aiqsa-invocation-id") != INVOCATION:
                    return self.reply(403, {"error": "code_invocation_required"})
                result = gateway.agent_answer(body) if gateway.agent else gateway.answer(body)
                message = {"jsonrpc": "2.0", "id": body["id"], **result}
                data = f"event: message\ndata: {json.dumps(message)}\n\n".encode()
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def reply(self, status: int, value: Dict[str, Any]) -> None:
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def answer(self, body: Dict[str, Any]) -> Dict[str, Any]:
        if body["method"] == "tools/list":
            return {"result": {"tools": TOOLS}}
        name, args = body["params"]["name"], body["params"].get("arguments", {})
        if name == COMMITS:
            return {"result": {"content": [{"type": "text", "text": "2 commits"}],
                               "structuredContent": {"commits": ["a", "b"], "project": args.get("project")}}}
        if name == "mcp_gitlab_get_job_log_1111111111":
            if self.busy:
                self.busy -= 1
                return {"result": refusal("code_mcp_busy")}
            return {"result": {"content": [{"type": "text", "text": "log line"}]}}
        if name == "mcp_upstream_error_3333333333":
            return {"result": {"content": [{"type": "text", "text": "GitLab says 500"}], "isError": True}}
        if name == "mcp_budget_4444444444":
            return {"result": refusal("code_mcp_call_limit")}
        if name == "mcp_schema_5555555555":
            return {"result": refusal("invalid_arguments", input_schema={"type": "object", "required": ["project"]})}
        if name == "mcp_unknown_outcome_6666666666":
            return {"result": refusal("execution_outcome_unknown", dispatched=True)}
        if name == "mcp_signin_7777777777":
            return {"result": refusal("authorization_required")}
        return {"error": {"code": -32602, "message": f"Tool {name} not found"}}

    def agent_answer(self, body: Dict[str, Any]) -> Dict[str, Any]:
        if body["method"] == "tools/list":
            return {"result": {"tools": [{"name": "find_tools", "inputSchema": {"type": "object"}},
                                         {"name": "call_tool", "inputSchema": {"type": "object"}}]}}
        name, args = body["params"]["name"], body["params"].get("arguments", {})
        if name == "find_tools":
            found = [{"tool_id": COMMITS, "tool_version": "v" * 64}] if COMMITS in args["query"] or "GitLab/" in args["query"] else []
            return {"result": {"content": [{"type": "text", "text": json.dumps({"tools": found})}]}}
        if name == "call_tool" and args["tool_id"] == COMMITS:
            if args["arguments"].get("limit") == 0:
                return {"result": {"content": [{"type": "text", "text": json.dumps({
                    "code": "agent_mcp_call_limit", "message": "Agent MCP call limit reached."})}], "isError": True}}
            return {"result": {"content": [{"type": "text", "text": "agent ok"}], "structuredContent": {"via": "agent"}}}
        return {"error": {"code": -32602, "message": f"Tool {name} not found"}}


def code_client(gateway: FakeGateway, **overrides: str) -> mcp.Client:
    environ = {"AIQSA_RUN_TOKEN": TOKEN, "AIQSA_GATEWAY_URL": gateway.url, "AIQSA_INVOCATION_ID": INVOCATION, **overrides}
    return mcp.Client(environ={key: value for key, value in environ.items() if value}, retry_seconds=5)


class EnvironmentTests(unittest.TestCase):
    def test_typed_errors_without_access(self) -> None:
        cases = [({}, errors.NotInWorkspace), ({"AIQSA_MCP_UNAVAILABLE": "internet_off"}, errors.InternetOff),
                 ({"AIQSA_MCP_UNAVAILABLE": "mcp_off"}, errors.McpOff),
                 ({"AIQSA_MCP_UNAVAILABLE": "gateway_unavailable"}, errors.GatewayUnavailable),
                 ({"AIQSA_MCP_UNAVAILABLE": "project_unsupported"}, errors.ProjectUnsupported)]
        for environ, expected in cases:
            client = mcp.Client(environ=environ)
            with self.assertRaises(expected):
                client.call(COMMITS)
            with self.assertRaises(expected):
                client.list_tools()
        self.assertTrue(issubclass(errors.InternetOff, errors.McpUnavailable))

    def test_requires_the_command_invocation(self) -> None:
        client = mcp.Client(environ={"AIQSA_RUN_TOKEN": TOKEN, "AIQSA_GATEWAY_URL": "http://127.0.0.1:9"})
        with self.assertRaises(errors.InvocationClosed):
            client.call(COMMITS)

    def test_unreachable_gateway(self) -> None:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        client = mcp.Client(environ={"AIQSA_RUN_TOKEN": TOKEN, "AIQSA_GATEWAY_URL": f"http://127.0.0.1:{port}",
                                     "AIQSA_INVOCATION_ID": INVOCATION}, timeout=5)
        with self.assertRaises(errors.GatewayUnavailable):
            client.call(COMMITS)


class CodeClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.gateway = FakeGateway()

    def tearDown(self) -> None:
        self.gateway.close()

    def test_lists_and_calls_with_the_run_bearer_and_invocation(self) -> None:
        client = code_client(self.gateway)
        tools = client.list_tools()
        self.assertEqual([tool.name for tool in tools][:1], [COMMITS])
        self.assertEqual((tools[0].server, tools[0].tool), ("GitLab", "list_commits"))
        result = client.call(COMMITS, {"project": "group/app"})
        self.assertEqual(result.json(), {"commits": ["a", "b"], "project": "group/app"})
        self.assertEqual(result.text, "2 commits")
        request = self.gateway.requests[-1]
        self.assertEqual(request["path"], "/mcp")
        self.assertEqual(request["headers"]["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(request["headers"]["x-aiqsa-invocation-id"], INVOCATION)
        self.assertEqual(request["body"]["method"], "tools/call")
        self.assertEqual(request["body"]["params"], {"name": COMMITS, "arguments": {"project": "group/app"}})
        ids = {item["body"]["id"] for item in self.gateway.requests}
        self.assertEqual(len(ids), len(self.gateway.requests))

    def test_resolves_server_tool_names_and_refuses_ambiguous_ones(self) -> None:
        client = code_client(self.gateway)
        self.assertEqual(client.call("GitLab/list_commits").json()["commits"], ["a", "b"])
        self.assertEqual(client.call("gitlab/LIST_COMMITS").text, "2 commits")
        self.assertEqual(client.call("GitLab.list_commits").text, "2 commits")  # as the summary line shows it
        with self.assertRaises(errors.ToolUnavailable):
            client.call("list_commits")  # GitLab and Wiki both have it
        with self.assertRaises(errors.ToolUnavailable):
            client.call("Nowhere.list_commits")
        with self.assertRaises(errors.ToolUnavailable):
            client.call("Nowhere/list_commits")
        with self.assertRaises(errors.ToolUnavailable):
            client.call("mcp_not_in_run_9999999999")

    def test_typed_gateway_refusals_and_tool_errors(self) -> None:
        client = code_client(self.gateway)
        with self.assertRaises(errors.BudgetExhausted):
            client.call("mcp_budget_4444444444")
        with self.assertRaises(errors.InvalidArguments) as invalid:
            client.call("mcp_schema_5555555555", {})
        self.assertEqual(invalid.exception.details["input_schema"]["required"], ["project"])
        with self.assertRaises(errors.OutcomeUnknown):
            client.call("mcp_unknown_outcome_6666666666")
        with self.assertRaises(errors.AuthorizationRequired):
            client.call("mcp_signin_7777777777")
        with self.assertRaises(errors.ToolError) as tool:
            client.call("mcp_upstream_error_3333333333")
        self.assertEqual(tool.exception.result.text, "GitLab says 500")

    def test_retries_refusals_that_waiting_clears(self) -> None:
        self.gateway.busy = 2
        self.assertEqual(code_client(self.gateway).call("mcp_gitlab_get_job_log_1111111111").text, "log line")
        self.gateway.busy = 1000
        client = code_client(self.gateway)
        client.retry_seconds = 0.5
        with self.assertRaises(errors.RateLimited):
            client.call("mcp_gitlab_get_job_log_1111111111")

    def test_revoked_bearer_and_closed_invocation(self) -> None:
        with self.assertRaises(errors.TokenRevoked):
            code_client(self.gateway, AIQSA_RUN_TOKEN="R" * 43).call(COMMITS)
        with self.assertRaises(errors.InvocationClosed):
            code_client(self.gateway, AIQSA_INVOCATION_ID="b" * 32).call(COMMITS)

    def test_module_helpers_use_the_process_environment(self) -> None:
        saved = {key: os.environ.get(key) for key in ("AIQSA_RUN_TOKEN", "AIQSA_GATEWAY_URL", "AIQSA_INVOCATION_ID")}
        try:
            os.environ.update({"AIQSA_RUN_TOKEN": TOKEN, "AIQSA_GATEWAY_URL": self.gateway.url, "AIQSA_INVOCATION_ID": INVOCATION})
            mcp._default = None
            self.assertEqual(mcp.call(COMMITS).text, "2 commits")
            self.assertEqual(len(mcp.list_tools()), 3)
        finally:
            mcp._default = None
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


class AgentClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.gateway = FakeGateway(agent=True)
        self.client = mcp.Client(environ={"AIQSA_AGENT_TOKEN": TOKEN, "AIQSA_GATEWAY_URL": self.gateway.url})

    def tearDown(self) -> None:
        self.gateway.close()

    def test_uses_the_agent_surface_without_an_invocation(self) -> None:
        self.assertEqual(self.client.call(COMMITS, {"project": "x"}).json(), {"via": "agent"})
        methods = [(item["body"]["method"], item["body"]["params"].get("name")) for item in self.gateway.requests]
        self.assertEqual(methods, [("tools/list", None), ("tools/call", "find_tools"), ("tools/call", "call_tool")])
        self.assertNotIn("x-aiqsa-invocation-id", self.gateway.requests[-1]["headers"])
        self.assertEqual(self.gateway.requests[-1]["body"]["params"]["arguments"],
                         {"tool_id": COMMITS, "tool_version": "v" * 64, "arguments": {"project": "x"}})

    def test_clear_errors_in_agent_contexts(self) -> None:
        with self.assertRaises(errors.AgentModeUnsupported):
            self.client.list_tools()
        with self.assertRaises(errors.ToolUnavailable):
            self.client.call("Nowhere/nothing")
        with self.assertRaises(errors.BudgetExhausted):
            self.client.call(COMMITS, {"limit": 0})


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.gateway = FakeGateway()
        self.client = code_client(self.gateway)

    def tearDown(self) -> None:
        self.gateway.close()

    def run_cli(self, *argv: str, stdin: str = "") -> tuple:
        stdout, stderr = io.StringIO(), io.StringIO()
        code = main(list(argv), client=self.client, stdout=stdout, stderr=stderr, stdin=io.StringIO(stdin))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_list_and_call(self) -> None:
        code, out, _ = self.run_cli("list")
        self.assertEqual(code, 0)
        self.assertIn(f"{COMMITS}\tGitLab/list_commits\tList commits", out)
        code, out, _ = self.run_cli("list", "--json")
        self.assertEqual(json.loads(out)[0]["server"], "GitLab")
        code, out, _ = self.run_cli("call", COMMITS, "--json", '{"project": "group/app"}')
        self.assertEqual((code, json.loads(out)["project"]), (0, "group/app"))
        code, out, _ = self.run_cli("call", "GitLab/list_commits", "--stdin", stdin='{"project": "piped"}')
        self.assertEqual(json.loads(out)["project"], "piped")
        code, out, _ = self.run_cli("call", COMMITS, "--raw")
        self.assertEqual(json.loads(out)["content"][0]["text"], "2 commits")

    def test_usage_errors(self) -> None:
        for argv in [("call", COMMITS, "--json", "{not json"), ("call", COMMITS, "--json", "[1]"), ("bogus",), (),
                     ("call", COMMITS, "--json", "{}", "--stdin"), ("call", COMMITS, "--json-file", "/nonexistent/args.json")]:
            code, out, err = self.run_cli(*argv)
            self.assertEqual(code, 2, argv)
            self.assertEqual(out, "")
            self.assertEqual(json.loads(err)["error"]["code"], "usage")

    def test_typed_exit_codes(self) -> None:
        expectations = [("mcp_budget_4444444444", 5, "code_mcp_call_limit"), ("mcp_not_in_run_9999999999", 6, "tool_unavailable"),
                        ("mcp_upstream_error_3333333333", 7, "tool_error"), ("mcp_unknown_outcome_6666666666", 8,
                                                                             "execution_outcome_unknown"),
                        ("mcp_signin_7777777777", 4, "authorization_required")]
        for name, exit_code, error_code in expectations:
            code, out, err = self.run_cli("call", name)
            self.assertEqual((code, out), (exit_code, ""), name)
            self.assertEqual(json.loads(err)["error"]["code"], error_code)
        for reason in ("internet_off", "project_unsupported"):
            self.client = mcp.Client(environ={"AIQSA_MCP_UNAVAILABLE": reason})
            code, _, err = self.run_cli("list")
            self.assertEqual((code, json.loads(err)["error"]["code"]), (3, reason))
        self.assertIn("personal chats only", json.loads(err)["error"]["message"])


if __name__ == "__main__":
    unittest.main()
