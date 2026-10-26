"""Where the browser host and its files live in the guest: fixed paths, never read from the environment.

Saved environment secrets and a command's own environment reach every guest command, so a path taken
from there could move saved sign-ins into exported folders or the control socket elsewhere (AIQSA also
refuses `AIQSA_BROWSER_*` names in both). Tests move every root under one directory with
`use_test_root`; the client hands that root to a host it starts as an argument, which the
`aiqsa-browser` command itself never takes.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Tuple, Union

GUEST_PYTHON = "/opt/aiqsa-python/bin/python3"
#: How the client tells a host it starts where the test root is.
TEST_ROOT_FLAG = "--test-root"

_test_root: Optional[Path] = None
_test_python: Optional[str] = None


def use_test_root(root: Union[str, Path, None], python: Optional[str] = None) -> None:
    """Tests only: every path below lives under `root`, and the client starts hosts with `python`."""
    global _test_root, _test_python
    _test_root = Path(root) if root is not None else None
    _test_python = python if root is not None else None


def current_test_root() -> Optional[Path]:
    return _test_root


def _at(path: str) -> Path:
    return _test_root / path.lstrip("/") if _test_root is not None else Path(path)


def run_dir() -> Path:
    """Control socket, start lock, host log and failure status of this boot's browser host."""
    return _at("/tmp/aiqsa-browser")


def shots_dir() -> Path:
    """Screenshots the agent looks at: a project path the image tools accept, outside the exported output."""
    return _at("/workspace/project/.browser")


def downloads_dir() -> Path:
    return _at("/workspace/project/downloads")


def sessions_dir() -> Path:
    """Saved sign-ins: the managed secrets directory AIQSA collects after a run, never exported."""
    return _at("/workspace/secrets/browser")


def workspace_dir() -> Path:
    """The Workspace a file to upload must come from."""
    return _at("/workspace")


def writable_roots() -> Tuple[Path, ...]:
    """Where the agent may save a screenshot it names: never inbox originals or managed secrets."""
    root = workspace_dir()
    return (root / "project", root / "output", root / "tmp")


def python() -> str:
    """The interpreter that has Playwright; any caller's Python may start the host."""
    if _test_python:
        return _test_python
    return GUEST_PYTHON if os.path.exists(GUEST_PYTHON) else ""
