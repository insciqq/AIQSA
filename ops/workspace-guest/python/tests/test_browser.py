"""Browser helper tests that need no browser: identity, sessions, text, client and CLI (standard library only).

Run: python3 -m unittest discover -s ops/workspace-guest/python/tests -t ops/workspace-guest/python
The browser-backed tests live in test_browser_live.py.
"""

from __future__ import annotations

import io
import asyncio
import json
import math
import os
import random
import re
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa.browser import _client, _dom, _format, _human, _identity, _paths, _sessions, cli  # noqa: E402
try:  # The standard guest image does not install Playwright; host fakes run where it is present.
    from aiqsa.browser import _host  # noqa: E402
except ModuleNotFoundError:  # pragma: no cover - exercised only in the slim guest test image
    _host = None  # type: ignore[assignment]

#: The parser of `features/run-lifecycle-v2/workspaceActivityPresentation.ts`, kept equal to it.
UI_STEP_LINE = re.compile(r"^\[browser #(\d{1,5})(?: · [^\]\n]{1,64})?\] ([a-z_]{1,20})(?:: (.+?))?(?: @ (\S+))?$")


def cookie(name: str, domain: str, value: str = "v", **extra: Any) -> Dict[str, Any]:
    return {"name": name, "value": value, "domain": domain, "path": "/", "expires": -1, "httpOnly": True,
            "secure": True, "sameSite": "Lax", **extra}


class IdentityTests(unittest.TestCase):
    def test_locale_and_zone_fall_back_to_documented_defaults(self) -> None:
        self.assertEqual(_identity.browser_locale({"AIQSA_BROWSER_LOCALE": "es-ES"}), "es-ES")
        # Every IANA name AIQSA admits, single segments too: CET must never quietly become UTC.
        for zone in ["America/Argentina/Buenos_Aires", "CET", "GMT", "EST5EDT", "Etc/GMT+5", "UTC", "W-SU"]:
            self.assertEqual(_identity.browser_timezone({"AIQSA_BROWSER_TIMEZONE": zone}), zone)
        for bad in ["", "es_ES", "x" * 40, "es-ES;rm", "../etc", "es-ES\n"]:
            self.assertEqual(_identity.browser_locale({"AIQSA_BROWSER_LOCALE": bad}), "en-US", bad)
        for bad in ["", "Europe/../../etc/passwd", "Europe/Madrid ", "Europe/Madrid\n", "/etc/localtime", "a//b", "x" * 65]:
            self.assertEqual(_identity.browser_timezone({"AIQSA_BROWSER_TIMEZONE": bad}), "UTC", bad)
        self.assertEqual(_identity.browser_timezone({}), "UTC")
        self.assertEqual(_identity.browser_locale({}), "en-US")

    def test_launch_flags_stay_inside_the_operator_boundary(self) -> None:
        args = _identity.launch_args("es-ES", "UA")
        # Headed on the guest's X server: the screen is the server's (no `--screen-info`), WebGL runs on SwiftShader.
        self.assertEqual(args, ["--disable-blink-features=AutomationControlled", "--lang=es-ES", "--window-size=1440,900",
                                "--enable-unsafe-swiftshader", "--user-agent=UA"])
        self.assertNotIn("--user-agent", " ".join(_identity.launch_args("en-US")))
        self.assertEqual(_identity.IGNORED_DEFAULT_ARGS, ["--enable-automation"])

    def test_browser_environment_carries_the_user_zone_and_no_run_credentials(self) -> None:
        env = _identity.launch_env({"PATH": "/bin", "AIQSA_RUN_TOKEN": "t", "AIQSA_INVOCATION_ID": "i",
                                    "AIQSA_GATEWAY_URL": "g", "AIQSA_AGENT_ID": "thread-7", "AIQSA_AGENT_NAME": "shop",
                                    "SHOP_LOGIN": "user"}, "pt-BR", "America/Sao_Paulo")
        self.assertEqual(env["TZ"], "America/Sao_Paulo")
        self.assertEqual(env["LANG"], "pt_BR.UTF-8")
        self.assertEqual(env["LANGUAGE"], "pt_BR")
        self.assertEqual(env["SHOP_LOGIN"], "user")
        for name in ("AIQSA_RUN_TOKEN", "AIQSA_INVOCATION_ID", "AIQSA_GATEWAY_URL"):
            self.assertNotIn(name, env)
        self.assertNotIn("AIQSA_AGENT_ID", env)
        self.assertNotIn("AIQSA_AGENT_NAME", env)

    def test_user_agent_drops_only_the_headless_product_name(self) -> None:
        headless = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/148.0.0.0 Safari/537.36"
        self.assertEqual(_identity.native_user_agent(headless),
                         "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36")
        with self.assertRaises(ValueError):
            _identity.native_user_agent("curl/8")

    def test_client_hints_are_the_browser_own_and_never_a_renamed_headless_brand(self) -> None:
        reported = {"brands": [{"brand": "Not/A)Brand", "version": "99"}, {"brand": "Chromium", "version": "148"}],
                    "fullVersionList": [{"brand": "Not/A)Brand", "version": "99.0.0.0"}, {"brand": "Chromium", "version": "148.0.7778.96"}],
                    "platform": "Linux", "platformVersion": "", "architecture": "x86", "bitness": "64", "model": "",
                    "mobile": False, "wow64": False, "formFactors": ["Desktop"], "extra": "ignored"}
        meta = _identity.user_agent_metadata(reported)
        self.assertEqual(meta["fullVersionList"][1], {"brand": "Chromium", "version": "148.0.7778.96"})
        self.assertEqual((meta["architecture"], meta["bitness"], meta["formFactors"]), ("x86", "64", ["Desktop"]))
        self.assertNotIn("extra", meta)
        with self.assertRaisesRegex(ValueError, "client_hints_headless"):
            _identity.user_agent_metadata({**reported, "brands": [{"brand": "HeadlessChrome", "version": "148"}]})
        with self.assertRaisesRegex(ValueError, "client_hints_unavailable"):
            _identity.user_agent_metadata({**reported, "fullVersionList": []})


class SessionNameTests(unittest.TestCase):
    def test_file_names_follow_the_application_rule(self) -> None:
        for good in ["shop.example.json", "amazon.es.json", "127.0.0.1.json", "xn-80ak6aa92e.com.json"]:
            self.assertTrue(_sessions.is_session_filename(good), good)
        for bad in [".json", "a.json.tmp", "../x.json", "shop example.json", ".hidden.json", "a/b.json", "x.JSON1",
                    "xn--80ak6aa92e.com.json"]:
            self.assertFalse(_sessions.is_session_filename(bad), bad)
        # A punycode host still gets a name AIQSA accepts; its cookies are matched by the real host.
        self.assertEqual(_sessions.session_name("xn--80ak6aa92e.com"), "xn-80ak6aa92e.com.json")
        self.assertTrue(_sessions.is_session_filename(_sessions.session_name("xn--80ak6aa92e.com")))

    def test_site_names_strip_www_and_refuse_odd_hosts(self) -> None:
        self.assertEqual(_sessions.site_of("WWW.Amazon.ES"), "amazon.es")
        self.assertEqual(_sessions.site_of("127.0.0.1"), "127.0.0.1")
        self.assertEqual(_sessions.site_of("www.bbc.co.uk"), "bbc.co.uk")
        # A single label or a country-code suffix would gather every site under it into one file.
        for bad in ["", "-x.com", "a..b", "x_y.com", "a" * 300, "com", "localhost", "co.uk", "www.com.au", "shop example.com"]:
            self.assertIsNone(_sessions.site_of(bad), bad)

    def test_cookies_and_storage_belong_to_a_site_and_its_subdomains_or_parents(self) -> None:
        state = {"cookies": [cookie("a", ".amazon.es"), cookie("b", "www.amazon.es"), cookie("c", "fls-eu.amazon.es"),
                             cookie("d", "amazon.com"), cookie("e", ".notamazon.es")],
                 "origins": [{"origin": "https://www.amazon.es", "localStorage": [{"name": "k", "value": "v"}]},
                             {"origin": "https://ads.example", "localStorage": [{"name": "k", "value": "v"}]},
                             {"origin": "https://amazon.es", "localStorage": []}]}
        part = _sessions.filter_state(state, {"amazon.es"})
        self.assertEqual([c["name"] for c in part["cookies"]], ["a", "b", "c"])
        self.assertEqual([o["origin"] for o in part["origins"]], ["https://www.amazon.es"])
        self.assertTrue(_sessions.domain_matches(".example.com", {"shop.example.com"}))
        self.assertTrue(_sessions.domain_matches("a.shop.example.com", {"shop.example.com"}))
        self.assertFalse(_sessions.domain_matches("other.example.com", {"shop.example.com"}))
        self.assertFalse(_sessions.domain_matches("com", {"shop.example.com"}))
        self.assertFalse(_sessions.domain_matches(".co.uk", {"bbc.co.uk"}))
        self.assertTrue(_sessions.domain_matches(".bbc.co.uk", {"news.bbc.co.uk"}))
        self.assertFalse(_sessions.domain_matches("", {"x.com"}))

    def test_one_account_shares_one_site_whatever_service_signed_in(self) -> None:
        for host, account in [("mail.google.com", "google.com"), ("accounts.google.com", "google.com"), ("google.com", "google.com"),
                              ("passport.yandex.ru", "yandex.ru"), ("auth.cloud.yandex.ru", "yandex.ru"),
                              ("tracker.yandex.ru", "yandex.ru"), ("news.bbc.co.uk", "bbc.co.uk"), ("WWW.Amazon.ES", "amazon.es"),
                              ("shop.example.com.au", "example.com.au"), ("alice.github.io", "alice.github.io"),
                              ("docs.alice.github.io", "alice.github.io"), ("acme.atlassian.net", "acme.atlassian.net"),
                              ("github.io", "github.io"), ("127.0.0.1", "127.0.0.1")]:
            self.assertEqual(_sessions.account_of(host), account, host)
        for bad in ["", "localhost", "co.uk", "x_y.com"]:
            self.assertIsNone(_sessions.account_of(bad), bad)

    def test_a_stamp_is_a_positive_whole_number_of_milliseconds(self) -> None:
        self.assertEqual(_sessions.saved_at({"aiqsa": {"savedAt": 1_763_640_000_000}}), 1_763_640_000_000)
        for value in [{}, {"aiqsa": 5}, {"aiqsa": {"savedAt": "1"}}, {"aiqsa": {"savedAt": True}}, {"aiqsa": {"savedAt": -1}},
                      {"aiqsa": {"savedAt": 1.5}}, {"aiqsa": {"savedAt": 2 ** 60}}]:
            self.assertEqual(_sessions.saved_at(value), 0, value)

    def test_state_validation_matches_what_aiqsa_saves(self) -> None:
        self.assertTrue(_sessions.valid_state({"cookies": [cookie("a", "x.com")], "origins": []}))
        self.assertFalse(_sessions.valid_state({"cookies": [{**cookie("a", "x.com"), "sameSite": "lax"}], "origins": []}))
        self.assertFalse(_sessions.valid_state({"cookies": [{**cookie("a", "x.com"), "expires": True}], "origins": []}))
        self.assertFalse(_sessions.valid_state({"cookies": [], "origins": [{"origin": "file:///x", "localStorage": []}]}))
        self.assertFalse(_sessions.valid_state({"cookies": [], "origins": [{"origin": "https://x.com/path", "localStorage": []}]}))
        self.assertFalse(_sessions.valid_state([]))


class SessionStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name) / "secrets" / "browser"
        self.root.mkdir(parents=True, mode=0o700)
        self.store = _sessions.SessionStore(self.root)

    def tearDown(self) -> None:
        self.directory.cleanup()

    def write(self, name: str, value: Any) -> None:
        (self.root / name).write_text(json.dumps(value), encoding="utf-8")

    def test_load_merges_valid_files_tracks_their_sites_and_reports_the_rest(self) -> None:
        self.write("shop.example.json", {"cookies": [cookie("sid", "shop.example"), cookie("sso", "accounts.idp.test")],
                                         "origins": [{"origin": "https://shop.example", "localStorage": [{"name": "cart", "value": "2"}]}]})
        self.write("broken.json", "not a state")
        (self.root / "notes.txt").write_text("x")
        os.symlink(self.root / "shop.example.json", self.root / "linked.json")
        (self.root / "big.json").write_bytes(b" " * (_sessions.MAX_BYTES + 1))
        (self.root.parent / ".aiqsa-browser-0011223344556677.tmp").write_text("stale")
        merged = self.store.load()
        self.assertEqual(sorted(c["name"] for c in merged["cookies"]), ["sid", "sso"])
        self.assertEqual(merged["origins"][0]["origin"], "https://shop.example")
        self.assertEqual(sorted(self.store.tracked), ["shop.example.json"])
        self.assertEqual(self.store.tracked["shop.example.json"], {"shop.example", "accounts.idp.test"})
        self.assertEqual(sorted(self.store.skipped), ["big.json", "broken.json", "linked.json", "notes.txt"])
        self.assertFalse((self.root.parent / ".aiqsa-browser-0011223344556677.tmp").exists())

    def test_save_writes_only_the_site_part_atomically_and_detects_changes(self) -> None:
        self.store.track("shop.example.json", {"shop.example"})
        state = {"cookies": [cookie("sid", ".shop.example", "1"), cookie("other", "elsewhere.test")],
                 "origins": [{"origin": "https://shop.example", "localStorage": [{"name": "cart", "value": "2"}]}]}
        first = self.store.save("shop.example.json", state)
        self.assertEqual((first["changed"], first["file"]), (True, "shop.example.json"))
        saved = json.loads((self.root / "shop.example.json").read_text("utf-8"))
        self.assertEqual([c["name"] for c in saved["cookies"]], ["sid"])
        self.assertTrue(_sessions.valid_state(saved))
        self.assertEqual(stat.S_IMODE((self.root / "shop.example.json").stat().st_mode), 0o600)
        self.assertEqual(self.store.save("shop.example.json", state)["changed"], False)
        self.assertEqual(self.store.changed(state), [])
        rotated = {"cookies": [cookie("sid", ".shop.example", "2"), cookie("other", "elsewhere.test", "9")], "origins": state["origins"]}
        self.assertEqual(self.store.changed(rotated), ["shop.example.json"])
        elsewhere = {"cookies": [cookie("sid", ".shop.example", "1"), cookie("other", "elsewhere.test", "9")],
                     "origins": state["origins"] + [{"origin": "https://ads.example", "localStorage": [{"name": "k", "value": "v"}]}]}
        self.assertEqual(self.store.changed(elsewhere), [])
        # A single-page app rotates its sign-in token in local storage: that changes the session too.
        token = {"cookies": state["cookies"], "origins": [{"origin": "https://shop.example", "localStorage": [{"name": "cart", "value": "3"}]}]}
        self.assertEqual(self.store.changed(token), ["shop.example.json"])
        self.assertEqual(self.store.save("shop.example.json", token)["changed"], True)
        self.assertEqual(self.store.changed(token), [])
        self.assertEqual(self.store.sites(), {"shop.example"})
        self.assertEqual([entry.name for entry in self.root.parent.iterdir() if entry.name.endswith(".tmp")], [])

    def test_a_cookie_several_files_share_comes_from_the_one_saved_last_whatever_the_names(self) -> None:
        # One Google account saved per subdomain: every file carries the shared parent-domain cookie. Merged by name,
        # the alphabetically last file won with its stale copy.
        self.write("accounts.google.com.json", {"cookies": [cookie("SID", ".google.com", "fresh"), cookie("LSID", "accounts.google.com")],
                                                "origins": [{"origin": "https://mail.google.com", "localStorage": [{"name": "t", "value": "fresh"}]}],
                                                "aiqsa": {"savedAt": 2_000}})
        self.write("mail.google.com.json", {"cookies": [cookie("SID", ".google.com", "stale"), cookie("GMAIL_AT", "mail.google.com")],
                                            "origins": [{"origin": "https://mail.google.com", "localStorage": [{"name": "t", "value": "stale"}]}],
                                            "aiqsa": {"savedAt": 1_000}})
        self.write("script.google.com.json", {"cookies": [cookie("SID", ".google.com", "uploaded-long-ago")], "origins": []})
        merged = self.store.load()
        values = {(c["name"], c["domain"]): c["value"] for c in merged["cookies"]}
        self.assertEqual(values[("SID", ".google.com")], "fresh")
        self.assertEqual(sorted(values), [("GMAIL_AT", "mail.google.com"), ("LSID", "accounts.google.com"), ("SID", ".google.com")])
        self.assertEqual(merged["origins"], [{"origin": "https://mail.google.com", "localStorage": [{"name": "t", "value": "fresh"}]}])
        self.assertNotIn("aiqsa", merged)
        # Only some files: the freshest of those.
        self.assertEqual(self.store.merge(["mail.google.com.json", "script.google.com.json"])["cookies"][0]["value"], "stale")

    def test_a_save_is_stamped_and_an_unchanged_one_keeps_its_file_and_stamp(self) -> None:
        now = [1_000.0]
        store = _sessions.SessionStore(self.root, clock=lambda: now[0])
        store.track("shop.example.json", {"shop.example"})
        state = {"cookies": [cookie("sid", "shop.example", "1")], "origins": []}
        first = store.save("shop.example.json", state)
        self.assertEqual((first["changed"], first["savedAt"]), (True, 1_000_000))
        raw = (self.root / "shop.example.json").read_bytes()
        self.assertEqual(json.loads(raw)["aiqsa"], {"savedAt": 1_000_000})
        self.assertEqual(first["bytes"], len(raw))
        now[0] = 2_000.0
        # The same cookies in another order are the same session.
        again = store.save("shop.example.json", {"cookies": list(reversed(state["cookies"])), "origins": []})
        self.assertEqual((again["changed"], again["savedAt"], again["bytes"]), (False, 1_000_000, len(raw)))
        self.assertEqual((self.root / "shop.example.json").read_bytes(), raw)
        # A clock behind the one that wrote the file still writes a newer stamp.
        self.write("shop.example.json", {"cookies": [cookie("sid", "shop.example", "other-vm")], "origins": [],
                                         "aiqsa": {"savedAt": 2_100_000}})
        rotated = store.save("shop.example.json", {"cookies": [cookie("sid", "shop.example", "2")], "origins": []})
        self.assertEqual((rotated["changed"], rotated["savedAt"]), (True, 2_100_001))
        self.assertEqual(store.files["shop.example.json"]["aiqsa"], {"savedAt": 2_100_001})

    def test_a_stamp_past_the_clock_orders_nothing_and_is_never_carried_into_a_save(self) -> None:
        store = _sessions.SessionStore(self.root, clock=lambda: 1_000.0)
        future = 1_000_000 + _sessions.STAMP_SKEW_MS + 1
        self.write("a.example.json", {"cookies": [cookie("sid", ".example", "forged")], "origins": [], "aiqsa": {"savedAt": future}})
        self.write("b.example.json", {"cookies": [cookie("sid", ".example", "honest")], "origins": [], "aiqsa": {"savedAt": 900_000}})
        self.assertEqual(store.load()["cookies"][0]["value"], "honest", "a future stamp counts as none, never as the newest")
        store.track("a.example.json", {"a.example"})
        saved = store.save("a.example.json", {"cookies": [cookie("sid", "a.example", "rewritten")], "origins": []})
        self.assertEqual(saved["savedAt"], 1_000_000)
        self.assertEqual(_sessions.trusted_stamp({"aiqsa": {"savedAt": 1_000_000 + _sessions.STAMP_SKEW_MS}}, 1_000_000),
                         1_000_000 + _sessions.STAMP_SKEW_MS)

    def test_a_sign_in_joins_its_account_file_and_reuses_one_that_already_holds_the_account(self) -> None:
        self.assertEqual(self.store.file_for("mail.google.com"), ("google.com.json", {"google.com"}))
        self.assertIsNone(self.store.file_for("localhost"))
        # A file saved per subdomain before accounts shared one already holds every google.com cookie.
        self.write("mail.google.com.json", {"cookies": [cookie("SID", ".google.com")], "origins": []})
        self.write("shop.example.json", {"cookies": [cookie("sid", "shop.example")], "origins": []})
        self.store.load()
        self.assertEqual(self.store.file_for("docs.google.com"), ("mail.google.com.json", {"google.com"}))
        self.assertEqual(self.store.file_for("www.shop.example"), ("shop.example.json", {"shop.example"}))
        self.store.track("google.com.json", {"google.com"})
        self.assertEqual(self.store.file_for("docs.google.com"), ("google.com.json", {"google.com"}))

    def test_limits_keep_the_previous_version(self) -> None:
        self.store.track("big.example.json", {"big.example"})
        huge = {"cookies": [cookie("x", "big.example", "v" * (_sessions.MAX_BYTES + 10))], "origins": []}
        with self.assertRaises(_sessions.SessionError) as raised:
            self.store.save("big.example.json", huge)
        self.assertEqual(raised.exception.code, "browser_session_too_large")
        self.assertFalse((self.root / "big.example.json").exists())
        for index in range(_sessions.MAX_COUNT):
            self.write(f"site{index}.example.json", {"cookies": [], "origins": []})
        self.store.track("one-more.example.json", {"one-more.example"})
        with self.assertRaises(_sessions.SessionError) as raised:
            self.store.save("one-more.example.json", {"cookies": [cookie("a", "one-more.example")], "origins": []})
        self.assertEqual(raised.exception.code, "browser_session_limit")
        with self.assertRaises(_sessions.SessionError) as raised:
            self.store.save("not tracked.json", {"cookies": [], "origins": []})
        self.assertEqual(raised.exception.code, "session_name_invalid")

    def test_a_symlinked_directory_is_never_used(self) -> None:
        other = Path(self.directory.name) / "elsewhere"
        other.mkdir()
        os.rmdir(self.root)
        os.symlink(other, self.root)
        store = _sessions.SessionStore(self.root)
        self.assertEqual(store.load(), {"cookies": [], "origins": []})
        store.track("x.example.json", {"x.example"})
        with self.assertRaises(_sessions.SessionError):
            store.save("x.example.json", {"cookies": [cookie("a", "x.example")], "origins": []})
        self.assertEqual(list(other.iterdir()), [])


