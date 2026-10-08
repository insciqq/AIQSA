import { expect, test } from "@playwright/test";
import {
  PROBE_OUTCOME_SOURCE,
  productionViewerPolicies,
  renderArtifactDocument,
  startRuntimeServer,
  waitForProbe,
  type RuntimeServer
} from "./harness";

// Media generated inside the artifact plays from blob: and data: URLs. The
// opaque srcdoc frame inherits the app policy too, so both need media-src.

const MEDIA_PROBE = `<!doctype html><html><head><title>Media probe</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><rect width='1' height='1'/></svg>">
</head><body><script>
${PROBE_OUTCOME_SOURCE}
// 0.2 s of 8 kHz mono 8-bit PCM: a WAV every engine decodes.
const samples = 1600;
const bytes = new Uint8Array(44 + samples);
const view = new DataView(bytes.buffer);
const ascii = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
ascii(0, "RIFF"); view.setUint32(4, 36 + samples, true); ascii(8, "WAVE"); ascii(12, "fmt ");
view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true);
view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true); ascii(36, "data"); view.setUint32(40, samples, true);
for (let index = 0; index < samples; index++) bytes[44 + index] = 128 + Math.round(60 * Math.sin(index / 4));
const load = (name, src) => outcome(name, done => {
  const audio = document.createElement("audio");
  audio.muted = true; audio.preload = "auto";
  audio.onloadedmetadata = () => done("loadedmetadata");
  audio.onerror = () => done("error:" + (audio.error && audio.error.code));
  document.body.append(audio);
  audio.src = src; audio.load();
}, 8000);
Promise.all([
  load("blob", URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }))),
  load("data", "data:audio/wav;base64," + btoa(String.fromCharCode(...bytes)))
]).then(results => parent.postMessage({ type: "aiqsa_probe", name: "media", ...Object.fromEntries(results) }, "*"));
</script></body></html>`;

let host: RuntimeServer;
test.beforeAll(async () => { host = await startRuntimeServer(); });
test.afterAll(async () => { await host?.close(); });
test.beforeEach(() => { host.hits.length = 0; });

const modes = [
  { name: "A: parent without CSP", policies: () => [] },
  { name: "B: parent with the production viewer CSP", policies: productionViewerPolicies }
];

for (const mode of modes) {
  test(`${mode.name}: generated audio loads from blob: and data: URLs without policy violations`, async ({ page }) => {
    await page.goto(host.hostPage(renderArtifactDocument(MEDIA_PROBE), mode.policies()));
    const { messages, result } = await waitForProbe(page, "media");
    expect(result).toMatchObject({ blob: "loadedmetadata", data: "loadedmetadata" });
    expect(messages.filter(message => (message as { type?: string })?.type === "aiqsa_artifact_runtime_error")).toEqual([]);
    expect(host.hits).toEqual([]);
  });
}

test("an app policy without media-src blocks the same audio (control)", async ({ page }) => {
  const [enforced, ...rest] = productionViewerPolicies();
  const withoutMedia = enforced!.replace(/ media-src [^;]+;/u, "");
  expect(withoutMedia).not.toBe(enforced);
  await page.goto(host.hostPage(renderArtifactDocument(MEDIA_PROBE), [withoutMedia, ...rest]));
  const { result } = await waitForProbe(page, "media");
  expect(result.blob).not.toBe("loadedmetadata");
  expect(result.data).not.toBe("loadedmetadata");
});
