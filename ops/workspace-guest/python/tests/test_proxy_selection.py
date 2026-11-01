"""The forwarder's selection rules against the vectors the TypeScript rules pass (standard library only).

Run: python3 -m unittest discover -s ops/workspace-guest/python/tests -p 'test_proxy_*.py'

There is one vector file, `lib/domain/proxySelection.vectors.json`, and the guest image never holds it or
these tests, so no second copy can drift. Where the repository is absent, `AIQSA_PROXY_VECTORS` names the file;
a missing file fails here and never skips, so a run that could not read the rules cannot pass.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any, Dict
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa.proxy import selection  # noqa: E402


def vectors_path() -> Path:
    given = os.environ.get("AIQSA_PROXY_VECTORS")
    return Path(given) if given else Path(__file__).resolve().parents[4] / "lib" / "domain" / "proxySelection.vectors.json"


def load_vectors() -> Dict[str, Any]:
    return json.loads(vectors_path().read_text("utf-8"))


class VectorTests(unittest.TestCase):
    vectors: Dict[str, Any]

    @classmethod
    def setUpClass(cls) -> None:
        cls.vectors = load_vectors()

    def test_the_format_is_the_one_these_rules_implement(self) -> None:
        self.assertEqual(self.vectors["version"], 1)
        self.assertEqual(tuple(self.vectors["blockedHttpStatuses"]), selection.BLOCKED_HTTP_STATUSES)

    def test_hints(self) -> None:
        for vector in self.vectors["hints"]:
            with self.subTest(vector["name"]):
                self.assertEqual(selection.normalize_hint(vector["input"]), vector["output"])

    def test_hosts_and_site_keys(self) -> None:
        for vector in self.vectors["hosts"]:
            with self.subTest(vector["name"]):
                host = selection.normalize_site_host(vector["input"])
                self.assertEqual(host, vector["host"])
                if host is not None:
                    self.assertEqual(selection.site_key(host), vector["site"])

    def test_selection(self) -> None:
        for vector in self.vectors["selection"]:
            with self.subTest(vector["name"]):
                state = vector.get("state", selection.empty_state())
                for step in vector["steps"]:
                    before = json.dumps(state, sort_keys=True)
                    if step["op"] == "select":
                        decision, after = selection.select(vector["proxies"], step["host"], state, step.get("explicit"))
                        self.assertEqual(decision, step["expect"])
                    else:
                        after = selection.record_failure(step["host"], step["proxyId"], state)
                    self.assertEqual(json.dumps(state, sort_keys=True), before, "the input state stays as it was")
                    state = after
                    if "state" in step:
                        self.assertEqual(state, step["state"])

    def test_proxies_to_try(self) -> None:
        for vector in self.vectors["toTry"]:
            with self.subTest(vector["name"]):
                self.assertEqual(selection.proxies_to_try(vector["proxies"], vector["host"]), vector["output"])

    def test_every_vector_group_has_cases(self) -> None:
        # An emptied or renamed group must not pass by checking nothing.
        for name in ("hints", "hosts", "selection", "toTry"):
            self.assertGreater(len(self.vectors[name]), 3, name)


class VectorLocationTests(unittest.TestCase):
    def test_a_missing_file_fails_rather_than_skips(self) -> None:
        with mock.patch.dict(os.environ, {"AIQSA_PROXY_VECTORS": "/nonexistent/proxySelection.vectors.json"}):
            with self.assertRaises(OSError):
                load_vectors()


if __name__ == "__main__":
    unittest.main()
