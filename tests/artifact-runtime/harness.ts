import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { ARTIFACT_VIEW_ALLOW, ARTIFACT_VIEW_SANDBOX } from "../../lib/contracts/artifactRuntime";
import { artifactContentSecurityPolicy } from "../../lib/contracts/artifacts";
import { renderArtifactBundle, type ArtifactBundleFile } from "../../lib/server/artifacts/bundle";
import { runtimeSecurityHeaders } from "../../lib/server/security/headers";

/**
 * App-free artifact runtime stand. A host page mimics the viewer: an opaque
 * sandboxed srcdoc frame holding the real renderer output. Every request that
 * is not a host page lands in `hits`, so a spec can prove that nothing left the
 * artifact. Specs post results with `parent.postMessage({ type: "aiqsa_probe",
 * name, ... }, "*")` and read them with `waitForProbe`.
 */

export const ARTIFACT_META_POLICY = artifactContentSecurityPolicy("meta");

/** The production app policy plus the viewer's extra `frame-src 'none'` (proxy.ts). */
export function productionViewerPolicies(): string[] {
  const enforced = runtimeSecurityHeaders({ AIQSA_APP_BASE_URL: "https://aiqsa.example", NODE_ENV: "production" })["Content-Security-Policy"];
  if (!enforced) throw new Error("production_policy_missing");
  return [enforced, "frame-src 'none'"];
}

/** Renders an entry document (and optional extra files) through the real renderer. */
export function renderArtifactDocument(html: string, files: readonly ArtifactBundleFile[] = []): string {
  return renderArtifactPage([{ mimeType: "text/html", path: "index.html", text: html }, ...files]);
}

/** Renders one page (default: the `index.html` entrypoint) of a multi-file bundle. */
export function renderArtifactPage(files: readonly ArtifactBundleFile[], page?: string): string {
  return renderArtifactBundle({ entrypoint: "index.html", files, kind: "html", version: 2 }, false, page).body.toString("utf8");
}

/** 0.2 s of 8 kHz mono 8-bit PCM: a WAV file every engine decodes. */
export function syntheticWav(): Buffer {
  const samples = 1600;
  const bytes = Buffer.alloc(44 + samples);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(36 + samples, 4); bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34); bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(samples, 40);
  for (let index = 0; index < samples; index++) bytes[44 + index] = 128 + Math.round(60 * Math.sin(index / 4));
  return bytes;
}

/** Replaces the injected artifact meta policy; `null` removes it (positive controls only). */
export function withArtifactPolicy(document: string, policy: string | null): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_META_POLICY}">`;
  if (document.split(meta).length !== 2) throw new Error("artifact_policy_meta_missing");
  return document.replace(meta, policy === null ? "" : `<meta http-equiv="Content-Security-Policy" content="${policy}">`);
}

export type RuntimeHit = Readonly<{ kind: "http" | "upgrade"; method: string; path: string }>;

export type RuntimeServer = Readonly<{
  origin: string;
  wsOrigin: string;
  hits: RuntimeHit[];
  /** Serves a viewer-like host page for an already rendered artifact document. */
  hostPage(document: string, policies?: readonly string[]): string;
  close(): Promise<void>;
}>;

const attribute = (value: string) => value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");

function hostDocument(document: string): string {
  // The listener precedes the frame so no early artifact message is lost.
  return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Artifact host</title><script>" +
    "window.__artifactMessages = [];" +
    "addEventListener('message', event => { if (event.source === document.getElementById('artifact')?.contentWindow) window.__artifactMessages.push(event.data); });" +
    `</script></head><body><iframe id="artifact" title="Artifact" sandbox="${ARTIFACT_VIEW_SANDBOX}" allow="${ARTIFACT_VIEW_ALLOW}" srcdoc="${attribute(document)}"></iframe></body></html>`;
}

function trapResponse(request: IncomingMessage, response: ServerResponse): void {
  const script = /import/u.test(request.url ?? "");
  response.writeHead(200, { "access-control-allow-origin": "*", "cache-control": "no-store",
    "content-type": script ? "text/javascript" : "text/plain" });
  response.end(script ? "void 0;" : "trap");
}

export async function startRuntimeServer(): Promise<RuntimeServer> {
  const pages = new Map<string, { body: string; policies: readonly string[] }>();
  const hits: RuntimeHit[] = [];
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://runtime.invalid").pathname;
    const page = pages.get(path);
    if (page) {
      // One header line per policy, each enforced independently.
      if (page.policies.length) response.setHeader("content-security-policy", [...page.policies]);
      response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
      response.end(page.body);
      return;
    }
    // Top-level documents may ask for a favicon on their own; it is not artifact traffic.
    if (path === "/favicon.ico") { response.writeHead(204).end(); return; }
    hits.push({ kind: "http", method: request.method ?? "", path });
    trapResponse(request, response);
  });
  server.on("upgrade", (request, socket) => {
    hits.push({ kind: "upgrade", method: request.method ?? "", path: new URL(request.url ?? "/", "http://runtime.invalid").pathname });
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address() as AddressInfo;
  let next = 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    wsOrigin: `ws://127.0.0.1:${port}`,
    hits,
    hostPage(document, policies = []) {
      const path = `/host/${++next}`;
      pages.set(path, { body: hostDocument(document), policies });
      return `http://127.0.0.1:${port}${path}`;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => error ? reject(error) : resolve());
    })
  };
}

export type ProbeMessage = Readonly<{ type: "aiqsa_probe"; name: string } & Record<string, unknown>>;

/** Waits for the artifact's probe result and returns it with every frame message seen so far. */
export async function waitForProbe(page: Page, name: string, timeout = 15_000): Promise<{ result: ProbeMessage; messages: unknown[] }> {
  await page.waitForFunction(probe => (window as unknown as { __artifactMessages: Array<{ type?: string; name?: string }> }).__artifactMessages
    .some(message => message?.type === "aiqsa_probe" && message.name === probe), name, { timeout });
  const messages = await page.evaluate(() => (window as unknown as { __artifactMessages: unknown[] }).__artifactMessages);
  const result = messages.find((message): message is ProbeMessage => typeof message === "object" && message !== null &&
    (message as ProbeMessage).type === "aiqsa_probe" && (message as ProbeMessage).name === name)!;
  return { messages, result };
}

/** Shared probe prelude: `outcome(name, run)` settles each channel once, with a timeout. */
export const PROBE_OUTCOME_SOURCE = "const outcome = (name, run, ms = 3000) => new Promise(resolve => {" +
  "let settled = false; const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve([name, String(value)]); } };" +
  "const timer = setTimeout(() => done('timeout'), ms);" +
  "try { run(done); } catch (error) { done('threw:' + (error && error.name)); } });";
