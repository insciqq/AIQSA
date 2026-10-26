"""Browser helper tests that need no browser: identity, sessions, text, client and CLI (standard library only).

Run: python3 -m unittest discover -s ops/workspace-guest/python/tests -t ops/workspace-guest/python
The browser-backed tests live in test_browser_live.py.
"""

from __future__ import annotations

import io
import json
import os
import re
import socket
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa.browser import _client, _format, _identity, _paths, _sessions, cli  # noqa: E402

#: The parser of `features/run-lifecycle-v2/workspaceActivityPresentation.ts`, kept equal to it.
UI_STEP_LINE = re.compile(r"^\[browser #(\d{1,5})\] ([a-z_]{1,20})(?:: (.+?))?(?: @ (\S+))?$")


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
        self.assertEqual(args, ["--disable-blink-features=AutomationControlled", "--lang=es-ES", "--window-size=1440,900",
                                "--screen-info={1920x1080}", "--user-agent=UA"])
        self.assertNotIn("--user-agent", " ".join(_identity.launch_args("en-US")))
        self.assertEqual(_identity.IGNORED_DEFAULT_ARGS, ["--enable-automation"])

    def test_browser_environment_carries_the_user_zone_and_no_run_credentials(self) -> None:
        env = _identity.launch_env({"PATH": "/bin", "AIQSA_RUN_TOKEN": "t", "AIQSA_INVOCATION_ID": "i",
                                    "AIQSA_GATEWAY_URL": "g", "SHOP_LOGIN": "user"}, "pt-BR", "America/Sao_Paulo")
        self.assertEqual(env["TZ"], "America/Sao_Paulo")
        self.assertEqual(env["LANG"], "pt_BR.UTF-8")
        self.assertEqual(env["LANGUAGE"], "pt_BR")
        self.assertEqual(env["SHOP_LOGIN"], "user")
        for name in ("AIQSA_RUN_TOKEN", "AIQSA_INVOCATION_ID", "AIQSA_GATEWAY_URL"):
            self.assertNotIn(name, env)

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
        self.assertEqual(lines[3], "[browser #4] back")
        parsed = [UI_STEP_LINE.match(line) for line in lines]
        self.assertTrue(all(parsed))
        self.assertEqual(parsed[2].group(3), 'textbox "Email @ work" (13 characters)')
        self.assertEqual(parsed[2].group(4), "127.0.0.1:8080/a%20b")
        self.assertNotIn("secret", "".join(lines))
        self.assertNotIn("\n", _format.step_line({"n": 1, "action": "click", "target": "a\nb\u2028c", "url": None}))

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
        self.assertIn("Do not try to solve or get around it", text)
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
        self.assertEqual(self.host.requests[-1], {"v": 1, "op": "click", "args": {"n": 7}})
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

    def test_failures_print_a_code_and_map_to_stable_exit_codes(self) -> None:
        cases = [("stale_element", cli.EXIT_ELEMENT), ("captcha_requires_user", cli.EXIT_CAPTCHA),
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
            (["select", "3", "Price (low to high)"], "select", {"n": 3, "option": "Price (low to high)"}),
        ]
        for argv, op, args in cases:
            self.assertEqual(self.run_cli(*argv)[0], 0, argv)
            self.assertEqual(self.host.requests[-1], {"v": 1, "op": op, "args": args}, argv)
        self.assertEqual(self.run_cli("click")[0], cli.EXIT_USAGE)
        self.assertEqual(self.run_cli("fly")[0], cli.EXIT_USAGE)

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
            "assert 'AIQSA_RUN_TOKEN' not in os.environ and 'AIQSA_INVOCATION_ID' not in os.environ\n"
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
            "    if data: connection.sendall(json.dumps({'ok': True, 'result': {'text': 'served ' + json.loads(data)['op']}}).encode() + b'\\n')\n"
            "    connection.close()\n")
        # Paths in the command environment move nothing: the client and host never read them.
        with mock.patch.dict(os.environ, {"AIQSA_BROWSER_RUN_DIR": str(self.root / "elsewhere"),
                                          "AIQSA_BROWSER_SESSIONS_DIR": "/workspace/project",
                                          "AIQSA_RUN_TOKEN": "x" * 43, "AIQSA_INVOCATION_ID": "a" * 32}):
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


if __name__ == "__main__":
    unittest.main()
