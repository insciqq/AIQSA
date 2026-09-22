import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactResourceFetcher, verifyArtifactIntegrity } from "./resourceFetch";
import { ARTIFACT_RESOURCE_LIMITS, type ArtifactResourcePolicy } from "./resourcePolicy";
import type { McpPinnedHttpRequest } from "../mcp/safeFetch";

const url = "https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/a.js";
const publicDns = async () => [{ address: "93.184.216.34", family: 4 as const }];
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("artifact pinned fetch", () => {
  it("intersects admitted hosts with live policy, including after DNS and redirects", async () => {
    const acceptedPolicy = { on: true, libraryHosts: ["cdnjs.cloudflare.com"], imageHosts: [] };
    let current = { ...acceptedPolicy, libraryHosts: ["cdnjs.cloudflare.com", "new.example"] };
    const dispatch = vi.fn(async () => new Response("/* synthetic */", { headers: { "content-type": "text/javascript" } }));
    const fetcher = createArtifactResourceFetcher({ dispatch, lookupHostname: publicDns, policy: () => current });
    await expect(fetcher({ url: "https://new.example/a.js", kind: "script", acceptedPolicy })).rejects.toThrow("artifact_resource_host_not_allowed");
    expect(dispatch).not.toHaveBeenCalled();
    await expect(fetcher({ url, kind: "script", acceptedPolicy })).resolves.toMatchObject({ mimeType: "text/javascript" });
    current = { ...current, on: false };
    await expect(fetcher({ url, kind: "script", acceptedPolicy })).rejects.toThrow("artifact_resource_host_not_allowed");
    expect(dispatch).toHaveBeenCalledOnce();
    current = { ...current, on: true };
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://new.example/a.js" } }));
    await expect(createArtifactResourceFetcher({ dispatch: redirect, lookupHostname: publicDns, policy: () => current })({ url, kind: "script", acceptedPolicy }))
      .rejects.toThrow("artifact_resource_host_not_allowed");
    expect(redirect).toHaveBeenCalledOnce();
  });
  it("pins public DNS, sends no credentials, and never dispatches disallowed redirects", async () => {
    const dispatch = vi.fn(async (request: McpPinnedHttpRequest) => {
      expect(request.address).toEqual({ address: "93.184.216.34", family: 4 });
      expect([...request.headers.keys()].sort()).toEqual(["accept", "accept-encoding"]);
      expect(request.method).toBe("GET"); expect(request.body).toBeNull();
      return new Response(null, { status: 302, headers: { location: "https://private.example/secret.js" } });
    });
    const fetcher = createArtifactResourceFetcher({ dispatch, lookupHostname: publicDns });
    await expect(fetcher({ url, kind: "script" })).rejects.toThrow("artifact_resource_host_not_allowed");
    expect(dispatch).toHaveBeenCalledOnce();
    for (const address of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1"]) {
      const denied = createArtifactResourceFetcher({ dispatch, lookupHostname: async () => [{ address, family: address.includes(":") ? 6 : 4 }] });
      await expect(denied({ url, kind: "script" })).rejects.toThrow("artifact_resource_unreachable");
    }
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("checks raw redirect traversal, current policy, and at most three hops", async () => {
    let current: ArtifactResourcePolicy = { on: true, libraryHosts: ["cdnjs.cloudflare.com"], imageHosts: [] };
    const dispatch = vi.fn(async () => { current = { ...current, on: false }; return new Response(null, { status: 302, headers: { location: "b.js" } }); });
    await expect(createArtifactResourceFetcher({ dispatch, lookupHostname: publicDns, policy: () => current })({ url, kind: "script" })).rejects.toThrow("artifact_resource_host_not_allowed");
    expect(dispatch).toHaveBeenCalledOnce();
    current = { ...current, on: true };
    const delayedDns = createArtifactResourceFetcher({ dispatch, policy: () => current, lookupHostname: async () => {
      current = { ...current, on: false }; return publicDns();
    } });
    await expect(delayedDns({ url, kind: "script" })).rejects.toThrow("artifact_resource_host_not_allowed");
    expect(dispatch).toHaveBeenCalledOnce();
    const traversal = vi.fn(async () => new Response(null, { status: 302, headers: { location: "../1.2.3/a.js" } }));
    await expect(createArtifactResourceFetcher({ dispatch: traversal, lookupHostname: publicDns })({ url, kind: "script" })).rejects.toThrow("artifact_resource_host_not_allowed");
    expect(traversal).toHaveBeenCalledOnce();
    const looping = vi.fn(async () => new Response(null, { status: 302, headers: { location: url } }));
    await expect(createArtifactResourceFetcher({ dispatch: looping, lookupHostname: publicDns })({ url, kind: "script" })).rejects.toThrow("artifact_resource_unreachable");
    expect(looping).toHaveBeenCalledTimes(4);
  });
  it("bounds streamed bytes and declared sizes, verifies MIME and UTF-8", async () => {
    const cancelled = vi.fn();
    const dispatch = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(ARTIFACT_RESOURCE_LIMITS.scriptBytes)); controller.enqueue(new Uint8Array(1));
    }, cancel: cancelled }), { headers: { "content-type": "text/javascript" } }));
    await expect(createArtifactResourceFetcher({ dispatch, lookupHostname: publicDns })({ url, kind: "script" })).rejects.toThrow("artifact_resource_too_large");
    expect(cancelled).toHaveBeenCalledOnce();
    for (const response of [new Response("x", { headers: { "content-type": "text/html" } }),
      new Response(new Uint8Array([255]), { headers: { "content-type": "text/javascript" } })]) {
      await expect(createArtifactResourceFetcher({ dispatch: async () => response, lookupHostname: publicDns })({ url, kind: "script" })).rejects.toThrow("artifact_resource_type_mismatch");
    }
    const exact = Buffer.alloc(ARTIFACT_RESOURCE_LIMITS.scriptBytes, 32);
    const accepted = await createArtifactResourceFetcher({ dispatch: async () => new Response(exact, { headers: { "content-type": "application/javascript" } }), lookupHostname: publicDns })({ url, kind: "script" });
    expect(accepted.mimeType).toBe("text/javascript"); expect(accepted.bytes.equals(exact)).toBe(true);
    await expect(createArtifactResourceFetcher({ dispatch: async () => new Response("x", { headers: { "content-type": "text/javascript", "content-length": String(ARTIFACT_RESOURCE_LIMITS.scriptBytes + 1) } }), lookupHostname: publicDns })({ url, kind: "script" })).rejects.toThrow("artifact_resource_too_large");
  });
  it("fully decodes images and rejects SVG, truncation and MIME mismatch", async () => {
    vi.stubEnv("AIQSA_ARTIFACT_IMAGE_HOSTS", "images.example");
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    for (const [body, mimeType] of [[bytes, "image/png"], [bytes, "image/jpeg"], [bytes.subarray(0, 33), "image/png"], [Buffer.from("<svg/>"), "image/svg+xml"]] as const) {
      const result = createArtifactResourceFetcher({ lookupHostname: publicDns, dispatch: async () => new Response(body, { headers: { "content-type": mimeType } }) })({ url: "https://images.example/image.png", kind: "image" });
      if (body === bytes && mimeType === "image/png") await expect(result).resolves.toMatchObject({ bytes });
      else await expect(result).rejects.toThrow("artifact_resource_type_mismatch");
    }
  });
  it("aborts a stalled body at the resource deadline", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const result = createArtifactResourceFetcher({ lookupHostname: publicDns, dispatch: async () => new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-type": "text/javascript" } }) })({ url, kind: "script" });
    const assertion = expect(result).rejects.toThrow("artifact_resource_unreachable");
    await vi.advanceTimersByTimeAsync(ARTIFACT_RESOURCE_LIMITS.resourceTimeoutMs);
    await assertion; expect(cancelled).toHaveBeenCalledOnce();
  });
  it("accepts missing integrity and checks the strongest supplied hash", () => {
    const bytes = Buffer.from("fixture");
    expect(() => verifyArtifactIntegrity(bytes, undefined)).not.toThrow();
    const digest = createHash("sha256").update(bytes).digest("base64");
    expect(() => verifyArtifactIntegrity(bytes, `sha256-${digest}`)).not.toThrow();
    expect(() => verifyArtifactIntegrity(bytes, `sha256-${digest} sha512-YWJj`)).toThrow(expect.objectContaining({ code: "artifact_resource_integrity_mismatch", hint: expect.stringContaining("Remove") }));
    expect(() => verifyArtifactIntegrity(bytes, "invented")).toThrow("artifact_resource_integrity_mismatch");
  });
});