class FormatTests(unittest.TestCase):
    def test_step_lines_have_the_shape_the_answer_activity_parses(self) -> None:
        lines = [
            _format.step_line({"n": 3, "action": "click", "target": 'button "Add to cart"',
                               "url": "https://www.saucedemo.com/inventory.html?token=secret#x"}),
            _format.step_line({"n": 1, "action": "open", "target": None, "url": "https://www.amazon.es/"}),
            _format.step_line({"n": 12, "action": "type", "target": 'textbox "Email @ work" (13 characters)', "url": "http://127.0.0.1:8080/a b"}),
            _format.step_line({"n": 4, "action": "back", "target": None, "url": None}),
        ]
        self.assertEqual(lines[0], '[browser #3] click: button "Add to cart" @ www.saucedemo.com/inventory.html')
        self.assertEqual(lines[1], "[browser #1] open @ www.amazon.es/")
        agent = _format.step_line({"n": 3, "agent": "shop-amazon", "action": "open", "target": None, "url": "https://linux.example/"})
        self.assertEqual(agent, "[browser #3 · shop-amazon] open @ linux.example/")
        self.assertEqual(lines[3], "[browser #4] back")
        parsed = [UI_STEP_LINE.match(line) for line in lines]
        self.assertTrue(all(parsed))
        # A sub-agent's line names it after the number; the answer's activity reads it the same way.
        self.assertEqual(UI_STEP_LINE.match(agent).groups(), ("3", "open", None, "linux.example/"))
        self.assertEqual(parsed[2].group(3), 'textbox "Email @ work" (13 characters)')
        self.assertEqual(parsed[2].group(4), "127.0.0.1:8080/a%20b")
        self.assertNotIn("secret", "".join(lines))
        self.assertNotIn("\n", _format.step_line({"n": 1, "action": "click", "target": "a\nb\u2028c", "url": None}))

    def test_a_sign_in_wall_names_a_saved_session_without_claiming_it_ever_signed_in(self) -> None:
        # A handoff for a check saves a session too, so the line never tells the agent a sign-in expired.
        line = _format.sign_in_line("forum.example", None, ["forum.example"])
        self.assertIn("forum.example asks for a sign-in: it sent the browser to its sign-in page; the saved browser session "
                      "forum.example does not sign it in, either because it expired or because it was saved after a check, "
                      "not a sign-in. Prefer a connected service", line)
        self.assertNotIn("signed in", line)
        self.assertNotIn("saved browser session", _format.sign_in_line("forum.example", "sso.example", []))
        loop = _format.redirect_loop_line("forum.example", ["forum.example"])
        self.assertIn("usually means it needs a sign-in that the saved browser session forum.example does not give it.", loop)
        self.assertNotIn("stale", loop)

    def test_hidden_values_never_print(self) -> None:
        line = _format.item_line({"n": 2, "role": "textbox", "name": "Password", "secret": True, "filled": True, "value": "hunter2"})
        self.assertEqual(line, '[2] textbox "Password" (hidden value, filled)')
        self.assertEqual(_format.item_line({"n": 5, "role": "link", "name": "Docs", "href": "/docs?page=2"}),
                         '[5] link "Docs" → /docs?page=2')
        self.assertEqual(_format.item_line({"n": 7, "role": "checkbox", "name": "Remember", "checked": False, "disabled": True}),
                         '[7] checkbox "Remember" (not checked, disabled)')

    def test_page_summary_is_bounded_and_counts_what_it_leaves_out(self) -> None:
        items = [{"n": i, "role": "button", "name": f"Item {i} " + "x" * 300, "inView": i <= 150,
                  "position": "screen" if i <= 150 else "below"} for i in range(1, 400)]
        text = _format.render_info({"url": "https://x.test/", "title": "T", "items": items, "captcha": ["reCAPTCHA"],
                                    "notes": ["A dialog was dismissed."], "tabs": 2, "tab": 1,
                                    "scroll": {"y": 0, "height": 9000, "viewport": [1440, 813]}})
        self.assertLessEqual(len(text), _format.INFO_CHARS + 200)
        self.assertIn("On screen (80 of 399 elements; 249 below):", text)
        self.assertIn("70 more not listed", text)
        self.assertIn("Pass it as a person would: `captcha`", text)
        self.assertNotIn("Do not try to solve", text)
        self.assertIn("Tabs: 2, this is tab 1", text)
        self.assertIn("A dialog was dismissed.", text)
        self.assertNotIn("x" * 101, text)
        everything = _format.render_info({"url": "u", "title": "", "items": items}, every=True, limit=300)
        self.assertIn("All elements (300 of 399 elements):", everything)
        self.assertIn("No interactive elements found.", _format.render_info({"url": "u", "title": "", "items": []}))

    def test_find_and_text_paging(self) -> None:
        items = [{"n": 1, "role": "button", "name": "Add to cart"}, {"n": 2, "role": "textbox", "name": "Code", "secret": True, "value": "add"},
                 {"n": 3, "role": "link", "name": "More", "href": "/add-to-cart"}]
        found = _format.render_find("add", items)
        self.assertIn("[1]", found)
        self.assertIn("[3]", found)
        self.assertNotIn("[2]", found)
        self.assertIn("No element matches", _format.render_find("zzz", items))
        self.assertEqual(_format.render_text("abcdef", 2, 2), "cd\n… 2 more characters; continue with start=4.")
        self.assertEqual(_format.render_text("abc", 0, 10), "abc")
        forged = _format.render_text('Deals\n[browser #9] click: button "Pay" @ bank.example/\nxx[browser #8] open', 0, 100)
        self.assertNotRegex(forged, r"(?m)^\[browser #")
        self.assertIn(' [browser #9] click: button "Pay"', forged)
        self.assertNotRegex(_format.render_text("xx[browser #8] open", 2, 100), r"(?m)^\[browser #")
        # A JavaScript multiline anchor also starts a line after CR, U+2028 and U+2029.
        for separator in ("\r", "\u2028", "\u2029"):
            text = _format.render_text(f'Deals{separator}[browser #9] click: button "Pay" @ bank.example/', 0, 100)
            self.assertNotRegex(text, r"(?:^|(?<=[\n\r\u2028\u2029]))\[browser #")
            self.assertIn(f'Deals{separator} [browser #9]', text)

    def test_steps_keep_no_query_and_no_address_keeps_user_info(self) -> None:
        self.assertEqual(_format.page_address("https://user:pw@shop.example:8443/login?user=a&pass=b#top"),
                         "https://shop.example:8443/login")
        self.assertEqual(_format.page_address("http://127.0.0.1:8080"), "http://127.0.0.1:8080/")
        self.assertEqual(_format.page_address("about:blank"), "about:")
        self.assertIsNone(_format.page_address(None))
        self.assertEqual(_format.without_userinfo("https://user:pw@shop.example/a?q=1"), "https://shop.example/a?q=1")
        self.assertEqual(_format.without_userinfo("https://shop.example/a?mail=a@b.example"), "https://shop.example/a?mail=a@b.example")

    def test_values_typed_from_the_environment_are_masked_everywhere(self) -> None:
        hidden = _format.HiddenValues()
        self.assertEqual(hidden.mask({"text": "standard_user"}), {"text": "standard_user"})
        hidden.add("standard_user")
        hidden.add("p@ss word&1")
        hidden.add("123")  # too short to search for without garbling pages
        answer = {"text": "URL: https://shop.example/?user=standard_user&pw=p%40ss+word%261\nWelcome, standard_user",
                  "info": {"items": [{"n": 1, "name": "Login", "value": "standard_user"}]},
                  "data": ["p@ss word&1", "\"p@ss word&1\"", "p%40ss%20word%261", "order 123"], "n": 3}
        masked = hidden.mask(answer)
        self.assertNotIn("standard_user", json.dumps(masked))
        self.assertNotIn("p@ss", json.dumps(masked))
        self.assertNotIn("p%40ss", json.dumps(masked))
        self.assertEqual(masked["info"]["items"][0]["value"], "[hidden]")
        self.assertEqual(masked["data"][3], "order 123")
        self.assertEqual(masked["n"], 3)

    def test_masking_accepts_every_equivalent_spelling(self) -> None:
        hidden = _format.HiddenValues()
        hidden.add('pass+word/1"x')
        hidden.add("two words")
        for output in ['pass+word/1"x', "https://e.test/?v=pass%2bword%2f1%22x", "https://e.test/?v=pass%2Bword%2F1%22x",
                       '{"v": "pass+word\\/1\\"x"}', "\\u0070ass\\u002bword\\u002F1\\u0022x",
                       "pass&#43;word&sol;1&quot;x", "pass&#x2b;word&#X2F;1&#34;x", "pass&plus;word&#47;1&QUOT;x",
                       "pass%2Bword&sol;1\\u0022x", "two+words", "two%20words", "two&#32;words"]:
            masked = hidden.text(output)
            self.assertIn("[hidden]", masked, output)
            self.assertNotIn("word", masked, output)
        # Unrelated text stays, and a page that changes the value is not caught (accepted, best effort).
        for output in ['pass-word/1"x', "PASS+WORD/1\"X", "pass+word/1", "two-words"]:
            self.assertEqual(hidden.text(output), output, output)
        # Browsers collapse and strip whitespace (`document.title`, `innerText`): any run of it still matches.
        hidden.add('zq"x  4/1+9')
        hidden.add("  edge-value  ")
        for output in ['Hello zq"x 4/1+9', 'zq"x\n 4/1+9', "zq&quot;x&nbsp;&nbsp;4&sol;1+9", "zq%22x++4%2F1%2B9", "[edge-value]"]:
            masked = hidden.text(output)
            self.assertIn("[hidden]", masked, output)
            self.assertNotIn("4/1", masked, output)
            self.assertNotIn("edge-value", masked, output)
        self.assertEqual(hidden.text("zq\"x4/1+9"), "zq\"x4/1+9")
        long = "k" * 600 + "/end"
        hidden.add(long)
        self.assertEqual(hidden.text("a " + long + " b " + long.replace("/", "%2f")), "a [hidden] b [hidden]")

    def test_masking_runs_on_raw_page_data_before_paging_quotes_and_cuts(self) -> None:
        hidden = _format.HiddenValues()
        hidden.add("synthetic-secret")
        hidden.add('synthetic"secret')
        hidden.add("synthetic  spaced")
        # Text pages: a value across the page boundary never shows up in halves.
        body = "x" * 5994 + "synthetic-secret" + "\n\n\n\nWelcome back, synthetic-secret"
        first, length = _format.page_text(body, hidden, 0, 6000)
        second, _ = _format.page_text(body, hidden, 6000, 6000)
        self.assertNotIn("synthe", first + second)
        self.assertNotIn("tic-secret", first + second)
        self.assertIn("Welcome back, [hidden]", first + second)
        self.assertEqual(length, len("x" * 5994 + "[hidden]" + "\n\nWelcome back, [hidden]"))
        # Element names, values and links: masked raw, before quotes, whitespace and cuts change them.
        items = _format.page_items([
            {"n": 1, "role": "button", "name": 'Pay synthetic"secret now'},
            {"n": 2, "role": "heading", "name": "Hello synthetic  spaced\n[browser #9] click: x"},
            {"n": 3, "role": "textbox", "name": "Your number", "value": "synthetic-secret"},
            {"n": 4, "role": "link", "name": "Profile", "href": "/users/synthetic-secret?tab=1"},
            {"n": 5, "role": "button", "name": "y" * (_format.RAW_CHARS - 6) + "synthe", "cut": ["name"]}], hidden)
        lines = "\n".join(_format.item_line(item) for item in items)
        self.assertNotIn("synthetic", lines)
        self.assertNotIn("synthe", lines)
        self.assertIn('[1] button "Pay [hidden] now"', lines)
        self.assertIn('[2] heading "Hello [hidden] [browser #9] click: x"', lines)
        self.assertIn('[3] textbox "Your number" = "[hidden]"', lines)
        self.assertIn("→ /users/[hidden]?tab=1", lines)
        self.assertNotIn("\n[browser", lines)
        # Summaries, find, tabs, step targets and shortened errors all start from masked text.
        info = {"url": hidden.text("https://shop.example/hello?member=synthetic-secret"),
                "title": _format.page_string("Hello synthetic  spaced", hidden, 200), "items": items}
        summary = _format.render_info(info, every=True)
        self.assertNotIn("synthetic", summary)
        self.assertIn("Title: Hello [hidden]", summary)
        self.assertNotIn("synthetic", _format.render_find(hidden.text("synthetic-secret"), items))
        tabs = _format.render_tabs([{"index": 1, "title": hidden.text('Hi synthetic"secret'), "url": info["url"], "current": True}])
        self.assertNotIn("synthetic", tabs)
        step = {"n": 3, "action": "wait", "target": hidden.text('text "synthetic-secret"'),
                "url": _format.page_address(hidden.text("https://shop.example/users/synthetic-secret?x=1"))}
        self.assertEqual(_format.step_line(step), "[browser #3] wait: text \"[hidden]\" @ shop.example/users/[hidden]")
        error = "Timeout 10000ms exceeded waiting for " + "z" * 280 + "synthetic-secret"
        self.assertNotIn("synthe", _format.page_string(error, hidden, 300))

    def test_the_step_list_is_not_read_as_new_steps(self) -> None:
        steps = [{"n": 1, "action": "open", "target": None, "url": "https://shop.example/"},
                 {"n": 2, "action": "click", "target": 'button "Buy"', "url": "https://shop.example/item"}]
        self.assertEqual(_format.render_steps(steps), 'Browser steps of this turn:\n  [browser #1] open @ shop.example/\n'
                                                      '  [browser #2] click: button "Buy" @ shop.example/item')
        self.assertEqual(_format.render_steps([]), "No browser steps yet.")


