import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_LIMITS, normalizeArtifactOperation } from "@/lib/contracts/artifacts";
import { ARTIFACT_BRIDGE_SCRIPT_OPEN } from "@/lib/contracts/artifactRuntime";
import { buildArtifactBundle, decodeArtifactBundle, hydrateArtifactBundleFile, renderArtifactBundle, type ArtifactBundle } from "./bundle";
import { artifactZip } from "./zip";
import { vendorArtifactResources } from "./vendoring";
import { createArtifactResourceFetcher, type ArtifactResourceFetcher } from "./resourceFetch";
import { ARTIFACT_RESOURCE_LIMITS } from "./resourcePolicy";

const library = "https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/";
const google = "https://fonts.googleapis.com/css2?family=Example&display=swap";
const font = "https://fonts.gstatic.com/s/example/v1/font.woff2";
const html = (text: string, extras: Array<{ path: string; mimeType: string; text: string }> = []) => normalizeArtifactOperation({
  intent: "create", title: "Static fixture", kind: "html", entrypoint: "pages/index.html", files: [{ path: "pages/index.html", mimeType: "text/html", text }, ...extras]
});
const fontBytes = Buffer.from("wOF2syntheticfontfixture");
const fixtures: Record<string, { bytes: Buffer; mimeType: string }> = {
  [`${library}chart.js`]: { bytes: Buffer.from("window.syntheticChart = () => 42;"), mimeType: "application/javascript" },
  [`${library}framework.css`]: { bytes: Buffer.from('@import "nested.css" screen; .md\\:grid{display:grid;background:url("data:image/svg+xml,%3csvg%20xmlns=\'http://www.w3.org/2000/svg\'%3e%3cpath%20d=\'M0%200\'/%3e%3c/svg%3e")}'), mimeType: "text/css" },
  [`${library}nested.css`]: { bytes: Buffer.from(".card:hover{color:red}"), mimeType: "text/css" },
  [google]: { bytes: Buffer.from(`@font-face{font-family:Example;src:url(${font}) format('woff2')}`), mimeType: "text/css" },
  [font]: { bytes: fontBytes, mimeType: "font/woff2" }
};
const fakeTransport = () => {
  const calls: string[] = [];
  const fetchResource = createArtifactResourceFetcher({
    lookupHostname: async () => [{ address: "93.184.216.34", family: 4 }],
    dispatch: async request => {
      calls.push(request.url.href);
      const fixture = fixtures[request.url.href];
      if (!fixture) return new Response(null, { status: 404 });
      return new Response(fixture.bytes, { headers: { "content-type": fixture.mimeType } });
    }
  });
  return { calls, fetchResource };
};
const hydrate = (bundle: ArtifactBundle, assets: { path: string; bytes: Buffer }[]) => ({ ...bundle,
  files: bundle.files.map(file => file.blob ? hydrateArtifactBundleFile(file, assets.find(asset => asset.path === file.path)!.bytes) : file) });
