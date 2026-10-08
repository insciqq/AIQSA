// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import { buildArtifactBundle, hydrateArtifactBundleFile, type ArtifactBundle, type ArtifactBundleAsset } from "./bundle";
import { createArtifactResourceFetcher } from "./resourceFetch";
import { vendorArtifactResources } from "./vendoring";
import { artifactZip } from "./zip";
import { readZipArchive } from "./zipReader";

const cdn = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
// Synthetic stand-ins for the pinned UMD build: no network in tests.
const library = "globalThis.pdfjsLib = { GlobalWorkerOptions: {} };";
const worker = "self.onmessage = () => self.postMessage(\"</script>\");";
const sorter = "self.onmessage = event => self.postMessage(event.data.sort());";
const hydrate = (bundle: ArtifactBundle, assets: readonly ArtifactBundleAsset[]) => ({ ...bundle,
  files: bundle.files.map(file => file.blob ? hydrateArtifactBundleFile(file, assets.find(asset => asset.path === file.path)!.bytes) : file) });
async function exported(bundle: ArtifactBundle) {
  return new Map((await readZipArchive(artifactZip(bundle))).entries.map(entry => [entry.path, entry.bytes]));
}

describe("artifact ZIP export", () => {
  it("carries scripts a browser never loads by src inline, so the exported site works offline, and changes nothing else", async () => {
    const fixtures: Record<string, string> = { [`${cdn}pdf.min.js`]: library, [`${cdn}pdf.worker.min.js`]: worker };
    const fetchResource = createArtifactResourceFetcher({
      lookupHostname: async () => [{ address: "104.16.0.1", family: 4 }],
      dispatch: async request => fixtures[request.url.href] === undefined ? new Response(null, { status: 404 })
        : new Response(fixtures[request.url.href], { headers: { "content-type": "application/javascript" } })
    });
    const index = `<!doctype html><html><head><script src="${cdn}pdf.min.js" crossorigin="anonymous"></script>
      <script id="pdf-worker" type="text/js-worker" src="${cdn}pdf.worker.min.js"></script>
      <script id="classic" src="app.js"></script><script id="typed" type=" TEXT/JAVASCRIPT " src="app.js?v=2"></script>
      <script id="language" language="JavaScript" src="app.js"></script><script id="module" type="module" src="module.js"></script>
      </head><body><a href="docs/about.html">About</a></body></html>`;
    const about = '<!doctype html><html><head><script id="sorter" type=" Text/JS-Worker " src="../workers/sort.js?v=2#top"></script></head><body><a href="../index.html">Home</a></body></html>';
    const operation = normalizeArtifactOperation({ intent: "create", kind: "html", title: "PDF site", entrypoint: "index.html", files: [
      { path: "index.html", mimeType: "text/html", text: index }, { path: "docs/about.html", mimeType: "text/html", text: about },
      { path: "app.js", mimeType: "text/javascript", text: "window.app = 1;" }, { path: "module.js", mimeType: "text/javascript", text: "export const ready = true;" },
      { path: "workers/sort.js", mimeType: "text/javascript", text: sorter }
    ] });
    const vendored = await vendorArtifactResources(operation, { fetchResource, acceptedPolicy: { on: true, libraryHosts: ["cdnjs.cloudflare.com"], imageHosts: [] } });
    const built = buildArtifactBundle(operation, vendored.assets, vendored.files);
    const files = await exported(hydrate(built.bundle, vendored.assets));
    // The archive still holds every file of the version.
    expect([...files.keys()].sort()).toEqual(built.bundle.files.map(file => file.path).sort());
    const vendorWorker = vendored.files.find(file => file.path.endsWith("/pdf.worker.min.js"))!;
    const vendorLibrary = vendored.files.find(file => file.path.endsWith("/pdf.min.js"))!;
    expect(files.get(vendorWorker.path)!.toString()).toBe(worker);
    // Only the vendored address, the crossorigin attribute and the worker's src change.
    expect(files.get("index.html")!.toString()).toBe(index
      .replace(`src="${cdn}pdf.min.js" crossorigin="anonymous"`, `src="${vendorLibrary.path}" `)
      .replace(`src="${cdn}pdf.worker.min.js"></script>`, `>${worker.replace("</script", "<\\/script")}</script>`));
    const page = new DOMParser().parseFromString(files.get("index.html")!.toString(), "text/html");
    const block = page.getElementById("pdf-worker")!;
    expect(block.getAttribute("src")).toBeNull();
    expect(block.getAttribute("type")).toBe("text/js-worker");
    expect(block.textContent).toBe(worker.replace("</script", "<\\/script"));
    expect(JSON.parse('"<\\/script>"')).toBe("</script>");
    // Scripts that run keep loading their files.
    for (const [id, src] of [["classic", "app.js"], ["typed", "app.js?v=2"], ["language", "app.js"], ["module", "module.js"]]) {
      expect(page.getElementById(id)!.getAttribute("src")).toBe(src);
    }
    // A nested page resolves its own relative reference, ignoring the query and fragment.
    expect(files.get("docs/about.html")!.toString()).toBe(about.replace('src="../workers/sort.js?v=2#top"></script>', `>${sorter}</script>`));
    expect(files.get("workers/sort.js")!.toString()).toBe(sorter);
  });

  it("splices at the exact source offsets of a page with a byte order mark and CRLF line breaks", async () => {
    const worker = "self.onmessage = () => self.postMessage(1);";
    const page = `${String.fromCharCode(0xfeff)}<!doctype html>\r\n<html>\r\n<head>\r\n<script id="w" type="text/js-worker" src="w.js"></script>\r\n</head>\r\n` +
      '<body>\r\n<img alt="" crossorigin="anonymous" src="pixel.png">\r\n<p>End</p>\r\n</body>\r\n</html>\r\n';
    const assets = [{ path: "pixel.png", mimeType: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") }];
    const operation = normalizeArtifactOperation({ intent: "create", kind: "html", title: "CRLF", entrypoint: "index.html", files: [
      { path: "index.html", mimeType: "text/html", text: page }, { path: "w.js", mimeType: "text/javascript", text: worker },
      { path: "pixel.png", mimeType: "image/png", assetRef: "pixel" }] });
    const files = await exported(hydrate(buildArtifactBundle(operation, assets).bundle, assets));
    expect(files.get("index.html")!.toString("utf8")).toBe(page.replace('src="w.js"></script>', `>${worker}</script>`).replace('crossorigin="anonymous"', ""));
  });

  it("exports stored files byte for byte, editor SVG and unvendored addresses included", async () => {
    const drawing = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!-- Created with an editor -->\n<svg\n   xmlns="http://www.w3.org/2000/svg"\n' +
      '   xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" viewBox="0 0 10 10">\n' +
      '  <sodipodi:namedview id="base" />\n  <image xlink:href="https://cdn.example/texture.png" width="10" height="10" />\n  <circle cx="5" cy="5" r="4"/>\n</svg>\n';
    const page = `${String.fromCharCode(0xfeff)}<!DOCTYPE html>\n<HTML lang=en>\n<HEAD><Title>Stored</Title></HEAD>\n<body><img src='drawing.svg' alt="Drawing"><p>Unclosed paragraph\n</body>\n</HTML>\n`;
    const assets = [{ path: "index.html", mimeType: "text/html", bytes: Buffer.from(page) }, { path: "drawing.svg", mimeType: "image/svg+xml", bytes: Buffer.from(drawing) }];
    const operation = normalizeArtifactOperation({ intent: "create", kind: "html", title: "Stored", entrypoint: "index.html",
      files: assets.map(asset => ({ path: asset.path, mimeType: asset.mimeType, assetRef: asset.path })) });
    const files = await exported(hydrate(buildArtifactBundle(operation, assets).bundle, assets));
    for (const asset of assets) expect(files.get(asset.path)!.equals(asset.bytes), asset.path).toBe(true);
  });
});
