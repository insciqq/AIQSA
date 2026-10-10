import { describe, expect, it } from "vitest";
import { ARTIFACT_LIMITS } from "@/lib/contracts/artifacts";
import { applyArtifactGenerationEvent as apply, visibleArtifactGenerationAttempts, type ArtifactGenerationDraft } from "./artifactGenerationState";

describe("transient artifact code", () => {
  it("appends actual fragments by offset, accepts a later path and releases text when the version is ready", () => {
    let drafts = apply([], { draftId: "a", phase: "started" });
    drafts = apply(drafts, { draftId: "a", phase: "file", index: 0, offset: 0, text: "<h1>" });
    drafts = apply(drafts, { draftId: "a", phase: "file", index: 0, offset: 4, text: "Hi</h1>", path: "index.html" });
    expect(drafts[0].files).toEqual([{ index: 0, path: "index.html", text: "<h1>Hi</h1>", byteSize: 11 }]);
    const artifact = { artifactId: "saved", versionId: "v1", title: "Page", kind: "html" as const, versionNumber: 1, entrypoint: "index.html" };
    drafts = apply(drafts, { draftId: "a", phase: "settled", status: "ready", artifact });
    expect(drafts[0]).toMatchObject({ artifact, status: "ready", files: [] });
    expect(apply(drafts, { draftId: "a", phase: "file", index: 0, offset: 0, text: "late" })).toBe(drafts);
  });
  it("fails closed on gaps and byte overflow while a reset can start a new valid preview", () => {
    let drafts = apply([], { draftId: "a", phase: "started" });
    drafts = apply(drafts, { draftId: "a", phase: "metadata", title: "Preview" });
    drafts = apply(drafts, { draftId: "a", phase: "file", index: 0, offset: 7, text: "gap" });
    expect(drafts[0]).toMatchObject({ previewUnavailable: true, files: [] });
    drafts = apply(drafts, { draftId: "a", phase: "reset" });
    expect(drafts[0]).toMatchObject({ title: "Preview", previewUnavailable: false });
    const full = "x".repeat(ARTIFACT_LIMITS.maxTextFileBytes);
    const atLimit: readonly ArtifactGenerationDraft[] = [{ ...drafts[0], files: [{ index: 0, text: full, byteSize: full.length }] }];
    expect(apply(atLimit, { draftId: "a", phase: "file", index: 0, offset: full.length, text: "界" })[0]).toMatchObject({ previewUnavailable: true, files: [] });
    expect(apply([], { draftId: "unknown", phase: "file", index: 0, offset: 0, text: "unowned" })).toEqual([]);
  });
  it("keeps attempt cards honest: a failure hides only once the answer created an artifact", () => {
    const artifact = { artifactId: "saved", versionId: "v1", title: "Page", kind: "html" as const, versionNumber: 1, entrypoint: "index.html" };
    const attempt = (draftId: string, status: ArtifactGenerationDraft["status"]): ArtifactGenerationDraft =>
      ({ draftId, status, files: [], ...status === "ready" ? { artifact } : {} });
    const [failed, pending, cancelled, interrupted, ready] = (["failed", "pending", "cancelled", "interrupted", "ready"] as const)
      .map(status => attempt(status, status));
    const ids = (drafts: readonly ArtifactGenerationDraft[]) => drafts.map(draft => draft.draftId);
    expect(ids(visibleArtifactGenerationAttempts([failed, pending, cancelled, interrupted], []))).toEqual(["failed", "pending", "cancelled", "interrupted"]);
    expect(ids(visibleArtifactGenerationAttempts([failed, pending, cancelled, interrupted, ready], []))).toEqual(["pending", "cancelled", "interrupted"]);
    expect(ids(visibleArtifactGenerationAttempts([failed, cancelled, interrupted], [artifact]))).toEqual(["cancelled"]);
  });
});
