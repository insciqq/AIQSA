"""Opening a page the agent built in the Workspace: which paths open, and what the loopback server gives a page.

No browser: requests go to the server directly with the host name Chromium would send.
Run: python3 -m unittest discover -s ops/workspace-guest/python/tests -p test_browser_files.py
"""

from __future__ import annotations

import base64
import http.client
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict, Tuple
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiqsa.browser import _files, _paths  # noqa: E402

try:  # The slim guest test image has no Playwright; the host's part runs where it is present.
    from aiqsa.browser import _host  # noqa: E402
except ModuleNotFoundError:  # pragma: no cover
    _host = None  # type: ignore[assignment]

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


class _Workspace(unittest.TestCase):
    """A Workspace with a built site, other folders, an inbox original and a saved sign-in."""

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        previous = _paths.current_test_root()
        _paths.use_test_root(directory.name)
        self.addCleanup(_paths.use_test_root, previous)
        self.workspace = Path(os.path.realpath(_paths.workspace_dir()))
        for part in ("project/site/css", "project/site/empty", "project/other", "output", "tmp", "inbox", "secrets/browser"):
            (self.workspace / part).mkdir(parents=True)
        self.site = self.workspace / "project" / "site"
        (self.site / "index.html").write_text("<!doctype html><title>Сайт</title><link rel=stylesheet href=css/site.css>"
                                              "<script src=app.js></script><img src=dot.png>", "utf-8")
        (self.site / "css" / "site.css").write_text("body { color: rgb(1, 2, 3); }", "utf-8")
        (self.site / "app.js").write_text("document.title = 'ran';", "utf-8")
        (self.site / "dot.png").write_bytes(PNG)
        (self.workspace / "project" / "other" / "private.txt").write_text("other folder", "utf-8")
        (self.workspace / "secrets" / "browser" / "shop.example.json").write_text("{}", "utf-8")
        (self.workspace / "inbox" / "upload.html").write_text("<p>original</p>", "utf-8")
        os.symlink(self.workspace / "secrets" / "browser" / "shop.example.json", self.site / "linked.json")
        self.server = _files.FileServer()
        self.addCleanup(self.server.close)

    def get(self, url: str, path: str = "", host: str = "") -> Tuple[int, Dict[str, str], bytes]:
        parts = urlsplit(url)
        connection = http.client.HTTPConnection("127.0.0.1", parts.port, timeout=5)
        try:
            connection.putrequest("GET", path or parts.path or "/", skip_host=True)
            connection.putheader("Host", host or parts.netloc)
            connection.endheaders()
            response = connection.getresponse()
            return response.status, {key.lower(): value for key, value in response.getheaders()}, response.read()
        finally:
            connection.close()


