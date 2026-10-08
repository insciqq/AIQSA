import { expect, test } from "@playwright/test";
import {
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

// Channels that reach the network without ever being a CSP "fetch", so
// connect-src 'none' / default-src 'none' do not govern them:
//   - WebRTC ICE: an RTCPeerConnection with a stun:/turn: server sends STUN
//     binding requests over UDP (and resolves the server's DNS name, which can
//     carry data) the moment a data channel's offer is applied.
//   - resource hints: a runtime-inserted <link rel="preconnect"> opens a TCP
//     connection to an arbitrary host, and dns-prefetch resolves its name.
// The traps below observe the real network: a UDP listener for STUN and a TCP
// listener that counts raw sockets (a preconnect sends no HTTP request). The
// fix lives in the runtime bridge, which runs before any authored script, so it
// closes these channels regardless of CSP. The positive control therefore uses
// a bare document with neither the bridge nor the artifact CSP: it proves the
// traps fire against an unprotected page.

type Probe = Readonly<{ globals: string[]; results: Record<string, string> }>;

/** The probe body, shared by the rendered pages and the bare positive control. */
function probeBody(stunPort: number, preconnectAuthority: string, fetchOrigin: string): string {
  return `${PROBE_OUTCOME_SOURCE}
const report = value => parent.postMessage({ type: "aiqsa_probe", name: "side-channels", ...value }, "*");
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
// A link hint inserted by script. appendChild and innerHTML take different code
// paths; both must stay inert.
const hintAppend = (name, rel, href, attrs) => outcome(name, done => {
  const link = document.createElement("link");
  link.rel = rel;
  if (attrs) for (const key of Object.keys(attrs)) link.setAttribute(key, attrs[key]);
  link.href = href;
  document.head.appendChild(link);
  setTimeout(() => done("inserted:rel=" + link.rel + ":href=" + (link.href ? "set" : "empty")), 1200);
}, 4000);
const hintInnerHtml = (name, rel, href) => outcome(name, done => {
  const host = document.createElement("div");
  host.innerHTML = '<link rel="' + rel + '" href="' + href + '">';
  document.head.appendChild(host.firstChild);
  setTimeout(() => done("inserted"), 1200);
}, 4000);
Promise.all([
  rtc("webrtcStunIp", "stun:127.0.0.1:" + ${stunPort}),
  rtc("webrtcStunHost", "stun:localhost:" + ${stunPort}),
  hintAppend("preconnect", "preconnect", "//" + ${JSON.stringify(preconnectAuthority)}),
  hintInnerHtml("preconnectInnerHtml", "preconnect", "//" + ${JSON.stringify(preconnectAuthority)}),
  hintAppend("dnsPrefetch", "dns-prefetch", "//" + ${JSON.stringify(preconnectAuthority)}),
  hintAppend("prefetch", "prefetch", ${JSON.stringify(fetchOrigin)} + "/trap/prefetch"),
  hintAppend("preload", "preload", ${JSON.stringify(fetchOrigin)} + "/trap/preload", { as: "fetch", crossorigin: "anonymous" })
]).then(results => report({ globals, results: Object.fromEntries(results) }));`;
}

function probeDocument(stunPort: number, preconnectAuthority: string, fetchOrigin: string): string {
  return `<!doctype html><html><head><title>Side-channel probe</title></head><body><script>
${probeBody(stunPort, preconnectAuthority, fetchOrigin)}
</script></body></html>`;
}

/** The bare positive control: no renderer (so no bridge) and no artifact CSP. */
function bareHost(host: RuntimeServer, stunPort: number, preconnectAuthority: string, fetchOrigin: string): string {
  return host.hostPage(probeDocument(stunPort, preconnectAuthority, fetchOrigin));
}

let host: RuntimeServer;
let preconnectTrap: RuntimeServer;
let fetchTrap: RuntimeServer;
let stunTrap: StunTrap;

test.beforeAll(async () => {
  host = await startRuntimeServer();
  preconnectTrap = await startRuntimeServer();
  fetchTrap = await startRuntimeServer();
  stunTrap = await startStunTrap();
});
test.afterAll(async () => { await host?.close(); await preconnectTrap?.close(); await fetchTrap?.close(); await stunTrap?.close(); });
test.beforeEach(() => {
  host.hits.length = 0; host.connections.length = 0;
  preconnectTrap.hits.length = 0; preconnectTrap.connections.length = 0;
  fetchTrap.hits.length = 0; fetchTrap.connections.length = 0;
  stunTrap.packets.length = 0;
});

function preconnectAuthority(): string { return new URL(preconnectTrap.origin).host; }

const modes = [
  { name: "A: parent without CSP", policies: () => [] },
  { name: "B: parent with the production viewer CSP", policies: productionViewerPolicies }
];

for (const mode of modes) {
  test(`${mode.name}: WebRTC, preconnect and dns-prefetch reach no trap`, async ({ page }) => {
    await page.goto(host.hostPage(renderArtifactDocument(probeDocument(stunTrap.port, preconnectAuthority(), fetchTrap.origin)), mode.policies()));
    const { result } = await waitForProbe(page, "side-channels");
    const probe = result as unknown as Probe;
    // Let any socket or datagram the hints or ICE would open actually arrive.
    await page.waitForTimeout(800);
    // The bridge deleted every WebRTC constructor, so no peer connection opens.
    expect(probe.globals, "surviving WebRTC globals").toEqual([]);
    expect(probe.results.webrtcStunIp).toMatch(/^(?:absent|construct-threw|ice-threw)/u);
    expect(stunTrap.packets.filter(isStunPacket).length, "STUN packets").toBe(0);
    expect(preconnectTrap.connections, "preconnect/dns-prefetch TCP sockets").toEqual([]);
    expect(preconnectTrap.hits, "preconnect/dns-prefetch HTTP requests").toEqual([]);
    expect(fetchTrap.hits, "prefetch/preload HTTP requests").toEqual([]);
    expect(fetchTrap.connections, "prefetch/preload TCP sockets").toEqual([]);
  });
}

test("D (positive control): a bare document (no bridge, no artifact CSP) still reaches the traps", async ({ page, browserName }) => {
  await page.goto(bareHost(host, stunTrap.port, preconnectAuthority(), fetchTrap.origin));
  const { result } = await waitForProbe(page, "side-channels");
  const probe = result as unknown as Probe;
  await page.waitForTimeout(800);
  // Without the bridge the WebRTC constructor is present again.
  expect(probe.globals, JSON.stringify(probe.results)).toContain("RTCPeerConnection");
  // The TCP trap works: a prefetch/preload without the artifact CSP fetches.
  await expect.poll(() => fetchTrap.hits.map(hit => hit.path).sort()).toEqual(["/trap/prefetch", "/trap/preload"]);
  expect(fetchTrap.connections.length, "prefetch/preload TCP sockets").toBeGreaterThan(0);
  // The UDP trap works: Chromium ICE gathering sends STUN to the stun server.
  // Playwright Firefox does not contact a loopback STUN server even unprotected,
  // so only Chromium proves the UDP trap here; the bridge removes the channel in
  // every engine regardless.
  if (browserName === "chromium") expect(stunTrap.packets.filter(isStunPacket).length, JSON.stringify(probe.results)).toBeGreaterThan(0);
  // preconnect / dns-prefetch opened no socket in either local engine, even on
  // this unprotected page, so there is no connection for the probe to assert.
  expect(preconnectTrap.connections, "preconnect/dns-prefetch TCP sockets").toEqual([]);
});

test("prefetch and preload are already blocked by the artifact CSP (default-src 'none')", async ({ page }) => {
  await page.goto(host.hostPage(renderArtifactDocument(probeDocument(stunTrap.port, preconnectAuthority(), fetchTrap.origin))));
  await waitForProbe(page, "side-channels");
  await page.waitForTimeout(800);
  // A prefetch/preload is a CSP fetch, so the artifact's default-src 'none' stops it.
  expect(fetchTrap.hits).toEqual([]);
  expect(fetchTrap.connections).toEqual([]);
});
