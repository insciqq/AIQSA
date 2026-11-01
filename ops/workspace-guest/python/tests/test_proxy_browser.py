"""`aiqsa-browser`'s proxy options and commands, with no browser (standard library only; host fakes where Playwright is present)."""

from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa.browser import _identity, _paths, cli  # noqa: E402
from aiqsa.proxy import client  # noqa: E402
try:  # The standard guest image does not install Playwright; host fakes run where it is present.
    from aiqsa.browser import _host  # noqa: E402
except ModuleNotFoundError:  # pragma: no cover - exercised only in the slim guest test image
    _host = None  # type: ignore[assignment]

PASSWORD = "synthetic-pass-77c1"


def proxy(identifier: str, **overrides: Any) -> Dict[str, Any]:
    return {"active": True, "available": True, "country": "KZ", "domainHints": [".kz"], "host": "proxy.example.com", "id": identifier,
            "login": "synthetic-login", "name": identifier.upper(), "owner": "personal", "password": PASSWORD, "port": 1080, "protocol": "socks5", **overrides}


class Commands(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="aiqsa-proxy-cli-")
        self.addCleanup(shutil.rmtree, self.root, True)
        _paths.use_test_root(self.root, sys.executable)
        self.addCleanup(_paths.use_test_root, None)

    def deliver(self, *entries: Dict[str, Any]) -> None:
        path = _paths.proxy_plan_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": 1, "proxies": list(entries)}), "utf-8")

    def run_cli(self, *argv: str) -> Any:
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(list(argv), stdout=out, stderr=err)
        return code, out.getvalue(), err.getvalue()

    def test_a_chat_without_proxies_starts_nothing(self) -> None:
        self.assertEqual(self.run_cli("proxies"), (0, "This chat has no proxies.\n", ""))
        with mock.patch("os.execvpe") as execute:
            execute.side_effect = OSError(2, "No such file or directory")
            code, _, err = self.run_cli("proxied", "curl", "-sS", "https://shop.kz/")
        self.assertEqual(code, cli.EXIT_COMMAND_NOT_RUN)
        self.assertIn("error[command_not_run]", err)
        env = execute.call_args.args[2]
        self.assertNotIn("HTTPS_PROXY", env)
        self.assertEqual(execute.call_args.args[:2], ("curl", ["curl", "-sS", "https://shop.kz/"]))
        self.assertFalse(_paths.proxy_run_dir().exists())
        code, _, err = self.run_cli("proxied", "--proxy", "KZ1", "curl", "https://shop.kz/")
        self.assertEqual(code, cli.EXIT_PAGE)
        self.assertIn("error[proxy_not_found]", err)

    def test_the_list_names_proxies_and_never_a_credential(self) -> None:
        self.deliver(proxy("kz1"), proxy("off", active=False, domainHints=[]), proxy("gone", available=False, country=None, login=None, password=None),
                     proxy("direct", owner="administrator"), proxy("twin"), proxy("twin2", name="TWIN"))
        code, out, _ = self.run_cli("proxies")
        self.assertEqual(code, 0)
        self.assertIn("- KZ1, socks5, country KZ, hints .kz, personal", out)
        self.assertIn("no hints, personal, switched off", out)
        self.assertIn("unavailable now", out)
        self.assertIn("DIRECT (id direct)", out)
        self.assertIn("TWIN (id twin)", out)
        self.assertNotIn(PASSWORD, out)
        self.assertNotIn("synthetic-login", out)
        self.assertFalse(_paths.proxy_run_dir().exists(), "listing starts no process")

    def test_a_damaged_plan_is_a_failure_and_not_no_proxies(self) -> None:
        path = _paths.proxy_plan_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", "utf-8")
        code, _, err = self.run_cli("proxies")
        self.assertEqual(code, cli.EXIT_PAGE)
        self.assertIn("error[proxy_unavailable]", err)
        with mock.patch("os.execvpe") as execute:
            code, _, err = self.run_cli("proxied", "curl", "https://shop.kz/")
        execute.assert_not_called()
        self.assertEqual(code, cli.EXIT_PAGE)

    def test_a_command_runs_with_the_forwarder_and_its_choice(self) -> None:
        self.deliver(proxy("kz1"), proxy("off", active=False))
        with mock.patch.object(client, "ensure", return_value=4321), mock.patch("os.execvpe", side_effect=OSError(2, "gone")) as execute:
            self.run_cli("proxied", "curl", "https://shop.kz/")
            self.assertEqual(execute.call_args.args[2]["https_proxy"], "http://127.0.0.1:4321")
            self.run_cli("proxied", "--proxy", "kz1", "--", "curl", "https://shop.es/")
            self.assertEqual(execute.call_args.args[2]["HTTPS_PROXY"], "http://kz1:x@127.0.0.1:4321")
            self.assertEqual(execute.call_args.args[1], ["curl", "https://shop.es/"])
            self.run_cli("proxied", "--proxy", "direct", "curl", "https://shop.es/")
            self.assertEqual(execute.call_args.args[2]["ALL_PROXY"], "http://direct:x@127.0.0.1:4321")
            execute.reset_mock()
            for name, code_name in (("nobody", "proxy_not_found"), ("off", "proxy_inactive")):
                code, _, err = self.run_cli("proxied", "--proxy", name, "curl", "https://shop.es/")
                self.assertEqual(code, cli.EXIT_PAGE)
                self.assertIn(f"error[{code_name}]", err)
            execute.assert_not_called()
        code, _, err = self.run_cli("proxied")
        self.assertEqual(code, cli.EXIT_USAGE)
        self.assertIn("give the command", err)

    def test_open_and_new_tab_carry_the_choice(self) -> None:
        seen: List[Any] = []

        def call(op: str, args: Dict[str, Any]) -> Dict[str, Any]:
            seen.append((op, args))
            return {"text": "ok"}

        with mock.patch.object(cli, "call", call):
            self.run_cli("open", "https://shop.es/", "--proxy", "KZ1")
            self.run_cli("open", "https://shop.es/")
            self.run_cli("new-tab", "https://shop.es/", "--proxy", "direct")
        self.assertEqual(seen, [("open", {"url": "https://shop.es/", "proxy": "KZ1"}), ("open", {"url": "https://shop.es/", "proxy": None}),
                                ("new_tab", {"url": "https://shop.es/", "proxy": "direct"})])

    def test_the_codes_exit_as_their_kind(self) -> None:
        self.assertEqual(cli.exit_code("proxy_all_failed"), cli.EXIT_PAGE)
        self.assertEqual(cli.exit_code("proxy_target_refused"), cli.EXIT_PAGE)
        self.assertEqual(cli.exit_code(client.UNAVAILABLE), cli.EXIT_UNAVAILABLE)
        self.assertEqual(cli.exit_code("proxy_browser_restart_required"), cli.EXIT_UNAVAILABLE)


