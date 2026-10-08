import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { parseArtifactNavigateMessage, parseArtifactRuntimeError } from "../../lib/contracts/artifactRuntime";
import type { ArtifactBundleFile } from "../../lib/server/artifacts/bundle";
import {
  PROBE_OUTCOME_SOURCE,
  productionViewerPolicies,
  renderArtifactPage,
  startRuntimeServer,
  syntheticWav,
  waitForProbe,
  type RuntimeServer
} from "./harness";

// Files of the artifact reach its scripts only through the runtime bridge, from
// bytes embedded in the page: fetch, XHR, script-set src and static media all
// work offline, links navigate or download, and nothing reaches the network.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const WAV = syntheticWav();

const files = (probe: string): ArtifactBundleFile[] => [
  { path: "index.html", mimeType: "text/html", text: "<!doctype html><title>Home</title><p>Home</p>" },
  { path: "app/index.html", mimeType: "text/html", text: probe },
  { path: "app/data.json", mimeType: "application/json", text: '{"answer":1}' },
  { path: "app/notes.txt", mimeType: "text/plain", text: "hello notes" },
  { path: "data.json", mimeType: "application/json", text: '{"answer":42}' },
  { path: "img/a.png", mimeType: "image/png", base64: PNG },
  { path: "media/clip.wav", mimeType: "audio/wav", base64: WAV.toString("base64") },
  { path: "docs/b.html", mimeType: "text/html", text: "<!doctype html><title>B</title><h1 id=\"part\">B</h1>" },
  { path: "files/report.csv", mimeType: "text/csv", text: "a,b\n1,2\n" }
];

// Paths are built at runtime where a literal would be inlined by the renderer,
// so the bridge (not the static image rewrite) has to answer them.
const READS = `<!doctype html><html><head><title>Local files</title></head><body>
<audio id="static" src="../media/clip.wav" preload="auto" muted></audio>
<script>
${PROBE_OUTCOME_SOURCE}
const json = response => response.json().then(value => String(value.answer));
const xhr = (name, path, setup, read, async = true) => outcome(name, done => {
  const request = new XMLHttpRequest();
  request.open("GET", path, async);
  setup(request);
  request.onload = () => done(request.status + ":" + read(request));
  request.onerror = () => done("error");
  request.send();
  if (!async) done(request.status + ":" + read(request));
});
const media = (name, element, start) => outcome(name, done => {
  const ready = () => done("loadedmetadata:" + element.currentSrc.slice(0, 5));
  if (element.readyState >= 1) return ready();
  element.onloadedmetadata = ready;
  element.onerror = () => done("error:" + (element.error && element.error.code));
  start();
}, 8000);
const script = document.createElement("audio");
script.muted = true; script.preload = "auto";
const withSource = document.createElement("audio");
withSource.muted = true; withSource.preload = "auto";
const source = document.createElement("source");
Promise.all([
  outcome("fetchRelative", done => fetch("data.json").then(response => json(response).then(value => done(response.status + ":" + response.headers.get("content-type") + ":" + value)), error => done("rejected:" + error.name))),
  outcome("fetchRoot", done => fetch("/data.json").then(json).then(done, error => done("rejected:" + error.name))),
  outcome("fetchParent", done => fetch("../data.json").then(json).then(done, error => done("rejected:" + error.name))),
  outcome("fetchBase", done => fetch(new URL("data.json", document.baseURI)).then(json).then(done, error => done("rejected:" + error.name))),
  outcome("fetchMissing", done => fetch("missing.json").then(response => done(String(response.status)), error => done("rejected:" + error.name))),
  xhr("xhrText", "notes.txt", () => {}, request => request.responseText),
  xhr("xhrJson", "data.json", request => { request.responseType = "json"; }, request => request.response && request.response.answer),
  xhr("xhrArrayBuffer", "../media/" + "clip.wav", request => { request.responseType = "arraybuffer"; }, request => request.response.byteLength),
  xhr("xhrSync", "notes.txt", () => {}, request => request.responseText + ":" + request.getResponseHeader("content-type"), false),
  outcome("image", done => {
    const image = new Image();
    image.onload = () => done(image.naturalWidth + ":" + image.src.slice(0, 5));
    image.onerror = () => done("error");
    image.src = "../img/" + "a.png";
  }, 8000),
  media("audioScript", script, () => { document.body.append(script); script.src = "/media/" + "clip.wav"; }),
  media("audioSource", withSource, () => { source.setAttribute("src", "../media/" + "clip.wav"); withSource.append(source); document.body.append(withSource); withSource.load(); }),
  media("audioStatic", document.getElementById("static"), () => {})
]).then(results => parent.postMessage({ type: "aiqsa_probe", name: "local-files", ...Object.fromEntries(results) }, "*"));
</script></body></html>`;

