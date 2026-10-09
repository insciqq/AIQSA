import { expect, test } from "@playwright/test";
import {
  ARTIFACT_META_POLICY,
  PROBE_OUTCOME_SOURCE,
  developmentReportOnlyPolicy,
  productionViewerPolicies,
  renderArtifactDocument,
  startRuntimeServer,
  waitForProbe,
  withArtifactPolicy,
  type RuntimeServer
} from "./harness";

// A blob: worker inherits the artifact frame's policy: it starts, yet every
// network channel from the worker and the document stays blocked.

const WORKER_CHANNELS = ["fetch", "xhr", "importScripts", "websocket"];
const DOCUMENT_CHANNELS = ["fetch", "xhr", "websocket", "eventsource"];

function workerSource(origin: string, wsOrigin: string): string {
  return `${PROBE_OUTCOME_SOURCE}
const trap = ${JSON.stringify(origin)};
postMessage({ started: true });
Promise.all([
  outcome("fetch", done => fetch(trap + "/trap/worker-fetch").then(() => done("ok"), error => done("rejected:" + error.name))),
  outcome("xhr", done => { const request = new XMLHttpRequest(); request.onload = () => done("ok"); request.onerror = () => done("error"); request.open("GET", trap + "/trap/worker-xhr"); request.send(); }),
  outcome("importScripts", done => { importScripts(trap + "/trap/worker-import"); done("ok"); }),
  outcome("websocket", done => { const socket = new WebSocket(${JSON.stringify(wsOrigin)} + "/trap/worker-ws"); socket.onopen = () => done("ok"); socket.onerror = () => done("error"); })
]).then(results => postMessage({ results: Object.fromEntries(results) }));`;
}

function probeDocument(trap: RuntimeServer): string {
  return `<!doctype html><html><head><title>Worker probe</title></head><body><script>
${PROBE_OUTCOME_SOURCE}
const trap = ${JSON.stringify(trap.origin)};
const report = value => parent.postMessage({ type: "aiqsa_probe", name: "network", ...value }, "*");
const worker = outcome("worker", done => {
  const instance = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSource(trap.origin, trap.wsOrigin))}], { type: "text/javascript" })));
  let started = false;
  instance.onmessage = event => {
    if (event.data.started) started = true;
    if (event.data.results) done(JSON.stringify({ started, results: event.data.results }));
  };
  instance.onerror = event => { event.preventDefault(); done(JSON.stringify({ started, error: "error" })); };
}, 8000);
const documentChannels = Promise.all([
  outcome("fetch", done => fetch(trap + "/trap/document-fetch").then(() => done("ok"), error => done("rejected:" + error.name))),
  outcome("xhr", done => { const request = new XMLHttpRequest(); request.onload = () => done("ok"); request.onerror = () => done("error"); request.open("GET", trap + "/trap/document-xhr"); request.send(); }),
  outcome("websocket", done => { const socket = new WebSocket(${JSON.stringify(trap.wsOrigin)} + "/trap/document-ws"); socket.onopen = () => done("ok"); socket.onerror = () => done("error"); }),
  outcome("eventsource", done => { const source = new EventSource(trap + "/trap/document-eventsource"); source.onopen = () => { source.close(); done("ok"); }; source.onerror = () => { source.close(); done("error"); }; }),
  outcome("beacon", done => done(typeof navigator.sendBeacon === "function" ? "returned:" + navigator.sendBeacon(trap + "/trap/document-beacon", "x") : "absent"))
]);
Promise.all([worker, documentChannels]).then(([[, workerResult], channels]) => {
  let parsed; try { parsed = JSON.parse(workerResult); } catch { parsed = { started: false, error: workerResult }; }
  report({ worker: parsed, document: Object.fromEntries(channels) });
});
</script></body></html>`;
}

type NetworkProbe = { worker: { started: boolean; error?: string; results?: Record<string, string> }; document: Record<string, string> };

let host: RuntimeServer;
let foreignTrap: RuntimeServer;
test.beforeAll(async () => { host = await startRuntimeServer(); foreignTrap = await startRuntimeServer(); });
test.afterAll(async () => { await host?.close(); await foreignTrap?.close(); });
test.beforeEach(() => { host.hits.length = 0; foreignTrap.hits.length = 0; });

const modes = [
  { name: "A: parent without CSP, trap on another origin", trap: () => foreignTrap, policies: () => [] },
  { name: "B: parent with the production viewer CSP, trap on the parent origin", trap: () => host, policies: productionViewerPolicies }
];

