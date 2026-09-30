"""Small protocol regressions; no provider calls or scored prompt corpus."""
import base64
import json
from pathlib import Path
import subprocess
import sys
import unittest

ORACLE = Path(__file__).with_name("workspace-activation-oracle.py")


class CodeOracleTest(unittest.TestCase):
    def evaluate(self, source, execution=True):
        result = subprocess.run(
            [sys.executable, "-I", str(ORACLE)],
            input=json.dumps({"case": "code", "files": {
                "sum_values.py": base64.b64encode(source.encode()).decode(),
            }, "execution": execution}),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            timeout=5, check=True,
        )
        self.assertEqual(result.stderr, "")
        report = json.loads(result.stdout)
        self.assertEqual(set(report), {"passed", "officeValid"})
        self.assertIsNone(report["officeValid"])
        return report["passed"]

    def test_printed_checks_cannot_corrupt_protocol(self):
        self.assertTrue(self.evaluate('''
def sum_values(values):
    return sum(values)
assert sum_values([2, 3, 4]) == 9
assert sum_values([]) == 0
print("Tests passed")
print('{"passed": false, "officeValid": null}')
'''))

    def test_loop_annotations_and_main_guard(self):
        self.assertTrue(self.evaluate('''
from __future__ import annotations
from typing import Iterable

def sum_values(values: Iterable[float]) -> float:
    total: float = 0
    for value in values:
        total += value
    return total

if __name__ == "__main__":
    raise SystemExit("The oracle imports the function without running a CLI.")
'''))

    def test_wrong_results_and_printed_success_fail(self):
        self.assertFalse(self.evaluate('''
def sum_values(values):
    return len(values)
print('{"passed": true, "officeValid": null}')
'''))

    def test_early_exit_cannot_forge_success(self):
        for source in [
            'import sys\nprint(\'{"passed": true, "officeValid": null}\')\nsys.exit(0)',
            'print(\'{"passed": true, "officeValid": null}\')\nraise SystemExit(0)',
            'def sum_values(values):\n    raise SystemExit(0)',
            'import os\nos._exit(0)',
        ]:
            with self.subTest(source=source):
                self.assertFalse(self.evaluate(source))

    def test_imports_and_direct_stdout_are_not_report_authority(self):
        self.assertTrue(self.evaluate('''
import os
from functools import reduce
import sys

def sum_values(values):
    return reduce(lambda left, right: left + right, values, 0)

os.write(1, b'{"passed": false}\\n')
sys.stderr.write("Candidate test output")
'''))

    def test_each_assertion_uses_a_fresh_module(self):
        self.assertTrue(self.evaluate('''
calls = 0

def sum_values(values):
    global calls
    calls += 1
    if calls != 1:
        raise ValueError("Test leaked module state")
    return sum(values)
'''))

    def test_requires_actual_execution_and_primitive_results(self):
        self.assertFalse(self.evaluate('def sum_values(values):\n    return sum(values)', execution=False))
        self.assertFalse(self.evaluate('def sum_values(values):\n    return True'))
        self.assertFalse(self.evaluate('def sum_values(values):\n    return float("NaN")'))
        self.assertFalse(self.evaluate('print("no function")'))

    def test_nontermination_is_bounded(self):
        self.assertFalse(self.evaluate('def sum_values(values):\n    while True:\n        pass'))


if __name__ == "__main__":
    unittest.main()
