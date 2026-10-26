"""Build step: Playwright's default headless launch runs the full Chromium (operator decision 2026-10-26).

The guest installs only the full build (`playwright install --no-shell chromium`), because sites block the
headless shell. Scripts that call `p.chromium.launch()` without a channel still look for the shell, so its
executable path becomes a link to the full binary, which runs headless with the same flags. Such raw launches
keep Playwright's own automation markers; the browser helper (`aiqsa-browser`) is the way to browse. The build
fails if the real shell is present or a default launch cannot load a page.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from playwright.sync_api import Error, sync_playwright

BODY = "<!doctype html><title>default launch</title><p>ok</p>"


def main() -> int:
    with sync_playwright() as playwright:
        full = Path(playwright.chromium.executable_path)
        if not full.is_file():
            print(f"full Chromium missing: {full}", file=sys.stderr)
            return 1
        try:
            playwright.chromium.launch().close()
            print("a default launch already works: the headless shell is installed", file=sys.stderr)
            return 1
        except Error as error:
            found = re.search(r"Executable doesn't exist at (\S+)", str(error))
        if not found:
            print("Playwright did not name the headless shell path", file=sys.stderr)
            return 1
        shim = Path(found.group(1))
        if shim.exists() or shim.is_symlink():
            print(f"unexpected file at {shim}", file=sys.stderr)
            return 1
        shim.parent.mkdir(parents=True, exist_ok=True)
        shim.symlink_to(full)
        browser = playwright.chromium.launch()
        try:
            page = browser.new_page()
            page.route("https://default-launch.invalid/**",
                       lambda route: route.fulfill(status=200, content_type="text/html", body=BODY))
            page.goto("https://default-launch.invalid/")
            title = page.title()
            version = browser.version
        finally:
            browser.close()
        if title != "default launch":
            print("the default launch did not load the page", file=sys.stderr)
            return 1
        print(f"default headless launch: {shim} -> {full} (Chromium {version})")
        return 0


if __name__ == "__main__":
    sys.exit(main())
