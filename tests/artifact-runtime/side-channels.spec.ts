import { networkInterfaces } from "node:os";
import { expect, test, type Page } from "@playwright/test";
import {
  ARTIFACT_META_POLICY,
  isStunPacket,
  PROBE_OUTCOME_SOURCE,
  productionViewerPolicies,
  renderArtifactDocument,
  startRuntimeServer,
  startStunTrap,
  waitForProbe,
  type RuntimeServer,
  type StunTrap
} from "./harness";

// Channels that reach the network without being a CSP fetch, so
// connect-src 'none' / default-src 'none' do not govern them:
//   - WebRTC ICE: an RTCPeerConnection with a stun:/turn: server sends STUN
//     binding requests over UDP the moment a data channel's offer is applied.
//   - resource hints: WebKit opens a TCP connection for a <link rel=preconnect>
//     as soon as such a link is connected, or a connected one gains the relation,
//     synchronously and under any CSP.
//   - nested documents: a srcdoc (or javascript:) iframe is a fresh realm without
//     the bridge, whose own markup and scripts reach the same channels.
// The traps observe the real network: a UDP listener for STUN, one TCP listener
// per (insertion path, hint) that counts raw sockets (a preconnect sends no HTTP
// request), and an HTTP trap whose paths name the prefetch/preload that reached it.
// A and B render the probe through the real renderer, bridge included, and require
// silence; C keeps only the artifact CSP and D neither, to show per engine which of
// these channels CSP leaves open and that every trap an engine uses really fires.

/** Every script path that creates, changes or connects a link; each gets its own socket traps. */
const HINT_PATHS = ["documentWrite", "documentWriteSplit", "appendChild", "innerHTML", "insertAdjacentHTML", "outerHTML", "setAttribute",
  "relList", "relProperty", "attributeNode", "contextualFragment", "domParser", "execCommand", "shadowRoot", "srcdocFrame", "javascriptFrame"] as const;
const SOCKET_HINTS = ["preconnect", "dns-prefetch"] as const;

type ProbeConfig = Readonly<{ stun: number; fetch: string; sockets: Record<string, Record<string, string>> }>;
type Probe = Readonly<{ globals: string[]; results: Record<string, string>; nested: string[]; blockedLinks: string[]; errors: Record<string, string> }>;

type Traps = Readonly<{ stun: StunTrap; fetch: RuntimeServer; sockets: ReadonlyMap<string, RuntimeServer> }>;

async function startTraps(): Promise<Traps> {
  const sockets = new Map<string, RuntimeServer>();
  for (const path of HINT_PATHS) for (const hint of SOCKET_HINTS) sockets.set(`${path}/${hint}`, await startRuntimeServer());
  return { stun: await startStunTrap(), fetch: await startRuntimeServer(), sockets };
}

async function closeTraps(traps: Traps | undefined): Promise<void> {
  if (!traps) return;
  await Promise.all([traps.stun.close(), traps.fetch.close(), ...[...traps.sockets.values()].map(server => server.close())]);
}

function probeConfig(traps: Traps): ProbeConfig {
  const sockets: Record<string, Record<string, string>> = {};
  for (const path of HINT_PATHS) {
    sockets[path] = Object.fromEntries(SOCKET_HINTS.map(hint => [hint, `${traps.sockets.get(`${path}/${hint}`)!.origin}/`]));
  }
  return { stun: traps.stun.port, fetch: traps.fetch.origin, sockets };
}

type Observation = Readonly<{ sockets: string[]; fetchHits: string[]; fetchSockets: number; stun: number }>;

function observe(traps: Traps): Observation {
  return {
    sockets: [...traps.sockets].filter(([, server]) => server.connections.length > 0).map(([key]) => key).sort(),
    fetchHits: [...new Set(traps.fetch.hits.map(hit => hit.path))].sort(),
    fetchSockets: traps.fetch.connections.length,
    stun: traps.stun.packets.filter(isStunPacket).length
  };
}

