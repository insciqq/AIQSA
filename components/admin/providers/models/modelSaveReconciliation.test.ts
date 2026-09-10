import { describe, expect, it } from "vitest";
import { fixtureModel } from "../providerFixtures";
import { modelFormFrom } from "./modelSheetView";
import { reconcileModelForm } from "./modelSaveReconciliation";

describe("confirmed model fields", () => {
  it("cleans only the persisted name while keeping JSON, capability and timeout changes dirty", () => {
    const model = fixtureModel({ connectionId: "provider", displayName: "Old name", id: "model" });
    const baseline = modelFormFrom(model);
    const submitted = { ...baseline, displayName: "New name", defaultParamsText: '{"temperature":0.8}',
      responseTimeoutSeconds: "120", capabilities: { ...baseline.capabilities, vision: true } };
    const saved = { ...model, displayName: "New name", updatedAt: "2026-09-10T10:00:00.000Z" };
    const result = reconcileModelForm(baseline, submitted, { receipt: null, model: saved });
    expect(result).toEqual({ baseline: { ...baseline, displayName: "New name" }, guardModel: saved, confirmed: true, complete: false });
  });

  it("acknowledges exactly the submitted fields even when JSON formatting differs or catalog refresh failed", () => {
    const model = fixtureModel({ connectionId: "provider", displayName: "Old", id: "model" });
    const baseline = modelFormFrom(model);
    const submitted = { ...baseline, displayName: "Name", defaultParamsText: "{  }", responseTimeoutSeconds: "120" };
    const result = reconcileModelForm(baseline, submitted, { model: null, receipt: { connectionId: "provider", modelId: "model",
      displayName: "Name", draftVersion: 2, saved: "configuration", publication: "active", checks: "failed" } });
    expect(result).toEqual({ baseline: submitted, guardModel: null, confirmed: true, complete: true });
  });

  it("does not advance the next CAS guard when another server field changed", () => {
    const model = fixtureModel({ connectionId: "provider", displayName: "Old", id: "model" });
    const baseline = modelFormFrom(model);
    const submitted = { ...baseline, displayName: "Name" };
    const newer = { ...model, displayName: "Name", draftVersion: 9,
      draftConfig: { ...model.draftConfig, responseTimeoutSeconds: 120 } };
    expect(reconcileModelForm(baseline, submitted, { model: newer, receipt: null }))
      .toEqual({ baseline: submitted, guardModel: null, confirmed: true, complete: true });
  });
});
