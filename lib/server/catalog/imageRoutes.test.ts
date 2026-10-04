import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticImagePlan } from "@/tests/support/imagePlan";
import type { CatalogWireModel } from "../../contracts/catalog";
import type { ImageModelResolution } from "../providerRuntime/imageModelRole";
import { resolveImageRouteFacts, withImageRoutes } from "./imageRoutes";

const runtime = vi.hoisted(() => ({
  resolveFor: vi.fn<(scope: unknown) => Promise<unknown>>(),
  vision: { available: false }
}));
vi.mock("../providerRuntime/imageModelRole", () => ({ createImageModelRoleResolver: () => ({ resolveFor: runtime.resolveFor }) }));
vi.mock("../providerRuntime/visionAnalysis", () => ({ createVisionAnalysisPlanResolver: () => async () => runtime.vision }));

const db = {} as PrismaClient;
const plan = (imageEditing: boolean) => {
  const base = syntheticImagePlan();
  return { ...base, snapshot: { ...base.snapshot, model: { ...base.snapshot.model,
    capabilities: { ...base.snapshot.model.capabilities, imageEditing } } } };
};
const resolved = (imageEditing: boolean, source: "organization" | "personal"): ImageModelResolution =>
  ({ ok: true, plan: plan(imageEditing), providerModelId: "image-model", source });

describe("composer image routes", () => {
  beforeEach(() => {
    runtime.resolveFor.mockReset();
    runtime.vision = { available: false };
  });

  it("takes personal editing from the user's effective image model, as admission resolves it", async () => {
    runtime.resolveFor.mockResolvedValueOnce(resolved(true, "personal"));
    expect(await resolveImageRouteFacts(db, { kind: "personal", userId: "user-1" })).toEqual({ systemVision: false, imageEditing: true });
    expect(runtime.resolveFor).toHaveBeenCalledExactlyOnceWith({ kind: "personal", userId: "user-1" });
    // A generation-only choice edits nothing, whatever the organization default could do.
    runtime.resolveFor.mockResolvedValueOnce(resolved(false, "personal"));
    expect(await resolveImageRouteFacts(db, { kind: "personal", userId: "user-1" })).toEqual({ systemVision: false, imageEditing: false });
  });

  it.each([
    { ok: false, reason: "credential_unavailable", providerModelId: "image-model", source: "personal" },
    { ok: false, reason: "not_configured", providerModelId: null, source: "organization" }
  ] as const)("never substitutes another model for an unusable or absent one: $reason", async (resolution) => {
    runtime.resolveFor.mockResolvedValueOnce(resolution);
    runtime.vision = { available: true };
    expect(await resolveImageRouteFacts(db, { kind: "personal", userId: "user-1" })).toEqual({ systemVision: true, imageEditing: false });
  });

  it("keeps Project composers on the administrator default without a personal lookup", async () => {
    runtime.resolveFor.mockResolvedValueOnce(resolved(true, "organization"));
    expect(await resolveImageRouteFacts(db, { kind: "project" })).toEqual({ systemVision: false, imageEditing: true });
    expect(runtime.resolveFor).toHaveBeenCalledExactlyOnceWith({ kind: "project" });
  });

  it("applies one rule to the facts of either scope: routes need tool calling, System Vision a model without image input", () => {
    const model = (toolCalling: boolean, imageInput: boolean) =>
      ({ capabilities: { toolCalling, imageInput } }) as unknown as CatalogWireModel;
    const facts = { systemVision: true, imageEditing: false };
    expect(withImageRoutes(model(true, false), facts).capabilities.imageRoutes).toEqual({ systemVision: true, imageEditing: false });
    expect(withImageRoutes(model(true, true), facts).capabilities.imageRoutes).toEqual({ systemVision: false, imageEditing: false });
    expect(withImageRoutes(model(false, false), facts).capabilities.imageRoutes).toBeUndefined();
  });
});