/** The probe body, shared by the rendered pages and the unprotected controls. */
function probeBody(config: ProbeConfig): string {
  return `${PROBE_OUTCOME_SOURCE}
const config = ${JSON.stringify(config)};
const report = value => parent.postMessage({ type: "aiqsa_probe", name: "side-channels", ...value }, "*");
const hints = path => [
  { rel: "preconnect", href: config.sockets[path].preconnect },
  { rel: "dns-prefetch", href: config.sockets[path]["dns-prefetch"] },
  { rel: "prefetch", href: config.fetch + "/trap/prefetch-" + path },
  { rel: "preload", href: config.fetch + "/trap/preload-" + path, as: "fetch" }
];
const tag = hint => '<link rel="' + hint.rel + '" href="' + hint.href + '"' + (hint.as ? ' as="' + hint.as + '" crossorigin="anonymous"' : "") + ">";
const markup = path => hints(path).map(tag).join("");
const nestedScript = name => "<script>parent.postMessage({ nested: " + JSON.stringify(name) + " }, '*')<\\/script>";
// document.write feeds the parser only while this script runs, before load.
document.write(markup("documentWrite"));
// The same tags with each tag name split across two calls.
for (const piece of hints("documentWriteSplit").map(tag)) { document.write(piece.slice(0, 4)); document.write(piece.slice(4)); }
const connectedLink = hint => {
  const link = document.createElement("link");
  if (hint.as) { link.setAttribute("as", hint.as); link.setAttribute("crossorigin", "anonymous"); }
  link.href = hint.href;
  document.head.appendChild(link);
  return link;
};
const paths = {
  appendChild: path => { for (const hint of hints(path)) { const link = document.createElement("link"); link.rel = hint.rel; if (hint.as) { link.as = hint.as; link.crossOrigin = "anonymous"; } link.href = hint.href; document.head.appendChild(link); } },
  innerHTML: path => { const holder = document.createElement("div"); document.body.appendChild(holder); holder.innerHTML = markup(path); },
  insertAdjacentHTML: path => document.head.insertAdjacentHTML("beforeend", markup(path)),
  outerHTML: path => { const holder = document.createElement("span"); document.body.appendChild(holder); holder.outerHTML = markup(path); },
  setAttribute: path => { for (const hint of hints(path)) connectedLink(hint).setAttribute("rel", hint.rel); },
  relList: path => { for (const hint of hints(path)) connectedLink(hint).relList.add(hint.rel); },
  relProperty: path => { for (const hint of hints(path)) connectedLink(hint).rel = hint.rel; },
  attributeNode: path => { for (const hint of hints(path)) { const link = connectedLink(hint); link.setAttribute("rel", "author"); link.getAttributeNode("rel").value = hint.rel; } },
  contextualFragment: path => { const range = document.createRange(); range.selectNodeContents(document.head); document.head.appendChild(range.createContextualFragment(markup(path))); },
  domParser: path => { const parsed = new DOMParser().parseFromString(markup(path), "text/html"); for (const link of [...parsed.head.children]) document.head.appendChild(link); },
  execCommand: path => { const editable = document.getElementById("editable"); editable.focus(); getSelection().selectAllChildren(editable); document.execCommand("insertHTML", false, markup(path)); },
  shadowRoot: path => { const host = document.createElement("div"); document.body.appendChild(host); host.attachShadow({ mode: "open" }).innerHTML = markup(path); },
  srcdocFrame: path => { const frame = document.createElement("iframe"); frame.srcdoc = markup(path) + nestedScript("srcdoc"); document.body.appendChild(frame); },
  javascriptFrame: path => { const frame = document.createElement("iframe"); frame.src = "javascript:" + JSON.stringify(markup(path) + nestedScript("javascript")); document.body.appendChild(frame); },
  // Chromium speculation rules: a navigational prefetch outside the fetch directives.
  speculationRules: () => {
    const rules = document.createElement("script");
    rules.type = "speculationrules";
    rules.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: [config.fetch + "/trap/speculation-prefetch"] }], prerender: [{ source: "list", urls: [config.fetch + "/trap/speculation-prerender"] }] });
    document.head.appendChild(rules);
  }
};
const nested = [];
addEventListener("message", event => { if (event.data && typeof event.data.nested === "string") nested.push(event.data.nested); });
const errors = {};
for (const name of Object.keys(paths)) { try { paths[name](name); } catch (error) { errors[name] = String(error && error.name); } }
// The bridge's hooks hold only while no script can reach a fresh realm with untouched
// prototypes: a nested about:blank frame must stay a different (opaque) origin.
const blankFrame = document.createElement("iframe");
document.body.appendChild(blankFrame);
let blankFrameRealm = "closed";
try { if (blankFrame.contentDocument) blankFrameRealm = "document"; else if (blankFrame.contentWindow.Node) blankFrameRealm = "realm"; } catch (error) { blankFrameRealm = "threw:" + (error && error.name); }
const rtcGlobals = ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "RTCSessionDescription", "RTCCertificate"];
const globals = rtcGlobals.filter(name => name in window);
const PeerConnection = () => window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
// A data-channel offer starts ICE gathering, which contacts the stun server.
const rtc = (name, urls) => outcome(name, done => {
  const Ctor = PeerConnection();
  if (typeof Ctor !== "function") return done("absent");
  let pc;
  try { pc = new Ctor({ iceServers: [{ urls }] }); } catch (error) { return done("construct-threw:" + (error && error.name)); }
  try {
    pc.createDataChannel("probe");
    pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(error => done("offer-error:" + (error && error.name)));
  } catch (error) { return done("ice-threw:" + (error && error.name)); }
  setTimeout(() => { try { pc.close(); } catch {} done("gathered"); }, 1500);
}, 4000);
const blocked = /(^|[\\t\\n\\f\\r ])(preconnect|dns-prefetch|prefetch|prerender|preload|modulepreload)($|[\\t\\n\\f\\r ])/i;
const blockedLinks = [];
const scan = root => {
  for (const link of root.querySelectorAll("link")) if (blocked.test(link.getAttribute("rel") || "")) blockedLinks.push(link.getAttribute("rel"));
  for (const element of root.querySelectorAll("*")) if (element.shadowRoot) scan(element.shadowRoot);
};
Promise.all([
  rtc("webrtcStunIp", "stun:127.0.0.1:" + config.stun),
  rtc("webrtcStunHost", "stun:localhost:" + config.stun),
  new Promise(resolve => setTimeout(resolve, 1500))
]).then(results => {
  scan(document);
  report({ globals, results: { ...Object.fromEntries(results.filter(Array.isArray)), blankFrameRealm }, nested, blockedLinks, errors });
});`;
}