function trapProbe(trap: string): string {
  return `<!doctype html><html><head><title>Network stays closed</title></head><body><script>
${PROBE_OUTCOME_SOURCE}
const trap = ${JSON.stringify(trap)};
Promise.all([
  outcome("fetch", done => fetch(trap + "/trap/local-fetch").then(() => done("ok"), error => done("rejected:" + error.name))),
  outcome("xhr", done => { const request = new XMLHttpRequest(); request.onload = () => done("ok"); request.onerror = () => done("error"); request.open("GET", trap + "/trap/local-xhr"); request.send(); }),
  outcome("image", done => { const image = new Image(); image.onload = () => done("ok"); image.onerror = () => done("error"); image.src = trap + "/trap/local-image.png"; }),
  outcome("audio", done => { const audio = new Audio(); audio.onloadedmetadata = () => done("ok"); audio.onerror = () => done("error"); audio.src = trap + "/trap/local-audio.wav"; }),
  outcome("belowBase", done => fetch(new URL("not-in-bundle.json", document.baseURI)).then(response => done(String(response.status)), error => done("rejected:" + error.name)))
]).then(results => parent.postMessage({ type: "aiqsa_probe", name: "trap", ...Object.fromEntries(results) }, "*"));
</script></body></html>`;
}

const LINKS = `<!doctype html><html><head><title>Links</title></head><body>
<a id="page" href="../docs/b.html#part">Page</a>
<a id="file" href="/files/report.csv">Report</a>
<a id="missing" href="nowhere.html">Missing</a>
</body></html>`;

// Real-site patterns: a cache-busted script, an image path literal that the renderer
// turns into a data: URL before fetch reads it, and a worker script from the bundle
// whose own network attempts stay blocked.
function realSiteFiles(trap: RuntimeServer): ArtifactBundleFile[] {
  const worker = `${PROBE_OUTCOME_SOURCE}
const trap = ${JSON.stringify(trap.origin)};
onmessage = event => Promise.all([
  outcome("fetch", done => fetch(trap + "/trap/local-worker-fetch").then(() => done("ok"), error => done("rejected:" + error.name))),
  outcome("relative", done => fetch("data.json").then(() => done("ok"), error => done("rejected:" + error.name))),
  outcome("xhr", done => { const request = new XMLHttpRequest(); request.onload = () => done("ok"); request.onerror = () => done("error"); request.open("GET", trap + "/trap/local-worker-xhr"); request.send(); }),
  outcome("importScripts", done => { importScripts(trap + "/trap/local-worker-import"); done("ok"); }),
  outcome("websocket", done => { const socket = new WebSocket(${JSON.stringify(trap.wsOrigin)} + "/trap/local-worker-ws"); socket.onopen = () => done("ok"); socket.onerror = () => done("error"); })
]).then(results => postMessage({ sum: event.data + 1, results: Object.fromEntries(results) }));`;
  const probe = `<!doctype html><html><head><title>Real site</title><script src="app.js?v=3"></script></head><body><script>
${PROBE_OUTCOME_SOURCE}
Promise.all([
  outcome("script", done => done(String(window.appVersion))),
  outcome("literalImage", done => fetch("../img/a.png").then(response => response.arrayBuffer()
    .then(bytes => done(response.status + ":" + response.headers.get("content-type") + ":" + bytes.byteLength)), error => done("rejected:" + error.name))),
  outcome("worker", done => {
    const worker = new Worker(new URL("worker.js", document.baseURI), { name: "local" });
    worker.onmessage = event => done(JSON.stringify(event.data));
    worker.onerror = event => { event.preventDefault(); done("error"); };
    worker.postMessage(41);
  }, 8000)
]).then(results => parent.postMessage({ type: "aiqsa_probe", name: "real-site", ...Object.fromEntries(results) }, "*"));
</script></body></html>`;
  return [...files(probe), { path: "app/app.js", mimeType: "text/javascript", text: "window.appVersion = 3;" },
    { path: "app/worker.js", mimeType: "text/javascript", text: worker }];
}

type Message = { type?: string } & Record<string, unknown>;
const messages = (page: Page) => page.evaluate(() => (window as unknown as { __artifactMessages: Message[] }).__artifactMessages);
async function waitForMessage(page: Page, type: string): Promise<Message> {
  await page.waitForFunction(kind => (window as unknown as { __artifactMessages: Message[] }).__artifactMessages.some(message => message?.type === kind), type);
  return (await messages(page)).find(message => message?.type === type)!;
}

let host: RuntimeServer;
let foreignTrap: RuntimeServer;
test.beforeAll(async () => { host = await startRuntimeServer(); foreignTrap = await startRuntimeServer(); });
test.afterAll(async () => { await host?.close(); await foreignTrap?.close(); });
test.beforeEach(() => { host.hits.length = 0; foreignTrap.hits.length = 0; });

const modes = [
  { name: "A: parent without CSP", trap: () => foreignTrap, policies: () => [] },
  { name: "B: parent with the production viewer CSP", trap: () => host, policies: productionViewerPolicies }
];