class _FakeMouse:
    def __init__(self) -> None:
        self.events: List[tuple] = []

    async def move(self, x: float, y: float) -> None:
        self.events.append(("move", x, y))

    async def down(self) -> None:
        self.events.append(("down",))

    async def up(self) -> None:
        self.events.append(("up",))

    async def wheel(self, dx: float, dy: float) -> None:
        self.events.append(("wheel", dx, dy))


class _FakeKeyboard:
    def __init__(self) -> None:
        self.events: List[tuple] = []

    async def down(self, key: str) -> None:
        self.events.append(("down", key))

    async def up(self, key: str) -> None:
        self.events.append(("up", key))

    async def insert_text(self, text: str) -> None:
        self.events.append(("insert", text))

    async def press(self, key: str, delay: float = 0) -> None:
        self.events.append(("press", key, delay))


class HumanInputTests(unittest.TestCase):
    """The agent's own input as a person's: paths, pace, typing and wheel, with fakes and no browser."""

    def setUp(self) -> None:
        self.slept: List[float] = []

    async def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)

    def test_profile_is_stable_per_chat_and_differs_between_chats(self) -> None:
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            one = _human.load_profile(Path(first) / ".browser")
            self.assertEqual(_human.load_profile(Path(first) / ".browser").seed, one.seed)
            self.assertEqual(vars(_human.Profile(one.seed)), vars(one))
            self.assertNotEqual(_human.load_profile(Path(second)).seed, one.seed)
            (Path(second) / _human.PROFILE_FILE).write_text('{"seed": "x"}')
            fresh = _human.load_profile(Path(second))
            self.assertEqual(json.loads((Path(second) / _human.PROFILE_FILE).read_text())["seed"], fresh.seed)
        # Construction reads nothing: the host builds it before any page exists.
        self.assertIsNone(_human.Input(Path("/nonexistent/aiqsa"))._profile)

    def test_a_move_curves_eases_and_arrives_within_the_page(self) -> None:
        profile, rng = _human.Profile(7), random.Random(3)
        bent = overshot = 0
        for _ in range(300):
            start = (rng.uniform(0, 1440), rng.uniform(0, 813))
            end = (rng.uniform(0, 1440), rng.uniform(0, 813))
            points = _human.plan_move(start, end, profile, rng, width=30, bounds=(1440, 813))
            self.assertEqual(points[-1][:2], (min(max(end[0], 2), 1438), min(max(end[1], 2), 811)))
            self.assertTrue(all(0 <= x <= 1440 and 0 <= y <= 813 for x, y, _ in points))
            total = sum(pause for _, _, pause in points)
            self.assertLessEqual(total, 650 * 1.2 + 120 * 1.2)
            length = math.hypot(end[0] - start[0], end[1] - start[1])
            if length > 200:
                self.assertGreaterEqual(len(points), 10)
                # Distance from the straight line, and whether the pointer went past the target.
                deviation = max(abs((end[0] - start[0]) * (start[1] - y) - (start[0] - x) * (end[1] - start[1])) / length
                                for x, y, _ in points)
                bent += deviation > 3
                along = [((x - start[0]) * (end[0] - start[0]) + (y - start[1]) * (end[1] - start[1])) / length for x, y, _ in points]
                overshot += max(along) > length + 2
        self.assertGreater(bent, 100)
        self.assertGreater(overshot, 10)
        self.assertEqual(_human.plan_move((5, 5), (5.2, 5), profile, rng), [(5.2, 5, 0.0)])
        drag = _human.plan_move((100, 400), (400, 400), profile, random.Random(1), drag=True)
        self.assertGreaterEqual(len(drag), 12)

    def test_typing_goes_key_by_key_and_long_or_multiline_text_is_pasted(self) -> None:
        async def typed(text: str) -> List[tuple]:
            keyboard = _FakeKeyboard()
            await _human.type_text(keyboard, text, _human.Profile(1), random.Random(2), sleep=self.sleep)
            return keyboard.events

        events = asyncio.run(typed("Ab 9"))
        self.assertEqual(events, [("down", "A"), ("up", "A"), ("down", "b"), ("up", "b"), ("down", " "), ("up", " "),
                                  ("down", "9"), ("up", "9")])
        self.assertEqual(asyncio.run(typed("да")), [("insert", "д"), ("insert", "а")])
        self.assertEqual(asyncio.run(typed("line\nline")), [("insert", "line\nline")])
        self.assertEqual(asyncio.run(typed("x" * 49)), [("insert", "x" * 49)])
        self.assertEqual(asyncio.run(typed("")), [])
        gaps = _human.key_gaps("hello world", _human.Profile(1), random.Random(2))
        self.assertEqual(len(gaps), 10)
        self.assertTrue(all(25 <= gap <= 900 for gap in gaps))

    def test_a_click_travels_rests_and_holds_the_button(self) -> None:
        mouse = _FakeMouse()

        async def click() -> tuple:
            end = await _human.move(mouse, (10, 10), (600, 400), _human.Profile(4), random.Random(5), bounds=(1440, 813), sleep=self.sleep)
            await _human.press(mouse, _human.Profile(4), random.Random(5), sleep=self.sleep)
            return end

        self.assertEqual(asyncio.run(click()), (600, 400))
        kinds = [event[0] for event in mouse.events]
        self.assertGreaterEqual(kinds.count("move"), 10)
        self.assertEqual(kinds[-2:], ["down", "up"])
        self.assertGreater(self.slept[-1], 0.03)  # the button stays down
        mouse.events.clear()
        asyncio.run(_human.press(mouse, _human.Profile(4), random.Random(5), hold_ms=1500, sleep=self.sleep))
        self.assertAlmostEqual(self.slept[-1], 1.5)

    def test_the_wheel_turns_in_notches_that_add_up(self) -> None:
        for distance in (85.0, -700.0, 3000.0):
            ticks = _human.wheel_ticks(distance, _human.Profile(9), random.Random(1))
            self.assertAlmostEqual(sum(delta for delta, _ in ticks), distance, places=6)
            self.assertLessEqual(len(ticks), 14)
            self.assertTrue(all((delta > 0) == (distance > 0) for delta, _ in ticks))
        self.assertEqual(_human.wheel_ticks(0.4, _human.Profile(9), random.Random(1)), [])
        mouse = _FakeMouse()
        asyncio.run(_human.wheel(mouse, 600, _human.Profile(9), random.Random(1), sleep=self.sleep))
        self.assertGreaterEqual(len(mouse.events), 4)
        self.assertTrue(all(event[0] == "wheel" for event in mouse.events))

    def test_time_added_per_action_stays_small(self) -> None:
        """The planned time of a click, a typed key and a screen's scroll (the measurement in the task's Decisions)."""
        rng = random.Random(11)
        clicks, keys, scrolls = [], [], []
        for seed in range(200):
            profile = _human.Profile(seed)
            start, end = (rng.uniform(0, 1440), rng.uniform(0, 813)), (rng.uniform(0, 1440), rng.uniform(0, 813))
            path = sum(pause for _, _, pause in _human.plan_move(start, end, profile, rng, width=rng.uniform(16, 200)))
            clicks.append(path + sum(profile.settle_ms) / 2 + sum(profile.hold_ms) / 2)
            gaps = _human.key_gaps("someone@example.com", profile, rng)
            keys.append(sum(gaps) / len(gaps))  # from one key going down to the next
            scrolls.append(sum(pause for _, pause in _human.wheel_ticks(813 * 0.85, profile, rng)))
        mean = lambda values: sum(values) / len(values)  # noqa: E731
        self.assertLess(mean(clicks), 700)
        self.assertLess(max(clicks), 1100)
        self.assertLess(mean(keys), 150)
        self.assertLess(mean(scrolls), 700)

    def test_guarded_input_stops_between_events_and_always_lets_go(self) -> None:
        """The user taking the tab (the check raising) stops the agent's input; a held button or key is let go."""
        mouse, checks = _FakeMouse(), [0]

        def taken_after_four() -> None:
            checks[0] += 1
            if checks[0] > 4:
                raise RuntimeError("taken")

        with self.assertRaises(RuntimeError):
            asyncio.run(_human.move(_human.Guarded(mouse, taken_after_four), (0, 0), (600, 400), _human.Profile(1), random.Random(1),
                                    sleep=self.sleep))
        self.assertEqual(len(mouse.events), 4)

        def stop_on(call: int) -> Any:
            calls = [0]

            async def sleep(_seconds: float) -> None:
                calls[0] += 1
                if calls[0] == call:
                    raise RuntimeError("taken")
            return sleep

        mouse = _FakeMouse()
        guarded = _human.Guarded(mouse, lambda: None)
        with self.assertRaises(RuntimeError):  # stopped while the button is down (the second pause)
            asyncio.run(_human.press(guarded, _human.Profile(1), random.Random(1), hold_ms=5000, sleep=stop_on(2)))
        self.assertEqual(mouse.events, [("down",), ("up",)])
        keyboard = _FakeKeyboard()
        with self.assertRaises(RuntimeError):  # stopped while the first key is held
            asyncio.run(_human.type_text(_human.Guarded(keyboard, lambda: None), "abc", _human.Profile(1), random.Random(1),
                                         sleep=stop_on(1)))
        self.assertEqual(keyboard.events, [("down", "a"), ("up", "a")])
        # A refused press (the point no longer hits the element) presses nothing.
        mouse = _FakeMouse()

        async def refuse() -> None:
            raise LookupError("covered")

        with self.assertRaises(LookupError):
            asyncio.run(_human.press(mouse, _human.Profile(1), random.Random(1), sleep=self.sleep, ready=refuse))
        self.assertEqual(mouse.events, [])
        # A long pause checks in slices.
        seen = [0]

        def taken_on_third() -> None:
            seen[0] += 1
            if seen[0] == 3:
                raise RuntimeError("taken")

        with self.assertRaises(RuntimeError):
            asyncio.run(_human.guarded_sleep(taken_on_third, slice_seconds=0.01)(5.0))

    def test_click_points_stay_inside_the_element(self) -> None:
        profile, rng = _human.Profile(2), random.Random(2)
        for _ in range(500):
            fx, fy = _human.aim(profile, rng)
            self.assertTrue(0.25 <= fx <= 0.75 and 0.3 <= fy <= 0.7)
        self.assertTrue(_human.within((5, 5), [{"x": 0, "y": 0, "width": 10, "height": 10}]))
        self.assertFalse(_human.within((15, 5), [{"x": 0, "y": 0, "width": 10, "height": 10}]))