function probeDocument(config: ProbeConfig, head = ""): string {
  return `<!doctype html><html><head>${head}<title>Side-channel probe</title></head><body>
<div id="editable" contenteditable="true">x</div>
<script>
${probeBody(config)}
</script></body></html>`;
}

const attribute = (value: string) => value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");

let host: RuntimeServer;
let traps: Traps | undefined;

test.beforeAll(async () => { host = await startRuntimeServer(); });
test.afterAll(async () => { await host?.close(); });
test.beforeEach(async () => { host.hits.length = 0; traps = await startTraps(); });
// Fresh traps per test: a socket a previous page opens late reaches a closed port.
test.afterEach(async () => { await closeTraps(traps); traps = undefined; });

async function runProbe(page: Page, url: string): Promise<{ probe: Probe; messages: unknown[]; observed: Observation }> {
  await page.goto(url);
  const { result, messages } = await waitForProbe(page, "side-channels");
  // Let any socket, request or datagram the probe started actually arrive.
  await page.waitForTimeout(800);
  return { probe: result as unknown as Probe, messages, observed: observe(traps!) };
}

const modes = [
  { name: "A: parent without CSP", policies: () => [] },
  { name: "B: parent with the production viewer CSP", policies: productionViewerPolicies }
];

for (const mode of modes) {
  test(`${mode.name}: no resource hint, nested document or WebRTC channel reaches a trap`, async ({ page }) => {
    const config = probeConfig(traps!);
    const { probe, messages, observed } = await runProbe(page, host.hostPage(renderArtifactDocument(probeDocument(config)), mode.policies()));
    // One comparison, so a failure names every path that leaked at once.
    expect({ ...observed, hostHits: host.hits, globals: probe.globals, nested: probe.nested, blockedLinks: probe.blockedLinks }).toEqual({
      sockets: [], fetchHits: [], fetchSockets: 0, stun: 0, hostHits: [], globals: [], nested: [], blockedLinks: []
    });
    expect(probe.results.webrtcStunIp).toMatch(/^(?:absent|construct-threw|ice-threw)/u);
    expect(probe.results.blankFrameRealm).toMatch(/^(?:closed|threw:)/u);
    // The removed nested document is a visible runtime error, not a silent blank frame.
    expect(messages).toContainEqual(expect.objectContaining({ type: "aiqsa_artifact_runtime_error", message: expect.stringContaining("nested documents") }));
  });
}