class WorkspaceFileTests(_Workspace):
    def test_paths_and_file_addresses_under_the_roots_open_with_their_page_part(self) -> None:
        index = self.site / "index.html"
        self.assertEqual(_files.workspace_target(str(index)), (index, ""))
        self.assertEqual(_files.workspace_target(f"file://{index}?tab=2#top"), (index, "?tab=2#top"))
        self.assertEqual(_files.workspace_target(f"{index}#top"), (index, "#top"))
        self.assertEqual(_files.workspace_target(str(self.site)), (self.site, ""))
        (self.workspace / "output" / "report.html").write_text("<p>report</p>", "utf-8")
        self.assertEqual(_files.workspace_target(f"  {self.workspace}/output/report.html "), (self.workspace / "output" / "report.html", ""))
        for web in ("https://example.com/", "example.com", "http://127.0.0.1:8000/", "about:blank"):
            self.assertIsNone(_files.workspace_target(web), web)

    def test_secrets_inbox_other_places_and_links_out_are_refused(self) -> None:
        refused = [
            str(self.workspace / "secrets" / "browser" / "shop.example.json"),
            str(self.workspace / "inbox" / "upload.html"),
            str(self.site / "linked.json"),
            f"{self.site}/../../secrets/browser/shop.example.json",
            "/etc/hostname",
            "file://other-host/workspace/project/site/index.html",
            str(self.site / "missing.html"),
            str(self.site / "empty"),
        ]
        for value in refused:
            with self.assertRaises(_files.FileRefused, msg=value):
                _files.workspace_target(value)
        with self.assertRaises(_files.FileRefused) as raised:
            _files.workspace_target(str(self.workspace / "secrets" / "browser" / "shop.example.json"))
        self.assertIn("/workspace/project, /workspace/output or /workspace/tmp", raised.exception.message)

    def test_a_page_loads_its_relative_files_with_their_types_and_nothing_cached(self) -> None:
        url = self.server.address(self.site / "index.html")
        parts = urlsplit(url)
        self.assertRegex(parts.netloc, r"^[0-9a-f]{16}\.localhost:\d+$")
        self.assertEqual(parts.path, "/index.html")
        status, headers, body = self.get(url)
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "text/html; charset=utf-8")
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertIn("Сайт", body.decode("utf-8"))
        for path, kind in (("/css/site.css", "text/css; charset=utf-8"), ("/app.js", "text/javascript; charset=utf-8"), ("/dot.png", "image/png")):
            status, headers, _ = self.get(url, path)
            self.assertEqual((status, headers["content-type"]), (200, kind), path)
        # The folder itself opens its index page, and the same folder keeps its address.
        self.assertEqual(self.get(url, "/")[0], 200)
        self.assertEqual(self.server.address(self.site), f"{parts.scheme}://{parts.netloc}/")

    def test_a_page_reads_nothing_outside_its_folder(self) -> None:
        url = self.server.address(self.site / "index.html")
        other = self.server.address(self.workspace / "project" / "other" / "private.txt")
        self.assertNotEqual(urlsplit(url).netloc, urlsplit(other).netloc)
        self.assertEqual(self.get(other)[0], 200)
        port = urlsplit(url).port
        for path in ("/../other/private.txt", "/%2e%2e/other/private.txt", "/linked.json", "/empty/", "/css/"):
            self.assertEqual(self.get(url, path)[0], 404, path)
        self.assertEqual(self.get(url, "/css")[0], 404)
        # A folder's index page that is a link out of the folder serves nothing, whatever it points to.
        secret = self.workspace / "secrets" / "browser" / "shop.example.json"
        secret.write_text("SYNTHETIC_SECRET", "utf-8")
        for index, points_to in (("index.html", secret), ("index.htm", secret), ("index.html", self.workspace / "project" / "other" / "private.txt"),
                                 ("index.htm", self.workspace / "project" / "other" / "private.txt")):
            leak = self.site / f"leak-{index}-{points_to.parent.name}"
            leak.mkdir()
            (leak / index).symlink_to(points_to)
            for path in (f"/{leak.name}/", f"/{leak.name}/{index}"):
                status, _, body = self.get(url, path)
                self.assertEqual(status, 404, path)
                self.assertNotIn(b"SYNTHETIC_SECRET", body)
                self.assertNotIn(b"other folder", body)
        # Another host name, an unknown token or the bare loopback address reach nothing.
        for host in (f"127.0.0.1:{port}", f"localhost:{port}", f"0123456789abcdef.localhost:{port}", urlsplit(url).hostname or ""):
            self.assertEqual(self.get(url, host=host)[0], 404, host)


    def test_a_folder_index_and_its_subfolders_serve_and_a_link_inside_the_folder_still_works(self) -> None:
        sub = self.site / "docs"
        sub.mkdir()
        (sub / "index.htm").write_text("<p>docs index</p>", "utf-8")
        (self.site / "alias.css").symlink_to(self.site / "css" / "site.css")
        url = self.server.address(self.site / "index.html")
        status, headers, body = self.get(url, "/docs/")
        self.assertEqual((status, body), (200, b"<p>docs index</p>"))
        self.assertEqual(self.get(url, "/docs")[0], 301)
        self.assertEqual(self.get(url, "/alias.css")[2], b"body { color: rgb(1, 2, 3); }")

    def test_the_file_is_opened_without_following_a_link_swapped_in_after_the_check(self) -> None:
        folder = self.site
        swapped = folder / "swapped.html"
        swapped.symlink_to(self.workspace / "secrets" / "browser" / "shop.example.json")
        # `_open` gets the path the check resolved; if a link replaced it since, nothing opens.
        self.assertIsNone(_files._Handler._open(_files._Handler, folder, swapped))  # type: ignore[arg-type]
        opened = _files._Handler._open(_files._Handler, folder, folder / "index.html")  # type: ignore[arg-type]
        self.assertIsNotNone(opened)
        os.close(opened[0])
        self.assertIsNone(_files._Handler._open(_files._Handler, folder / "css", folder / "index.html"))  # type: ignore[arg-type]


@unittest.skipUnless(_host is not None, "Playwright is not installed")
class OpenWorkspaceFileTests(_Workspace):
    """`open PATH` in the host: the address it navigates to and the path its step line names."""

    def test_open_turns_a_path_into_its_folder_address_and_refuses_a_proxy_or_secrets(self) -> None:
        host = _host.Host({})
        self.addCleanup(host.files.close)
        url, path = host._open_target(str(self.site / "index.html"), None)
        self.assertRegex(url, r"^http://[0-9a-f]{16}\.localhost:\d+/index\.html$")
        self.assertEqual(path, str(self.site / "index.html"))
        self.assertEqual(host._open_target("example.com", None), ("https://example.com", None))
        with self.assertRaises(_host.HostError) as raised:
            host._open_target(str(self.site / "index.html"), "direct")
        self.assertEqual(raised.exception.code, "invalid_arguments")
        with self.assertRaises(_host.HostError) as raised:
            host._open_target(str(self.workspace / "secrets" / "browser" / "shop.example.json"), None)
        self.assertEqual(raised.exception.code, "invalid_path")
        host._note_file(path, url)
        self.assertIn(f"Opened {self.site / 'index.html'} from the Workspace", host.notes[-1])
        self.assertIn(urlsplit(url).netloc, host.notes[-1])


if __name__ == "__main__":
    unittest.main()