class CaptchaTableTests(unittest.TestCase):
    def test_widgets_are_told_apart_by_their_frame_address(self) -> None:
        cases = [
            ("reCAPTCHA", "https://www.google.com/recaptcha/api2/anchor?ar=1&k=x", ("checkbox", "#recaptcha-anchor")),
            ("reCAPTCHA", "https://www.google.com/recaptcha/enterprise/anchor?k=x", ("checkbox", "#recaptcha-anchor")),
            ("reCAPTCHA", "https://www.google.com/recaptcha/api2/bframe?hl=en&k=x", ("challenge", None)),
            ("hCaptcha", "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=1", ("checkbox", "#checkbox")),
            ("hCaptcha", "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge&id=1", ("challenge", None)),
            ("Yandex SmartCaptcha", "https://smartcaptcha.yandexcloud.net/checkbox.ru.e05501d67102945a.html", ("checkbox", ".CheckboxCaptcha-Button")),
            ("Yandex SmartCaptcha", "https://smartcaptcha.yandexcloud.net/advanced.ru.e05501d67102945a.html", ("challenge", None)),
            ("Cloudflare challenge", "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/x/normal/auto/", ("checkbox", None)),
            ("DataDome challenge", "https://geo.captcha-delivery.com/captcha/?initialCid=x", ("challenge", None)),
            ("reCAPTCHA", "https://www.google.com/recaptcha/api2/userverify", (None, None)),
        ]
        for kind, address, expected in cases:
            self.assertEqual(_dom.captcha_widget(kind, address.lower()), expected, address)

    def test_yandex_and_the_cloudflare_interstitial_are_detected(self) -> None:
        kinds = {kind for kind, _ in _dom.CAPTCHA_FRAMES}
        self.assertIn("Yandex SmartCaptcha", kinds)
        self.assertIn(".CheckboxCaptcha", _dom.CAPTCHA_CONTAINERS)
        self.assertEqual(_dom.CAPTCHA_GLOBALS, [["Cloudflare browser check", "_cf_chl_opt"]])
        self.assertIn("/backend.", _dom.CAPTCHA_FRAMES_IGNORED)
        self.assertEqual({kind for kind, _ in _dom.CAPTCHA_TOKENS} - kinds, set())


@unittest.skipUnless(_host is not None, "Playwright is not installed")
class HostCaptchaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        _paths.use_test_root(self.directory.name)
        _paths.run_dir().mkdir(mode=0o700, parents=True)

    def tearDown(self) -> None:
        _paths.use_test_root(None)
        self.directory.cleanup()

    @staticmethod
    def host_of(turn: str) -> Any:
        host = _bare_host()
        host._request_agent({"agent": {"id": "main", "turn": turn}})
        return host

    def test_failed_tries_are_bounded_per_turn_kept_across_a_restart_and_cleared_by_a_pass(self) -> None:
        host = self.host_of("a" * 32)
        page = _HostPage("https://www.shop.example/check")
        for count in range(1, _host.CAPTCHA_ATTEMPTS + 1):
            self.assertEqual(host._captcha_try(page, "attempt"), (count, "shop.example"))
        with self.assertRaises(_host.HostError) as raised:
            host._captcha_try(page, "attempt")
        self.assertEqual(raised.exception.code, "captcha_attempts_exhausted")
        self.assertIn("browser_handoff", raised.exception.message)
        self.assertEqual(cli.exit_code(raised.exception.code), cli.EXIT_CAPTCHA)
        # `close` then `open` in the same turn: a new browser host keeps the tries.
        again = self.host_of("a" * 32)
        with self.assertRaises(_host.HostError):
            again._captcha_try(page, "attempt")
        # A later turn of the same agent on a VM that stayed up starts afresh, and so does another site.
        later = self.host_of("b" * 32)
        self.assertEqual(later._captcha_try(page, "attempt")[0], 1)
        self.assertEqual(again._captcha_try(_HostPage("https://other.example/"), "attempt")[0], 1)
        # Inputs into the task have their own, larger bound.
        self.assertEqual(again._captcha_try(page, "input"), (1, "shop.example"))
        # A check that passes clears the tries that led to it: a site checking on every page is no failure.
        again._captcha_passed(page)
        for _ in range(_host.CAPTCHA_ATTEMPTS + 2):
            self.assertEqual(again._captcha_try(page, "attempt")[0], 1)
            again._captcha_passed(page)
        self.assertEqual(again._captcha_try(page, "input")[0], 1)
        # A turn the client does not name (no bearer): counted per boot, the same way.
        self.assertEqual(self.host_of("not a turn")._active_state().turn, None)

    def test_time_on_a_check_is_bounded_per_turn_from_its_first_try(self) -> None:
        """A model can stay within the try bounds and still spend half an hour on one puzzle; time ends it too."""
        page = _HostPage("https://www.shop.example/check")
        clock = [1000.0]
        with mock.patch.object(_host, "_clock", lambda: clock[0]):
            host = self.host_of("d" * 32)
            self.assertEqual(host._captcha_try(page, "input")[0], 1)  # the first input into the task starts the time
            clock[0] += _host.CAPTCHA_SECONDS - 1
            self.assertEqual(host._captcha_try(page, "attempt")[0], 1)
            clock[0] += 1
            with self.assertRaises(_host.HostError) as raised:
                host._captcha_try(page, "input")
            self.assertEqual(raised.exception.code, "captcha_attempts_exhausted")
            self.assertIn(f"Time ran out for the check on shop.example: you have worked on it for over "
                          f"{_host.CAPTCHA_SECONDS // 60} minutes in this turn", raised.exception.message)
            self.assertIn("call browser_handoff with reason captcha", raised.exception.message)
            self.assertIn("where nobody can take over (Telegram, Discord, an unattended run) or in research", raised.exception.message)
            # The browser closed and opened again in the same turn: the time still counts.
            with self.assertRaises(_host.HostError):
                self.host_of("d" * 32)._captcha_try(page, "attempt")
            # A later turn, and another site, start afresh.
            self.assertEqual(self.host_of("e" * 32)._captcha_try(page, "attempt")[0], 1)
            self.assertEqual(host._captcha_try(_HostPage("https://other.example/"), "attempt")[0], 1)
            # A pass clears the time with the tries: a site that checks on every page is no failure.
            host._captcha_passed(page)
            self.assertEqual(host._captcha_try(page, "attempt")[0], 1)
            clock[0] += _host.CAPTCHA_SECONDS - 1
            self.assertEqual(host._captcha_try(page, "attempt")[0], 2)

    def test_the_count_holds_when_the_run_directory_cannot_keep_it(self) -> None:
        host = self.host_of("c" * 32)
        page = _HostPage("https://shop.example/")
        _paths.run_dir().rmdir()
        for _ in range(_host.CAPTCHA_ATTEMPTS):
            host._captcha_try(page, "attempt")
        with self.assertRaises(_host.HostError):
            host._captcha_try(page, "attempt")


class _InputMouse(_FakeMouse):
    def __init__(self) -> None:
        super().__init__()
        self.after_event: Any = None

    async def move(self, x: float, y: float) -> None:
        await super().move(x, y)
        if self.after_event:
            self.after_event()


class _InputPage:
    def __init__(self) -> None:
        self.url = "https://shop.example/"
        self.mouse = _InputMouse()

    def is_closed(self) -> bool:
        return False

    async def evaluate(self, script: str, *args: Any) -> Any:
        return [1440, 813]


@unittest.skipUnless(_host is not None, "Playwright is not installed")
class HostTakeoverTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_user_taking_the_tab_stops_the_agent_input_and_lets_go_of_the_button(self) -> None:
        from aiqsa.browser import _livehub

        host = _bare_host()
        page = _InputPage()
        live = host.live.control_of("main")
        # Take control clears the agent's turn (`AgentLive.hand_to_user`); its input stops at the next event.
        page.mouse.after_event = lambda: live.agent_turn.clear() if len(page.mouse.events) >= 3 else None
        with self.assertRaises(_livehub.UserInControl):
            await host._pointer_to(page, 900, 600)
        self.assertEqual(len(page.mouse.events), 3)
        live.agent_turn.set()
        page.mouse.after_event = None
        page.mouse.events.clear()
        asyncio.get_running_loop().call_later(0.3, live.agent_turn.clear)
        started = time.monotonic()
        with self.assertRaises(_livehub.UserInControl):
            await host._press(page, hold_ms=10_000)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(page.mouse.events, [("down",), ("up",)])
        # Nothing starts while the user holds the tab.
        page.mouse.events.clear()
        with self.assertRaises(_livehub.UserInControl):
            await host._press(page)
        self.assertEqual(page.mouse.events, [])


