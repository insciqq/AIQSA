import { describe, expect, it, vi } from "vitest";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { createArtifactContentHandler, createArtifactDuplicateHandler, createPublicArtifactHandler, createPublicArtifactManifestHandler,
  createArtifactPublishHandler, createArtifactPublicationMutationHandler, createArtifactPublicationReissueHandler, createArtifactRevokeHandler } from "./handlers";
import { ArtifactToolError } from "./errors";
import { ArtifactPublicBusyError } from "./objects";
import type { ArtifactService } from "./service";

const auth: RequestAuthResolver = async () => ({
  id: "artifact-test-session", userId: "owner", expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  user: { id: "owner", displayName: "Artifact owner", email: null, role: "user", status: "active" }
});
const download = { versionNumber: 1, title: "Гусь-рокер — страница", fileName: "image.svg", contentType: "image/svg+xml", body: Buffer.from("<svg/>") };
describe("artifact delivery boundaries", () => {
  it("keeps private main-file authorization and Unicode disposition while routing SVG downloads", async () => {
    const getPrivateBundle = vi.fn(async () => download);
    const handler = createArtifactContentHandler({ resolveAuth: auth, service: { getPrivateBundle } as unknown as ArtifactService });
    const response = await handler(new Request("https://app.example/api/artifacts/a/versions/v/content?download=file"), { params: { artifactId: "a", versionId: "v" } });
    expect(getPrivateBundle).toHaveBeenCalledWith({ artifactId: "a", versionId: "v", ownerUserId: "owner", mainFile: true });
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="artifact.svg"; filename*=UTF-8''${encodeURIComponent(download.title + ".svg")}`);
    expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-forms allow-pointer-lock allow-downloads;");
    const denied = createArtifactContentHandler({ resolveAuth: async () => null, service: { getPrivateBundle } as unknown as ArtifactService });
    expect((await denied(new Request("https://app.example/api/artifacts/a/versions/v/content"), { params: { artifactId: "a", versionId: "v" } })).status).toBe(401);
    expect(getPrivateBundle).toHaveBeenCalledOnce();
  });
  it("returns generic anonymous failures and bounded-work rejection without internal details", async () => {
    const publicBundle = vi.fn(async () => download);
    const handler = createPublicArtifactHandler({ publicBundle } as unknown as ArtifactService);
    const request = new Request("https://app.example/api/artifact-public/token?download=file");
    const context = { params: { artifactToken: "s".repeat(43) } };
    expect((await handler(request, { params: { artifactToken: "bad" } })).status).toBe(404);
    expect(publicBundle).not.toHaveBeenCalled();
    const response = await handler(request, context);
    expect(publicBundle).toHaveBeenCalledWith(context.params.artifactToken, true, undefined, undefined);
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    publicBundle.mockRejectedValueOnce(new Error("private storage path"));
    const failed = await handler(request, context);
    expect(failed.status).toBe(404); await expect(failed.json()).resolves.toEqual({ error: "artifact_not_found" });
    publicBundle.mockRejectedValueOnce(new ArtifactPublicBusyError());
    const busy = await handler(request, context);
    expect(busy.status).toBe(429); expect(busy.headers.get("retry-after")).toBe("1");
    await expect(busy.json()).resolves.toEqual({ error: "rate_limit_exceeded" });
  });
  it("selects one validated page of a private version with the entry page's headers, and refuses other selectors", async () => {
    const page = { ...download, contentType: "text/html; charset=utf-8", fileName: "page.html", page: "docs/guide.html" };
    const getPrivateBundle = vi.fn(async () => page);
    const getPrivateZip = vi.fn();
    const handler = createArtifactContentHandler({ resolveAuth: auth, service: { getPrivateBundle, getPrivateZip } as unknown as ArtifactService });
    const context = { params: { artifactId: "a", versionId: "v" } };
    const response = await handler(new Request(`https://app.example/api/artifacts/a/versions/v/content?page=${encodeURIComponent("docs/guide.html")}`), context);
    expect(response.status).toBe(200);
    expect(getPrivateBundle).toHaveBeenCalledWith({ artifactId: "a", versionId: "v", ownerUserId: "owner", page: "docs/guide.html" });
    expect(response.headers.get("X-AIQSA-Artifact-Page")).toBe("docs/guide.html");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
    for (const search of ["?page=../index.html", "?page=_vendor/0123456789ab/a.html", "?page=a.html&page=b.html", "?page=a.html&download=file",
      "?page=a.html&download=zip", "?download=other", "?theme=dark"]) {
      const refused = await handler(new Request(`https://app.example/api/artifacts/a/versions/v/content${search}`), context);
      expect(refused.status, search).toBe(400);
      expect(await refused.json()).toEqual({ error: "artifact_content_query_invalid" });
    }
    expect(getPrivateBundle).toHaveBeenCalledOnce(); expect(getPrivateZip).not.toHaveBeenCalled();
    getPrivateBundle.mockRejectedValueOnce(new ArtifactToolError("artifact_page_not_found", { path: "missing.html", hint: "private hint" }));
    const missing = await handler(new Request("https://app.example/api/artifacts/a/versions/v/content?page=missing.html"), context);
    expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: "artifact_page_not_found" });
    // A page that breaks the artifact rules fails with its own code, never as an empty page.
    getPrivateBundle.mockRejectedValueOnce(new ArtifactToolError("artifact_element_unsupported", { path: "broken.html", hint: "private hint" }));
    const broken = await handler(new Request("https://app.example/api/artifacts/a/versions/v/content?page=broken.html"), context);
    expect(broken.status).toBe(400); expect(await broken.json()).toEqual({ error: "artifact_element_unsupported" });
    getPrivateBundle.mockRejectedValueOnce(new ArtifactPublicBusyError());
    const busy = await handler(new Request("https://app.example/api/artifacts/a/versions/v/content"), context);
    expect(busy.status).toBe(429); expect(busy.headers.get("retry-after")).toBe("1");
    getPrivateBundle.mockResolvedValueOnce(null as never);
    const unknown = await handler(new Request("https://app.example/api/artifacts/a/versions/v/content"), context);
    expect(unknown.status).toBe(404); expect(unknown.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });
  it("serves a published page only for exact page selectors and answers every other one like an unknown token", async () => {
    const token = "p".repeat(43);
    const publicBundle = vi.fn(async () => ({ ...download, contentType: "text/html; charset=utf-8", fileName: "page.html", versionNumber: 2, page: "about.html" }));
    const publicZip = vi.fn();
    const handler = createPublicArtifactHandler({ publicBundle, publicZip } as unknown as ArtifactService);
    const context = { params: { artifactToken: token } };
    const response = await handler(new Request(`https://app.example/api/artifact-public/${token}?page=about.html`, { headers: { "X-AIQSA-Artifact-Version": "2" } }), context);
    expect(response.status).toBe(200);
    expect(publicBundle).toHaveBeenCalledWith(token, false, 2, "about.html");
    expect(response.headers.get("X-AIQSA-Artifact-Page")).toBe("about.html");
    expect(response.headers.get("X-AIQSA-Artifact-Version")).toBe("2");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(response.headers.get("cache-control")).toContain("no-store");
    for (const search of ["?page=../about.html", "?page=", "?page=_vendor/0123456789ab/a.html", "?page=a.html&page=b.html", "?page=a.html&download=file",
      "?download=zip&page=a.html", "?page=a.html&utm=1"]) {
      const refused = await handler(new Request(`https://app.example/api/artifact-public/${token}${search}`), context);
      expect(refused.status, search).toBe(404);
      expect(refused.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await refused.json()).toEqual({ error: "artifact_not_found" });
    }
    expect(publicBundle).toHaveBeenCalledOnce(); expect(publicZip).not.toHaveBeenCalled();
    publicBundle.mockResolvedValueOnce(null as never);
    const missing = await handler(new Request(`https://app.example/api/artifact-public/${token}?page=missing.html`), context);
    expect(missing.status).toBe(404); expect(await missing.json()).toEqual({ error: "artifact_not_found" });
  });
  it("duplicates only under the current owner and returns the library projection", async () => {
    const artifact = { id: "new-artifact", currentVersionId: "new-version", publicationCount: 0, sourceChatId: null };
    const duplicate = vi.fn(async () => artifact);
    const handler = createArtifactDuplicateHandler({ resolveAuth: auth, service: { duplicate } as unknown as ArtifactService });
    const response = await handler(new Request("https://app.example/api/artifacts/a/duplicate", { method: "POST" }), { params: Promise.resolve({ artifactId: "a" }) });
    expect(duplicate).toHaveBeenCalledWith({ artifactId: "a", ownerUserId: "owner" });
    expect(response.status).toBe(201); await expect(response.json()).resolves.toEqual({ artifact });
  });
});