for (const mode of modes) {
  test(`${mode.name}: fetch, XHR, script-set and static sources read bundle files without the network`, async ({ page }) => {
    await page.goto(host.hostPage(renderArtifactPage(files(READS), "app/index.html"), mode.policies()));
    const { messages: seen, result } = await waitForProbe(page, "local-files");
    expect(result).toMatchObject({
      fetchRelative: "200:application/json:1",
      fetchRoot: "42",
      fetchParent: "42",
      fetchBase: "1",
      fetchMissing: "404",
      xhrText: "200:hello notes",
      xhrJson: "200:1",
      xhrArrayBuffer: `200:${WAV.length}`,
      xhrSync: "200:hello notes:text/plain",
      image: "1:blob:",
      audioScript: "loadedmetadata:blob:",
      audioSource: "loadedmetadata:blob:",
      audioStatic: "loadedmetadata:blob:"
    });
    expect(seen.filter(message => (message as Message)?.type === "aiqsa_artifact_runtime_error")).toEqual([]);
    expect(host.hits).toEqual([]);
  });

  test(`${mode.name}: requests outside the bundle still fail and never reach the trap`, async ({ page }) => {
    const trap = mode.trap();
    await page.goto(host.hostPage(renderArtifactPage(files(trapProbe(trap.origin)), "app/index.html"), mode.policies()));
    const { result } = await waitForProbe(page, "trap");
    for (const channel of ["fetch", "xhr", "image", "audio"]) expect(result[channel], channel).not.toBe("ok");
    expect(result.belowBase).toBe("404");
    await page.waitForTimeout(750);
    expect(trap.hits).toEqual([]);
    expect(host.hits).toEqual([]);
  });

  test(`${mode.name}: a cache-busted script, a fetched image literal and a bundle worker work while the worker's network stays closed`, async ({ page }) => {
    const trap = mode.trap();
    await page.goto(host.hostPage(renderArtifactPage(realSiteFiles(trap), "app/index.html"), mode.policies()));
    const { messages: seen, result } = await waitForProbe(page, "real-site");
    expect(result).toMatchObject({ script: "3", literalImage: `200:image/png:${Buffer.from(PNG, "base64").length}` });
    const worker = JSON.parse(String(result.worker)) as { sum: number; results: Record<string, string> };
    expect(worker.sum).toBe(42);
    expect(Object.keys(worker.results).sort()).toEqual(["fetch", "importScripts", "relative", "websocket", "xhr"]);
    for (const [channel, outcome] of Object.entries(worker.results)) expect(outcome, channel).not.toBe("ok");
    // Firefox reports the worker's blocked importScripts to the page; nothing else may fail.
    const errors = seen.filter(message => (message as Message)?.type === "aiqsa_artifact_runtime_error") as Message[];
    expect(errors.filter(error => error.kind !== "csp" || error.blocked !== trap.origin)).toEqual([]);
    await page.waitForTimeout(750);
    expect(trap.hits).toEqual([]);
    expect(host.hits).toEqual([]);
  });

  test(`${mode.name}: a local page link asks the viewer to navigate and a missing target is reported`, async ({ page }) => {
    await page.goto(host.hostPage(renderArtifactPage(files(LINKS), "app/index.html"), mode.policies()));
    const frame = page.frameLocator("#artifact");
    await frame.locator("#page").click();
    const navigate = await waitForMessage(page, "aiqsa_artifact_navigate");
    expect(navigate).toEqual({ type: "aiqsa_artifact_navigate", path: "docs/b.html", fragment: "part" });
    expect(parseArtifactNavigateMessage(navigate)).toEqual({ path: "docs/b.html", fragment: "part" });
    await frame.locator("#missing").click();
    const error = parseArtifactRuntimeError(await waitForMessage(page, "aiqsa_artifact_runtime_error"));
    expect(error).toEqual({ kind: "error", message: "Artifact link target not found: app/nowhere.html", line: 0, column: 0 });
    expect((await messages(page)).filter(message => message?.type === "aiqsa_artifact_open_link")).toEqual([]);
    // The frame itself never navigates; the viewer decides what to show.
    expect(page.frames().map(child => child.url())).toEqual([page.url(), "about:srcdoc"]);
    expect(host.hits).toEqual([]);
  });

  test(`${mode.name}: a local file link downloads the file from a blob: URL`, async ({ page, browserName }) => {
    // Firefox checks every download from the frame (blob: and data:, including the
    // authored blob downloads artifacts already use) against the viewer's frame-src.
    test.fixme(browserName === "firefox" && mode.name.startsWith("B"), "Firefox blocks frame downloads under the viewer's frame-src 'none'");
    await page.goto(host.hostPage(renderArtifactPage(files(LINKS), "app/index.html"), mode.policies()));
    const download = page.waitForEvent("download");
    await page.frameLocator("#artifact").locator("#file").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("report.csv");
    expect(await readFile((await file.path())!, "utf8")).toBe("a,b\n1,2\n");
    expect(await messages(page)).toEqual([]);
    expect(host.hits).toEqual([]);
  });
}