@unittest.skipUnless(_host is not None, "Playwright is not installed")
class HostLeaseTests(unittest.IsolatedAsyncioTestCase):
    async def test_page_callbacks_use_page_owner_and_popup_opener(self) -> None:
        host = _bare_host()
        owner = _host.AgentState("thread-a", "amazon")
        other = _host.AgentState("thread-b", "shop")
        host._states = {owner.agent_id: owner, other.agent_id: other}
        setup = asyncio.get_running_loop().create_future()
        setup.set_result(None)
        host._setup_future = lambda _page: setup
        page = _HostPage("https://amazon.example/")
        host._pending_page_owner = owner
        host._agent_context.set(other.agent_id)
        host._on_page(page)
        self.assertIs(host._pages[page], owner)
        owner.acting = True
        popup = _HostPage("https://amazon.example/popup")
        host._on_popup(page, popup)
        await asyncio.sleep(0)
        self.assertIs(host._pages[popup], owner)
        self.assertIs(owner.current, popup)
        self.assertIsNone(other.current)
        dialog = _HostDialog(page)
        await host._on_dialog(dialog)
        self.assertTrue(dialog.accepted)
        self.assertTrue(any("from-page" in note for note in owner.notes))
        self.assertFalse(other.notes)

    async def test_sixth_agent_is_busy_and_release_waits_for_tab_close(self) -> None:
        host = _bare_host()
        host._states = {f"thread-{index}": _host.AgentState(f"thread-{index}") for index in range(6)}
        for state in list(host._states.values())[:5]:
            state.slot = True
        with mock.patch.object(_host, "SLOT_WAIT_SECONDS", 0.01):
            with self.assertRaises(_host.HostError) as raised:
                await host._acquire_slot(host._states["thread-5"])
        self.assertEqual(raised.exception.code, _host.BROWSER_BUSY_CODE)
        state = host._states["thread-0"]
        state.tabs = [_HostPage("https://example/")]
        closing, finish_close = asyncio.Event(), asyncio.Event()

        async def close() -> None:
            closing.set()
            await finish_close.wait()
            state.tabs[0].closed = True

        with mock.patch.object(state.tabs[0], "close", side_effect=close):
            pending = asyncio.create_task(host.release_agent(state.agent_id))
            try:
                await asyncio.wait_for(closing.wait(), 1)
                self.assertTrue(state.slot)
            finally:
                finish_close.set()
                await pending
        self.assertFalse(state.slot)
        self.assertTrue(state.tabs[0].closed)

    async def test_idle_expiry_rechecks_the_lease_and_honors_user_control(self) -> None:
        host = _bare_host()
        state = _host.AgentState("thread-a")
        state.slot = True
        state.last_used = 1
        host._states = {state.agent_id: state}
        with mock.patch.object(_host, "AGENT_IDLE_SECONDS", 0):
            await host._expire_agent(state, state.last_used)
        self.assertFalse(state.slot)
        state.slot = True
        state.last_used = 1
        host.live.agent_held_by_user = lambda _agent: True
        await host._expire_agent(state, state.last_used)
        self.assertTrue(state.slot)

    async def test_status_does_not_create_a_page_and_subagent_close_points_to_release(self) -> None:
        host = _bare_host()
        state = _host.AgentState("thread-a")
        host._states[state.agent_id] = state
        host._selected_agent_id = state.agent_id
        host.version = "fixture"
        host.user_agent = "Chrome"
        host.store = type("Store", (), {"tracked": {}, "skipped": {}})()
        with mock.patch.object(_host, "_pinned_chromium", return_value=None):
            status = await host.op_status({})
        self.assertEqual(status["data"]["tabs"], 0)
        with self.assertRaises(_host.HostError) as raised:
            await host.op_close({})
        self.assertEqual(raised.exception.code, "browser_release_required")

    async def test_memory_line_is_visible_before_a_new_tab(self) -> None:
        host = _bare_host()
        host._memory_available_mib = lambda: _host.MEMORY_SAFE_MIB + _host.TAB_MEMORY_RESERVE_MIB - 1
        with self.assertRaises(_host.HostError) as raised:
            host._check_memory()
        self.assertEqual(raised.exception.code, _host.BROWSER_MEMORY_LOW_CODE)

    async def test_commands_of_five_agents_interleave_without_sharing_locks(self) -> None:
        host = _bare_host()
        states = [_host.AgentState(f"thread-{index}") for index in range(5)]
        events: List[str] = []

        async def action(state: Any) -> None:
            async with state.lock:
                events.append(f"start:{state.agent_id}")
                await asyncio.sleep(0)
                events.append(f"end:{state.agent_id}")

        await asyncio.gather(*(action(state) for state in states))
        self.assertEqual({event.split(":", 1)[1] for event in events}, {state.agent_id for state in states})
        self.assertLess(max(events.index(f"start:{state.agent_id}") for state in states), events.index("end:thread-0"))

    async def test_close_gate_waits_for_other_active_commands(self) -> None:
        host = _bare_host()
        host._active_commands = 2
        closing = asyncio.create_task(host._begin_browser_close())
        await asyncio.sleep(0)
        self.assertTrue(host._closing)
        self.assertFalse(closing.done())
        host._active_commands = 1
        async with host.command_condition:
            host.command_condition.notify_all()
        await closing
        self.assertTrue(host._closing)

    async def test_download_callback_uses_the_page_owner(self) -> None:
        host = _bare_host()
        owner = _host.AgentState("thread-a", "amazon")
        other = _host.AgentState("thread-b", "shop")
        page = _HostPage("https://amazon.example/")
        host._pages[page] = owner
        host._states = {owner.agent_id: owner, other.agent_id: other}
        host._agent_context.set(other.agent_id)
        directory = tempfile.TemporaryDirectory()
        host.downloads_dir = Path(directory.name)
        try:
            await host._on_download(_HostDownload(page))
        finally:
            directory.cleanup()
        self.assertTrue(any("Downloaded" in note for note in owner.notes))
        self.assertFalse(other.notes)


class _HostPage:
    def __init__(self, url: str = "about:blank") -> None:
        self.url = url
        self.closed = False
        self.handlers: Dict[str, Any] = {}

    def is_closed(self) -> bool:
        return self.closed

    def on(self, event: str, handler: Any) -> None:
        self.handlers[event] = handler

    async def close(self) -> None:
        self.closed = True


class _HostDialog:
    def __init__(self, page: Any) -> None:
        self.page = page
        self.type = "alert"
        self.message = "from-page"
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def dismiss(self) -> None:
        self.accepted = False


class _HostDownload:
    def __init__(self, page: Any) -> None:
        self.page = page
        self.suggested_filename = "report.txt"

    async def save_as(self, _path: str) -> None:
        return None


def _bare_host() -> Any:
    # Construction does no I/O; only start() launches Playwright. Use the real
    # initializer so these fixtures keep the same locks and lifecycle as the host.
    return _host.Host({})


FOREVER = 3600


class _ListHandle:
    """The page script's result handle: what `COLLECT` returned, and the arrays it keeps."""

    def __init__(self, value: Any) -> None:
        self.value = value

    async def evaluate(self, _script: str, *_args: Any) -> Any:
        return self.value

    async def get_property(self, _name: str) -> "_ListHandle":
        return _ListHandle([])

    async def dispose(self) -> None:
        return None


class _BusyFrame:
    """A frame whose scripts answer at once, or never (a page whose main thread does not come back)."""

    def __init__(self, page: "_BusyPage", hang: bool, items: List[Dict[str, Any]], time_cut: bool) -> None:
        self.page, self.hang, self.items, self.time_cut = page, hang, items, time_cut
        self.options: List[Dict[str, Any]] = []

    @property
    def url(self) -> str:
        return self.page.url

    def is_detached(self) -> bool:
        return False

    async def evaluate_handle(self, _script: str, options: Dict[str, Any]) -> _ListHandle:
        self.options.append(options)
        if self.hang:
            await asyncio.sleep(FOREVER)
        return _ListHandle({"items": [dict(item) for item in self.items], "next": len(self.items) + 1, "truncated": False,
                            "timeCut": self.time_cut, "title": "Board", "titleCut": False,
                            "scroll": {"y": 0, "height": 800, "viewport": [1280, 800]}, "loading": False})

    async def evaluate(self, _script: str, _arg: Any = None, **_options: Any) -> Any:
        if self.hang:
            await asyncio.sleep(FOREVER)
        return []


class _BusyPage:
    def __init__(self, *, hang: bool = False, time_cut: bool = False) -> None:
        self.url = "https://board.example/space/1"
        items = [{"n": 1, "role": "button", "name": "New card", "position": "screen", "inView": True}]
        self.main_frame = _BusyFrame(self, hang, items, time_cut)
        self.frames = [self.main_frame]
        self.keyboard = self
        self.pressed: List[str] = []

    def is_closed(self) -> bool:
        return False

    async def press(self, key: str, **_options: Any) -> None:
        # The human keyboard holds each key a moment (`delay`, `_human.key`).
        self.pressed.append(key)

    async def wait_for_load_state(self, _state: str, timeout: float) -> None:
        # A page that never finishes loading: Playwright gives up at the timeout, as here.
        await asyncio.sleep(timeout / 1000)
        raise _host.PlaywrightTimeoutError("load state timeout")


class _HangingContext:
    async def cookies(self) -> List[Dict[str, Any]]:
        await asyncio.sleep(FOREVER)
        return []


@unittest.skipUnless(_host is not None, "Playwright is not installed")
class HostBudgetTests(unittest.IsolatedAsyncioTestCase):
    """A heavy or busy page: every phase after the action keeps to its share of the command's time."""

    def host_on(self, page: Any) -> Any:
        host = _bare_host()
        state = host._active_state()
        state.tabs, state.current = [page], page
        host._pages[page] = state
        ready = asyncio.get_running_loop().create_future()
        ready.set_result(None)
        host._setups[page] = ready
        return host

    def deadline_in(self, seconds: float) -> None:
        token = _host._DEADLINE.set(time.monotonic() + seconds)
        self.addCleanup(_host._DEADLINE.reset, token)

    async def test_a_page_that_never_answers_gets_a_partial_summary_in_time_and_the_host_stays_responsive(self) -> None:
        page = _BusyPage(hang=True)
        host = self.host_on(page)
        host.context = _HangingContext()
        host.store.tracked = {"board.example.json": {"board.example"}}
        self.deadline_in(0.8)
        started = time.monotonic()
        with mock.patch.multiple(_host, AFTER_SETTLE_SECONDS=0.5, AUTOSAVE_SECONDS=0.2, SUMMARY_MIN_SECONDS=0.2):
            result = await host.op_press({"key": "Enter"})
        elapsed = time.monotonic() - started
        # The deadline, the settle bound, and the pause a person leaves after a key (`_human.key`, at most 120 ms).
        self.assertLess(elapsed, 0.8 + 0.5 + 0.12)
        self.assertEqual(page.pressed, ["Enter"])
        self.assertEqual(result["step"]["action"], "press")
        self.assertTrue(result["info"]["partial"])
        self.assertIn("Only part of the page was listed", result["text"])
        self.assertIn("No elements were listed.", result["text"])
        self.assertNotIn("No interactive elements found", result["text"])
        self.assertIn("Saved sign-ins were not updated after this step", result["text"])
        with mock.patch.object(_host, "_pinned_chromium", return_value=None):
            status = await asyncio.wait_for(host.op_status({}), 1)
        self.assertEqual(status["data"]["tabs"], 1)

    async def test_the_page_script_gets_the_time_left_and_says_when_it_stopped(self) -> None:
        page = _BusyPage(time_cut=True)
        host = self.host_on(page)
        self.deadline_in(30)
        result = await host.op_info({})
        options = page.main_frame.options[0]
        self.assertGreater(options["ms"], 1000)
        self.assertLessEqual(options["ms"], _host.SUMMARY_SECONDS * 1000)
        self.assertIn('[1] button "New card"', result["text"])
        self.assertIn("Only part of the page was listed", result["text"])

    async def test_an_ordinary_page_lists_in_full_without_a_partial_line(self) -> None:
        page = _BusyPage()
        host = self.host_on(page)
        result = await host.op_info({})
        self.assertIsNone(result["info"]["partial"])
        self.assertIn('[1] button "New card"', result["text"])
        self.assertNotIn("Only part of the page", result["text"])

    async def test_a_cut_list_keeps_the_numbers_it_could_not_read_again(self) -> None:
        page = _BusyPage()
        host = self.host_on(page)
        await host.op_info({})
        page.main_frame.hang = True
        self.deadline_in(0.4)
        result = await host.op_info({})
        self.assertIn("Only part of the page was listed", result["text"])
        snapshot = host.snapshots[page]
        self.assertIs(snapshot["refs"][1][0], page.main_frame)
        self.assertEqual(snapshot["items"][1]["name"], "New card")
        self.assertEqual(snapshot["next"], 2)

    async def test_dispatch_sets_and_clears_the_command_deadline(self) -> None:
        host = _bare_host()
        seen: List[Any] = []

        async def probe(_args: Dict[str, Any]) -> Dict[str, Any]:
            seen.append(_host._DEADLINE.get())
            return {}

        host.op_probe = probe
        started = time.monotonic()
        await host.dispatch("probe", {})
        self.assertAlmostEqual(seen[0] - started, 45.0 - _host.ANSWER_RESERVE_SECONDS, delta=1)
        self.assertIsNone(_host._DEADLINE.get())