describe("versioned publication HTTP contracts", () => {
  const token = "t".repeat(43);
  const context = { params: { publicationId: "publication" } };
  const summary = { id: "publication", mode: "version_set", revision: 2, status: "READY", defaultVersionId: "v3",
    versions: [{ id: "v3", title: "Three", kind: "html", versionNumber: 3, entrypoint: "index.html" }],
    expiresAt: null, createdAt: "2026-09-21T00:00:00.000Z" };
  const jsonRequest = (body: unknown, method = "POST") => new Request("https://app.example/api/artifacts/publications/publication", {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  it("selects content and ZIP solely with the bounded header and echoes their exact permanent number", async () => {
    const publicBundle = vi.fn(async () => ({ ...download, versionNumber: 3 }));
    const publicZip = vi.fn(async () => ({ ...download, contentType: "application/zip", fileName: "artifact.zip", versionNumber: 3 }));
    const handler = createPublicArtifactHandler({ publicBundle, publicZip } as unknown as ArtifactService);
    for (const suffix of ["", "?download=zip", "?download=file"]) {
      const response = await handler(new Request(`https://app.example/api/artifact-public/${token}${suffix}`, {
        headers: { "X-AIQSA-Artifact-Version": "3" }
      }), { params: { artifactToken: token } });
      expect(response.status).toBe(200);
      expect(response.headers.get("X-AIQSA-Artifact-Version")).toBe("3");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
    expect(publicBundle).toHaveBeenCalledWith(token, false, 3, undefined);
    expect(publicBundle).toHaveBeenCalledWith(token, true, 3, undefined);
    expect(publicZip).toHaveBeenCalledWith(token, 3);
    publicBundle.mockClear(); publicZip.mockClear();
    for (const selector of ["0", "01", "1e2", "-1", "2147483648", "1, 3", "9".repeat(200)]) {
      const failed = await handler(new Request(`https://app.example/api/artifact-public/${token}`, {
        headers: { "X-AIQSA-Artifact-Version": selector }
      }), { params: { artifactToken: token } });
      expect(failed.status).toBe(404); expect(await failed.json()).toEqual({ error: "artifact_not_found" });
    }
    expect((await handler(new Request(`https://app.example/api/artifact-public/${token}?version=3`), { params: { artifactToken: token } })).status).toBe(404);
    expect(publicBundle).not.toHaveBeenCalled(); expect(publicZip).not.toHaveBeenCalled();
  });
  it("exposes a no-store manifest through the shared privacy boundary without authored-content CSP", async () => {
    const publicManifest = vi.fn(async () => ({ mode: "version_set", title: "Three", kind: "html", expiresAt: null,
      defaultVersionNumber: 3, versions: [{ versionNumber: 3, title: "Three", kind: "html" }] }));
    const handler = createPublicArtifactManifestHandler({ publicManifest } as unknown as ArtifactService);
    const request = new Request(`https://app.example/api/artifact-public/${token}/manifest`);
    const response = await handler(request, { params: { artifactToken: token } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toContain("noarchive");
    expect(await response.json()).toEqual({ publication: await publicManifest() });
    publicManifest.mockRejectedValueOnce(new Error("private-storage-key"));
    const rejected = await handler(request, { params: { artifactToken: token } });
    expect(rejected.status).toBe(404); expect(await rejected.json()).toEqual({ error: "artifact_not_found" });
    publicManifest.mockRejectedValueOnce(new ArtifactPublicBusyError());
    const busy = await handler(request, { params: { artifactToken: token } });
    expect(busy.status).toBe(429); expect(busy.headers.get("retry-after")).toBe("1");
  });
  it("passes explicit membership to creation and projects the raw URL only in its one-time response", async () => {
    const publishSet = vi.fn(async () => ({ ...summary, shareToken: token, publicPath: `/a/${token}` }));
    const handler = createArtifactPublishHandler({ resolveAuth: auth, service: { publishSet } as unknown as ArtifactService });
    const response = await handler(jsonRequest({ mode: "version_set", versionIds: ["v1", "v3"], defaultVersionId: "v3" }), { params: { artifactId: "artifact" } });
    expect(response.status).toBe(201);
    expect(publishSet).toHaveBeenCalledWith({ ownerUserId: "owner", artifactId: "artifact", versionIds: ["v1", "v3"], defaultVersionId: "v3" });
    expect(await response.json()).toEqual({ publication: { ...summary, publicPath: `/a/${token}` } });
    const rejected = await handler(jsonRequest({ mode: "version_set", versionIds: ["v1"], defaultVersionId: "private" }), { params: { artifactId: "artifact" } });
    expect(rejected.status).toBe(400); expect(publishSet).toHaveBeenCalledOnce();
  });
  it("requires optimistic guards and returns recoverable conflicts without retrying a reissue", async () => {
    const mutatePublication = vi.fn(async () => summary);
    const reissue = vi.fn(async () => ({ ...summary, shareToken: token, publicPath: `/a/${token}` }));
    const service = { mutatePublication, reissue } as unknown as ArtifactService;
    const patch = createArtifactPublicationMutationHandler({ resolveAuth: auth, service });
    const rotate = createArtifactPublicationReissueHandler({ resolveAuth: auth, service });
    const mutation = { action: "remove", versionId: "v1", expectedRevision: 1 };
    expect((await patch(jsonRequest(mutation, "PATCH"), context)).status).toBe(200);
    expect(mutatePublication).toHaveBeenCalledWith({ ownerUserId: "owner", publicationId: "publication", mutation });
    mutatePublication.mockRejectedValueOnce(new Error("artifact_publication_conflict"));
    const conflict = await patch(jsonRequest(mutation, "PATCH"), context);
    expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual({ error: "artifact_publication_conflict" });
    expect((await rotate(jsonRequest({ expectedRevision: 1, expiresInDays: 365 }), context)).status).toBe(400);
    expect(reissue).not.toHaveBeenCalled();
    const rotated = await rotate(jsonRequest({ expectedRevision: 2 }), context);
    expect(await rotated.json()).toEqual({ publication: { ...summary, publicPath: `/a/${token}` } });
    expect(reissue).toHaveBeenCalledOnce();
    reissue.mockRejectedValueOnce(new Error("artifact_publication_not_found"));
    expect((await rotate(jsonRequest({ expectedRevision: 2 }), context)).status).toBe(404);
    expect(reissue).toHaveBeenCalledTimes(2);
  });
  it("preserves empty-body legacy revoke and rejects malformed guarded revocation", async () => {
    const revoke = vi.fn(async () => true);
    const handler = createArtifactRevokeHandler({ resolveAuth: auth, service: { revoke } as unknown as ArtifactService });
    expect((await handler(new Request("https://app.example/api/artifacts/publications/publication/revoke", { method: "POST" }), context)).status).toBe(200);
    expect(revoke).toHaveBeenCalledWith({ ownerUserId: "owner", publicationId: "publication" });
    expect((await handler(jsonRequest({ expectedRevision: 2 }), context)).status).toBe(200);
    expect(revoke).toHaveBeenLastCalledWith({ ownerUserId: "owner", publicationId: "publication", expectedRevision: 2 });
    expect((await handler(jsonRequest({ expectedRevision: 0 }), context)).status).toBe(400);
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
