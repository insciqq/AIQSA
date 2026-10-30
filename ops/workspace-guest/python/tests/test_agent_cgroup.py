"""The shared browser host leaves the starting agent's cgroup (standard library only).

Run: python3 -m unittest discover -s ops/workspace-guest/python/tests -t ops/workspace-guest/python
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa.browser import _client  # noqa: E402


class SharedHostGroupTest(unittest.TestCase):
    def test_host_moves_itself_into_the_shared_group(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            shared = os.path.join(root, "aiqsa-shared")
            with mock.patch.object(_client, "SHARED_CGROUP", shared):
                _client._leave_agent_group()
            self.assertEqual(Path(shared, "cgroup.procs").read_text(), str(os.getpid()))

    def test_a_guest_without_cgroups_still_starts_the_host(self) -> None:
        with mock.patch.object(_client, "SHARED_CGROUP", "/proc/aiqsa-no-such-cgroup"):
            _client._leave_agent_group()

    def test_the_host_is_started_through_the_group_move(self) -> None:
        captured = {}

        def popen(*_args, **kwargs):
            captured.update(kwargs)
            raise OSError(2, "stop here")

        with tempfile.TemporaryDirectory() as run_dir, mock.patch.object(_client.subprocess, "Popen", popen):
            with self.assertRaises(Exception):
                _client._start(Path(run_dir), Path(run_dir) / "host.sock")
        self.assertIs(captured.get("preexec_fn"), _client._leave_agent_group)
        self.assertTrue(captured.get("start_new_session"))


if __name__ == "__main__":
    unittest.main()