// What each engine does on a page without the bridge, measured with Playwright 1.60
// locally and on the dev server's --network none stand. A control asserts only the
// channels an engine demonstrably uses, so it can fail; a channel an engine never opens
// even unprotected proves nothing there, and A and B still require silence from all.
//   - Chromium fetches prefetch and preload links from every path but execCommand
//     insertHTML, which drops link elements; it opens no preconnect socket here, runs
//     javascript: frames, and sends STUN only from a host with a non-loopback interface.
//   - Firefox preloads from every path but the javascript: frame, which it does not run.
//     It prefetches only when idle and not on every run, so its prefetch is not asserted;
//     it sends no STUN to a loopback server.
//   - WebKit preconnects and preloads from every path but execCommand and the javascript:
//     frame, links in shadow roots and nested srcdoc documents included; it never
//     prefetches; it sends STUN even with loopback only. Its preconnect and STUN pass
//     the artifact CSP (C), which is why the bridge has to close them.
// No engine acts on speculation rules from this sandboxed frame, even unprotected.
const except = (...skipped: string[]) => HINT_PATHS.filter(path => !skipped.includes(path));
const externalInterface = () => Object.values(networkInterfaces()).flat().some(entry => entry && !entry.internal && entry.family === "IPv4");
type Unprotected = Readonly<{ fetch: readonly string[]; sockets: readonly string[]; nested: readonly string[]; stun: () => boolean }>;
const UNPROTECTED: Record<string, Unprotected> = {
  chromium: { fetch: except("execCommand").flatMap(path => [`/trap/prefetch-${path}`, `/trap/preload-${path}`]), sockets: [], nested: ["javascript", "srcdoc"], stun: externalInterface },
  firefox: { fetch: except("javascriptFrame").map(path => `/trap/preload-${path}`), sockets: [], nested: ["srcdoc"], stun: () => false },
  webkit: { fetch: except("execCommand", "javascriptFrame").map(path => `/trap/preload-${path}`), sockets: except("execCommand", "javascriptFrame").map(path => `${path}/preconnect`), nested: ["srcdoc"], stun: () => true }
};

/** Expected channels that have not reached their trap yet; empty once all have. */
function missing(expected: Pick<Unprotected, "fetch" | "sockets">): { fetch: string[]; sockets: string[] } {
  const now = observe(traps!);
  return { fetch: expected.fetch.filter(path => !now.fetchHits.includes(path)), sockets: expected.sockets.filter(key => !now.sockets.includes(key)) };
}

test("C (control): the artifact CSP alone stops prefetch and preload, not WebKit preconnect, STUN or nested documents", async ({ page, browserName }) => {
  const expected = UNPROTECTED[browserName]!;
  const head = `<meta http-equiv="Content-Security-Policy" content="${attribute(ARTIFACT_META_POLICY)}">`;
  const { probe } = await runProbe(page, host.hostPage(probeDocument(probeConfig(traps!), head)));
  await expect.poll(() => missing({ fetch: [], sockets: expected.sockets }), { timeout: 10_000 }).toEqual({ fetch: [], sockets: [] });
  // prefetch and preload are CSP fetches, so default-src 'none' alone stops them.
  expect(observe(traps!).fetchHits).toEqual([]);
  expect(probe.nested).toEqual(expect.arrayContaining([...expected.nested]));
  if (expected.stun()) expect(observe(traps!).stun, "STUN packets under the artifact CSP").toBeGreaterThan(0);
});

test("D (positive control): a bare document (no bridge, no artifact CSP) reaches every trap its engine uses", async ({ page, browserName }) => {
  const expected = UNPROTECTED[browserName]!;
  const { probe } = await runProbe(page, host.hostPage(probeDocument(probeConfig(traps!))));
  await expect.poll(() => missing(expected), { timeout: 10_000 }).toEqual({ fetch: [], sockets: [] });
  // The socket counter itself works in this engine: the fetches above opened sockets.
  expect(observe(traps!).fetchSockets).toBeGreaterThan(0);
  expect(probe.nested).toEqual(expect.arrayContaining([...expected.nested]));
  // Without the bridge the WebRTC constructor is present again.
  expect(probe.globals).toContain("RTCPeerConnection");
  if (expected.stun()) expect(observe(traps!).stun, "STUN packets").toBeGreaterThan(0);
  else test.info().annotations.push({ type: "stun", description: `${browserName} sends no STUN to a loopback server from this host` });
});