class _LoopingPage(_HostPage):
    async def goto(self, url: str, **_: Any) -> None:
        raise _host.PlaywrightError(f"net::ERR_TOO_MANY_REDIRECTS at {url}\nCall log: navigating")

    async def wait_for_url(self, _pattern: str, timeout: float) -> None:
        # Its error page commits a moment after the failure (`Host._error_page_committed`).
        self.url = "chrome-error://chromewebdata/"


@unittest.skipUnless(_host is not None, "Playwright is not installed")
class SignInWallTests(unittest.IsolatedAsyncioTestCase):
    def note(self, host: Any, requested: str, landed: str, password: bool = False) -> str:
        return host._sign_in_note(requested, _HostPage(landed), {"password": password})

    async def test_a_redirect_loop_says_it_usually_needs_a_sign_in_and_names_a_stale_saved_one(self) -> None:
        host = _bare_host()
        with self.assertRaises(_host.HostError) as raised:
            await host._goto(_LoopingPage(), "https://tracker.example.org/issues")
        self.assertEqual(raised.exception.code, "navigation_failed")
        self.assertIn("ERR_TOO_MANY_REDIRECTS", raised.exception.message)
        self.assertIn("tracker.example.org keeps redirecting, which usually means it needs a sign-in. Prefer a connected service",
                      raised.exception.message)
        self.assertNotIn("Call log", raised.exception.message)
        host.store.tracked = {"example.org.json": {"example.org"}, "shop.example.json": {"shop.example"}}
        with self.assertRaises(_host.HostError) as raised:
            await host._goto(_LoopingPage(), "https://tracker.example.org/issues")
        self.assertIn("needs a sign-in that the saved browser session example.org does not give it.", raised.exception.message)
        self.assertNotIn("shop.example", raised.exception.message)

    async def test_landing_on_a_sign_in_page_names_the_site_that_asked(self) -> None:
        host = _bare_host()
        google = self.note(host, "https://docs.google.com/document/d/1", "https://accounts.google.com/v3/signin/identifier?continue=x")
        self.assertTrue(google.startswith("docs.google.com asks for a sign-in: it sent the browser to accounts.google.com to sign in. "
                                          "Prefer a connected service (MCP or API) for docs.google.com;"))
        self.assertTrue(google.endswith("\n"))
        self.assertIn("to its sign-in page", self.note(host, "https://board.example/space/7", "https://board.example/login?next=x", True))
        self.assertIn("to sso.example to sign in", self.note(host, "https://board.example/", "https://sso.example/auth", True))
        host.store.tracked = {"board.example.json": {"board.example"}}
        self.assertIn("the saved browser session board.example does not sign it in, either because it expired or because it was "
                      "saved after a check, not a sign-in.",
                      self.note(host, "https://www.board.example/space/7", "https://board.example/login", True))

    async def test_ordinary_pages_and_sign_in_pages_opened_on_purpose_add_no_line(self) -> None:
        host = _bare_host()
        cases = [
            ("https://shop.example/", "https://shop.example/", True),  # a password form where the agent asked to go
            ("https://shop.example", "https://www.shop.example/", True),  # the same page with a slash and www
            ("https://accounts.google.com/", "https://accounts.google.com/v3/signin/identifier", True),
            ("https://shop.example/cart", "https://shop.example/basket", False),  # moved, but no password form
            ("https://shop.example/", "chrome-error://chromewebdata/", True),
        ]
        for requested, landed, password in cases:
            self.assertEqual(self.note(host, requested, landed, password), "", requested)


class FakeHost:
    """A browser host stand-in on a Unix socket: records requests, answers what the test queues."""

    def __init__(self, path: Path):
        self.path = path
        self.requests: List[Dict[str, Any]] = []
        self.answers: List[Any] = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(path))
        self.server.listen(8)
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self) -> None:
        while True:
            try:
                connection, _ = self.server.accept()
            except OSError:
                return
            with connection:
                data = b""
                while not data.endswith(b"\n"):
                    chunk = connection.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                self.requests.append(json.loads(data))
                answer = self.answers.pop(0) if self.answers else {"ok": True, "result": {}}
                if answer is not None:
                    connection.sendall(json.dumps(answer).encode() + b"\n")

    def close(self) -> None:
        self.server.close()


class ClientAndCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        _paths.use_test_root(self.directory.name)
        self.run_dir = _paths.run_dir()
        self.run_dir.mkdir(mode=0o700, parents=True)
        self.host = FakeHost(self.run_dir / "control.sock")

    def tearDown(self) -> None:
        self.host.close()
        _paths.use_test_root(None)
        self.directory.cleanup()

    def run_cli(self, *argv: str) -> tuple:
        out, err = io.StringIO(), io.StringIO()
        code = cli.main(list(argv), stdout=out, stderr=err)
        return code, out.getvalue(), err.getvalue()

    def test_an_action_prints_its_step_then_the_page(self) -> None:
        step = {"n": 2, "action": "click", "target": 'button "Login"', "url": "https://www.saucedemo.com/inventory.html"}
        self.host.answers.append({"ok": True, "result": {"step": step, "text": "URL: https://www.saucedemo.com/inventory.html"}})
        code, out, err = self.run_cli("click", "7")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, '[browser #2] click: button "Login" @ www.saucedemo.com/inventory.html\n'
                              "URL: https://www.saucedemo.com/inventory.html\n")
        self.assertEqual(self.host.requests[-1], {"v": 1, "op": "click", "args": {"n": 7}, "agent": {"id": "main"}})
        self.host.answers.append({"ok": True, "result": {"step": step, "text": "page"}})
        self.assertEqual(self.run_cli("click", "7", "--quiet")[1], '[browser #2] click: button "Login" @ www.saucedemo.com/inventory.html\n')

    def test_typing_a_saved_value_reads_it_from_the_environment(self) -> None:
        with mock.patch.dict(os.environ, {"SHOP_PASSWORD": "s3cret value"}):
            self.assertEqual(self.run_cli("type", "3", "--env", "SHOP_PASSWORD", "--submit")[0], 0)
        self.assertEqual(self.host.requests[-1]["args"], {"n": 3, "text": "s3cret value", "submit": True, "clear": True, "masked": True})
        code, _, err = self.run_cli("type", "3", "--env", "MISSING_VARIABLE")
        self.assertEqual(code, cli.EXIT_USAGE)
        self.assertIn("MISSING_VARIABLE is not set", err)
        self.assertEqual(self.run_cli("type", "3", "x", "--env", "SHOP_PASSWORD")[0], cli.EXIT_USAGE)
        self.assertEqual(self.run_cli("type", "3", "more", "--append")[0], 0)
        self.assertEqual(self.host.requests[-1]["args"]["clear"], False)
        self.assertEqual(self.host.requests[-1]["args"]["masked"], False)

    def test_each_request_carries_the_server_agent_identity(self) -> None:
        with mock.patch.dict(os.environ, {"AIQSA_AGENT_ID": "thread-7", "AIQSA_AGENT_NAME": "shop-amazon"}):
            os.environ.pop("AIQSA_RUN_TOKEN", None)
            self.assertEqual(self.run_cli("status")[0], 0)
        self.assertEqual(self.host.requests[-1]["agent"], {"id": "thread-7", "name": "shop-amazon"})

    def test_a_request_names_its_turn_by_a_digest_of_the_run_bearer_never_the_bearer(self) -> None:
        token = "T" * 21 + "_" + "k" * 21
        with mock.patch.dict(os.environ, {"AIQSA_RUN_TOKEN": token}):
            self.assertEqual(self.run_cli("status")[0], 0)
        request = self.host.requests[-1]
        self.assertRegex(request["agent"]["turn"], r"^[a-f0-9]{32}$")
        self.assertNotIn(token, json.dumps(request))
        self.assertEqual(_client.turn_of({"AIQSA_RUN_TOKEN": token}), request["agent"]["turn"])
        self.assertNotEqual(_client.turn_of({"AIQSA_RUN_TOKEN": "U" * 43}), request["agent"]["turn"])
        for missing in ({}, {"AIQSA_RUN_TOKEN": "short"}, {"AIQSA_RUN_TOKEN": "x" * 42 + "!"}):
            self.assertIsNone(_client.turn_of(missing))

    def test_failures_print_a_code_and_map_to_stable_exit_codes(self) -> None:
        cases = [("stale_element", cli.EXIT_ELEMENT), ("captcha_attempts_exhausted", cli.EXIT_CAPTCHA),
                 ("browser_session_too_large", cli.EXIT_SESSION), ("navigation_timeout", cli.EXIT_PAGE),
                 ("browser_start_failed", cli.EXIT_UNAVAILABLE), ("something_new", 1)]
        for code, expected in cases:
            self.host.answers.append({"ok": False, "error": {"code": code, "message": "What to do next."}})
            result = self.run_cli("click", "1")
            self.assertEqual(result[0], expected, code)
            self.assertEqual(result[2], f"error[{code}]: What to do next.\n")

    def test_commands_map_to_requests(self) -> None:
        cases = [
            (["open", "saucedemo.com"], "open", {"url": "saucedemo.com"}),
            (["info", "--all"], "info", {"all": True}),
            (["scroll"], "scroll", {"direction": "down"}),
            (["scroll", "12"], "scroll", {"n": 12}),
            (["wait", "--text", "Checkout", "--timeout", "30"], "wait", {"text": "Checkout", "timeout": 30}),
            (["text", "4", "--start", "100"], "text", {"n": 4, "start": 100, "max": 6000}),
            (["save-session"], "save_session", {}),
            (["save-session", "shop.example"], "save_session", {"name": "shop.example"}),
            (["close-tab", "2"], "close_tab", {"index": 2}),
            (["new-tab"], "new_tab", {}),
            (["status", "--markers"], "status", {"markers": True}),
            (["release"], "release", {}),
            (["select", "3", "Price (low to high)"], "select", {"n": 3, "option": "Price (low to high)"}),
            (["captcha"], "captcha", {"wait": 20}),
            (["captcha", "--wait", "40"], "captcha", {"wait": 40}),
            (["click-at", "512", "300"], "click_at", {"x": 512, "y": 300}),
            (["click-at", "512", "300", "--hold", "1.5"], "click_at", {"x": 512, "y": 300, "hold_ms": 1500}),
            (["drag", "100", "400", "380", "402"], "drag", {"x1": 100, "y1": 400, "x2": 380, "y2": 402}),
            (["js", "document.title"], "js", {"expression": "document.title"}),
        ]
        for argv, op, args in cases:
            self.assertEqual(self.run_cli(*argv)[0], 0, argv)
            self.assertEqual(self.host.requests[-1], {"v": 1, "op": op, "args": args, "agent": {"id": "main"}}, argv)
        self.assertEqual(self.run_cli("click")[0], cli.EXIT_USAGE)
        self.assertEqual(self.run_cli("fly")[0], cli.EXIT_USAGE)
        self.assertEqual(self.run_cli("click-at", "1", "2", "--hold", "30")[0], cli.EXIT_USAGE)

    def test_chained_commands_run_in_order_and_print_the_page_once(self) -> None:
        steps = [{"n": n, "action": action, "target": target, "url": "https://shop.example/login"}
                 for n, action, target in ((1, "type", 'textbox "User" (5 characters)'), (2, "type", 'textbox "Password" (6 characters)'),
                                           (3, "click", 'button "Sign in"'))]
        self.host.answers.extend([{"ok": True, "result": {"step": steps[0], "text": ""}},
                                  {"ok": True, "result": {"step": steps[1], "text": "A alert dialog was accepted: \"Hi\"."}},
                                  {"ok": True, "result": {"step": steps[2], "text": "URL: https://shop.example/account"}}])
        with mock.patch.dict(os.environ, {"SHOP_PASSWORD": "s3cret"}):
            code, out, err = self.run_cli("type", "1", "alice", cli.THEN, "type", "2", "--env", "SHOP_PASSWORD", cli.THEN, "click", "3")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, '[browser #1] type: textbox "User" (5 characters) @ shop.example/login\n'
                              '[browser #2] type: textbox "Password" (6 characters) @ shop.example/login\n'
                              'A alert dialog was accepted: "Hi".\n'
                              '[browser #3] click: button "Sign in" @ shop.example/login\n'
                              "URL: https://shop.example/account\n")
        # Only the last command summarizes the page.
        self.assertEqual([request["args"].get("page") for request in self.host.requests[-3:]], [False, False, None])
        self.assertEqual([request["op"] for request in self.host.requests[-3:]], ["type", "type", "click"])
        self.assertTrue(self.host.requests[-2]["args"]["masked"])

    def test_the_first_failure_stops_a_chain_and_shows_the_page(self) -> None:
        step = {"n": 4, "action": "click", "target": 'button "Next"', "url": "https://shop.example/"}
        self.host.answers.extend([{"ok": True, "result": {"step": step, "text": ""}},
                                  {"ok": False, "error": {"code": "element_not_found", "message": "There is no element [9]."}},
                                  {"ok": True, "result": {"text": "URL: https://shop.example/2"}}])
        before = len(self.host.requests)
        code, out, err = self.run_cli("click", "4", cli.THEN, "click", "9", cli.THEN, "text")
        self.assertEqual(code, cli.EXIT_ELEMENT)
        self.assertEqual(out, '[browser #4] click: button "Next" @ shop.example/\nURL: https://shop.example/2\n')
        self.assertEqual(err, "error[element_not_found]: There is no element [9].\n"
                              "Stopped at command 2 of 3 (`click`); the commands after it did not run. The page now is below.\n")
        self.assertEqual([request["op"] for request in self.host.requests[before:]], ["click", "click", "info"])
        # A command that cannot be read stops the chain before anything runs.
        code, _, err = self.run_cli("click", "4", cli.THEN, "click", cli.THEN, "text")
        self.assertEqual(code, cli.EXIT_USAGE)
        self.assertIn("(command 2 of the chain; none of them ran)", err)
        for argv in (["click", "4", cli.THEN], [cli.THEN, "click", "4"], ["click", "4", cli.THEN, "proxies"]):
            self.assertEqual(self.run_cli(*argv)[0], cli.EXIT_USAGE, argv)
        self.assertEqual(len(self.host.requests), before + 3)

    def test_a_quiet_action_asks_for_no_page(self) -> None:
        self.host.answers.append({"ok": True, "result": {"step": {"n": 1, "action": "scroll", "target": "down", "url": None}, "text": ""}})
        self.assertEqual(self.run_cli("scroll", "--quiet"), (0, "[browser #1] scroll: down\n", ""))
        self.assertEqual(self.host.requests[-1]["args"], {"direction": "down", "page": False})

    def test_a_host_that_dies_mid_request_is_reported_as_a_crash(self) -> None:
        self.host.answers.append(None)
        with self.assertRaises(_client.BrowserError) as raised:
            _client.call("click", {"n": 1})
        self.assertEqual(raised.exception.code, "browser_crashed")

    def test_python_api_prints_steps_and_returns_a_page_with_items(self) -> None:
        from aiqsa import browser

        info = {"url": "https://x.test/", "title": "X", "items": [{"n": 1, "role": "button", "name": "Go"}]}
        self.host.answers.append({"ok": True, "result": {"step": {"n": 1, "action": "open", "url": "https://x.test/"},
                                                         "info": info, "text": "URL: https://x.test/"}})
        printed = io.StringIO()
        with mock.patch("sys.stdout", printed):
            page = browser.open("https://x.test/")
        self.assertEqual(printed.getvalue(), "[browser #1] open @ x.test/\n")
        self.assertEqual(str(page), "URL: https://x.test/")
        self.assertEqual((page.url, page.title, page.items[0]["name"]), ("https://x.test/", "X", "Go"))
        self.host.answers.append({"ok": False, "error": {"code": "element_not_found", "message": "No [9]."}})
        with self.assertRaises(browser.BrowserError) as raised:
            browser.click(9)
        self.assertEqual(raised.exception.code, "element_not_found")
        with mock.patch("sys.stdout", io.StringIO()):
            browser.click_at(5, 6, hold=1.25)
            self.assertEqual(self.host.requests[-1]["args"], {"x": 5, "y": 6, "hold_ms": 1250})
            browser.drag(1, 2, 3, 4)
            self.assertEqual(self.host.requests[-1]["args"], {"x1": 1, "y1": 2, "x2": 3, "y2": 4})
            browser.captcha()
            self.assertEqual(self.host.requests[-1], {"v": 1, "op": "captcha", "args": {"wait": 20}, "agent": {"id": "main"}})


