import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildSync } from "esbuild";
import { expect, test, type Download, type Page } from "@playwright/test";
import type { ArtifactBundleFile } from "../../lib/server/artifacts/bundle";
import { productionViewerPolicies, renderArtifactPage, startRuntimeServer, type RuntimeServer } from "./harness";

// Firefox and WebKit refuse any download from the artifact frame under the viewer's
// frame-src 'none'. The bridge hands the frame's own bytes to the viewer instead, which
// saves them after the user's gesture in the frame (user activation reaches ancestor
// windows) and asks first otherwise. The host page runs the viewer's real module.

const PARENT_MODULE = buildSync({ entryPoints: [path.join(__dirname, "../../components/artifacts/artifactDownload.ts")], bundle: true,
  format: "iife", globalName: "artifactDownloads", platform: "browser", target: "es2022", write: false }).outputFiles[0]!.text;

/** The decisions of ArtifactFrameV2: save at once, or keep the request for the host's Save button. */
const VIEWER = `${PARENT_MODULE}
window.__downloads = [];
let pending = null;
addEventListener("message", event => {
  const frame = document.getElementById("artifact");
  if (event.origin !== "null" || !frame || event.source !== frame.contentWindow) return;
  const request = artifactDownloads.parseArtifactDownloadMessage(event.data);
  if (!request) return;
  const decision = artifactDownloads.artifactDownloadDecision(request, performance.now(), document.activeElement === frame);
  window.__downloads.push({ name: request.name, decision, size: request.blob.size });
  if (decision === "save") artifactDownloads.saveArtifactDownload(request);
  else if (decision === "ask") pending = request;
});
addEventListener("DOMContentLoaded", () => {
  const button = document.createElement("button");
  button.id = "save-download"; button.textContent = "Save file";
  button.addEventListener("click", () => { if (pending) artifactDownloads.saveArtifactDownload(pending); pending = null; });
  document.body.prepend(button);
});`;

const DOWNLOADS = `<!doctype html><html><head><title>Downloads</title></head><body>
<a id="file" href="files/report.csv">Report</a>
<a id="named" href="files/report.csv" download="Quarterly report.csv">Named report</a>
<a id="blob" download="table.csv">Table</a>
<a id="data" download="note.txt">Note</a>
<button id="saver" type="button">Save like FileSaver</button>
<script>
// Authored markup cannot hold data: links; scripts set blob: and data: download addresses.
document.getElementById("blob").href = URL.createObjectURL(new Blob(["x,y\\n1,2\\n"], { type: "text/csv" }));
document.getElementById("data").href = "data:text/plain;charset=utf-8,note%20text";
document.getElementById("saver").addEventListener("click", () => {
  const anchor = document.createElement("a");
  anchor.download = "saver.json";
  anchor.href = URL.createObjectURL(new Blob(['{"saved":true}'], { type: "application/json" }));
  setTimeout(() => anchor.dispatchEvent(new MouseEvent("click")), 0);
});
</script></body></html>`;

const UNPROMPTED = `<!doctype html><html><head><title>Unprompted</title></head><body><p>Loading</p><script>
addEventListener("load", () => {
  const anchor = document.createElement("a");
  anchor.download = "unprompted.txt";
  anchor.href = URL.createObjectURL(new Blob(["no gesture"], { type: "text/plain" }));
  anchor.click();
});
</script></body></html>`;

const files = (page: string): ArtifactBundleFile[] => [
  { path: "index.html", mimeType: "text/html", text: page },
  { path: "files/report.csv", mimeType: "text/csv", text: "a,b\n1,2\n" }
];

let host: RuntimeServer;
test.beforeAll(async () => { host = await startRuntimeServer(); });
test.afterAll(async () => { await host?.close(); });
test.beforeEach(() => { host.hits.length = 0; });

const modes = [
  { name: "A: parent without CSP", policies: () => [] },
  { name: "B: parent with the production viewer CSP", policies: productionViewerPolicies }
];

async function open(page: Page, document: string, policies: readonly string[]): Promise<Download[]> {
  const downloads: Download[] = [];
  page.on("download", download => { downloads.push(download); });
  await page.goto(host.hostPage(renderArtifactPage(files(document)), policies, [], VIEWER));
  return downloads;
}
const decisions = (page: Page) => page.evaluate(() => (window as unknown as { __downloads: unknown[] }).__downloads);

for (const mode of modes) {
  for (const [id, name, content] of [
    ["file", "report.csv", "a,b\n1,2\n"],
    ["named", "Quarterly report.csv", "a,b\n1,2\n"],
    ["blob", "table.csv", "x,y\n1,2\n"],
    ["data", "note.txt", "note text"],
    ["saver", "saver.json", '{"saved":true}']
  ] as const) {
    test(`${mode.name}: a click on ${id} saves "${name}" once through the viewer`, async ({ page }) => {
      const downloads = await open(page, DOWNLOADS, mode.policies());
      const saved = page.waitForEvent("download");
      await page.frameLocator("#artifact").locator(`#${id}`).click();
      const file = await saved;
      expect(file.suggestedFilename()).toBe(name);
      expect(await readFile((await file.path())!, "utf8")).toBe(content);
      // The click activated the viewer too; no second, in-frame download followed.
      expect(await decisions(page)).toEqual([{ name, decision: "save", size: Buffer.byteLength(content) }]);
      await page.waitForTimeout(500);
      expect(downloads).toHaveLength(1);
      expect(host.hits).toEqual([]);
    });
  }

  test(`${mode.name}: a download without a user gesture waits for the viewer's Save button`, async ({ page }) => {
    const downloads = await open(page, UNPROMPTED, mode.policies());
    await expect.poll(() => decisions(page)).toEqual([{ name: "unprompted.txt", decision: "ask", size: 10 }]);
    await page.waitForTimeout(500);
    expect(downloads).toEqual([]);
    const saved = page.waitForEvent("download");
    await page.locator("#save-download").click();
    const file = await saved;
    expect(file.suggestedFilename()).toBe("unprompted.txt");
    expect(await readFile((await file.path())!, "utf8")).toBe("no gesture");
    expect(host.hits).toEqual([]);
  });
}
