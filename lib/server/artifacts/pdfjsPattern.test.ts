// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import { ARTIFACT_PDFJS_BASE, describeArtifactTool } from "../tools/artifact";
import { buildArtifactBundle, hydrateArtifactBundleFile, renderArtifactBundle } from "./bundle";
import { createArtifactResourceFetcher } from "./resourceFetch";
import { vendorArtifactResources } from "./vendoring";

// Synthetic stand-ins for the pinned UMD build: no network in tests.
const library = Buffer.from("globalThis.pdfjsLib = { GlobalWorkerOptions: { workerPort: null } };");
const worker = Buffer.from("self.onmessage = (event) => { const tag = \"</script>\"; self.postMessage([event.data, tag.length]); };");

describe("pdf.js worker pattern from the artifact tool description", () => {
  it("vendors the worker into a non-executable block whose text starts a blob: worker offline", async () => {
    const description = describeArtifactTool({ on: true, libraryHosts: ["cdnjs.cloudflare.com"], imageHosts: [] });
    const markup = description.match(/PDF: (<script[^]*?<\/script><script[^]*?<\/script>)/u)![1]!;
    expect(markup).toContain(`${ARTIFACT_PDFJS_BASE}pdf.worker.min.js`);
    expect(description).toContain("workerPort = new Worker(URL.createObjectURL(new Blob([document.getElementById('pdf-worker').textContent])))");
    expect(describeArtifactTool({ on: true, libraryHosts: ["cdn.jsdelivr.net"], imageHosts: [] })).not.toContain("pdf-worker");
    expect(describeArtifactTool({ on: false, libraryHosts: ["cdnjs.cloudflare.com"], imageHosts: [] })).not.toContain("pdf-worker");

    const fixtures: Record<string, Buffer> = { [`${ARTIFACT_PDFJS_BASE}pdf.min.js`]: library, [`${ARTIFACT_PDFJS_BASE}pdf.worker.min.js`]: worker };
    const requested: string[] = [];
    const fetchResource = createArtifactResourceFetcher({
      lookupHostname: async () => [{ address: "104.16.0.1", family: 4 }],
      dispatch: async (request) => {
        requested.push(request.url.href);
        const bytes = fixtures[request.url.href];
        return bytes ? new Response(bytes, { headers: { "content-type": "application/javascript; charset=utf-8" } }) : new Response(null, { status: 404 });
      }
    });
    const page = `<!doctype html><html><head>${markup}</head><body><canvas id="page"></canvas><script>
      const port = new Worker(URL.createObjectURL(new Blob([document.getElementById('pdf-worker').textContent])));
      pdfjsLib.GlobalWorkerOptions.workerPort = port;
    </script></body></html>`;
    const operation = normalizeArtifactOperation({ intent: "create", kind: "html", title: "PDF viewer", entrypoint: "index.html",
      files: [{ path: "index.html", mimeType: "text/html", text: page }] });
    const vendored = await vendorArtifactResources(operation, { fetchResource,
      acceptedPolicy: { on: true, libraryHosts: ["cdnjs.cloudflare.com"], imageHosts: [] } });
    expect(requested.sort()).toEqual(Object.keys(fixtures).sort());
    const built = buildArtifactBundle(operation, vendored.assets, vendored.files);
    const hydrated = { ...built.bundle, files: built.bundle.files.map((file) => file.blob
      ? hydrateArtifactBundleFile(file, vendored.assets.find((asset) => asset.path === file.path)!.bytes) : file) };
    const rendered = renderArtifactBundle(hydrated).body.toString();
    const document = new DOMParser().parseFromString(rendered, "text/html");

    // Nothing is left to load at view time, and the worker block stays inert.
    expect(document.querySelectorAll("script[src]")).toHaveLength(0);
    const block = document.getElementById("pdf-worker")!;
    expect(block.getAttribute("type")).toBe("text/js-worker");
    expect(block.textContent).toBe(worker.toString().replace("</script", "<\\/script"));
    const scripts = [...document.querySelectorAll("script")];
    expect(scripts.some((script) => !script.hasAttribute("type") && script.textContent === library.toString())).toBe(true);
    // The escaped closing tag is the same JavaScript string value.
    expect(JSON.parse('"<\\/script>"')).toBe("</script>");
    const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
    expect(policy).toContain("worker-src blob:");
    expect(policy).toContain("connect-src 'none'");
  });
});