class PathTests(unittest.TestCase):
    def test_paths_are_fixed_and_only_a_test_root_moves_them(self) -> None:
        with mock.patch.dict(os.environ, {"AIQSA_BROWSER_SESSIONS_DIR": "/workspace/project", "AIQSA_BROWSER_RUN_DIR": "/tmp/x"}):
            self.assertEqual(_paths.sessions_dir(), Path("/workspace/secrets/browser"))
            self.assertEqual(_paths.run_dir(), Path("/tmp/aiqsa-browser"))
            self.assertEqual(_paths.writable_roots(), (Path("/workspace/project"), Path("/workspace/output"), Path("/workspace/tmp")))
        _paths.use_test_root("/t")
        try:
            self.assertEqual(_paths.sessions_dir(), Path("/t/workspace/secrets/browser"))
        finally:
            _paths.use_test_root(None)
        self.assertEqual(_paths.sessions_dir(), Path("/workspace/secrets/browser"))


class HostStartTests(unittest.TestCase):
    """The client starts a missing host once, waits for it, and reports a host that cannot start."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.fake = self.root / "fake-python"
        _paths.use_test_root(self.root, python=str(self.fake))
        self.run_dir = _paths.run_dir()

    def tearDown(self) -> None:
        _paths.use_test_root(None)
        self.directory.cleanup()

    def fake_python(self, body: str) -> None:
        self.fake.write_text("#!" + sys.executable + "\n" + body, encoding="utf-8")
        self.fake.chmod(0o700)

    def test_a_missing_host_is_started_detached_and_then_served(self) -> None:
        self.fake_python(
            "import json, os, socket, sys\n"
            "assert sys.argv[1:4] == ['-m', 'aiqsa.browser._host', '--test-root'], sys.argv\n"
            "run = os.path.join(sys.argv[4], 'tmp', 'aiqsa-browser')\n"
            "assert all(name not in os.environ for name in ('AIQSA_RUN_TOKEN', 'AIQSA_INVOCATION_ID', 'AIQSA_AGENT_ID', 'AIQSA_AGENT_NAME'))\n"
            "assert os.getsid(0) == os.getpid()\n"
            "server = socket.socket(socket.AF_UNIX); server.bind(os.path.join(run, 'control.sock')); server.listen(4)\n"
            "server.settimeout(20)\n"
            "for _ in range(2):\n"
            "    connection, _ = server.accept()\n"
            "    data = b''\n"
            "    while not data.endswith(b'\\n'):\n"
            "        chunk = connection.recv(4096)\n"
            "        if not chunk: break\n"
            "        data += chunk\n"
            "    if data:\n"
            "        request = json.loads(data)\n"
            "        assert request['agent'] == {'id': 'thread-7', 'name': 'shop-amazon', 'turn': %r}, request\n"
            "        assert 'x' * 43 not in json.dumps(request)\n"
            "        connection.sendall(json.dumps({'ok': True, 'result': {'text': 'served ' + request['op']}}).encode() + b'\\n')\n"
            "    connection.close()\n" % _client.turn_of({"AIQSA_RUN_TOKEN": "x" * 43}))
        # Paths in the command environment move nothing: the client and host never read them.
        with mock.patch.dict(os.environ, {"AIQSA_BROWSER_RUN_DIR": str(self.root / "elsewhere"),
                                          "AIQSA_BROWSER_SESSIONS_DIR": "/workspace/project",
                                          "AIQSA_RUN_TOKEN": "x" * 43, "AIQSA_INVOCATION_ID": "a" * 32,
                                          "AIQSA_AGENT_ID": "thread-7", "AIQSA_AGENT_NAME": "shop-amazon"}):
            self.assertEqual(_client.call("info")["text"], "served info")
        self.assertFalse((self.root / "elsewhere").exists())
        self.assertEqual(stat.S_IMODE(self.run_dir.stat().st_mode), 0o700)
        self.assertEqual(_client._STARTED[-1].wait(timeout=20), 0)

    def test_a_host_that_cannot_start_reports_its_status(self) -> None:
        self.fake_python(
            "import json, os, sys\n"
            "run = os.path.join(sys.argv[4], 'tmp', 'aiqsa-browser')\n"
            "open(os.path.join(run, 'host.status'), 'w').write(json.dumps({'code': 'browser_start_failed', 'error': 'Error', 'detail': 'no chromium'}))\n"
            "raise SystemExit(1)\n")
        with self.assertRaises(_client.BrowserError) as raised:
            _client.call("info")
        self.assertEqual(raised.exception.code, "browser_start_failed")
        self.assertIn("no chromium", raised.exception.message)
        self.assertEqual(_client._STARTED[-1].wait(timeout=20), 1)


class LiveStartTests(unittest.TestCase):
    def test_streamer_process_starts_without_agent_environment(self) -> None:
        root = tempfile.TemporaryDirectory()
        package_root = str(Path(__file__).resolve().parents[1])
        environment = {**os.environ, "PYTHONPATH": os.pathsep.join([package_root, os.environ.get("PYTHONPATH", "")]),
                       "AIQSA_AGENT_ID": "thread-7", "AIQSA_AGENT_NAME": "shop-amazon"}
        process = subprocess.Popen([sys.executable, "-m", "aiqsa.browser.live", "--test-root", root.name],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
        try:
            process_environment = b""
            for _ in range(100):
                if process.poll() is not None:
                    break
                try:
                    process_environment = Path(f"/proc/{process.pid}/environ").read_bytes()
                except FileNotFoundError:
                    break
                if b"AIQSA_AGENT_ID=" not in process_environment and b"AIQSA_AGENT_NAME=" not in process_environment:
                    break
                time.sleep(0.01)
            self.assertIsNone(process.poll())
            self.assertNotIn(b"AIQSA_AGENT_ID=", process_environment)
            self.assertNotIn(b"AIQSA_AGENT_NAME=", process_environment)
        finally:
            process.stdin.close()
            process.wait(timeout=10)
            process.stdout.close()
            process.stderr.close()
            root.cleanup()


if __name__ == "__main__":
    unittest.main()
