"""Where the browser host and its files live in the guest. Tests point these elsewhere."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping

#: Control socket, start lock, host log and failure status of this boot's browser host.
RUN_DIR_ENV = "AIQSA_BROWSER_RUN_DIR"
#: Screenshots the agent looks at: a project path the image tools accept, outside the exported output.
SHOTS_DIR_ENV = "AIQSA_BROWSER_SHOTS_DIR"
#: The turn's step log and its small screenshots; outside every export, archive and share root.
STEPS_DIR_ENV = "AIQSA_BROWSER_STEPS_DIR"
DOWNLOADS_DIR_ENV = "AIQSA_BROWSER_DOWNLOADS_DIR"
SESSIONS_DIR_ENV = "AIQSA_BROWSER_SESSIONS_DIR"
#: The interpreter that has Playwright; any caller's Python may start the host.
PYTHON_ENV = "AIQSA_BROWSER_PYTHON"
GUEST_PYTHON = "/opt/aiqsa-python/bin/python3"


def _path(environ: Mapping[str, str], name: str, default: str) -> Path:
    value = environ.get(name)
    return Path(value) if value and os.path.isabs(value) else Path(default)


def run_dir(environ: Mapping[str, str] = os.environ) -> Path:
    return _path(environ, RUN_DIR_ENV, "/tmp/aiqsa-browser")


def shots_dir(environ: Mapping[str, str] = os.environ) -> Path:
    return _path(environ, SHOTS_DIR_ENV, "/workspace/project/.browser")


def steps_dir(environ: Mapping[str, str] = os.environ) -> Path:
    return _path(environ, STEPS_DIR_ENV, "/workspace/.cache/aiqsa-browser/steps")


def downloads_dir(environ: Mapping[str, str] = os.environ) -> Path:
    return _path(environ, DOWNLOADS_DIR_ENV, "/workspace/project/downloads")


def sessions_dir(environ: Mapping[str, str] = os.environ) -> Path:
    return _path(environ, SESSIONS_DIR_ENV, "/workspace/secrets/browser")


#: Roots the agent may name for a screenshot it saves (never inbox originals or managed secrets),
#: and the Workspace a file to upload must come from.
WORKSPACE_DIR_ENV = "AIQSA_BROWSER_WORKSPACE_DIR"


def workspace_dir(environ: Mapping[str, str] = os.environ) -> Path:
    return _path(environ, WORKSPACE_DIR_ENV, "/workspace")


def writable_roots(environ: Mapping[str, str] = os.environ) -> tuple:
    root = workspace_dir(environ)
    return (root / "project", root / "output", root / "tmp")


def python(environ: Mapping[str, str] = os.environ) -> str:
    value = environ.get(PYTHON_ENV)
    if value and os.path.isabs(value):
        return value
    return GUEST_PYTHON if os.path.exists(GUEST_PYTHON) else ""