function unzip(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const compressed = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extra;
    files.set(bytes.subarray(offset + 30, offset + 30 + nameLength).toString(), inflateRawSync(bytes.subarray(start, start + compressed)));
    offset = start + compressed;
  }
  return files;
}
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("artifact immutable external resources", () => {
  it("vendors JS, a framework with escaped selectors/imports, and Google Fonts into offline render and ZIP", async () => {
    const harness = fakeTransport();
    const source = `<script src="${library}chart.js"></script><link rel="stylesheet" href="${library}framework.css"><link rel="stylesheet" href="${google.replaceAll("&", "&amp;")}"><form><input><button>Go</button></form><a target="_top" href="https://example.invalid/visit">Visit</a>`;
    const operation = html(source);
    const vendor = await vendorArtifactResources(operation, { fetchResource: harness.fetchResource });
    expect(harness.calls).toHaveLength(5);
    const built = buildArtifactBundle(operation, vendor.assets, vendor.files);
    expect(built.bundle.files[0]!.text).toBe(source);
    expect(built.bundle.files.filter(file => file.vendor).every(file => file.blob && file.text === undefined && file.base64 === undefined)).toBe(true);
    for (const file of vendor.files) {
      const asset = vendor.assets.find(asset => asset.path === file.path)!;
      expect(file.vendor).toMatchObject({ sha256: createHash("sha256").update(asset.bytes).digest("hex"), byteSize: asset.bytes.length });
      expect(file.path).toMatch(new RegExp(`^_vendor/${file.blob!.slice(0, 12)}/`));
    }
    expect(decodeArtifactBundle(built.bytes)).toEqual(built.bundle);
    const hydrated = hydrate(built.bundle, vendor.assets);
    const output = renderArtifactBundle(hydrated).body.toString();
    const document = new DOMParser().parseFromString(output, "text/html");
    expect(output).toContain(ARTIFACT_BRIDGE_SCRIPT_OPEN);
    expect(document.querySelectorAll('script[src],link[href],img[src^="http"]')).toHaveLength(0);
    expect(document.querySelector("style")!.textContent).toContain(".md\\:grid");
    expect(output).toContain("@media screen");
    expect(output).toContain("data:image/svg+xml;base64,");
    expect(output).toContain(`data:font/woff2;base64,${fontBytes.toString("base64")}`);
    expect(output).not.toContain("https://fonts.gstatic.com");
    expect(document.querySelector("a")?.getAttribute("target")).toBeNull();
    expect(document.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(document.querySelector("form")).not.toBeNull();
    const exported = unzip(artifactZip(hydrated));
    expect(exported.size).toBe(6);
    const exportedHtml = exported.get("pages/index.html")!.toString();
    expect(exportedHtml).toContain('src="../_vendor/');
    expect(exportedHtml).not.toContain(library);
    for (const [path, bytes] of exported) if (path.endsWith(".css") || path.endsWith("/css2")) {
      expect(bytes.toString()).not.toContain("https:");
    }
  });
  it("reuses frozen bytes while downloads and hosts are disabled and drops unused resources", async () => {
    const harness = fakeTransport();
    const operation = html(`<script src="${library}chart.js"></script><link rel="stylesheet" href="${library}framework.css">`);
    const first = await vendorArtifactResources(operation, { fetchResource: harness.fetchResource });
    const base = hydrate(buildArtifactBundle(operation, first.assets, first.files).bundle, first.assets);
    vi.stubEnv("AIQSA_ARTIFACT_EXTERNAL_RESOURCES", "off"); vi.stubEnv("AIQSA_ARTIFACT_LIBRARY_HOSTS", "");
    const noFetch = vi.fn<ArtifactResourceFetcher>();
    const copied = await vendorArtifactResources(operation, { base, fetchResource: noFetch });
    expect(copied).toEqual(first); expect(noFetch).not.toHaveBeenCalled();
    const smaller = await vendorArtifactResources(html(`<script src="${library}chart.js"></script>`), { base, fetchResource: noFetch });
    expect(smaller.files).toHaveLength(1);
    expect(noFetch).not.toHaveBeenCalled();
    const newUrl = html(`<script src="${library}new.js"></script>`);
    await expect(vendorArtifactResources(newUrl, { base })).rejects.toThrow("artifact_resource_host_not_allowed");
  });
  it("keeps authored limits and reserved paths separate from larger vendor text", async () => {
    const bytes = Buffer.from(`/*${"x".repeat(ARTIFACT_LIMITS.maxTextFileBytes)}*/`);
    const operation = html(`<script src="${library}large.js"></script>`);
    const vendor = await vendorArtifactResources(operation, { fetchResource: async input => ({ bytes, mimeType: "text/javascript", resolvedUrl: input.url }) });
    const built = buildArtifactBundle(operation, vendor.assets, vendor.files);
    expect(decodeArtifactBundle(built.bytes).files).toHaveLength(2);
    expect(hydrate(built.bundle, vendor.assets).files[1]!.text).toHaveLength(bytes.length);
    expect(() => buildArtifactBundle(operation, vendor.assets, [...vendor.files, ...vendor.files])).toThrow("artifact_path_duplicate");
    expect(() => buildArtifactBundle({ ...operation, files: [...operation.files,
      { path: vendor.files[0]!.path, mimeType: "text/javascript", byteSize: 9, text: "overwrite" }] }, vendor.assets, vendor.files)).toThrow("artifact_path_duplicate");
    expect(() => html("ok", [{ path: "large.js", mimeType: "text/javascript", text: bytes.toString() }])).toThrow("artifact_text_limit_exceeded");
    expect(() => html("ok", [{ path: vendor.files[0]!.path, mimeType: "text/javascript", text: "overwrite" }])).toThrow("artifact_path_invalid");
  });
  it("resolves SVG image hrefs through the same immutable raster resources", async () => {
    const url = "https://images.example/image.png";
    const bytes = Buffer.from([137, 80, 78, 71]);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${url}" width="1" height="1"/></svg>`;
    const operation = normalizeArtifactOperation({ intent: "create", kind: "svg", title: "Picture", entrypoint: "image.svg",
      files: [{ path: "image.svg", mimeType: "image/svg+xml", text: svg }] });
    const vendors = await vendorArtifactResources(operation, { fetchResource: async () => ({ bytes, mimeType: "image/png", resolvedUrl: url }) });
    const built = buildArtifactBundle(operation, vendors.assets, vendors.files);
    const hydrated = hydrate(built.bundle, vendors.assets);
    for (const main of [false, true]) {
      const rendered = renderArtifactBundle(hydrated, main).body.toString();
      expect(rendered).not.toContain(url); expect(rendered).toContain(`data:image/png;base64,${bytes.toString("base64")}`);
    }
    expect(unzip(artifactZip(hydrated)).get("image.svg")!.toString()).toContain('href="_vendor/');
    const embedded = html('<img src="../image.svg">', [{ path: "image.svg", mimeType: "image/svg+xml", text: svg }]);
    expect(renderArtifactBundle(hydrate(buildArtifactBundle(embedded, vendors.assets, vendors.files).bundle, vendors.assets)).body.toString()).toContain("data:image/svg+xml;base64,");
  });
  it("checks integrity again on reused bytes and accepts standalone modules without losing type", async () => {
    const harness = fakeTransport();
    const operation = html(`<script type="module" src="${library}chart.js"></script>`);
    const vendor = await vendorArtifactResources(operation, { fetchResource: harness.fetchResource });
    const base = hydrate(buildArtifactBundle(operation, vendor.assets, vendor.files).bundle, vendor.assets);
    expect(renderArtifactBundle(base).body.toString()).toContain('<script type="module">');
    await expect(vendorArtifactResources(html(`<script src="${library}chart.js" integrity="sha256-aW52ZW50ZWQ="></script>`), { base, fetchResource: harness.fetchResource })).rejects.toThrow("artifact_resource_integrity_mismatch");
    expect(harness.calls).toHaveLength(1);
    for (const source of ['import "https://example.invalid/module.js";', 'import { value } from "./module.js";', 'export * from "./module.js";', 'const value = import("./module.js");', 'const x=1; export { x }; import "./other.js";',
      'const text = `${await import("https://example.invalid/module.js")}`;', 'const text = `outer ${`inner ${import("./child.js")}`}`;', 'imp\\u006frt("./child.js");']) {
      await expect(vendorArtifactResources(html(`<script type="module">${source}</script>`), { fetchResource: harness.fetchResource })).rejects.toThrow("artifact_module_graph_unsupported");
      await expect(vendorArtifactResources(operation, { fetchResource: async input => ({ bytes: Buffer.from(source), mimeType: "text/javascript", resolvedUrl: input.url }) })).rejects.toThrow("artifact_module_graph_unsupported");
    }
    expect(() => buildArtifactBundle(html('<script type="module">const imported=1; const pattern=/import\\s*{}/g; export {imported}; console.log(import.meta.url);</script>'), [])).not.toThrow();
  });
  it("bounds nested CSS depth and cycles and keeps authored CSS external references denied", async () => {
    const fetchResource: ArtifactResourceFetcher = async input => ({ bytes: Buffer.from(`@import "${Number(new URL(input.url).pathname.split("/").at(-1)!.split(".")[0]) + 1}.css";`), mimeType: "text/css", resolvedUrl: input.url });
    await expect(vendorArtifactResources(html(`<link rel="stylesheet" href="${library}0.css">`), { fetchResource })).rejects.toThrow("artifact_resource_too_large");
    const cycle: ArtifactResourceFetcher = async input => ({ bytes: Buffer.from('@import "cycle.css";'), mimeType: "text/css", resolvedUrl: input.url });
    await expect(vendorArtifactResources(html(`<link rel="stylesheet" href="${library}cycle.css">`), { fetchResource: cycle })).rejects.toThrow("artifact_resource_too_large");
    const concurrentCycle: ArtifactResourceFetcher = async input => ({ bytes: Buffer.from(`@import "${input.url.endsWith("a.css") ? "b" : "a"}.css";`), mimeType: "text/css", resolvedUrl: input.url });
    await expect(vendorArtifactResources(html(`<link rel="stylesheet" href="${library}a.css"><link rel="stylesheet" href="${library}b.css">`), { fetchResource: concurrentCycle })).rejects.toThrow("artifact_resource_too_large");
    expect(() => buildArtifactBundle(html(`<style>.hover\\:block{background:u\\72l("${library}image.png")}</style>`), [])).toThrow("artifact_external_image_unsupported");
    expect(() => buildArtifactBundle(html(`<style>.a{background:image-set("https://images.example/a.png" 1x)}</style>`), [])).toThrow("artifact_external_image_unsupported");
  });
  it("limits distinct resources, bytes and download concurrency", async () => {
    const source = (count: number) => html(Array.from({ length: count }, (_, index) => `<script src="${library}${index}.js"></script>`).join(""));
    let active = 0, maximum = 0;
    const fetchResource: ArtifactResourceFetcher = async input => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return { bytes: Buffer.from(input.url), mimeType: "text/javascript", resolvedUrl: input.url };
    };
    expect((await vendorArtifactResources(source(16), { fetchResource })).files).toHaveLength(16);
    expect(maximum).toBe(4);
    await expect(vendorArtifactResources(source(17), { fetchResource })).rejects.toThrow("artifact_resource_too_large");
    await expect(vendorArtifactResources(source(6), { fetchResource: async input => ({ bytes: Buffer.alloc(3 * 1024 * 1024, new URL(input.url).pathname.at(-4)!), mimeType: "text/javascript", resolvedUrl: input.url }) })).rejects.toThrow("artifact_resource_too_large");
  });
  it("cancels all downloads at the tool deadline without starting queued I/O", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const operation = html(Array.from({ length: 8 }, (_, index) => `<script src="${library}${index}.js"></script>`).join(""));
    const result = vendorArtifactResources(operation, { fetchResource: async input => {
      calls++;
      await new Promise<void>((_resolve, reject) => input.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      throw new Error("unreachable");
    } });
    const assertion = expect(result).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(ARTIFACT_RESOURCE_LIMITS.operationTimeoutMs);
    await assertion; expect(calls).toBe(4);
  });
});