for (const mode of modes) {
  test(`${mode.name}: a blob: worker starts and every network channel is blocked`, async ({ page }) => {
    const trap = mode.trap();
    await page.goto(host.hostPage(renderArtifactDocument(probeDocument(trap)), mode.policies()));
    const { result } = await waitForProbe(page, "network");
    const probe = result as unknown as NetworkProbe;
    expect(probe.worker.started, JSON.stringify(probe.worker)).toBe(true);
    expect(Object.keys(probe.worker.results ?? {}).sort()).toEqual([...WORKER_CHANNELS].sort());
    for (const channel of WORKER_CHANNELS) expect(probe.worker.results?.[channel], `worker ${channel}`).not.toBe("ok");
    for (const channel of DOCUMENT_CHANNELS) expect(probe.document[channel], `document ${channel}`).not.toBe("ok");
    // A beacon is fire-and-forget: its return value proves nothing, the trap does.
    await page.waitForTimeout(750);
    expect(trap.hits).toEqual([]);
    expect(host.hits).toEqual([]);
  });
}

test("D (positive control): without the artifact policy the same probe reaches the trap", async ({ page }) => {
  await page.goto(host.hostPage(withArtifactPolicy(renderArtifactDocument(probeDocument(foreignTrap)), null)));
  const { result } = await waitForProbe(page, "network");
  expect((result as unknown as NetworkProbe).worker.started).toBe(true);
  const expected = ["worker-fetch", "worker-xhr", "worker-import", "worker-ws", "document-fetch", "document-xhr", "document-ws", "document-eventsource"];
  await expect.poll(() => expected.filter(tag => !foreignTrap.hits.some(hit => hit.path === `/trap/${tag}`))).toEqual([]);
  expect(foreignTrap.hits.filter(hit => hit.kind === "upgrade").map(hit => hit.path).sort()).toEqual(["/trap/document-ws", "/trap/worker-ws"]);
});

test("the previous worker-src 'none' policy keeps a blob: worker from starting", async ({ page }) => {
  const previous = ARTIFACT_META_POLICY.replace("worker-src blob:", "worker-src 'none'");
  expect(previous).not.toBe(ARTIFACT_META_POLICY);
  await page.goto(host.hostPage(withArtifactPolicy(renderArtifactDocument(probeDocument(foreignTrap)), previous)));
  const { result } = await waitForProbe(page, "network");
  expect((result as unknown as NetworkProbe).worker.started).toBe(false);
  await page.waitForTimeout(750);
  expect(foreignTrap.hits).toEqual([]);
});

// The development app sends its policy as report-only, and the srcdoc frame inherits it.
// A report-only violation never blocks anything, so the bridge must not report it as a
// runtime error; the current policy also allows blob: workers, so none is raised.
function reportOnlyWorkerDocument(): string {
  return `<!doctype html><html><head><title>Report-only worker</title></head><body><script>
const dispositions = [];
addEventListener("securitypolicyviolation", event => dispositions.push(event.effectiveDirective + ":" + event.disposition));
const instance = new Worker(URL.createObjectURL(new Blob(["postMessage('started')"], { type: "text/javascript" })));
instance.onmessage = () => setTimeout(() => parent.postMessage({ type: "aiqsa_probe", name: "report-only", started: true, dispositions }, "*"), 300);
instance.onerror = event => { event.preventDefault(); parent.postMessage({ type: "aiqsa_probe", name: "report-only", started: false, dispositions }, "*"); };
</script></body></html>`;
}

const reportOnlyModes = [
  { name: "the development report-only policy", policy: developmentReportOnlyPolicy, violation: false },
  { name: "a report-only policy without worker-src", policy: () => developmentReportOnlyPolicy().replace(/; worker-src [^;]*/u, ""), violation: true }
];

for (const mode of reportOnlyModes) {
  test(`a parent with ${mode.name} starts a blob: worker without a runtime error`, async ({ page }) => {
    const policy = mode.policy();
    expect(policy.includes("worker-src")).toBe(!mode.violation);
    await page.goto(host.hostPage(renderArtifactDocument(reportOnlyWorkerDocument()), [], [policy]));
    const { result, messages } = await waitForProbe(page, "report-only");
    expect(result.started).toBe(true);
    if (!mode.violation) expect(result.dispositions).toEqual([]);
    else expect(result.dispositions, "the control must raise a report-only violation").toContain("worker-src:report");
    expect(messages.filter(message => (message as { type?: string })?.type === "aiqsa_artifact_runtime_error")).toEqual([]);
  });
}
