// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import { buildArtifactBundle, hydrateArtifactBundleFile } from "./bundle";
import { createArtifactResourceFetcher } from "./resourceFetch";
import { vendorArtifactResources } from "./vendoring";
import { artifactZip } from "./zip";
import { readZipArchive } from "./zipReader";

const cdn = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
// Synthetic stand-ins for the pinned UMD build: no network in tests.
const library = "globalThis.pdfjsLib = { GlobalWorkerOptions: {} };";
const worker = "self.onmessage = () => self.postMessage(\"</script>\");";
const sorter = "self.onmessage = event => self.postMessage(event.data.sort());";

describe("artifact ZIP export", () => {
  it("carries scripts a browser never loads by src inline, so the exported site works offline", async () => {
    const fixtures: Record<string, string> = { [`${cdn}pdf.min.js`]: library, [`${cdn}pdf.worker.min.js`]: worker };
    const fetchResource = createArtifactResourceFetcher({
      lookupHostname: async () => [{ address: "104.16.0.1", family: 4 }],
      dispatch: async request => fixtures[request.url.href] === undefined ? new Response(null, { status: 404 })
        : new Response(fixtures[request.url.href], { headers: { "content-type": "application/javascript" } })
    });
    const index = `<!doctype html><html><head><script src="${cdn}pdf.min.js"></script>
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
    const hydrated = { ...built.bundle, files: built.bundle.files.map(file => file.blob
      ? hydrateArtifactBundleFile(file, vendored.assets.find(asset => asset.path === file.path)!.bytes) : file) };
    const { entries } = await readZipArchive(artifactZip(hydrated));
    const exported = new Map(entries.map(entry => [entry.path, entry.bytes.toString("utf8")]));
    // The archive still holds every file of the version.
    expect([...exported.keys()].sort()).toEqual(built.bundle.files.map(file => file.path).sort());
    const page = new DOMParser().parseFromString(exported.get("index.html")!, "text/html");
    const block = page.getElementById("pdf-worker")!;
    expect(block.getAttribute("src")).toBeNull();
    expect(block.getAttribute("type")).toBe("text/js-worker");
    expect(block.textContent).toBe(worker.replace("</script", "<\\/script"));
    expect(JSON.parse('"<\\/script>"')).toBe("</script>");
    // Scripts that run keep loading their files: vendored copies by relative path, local ones unchanged.
    const vendorWorker = vendored.files.find(file => file.path.endsWith("/pdf.worker.min.js"))!;
    const vendorLibrary = vendored.files.find(file => file.path.endsWith("/pdf.min.js"))!;
    expect(exported.get(vendorWorker.path)).toBe(worker);
    expect(page.querySelector(`script[src="${vendorLibrary.path}"]`)).not.toBeNull();
    expect(page.getElementById("classic")!.getAttribute("src")).toBe("app.js");
    expect(page.getElementById("typed")!.getAttribute("src")).toBe("app.js?v=2");
    expect(page.getElementById("language")!.getAttribute("src")).toBe("app.js");
    expect(page.getElementById("module")!.getAttribute("src")).toBe("module.js");
    // A nested page resolves its own relative reference, ignoring the query and fragment.
    const nested = new DOMParser().parseFromString(exported.get("docs/about.html")!, "text/html").getElementById("sorter")!;
    expect(nested.getAttribute("src")).toBeNull();
    expect(nested.getAttribute("type")).toBe(" Text/JS-Worker ");
    expect(nested.textContent).toBe(sorter);
    expect(exported.get("workers/sort.js")).toBe(sorter);
  });
});
