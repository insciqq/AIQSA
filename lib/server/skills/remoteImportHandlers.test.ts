// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createRemoteSkillImportHandlers } from "./remoteImportHandlers";
import { SkillBundleError } from "./bundleErrors";
import type { RemoteSkillImportService } from "./remoteImportService";
import { decodeSkillImportSource, decodeSkillSourceImportRequest } from "../../contracts/skillSources";

const auth = { userId: "owner", user: { id: "owner", role: "user", status: "active", displayName: "Fixture", email: "fixture@example.test" },
  id: "session", expiresAt: new Date(Date.now() + 60_000) } satisfies AuthenticatedSession;
const url = "https://github.com/example/skills";
const source = { kind: "github" as const, url, revision: "a".repeat(40) };
const fingerprint = "f".repeat(64);
const importBody = { url, fingerprint, selections: [{ path: ".", bundleDigest: fingerprint, action: { kind: "create" } }] };
const request = (body: unknown, headers?: Record<string, string>) => new Request("https://app.example.test/api/me/skills/import/preview", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
});
function fixture() {
  const preview = vi.fn<RemoteSkillImportService["preview"]>(async () => ({ source, fingerprint, candidates: [], ignoredFiles: 0 }));
  const importSelected = vi.fn<RemoteSkillImportService["importSelected"]>(async () => ({ results: [], ignoredFiles: 0 }));
  const resolveAuth = vi.fn(async (): Promise<AuthenticatedSession | null> => auth);
  return { preview, importSelected, resolveAuth, handlers: createRemoteSkillImportHandlers({ resolveAuth, service: () => ({ preview, importSelected }) }) };
}

describe("remote Skill import HTTP boundary", () => {
  it("checks authentication, account state and origin before consuming input or fetching", async () => {
    const f = fixture();
    f.resolveAuth.mockResolvedValueOnce(null);
    const body = request({ url });
    expect((await f.handlers.preview(body)).status).toBe(401);
    expect(body.bodyUsed).toBe(false);
    f.resolveAuth.mockResolvedValueOnce({ ...auth, user: { ...auth.user, status: "disabled" } });
    expect((await f.handlers.preview(request({ url }))).status).toBe(403);
    expect((await f.handlers.preview(request({ url }, { origin: "https://foreign.example.test" }))).status).toBe(403);
    expect(f.preview).not.toHaveBeenCalled();
  });

  it("rejects unbounded, credential-bearing, unsupported and client-authored inputs before use", async () => {
    const f = fixture();
    for (const body of [{ url: "git@example.test:skills" }, { url: "https://user:pass@example.test/SKILL.md" },
      { url: `${url}?token=private` }, { url, bundle: {} }, { url, targetSkillId: "../owned" }]) {
      expect((await f.handlers.preview(request(body))).status).toBe(400);
    }
    expect((await f.handlers.preview(request({ url: "x".repeat(270_000) }))).status).toBe(413);
    expect(f.preview).not.toHaveBeenCalled();
  });

  it("passes authenticated identity and cancellation, serves private projections and safe errors", async () => {
    const f = fixture();
    const response = await f.handlers.preview(request({ url }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(f.preview).toHaveBeenCalledWith("owner", { url }, { signal: expect.any(AbortSignal) });
    expect((await f.handlers.importSelected(request(importBody))).status).toBe(200);
    expect(f.importSelected).toHaveBeenCalledWith("owner", importBody, { signal: expect.any(AbortSignal) });
    f.preview.mockRejectedValueOnce(new SkillBundleError({ code: "skill_source_changed" }));
    expect((await f.handlers.preview(request({ url }))).status).toBe(409);
    f.preview.mockRejectedValueOnce(new Error("private upstream payload"));
    expect(await (await f.handlers.preview(request({ url }))).json()).toEqual({ error: "skill_source_unavailable" });
  });

  it("rejects duplicate paths, duplicate update targets and extra authority fields", () => {
    const selection = { path: "a", bundleDigest: fingerprint, action: { kind: "update", skillId: "owned", version: 1 } };
    for (const selections of [[selection, selection], [selection, { ...selection, path: "b" }],
      [{ ...selection, action: { ...selection.action, ownerUserId: "peer" } }], [{ ...selection, action: { kind: "update", skillId: "owned", version: 0 } }]]) {
      expect(decodeSkillSourceImportRequest({ ...importBody, selections })).toBeNull();
    }
    expect(decodeSkillImportSource({ ...source, path: ".", bundleDigest: fingerprint, secret: "omit" }))
      .toEqual({ ...source, path: ".", bundleDigest: fingerprint });
  });
});