class Flags(unittest.TestCase):
    def test_only_a_run_with_proxies_gets_a_flag(self) -> None:
        self.assertFalse(any("proxy" in arg or "webrtc" in arg for arg in _identity.launch_args("en-US", "UA")))
        args = _identity.launch_args("en-US", "UA", 4321)
        self.assertIn("--proxy-server=http://127.0.0.1:4321", args)
        self.assertIn("--force-webrtc-ip-handling-policy=disable_non_proxied_udp", args)

    def test_the_presentation_seam_changes_nothing_today(self) -> None:
        self.assertEqual(_identity.presentation_for_proxy("RU", "en-US", "UTC"), ("en-US", "UTC"))


class Session:
    def __init__(self) -> None:
        self.sent: List[Any] = []

    async def send(self, method: str, params: Dict[str, Any]) -> None:
        self.sent.append((method, params))


@unittest.skipIf(_host is None, "needs Playwright")
class Presentation(unittest.TestCase):
    def setUp(self) -> None:
        root = tempfile.mkdtemp(prefix="aiqsa-proxy-host-")
        self.addCleanup(shutil.rmtree, root, True)
        _paths.use_test_root(root, sys.executable)
        self.addCleanup(_paths.use_test_root, None)
        self.host = _host.Host({})
        self.host.user_agent = "UA"
        self.page = object()
        self.session = Session()
        self.host.cdp[self.page] = self.session

    def test_unchanged_sends_nothing_and_a_changed_answer_reaches_the_page(self) -> None:
        asyncio.run(self.host._present_for_proxy(self.page, "RU"))
        self.assertEqual(self.session.sent, [])
        with mock.patch.object(_identity, "presentation_for_proxy", return_value=("ru-RU", "Europe/Moscow")):
            asyncio.run(self.host._present_for_proxy(self.page, "RU"))
        self.assertEqual([method for method, _ in self.session.sent],
                         ["Emulation.setUserAgentOverride", "Emulation.setLocaleOverride", "Emulation.setTimezoneOverride"])
        self.assertEqual(self.session.sent[0][1]["acceptLanguage"], "ru-RU")


class WithoutForwarder(unittest.TestCase):
    """A browser started before the chat had proxies has no forwarder and cannot route: it says so."""

    def setUp(self) -> None:
        if _host is None:
            self.skipTest("needs Playwright")
        root = tempfile.mkdtemp(prefix="aiqsa-proxy-host-")
        self.addCleanup(shutil.rmtree, root, True)
        _paths.use_test_root(root, sys.executable)
        self.addCleanup(_paths.use_test_root, None)
        self.host = _host.Host({})

    def deliver(self, *entries: Dict[str, Any]) -> None:
        path = Path(_paths.proxy_plan_path())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": 1, "proxies": list(entries)}), "utf-8")

    def code(self, host: str, value: Any) -> Any:
        try:
            self.host._no_forwarder(host, client.parse_choice(value))
        except _host.HostError as error:
            return error.code
        return None

    def test_no_plan_changes_nothing_and_a_named_proxy_has_nothing_to_name(self) -> None:
        self.assertIsNone(self.code("shop.kz", None))
        self.assertIsNone(self.code("shop.kz", "direct"))
        self.assertIsNone(self.code("shop.kz", "auto"))
        self.assertEqual(self.code("shop.kz", "KZ1"), "proxy_not_found")

    def test_a_later_plan_never_opens_a_hinted_site_directly(self) -> None:
        self.deliver(proxy("kz1"))
        self.assertEqual(self.code("shop.kz", None), "proxy_browser_restart_required")
        self.assertEqual(self.code("other.example", "KZ1"), "proxy_browser_restart_required")
        self.assertEqual(self.code("other.example", "nobody"), "proxy_not_found")
        self.assertIsNone(self.code("other.example", None))
        self.assertIsNone(self.code("shop.kz", "direct"))


if __name__ == "__main__":
    unittest.main()
